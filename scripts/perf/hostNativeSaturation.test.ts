import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostNodeRunAdmission,
  HOST_NODE_MAX_CONCURRENT_RUNS,
  HOST_NODE_MAX_QUEUED_STARTS
} from '../../src/host-node/HostNodeRunAdmission'
import { bindHostNodeRunAdmissionForSaturation } from '../../src/host-node/HostNodeRunAdmissionSaturationAdapter'

const require = createRequire(import.meta.url)
const {
  DEFAULT_ACTIVE_TARGET,
  DEFAULT_QUEUED_TARGET,
  generateHostSaturationScript,
  runHostNativeSaturation,
  runDryRun
} = require('./hostNativeSaturation.cjs')

// Test double mirroring HostNodeRunAdmission semantics (16 active, 8 queued,
// thread_busy identity rule, cancel resolves the waiter as rejected). Used
// for driver-strictness cases that need hangs, lying counters, or garbage
// results. Production admission is bound in the dedicated test below.
function createFakeAdmission(options: Record<string, unknown> = {}) {
  const maxActive = (options.maxActive as number) ?? 16
  const maxQueued = (options.maxQueued as number) ?? 8
  const hangAcquires = new Set((options.hangAcquires as number[]) ?? [])
  const inflight = new Map<string, string>()
  const waiters: { commandId: string; threadId: string; resolve: (value: unknown) => void }[] = []
  let acquireCalls = 0
  const flush = () => {
    while (inflight.size < maxActive && waiters.length > 0) {
      const waiter = waiters.shift()!
      inflight.set(waiter.commandId, waiter.threadId)
      waiter.resolve({
        kind: 'admitted',
        lease: leaseFor(waiter.commandId, waiter.threadId)
      })
    }
  }
  const leaseFor = (commandId: string, threadId: string) => ({
    commandId,
    threadId,
    release: () => {
      if (!inflight.delete(commandId)) return
      flush()
    }
  })
  return {
    calls: () => acquireCalls,
    async acquire(input: { commandId: string; threadId: string }) {
      acquireCalls += 1
      if (hangAcquires.has(acquireCalls)) return await new Promise(() => {})
      const busy =
        [...inflight.values()].includes(input.threadId) ||
        waiters.some((waiter) => waiter.threadId === input.threadId)
      if (busy) {
        return { kind: 'rejected', errorCode: 'thread_busy', errorMessage: 'thread busy' }
      }
      if (inflight.size < maxActive) {
        inflight.set(input.commandId, input.threadId)
        return { kind: 'admitted', lease: leaseFor(input.commandId, input.threadId) }
      }
      if (waiters.length >= maxQueued) {
        return { kind: 'rejected', errorCode: 'host_saturated', errorMessage: 'saturated' }
      }
      return await new Promise((resolve) => {
        waiters.push({ commandId: input.commandId, threadId: input.threadId, resolve })
      })
    },
    inflightCount: () => inflight.size,
    queuedCount: () => waiters.length,
    cancelQueued: (input: { threadId: string; commandId?: string }) => {
      let cancelled = 0
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]
        if (waiter.threadId !== input.threadId) continue
        if (input.commandId && waiter.commandId !== input.commandId) continue
        waiters.splice(index, 1)
        waiter.resolve({
          kind: 'rejected',
          errorCode: 'run_start_cancelled',
          errorMessage: 'cancelled'
        })
        cancelled += 1
      }
      return cancelled
    },
    persistProbe: vi.fn(async () => ({ probed: true }))
  }
}

function saturate(api: ReturnType<typeof createFakeAdmission>, overrides = {}) {
  return runHostNativeSaturation({
    api,
    seed: 4242,
    acquireTimeoutMs: 1000,
    deadlineMs: 10_000,
    diagnosticOnly: true,
    ...overrides
  })
}

describe('generateHostSaturationScript', () => {
  it('derives a deterministic 16-hold + 1-arrival script from the seed', () => {
    const first = generateHostSaturationScript({ seed: 4242 })
    const second = generateHostSaturationScript({ seed: 4242 })
    expect(first).toEqual(second)
    expect(first.activeTarget).toBe(16)
    expect(first.queuedTarget).toBe(1)
    expect(first.holds).toHaveLength(16)
    expect(first.arrivals).toHaveLength(1)
    const ids = [...first.holds, ...first.arrivals].map((step) => step.commandId)
    expect(new Set(ids).size).toBe(17)
    const threads = [...first.holds, ...first.arrivals].map((step) => step.threadId)
    expect(new Set(threads).size).toBe(17)
  })

  it('refuses a missing seed and non-positive targets', () => {
    expect(() => generateHostSaturationScript({})).toThrow(/seed/)
    expect(() => generateHostSaturationScript({ seed: 1.5 })).toThrow(/seed/)
    expect(() => generateHostSaturationScript({ seed: 1, activeTarget: 0 })).toThrow(/activeTarget/)
    expect(() => generateHostSaturationScript({ seed: 1, queuedTarget: -1 })).toThrow(
      /queuedTarget/
    )
  })
})

describe('runHostNativeSaturation', () => {
  it('holds 16, queues the 17th, probes while queued, admits on release, drains clean', async () => {
    const api = createFakeAdmission()
    const result = await saturate(api)
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.holds.every((hold) => hold.outcome === 'completed')).toBe(true)
    expect(result.arrival.outcome).toBe('completed')
    expect(result.arrival.queuedBeforeAdmit).toBe(true)
    expect(result.probe.outcome).toBe('completed')
    expect(result.probe.whileQueued).toBe(true)
    expect(api.persistProbe).toHaveBeenCalledTimes(1)
    expect(result.drain.outcome).toBe('completed')
    expect(result.drain.inflightCount).toBe(0)
    expect(result.drain.queuedCount).toBe(0)
    expect(result.pendingEffects).toEqual([])
  })

  it('records immediate admission honestly when the adapter never queues', async () => {
    const api = createFakeAdmission({ maxActive: 64 })
    const result = await saturate(api)
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(false)
    expect(result.arrival.queuedBeforeAdmit).toBe(false)
    expect(result.probe.whileQueued).toBe(false)
    expect(result.notes).toContain('arrival settled without queueing')
  })

  it('records adapter rejection codes verbatim', async () => {
    const api = createFakeAdmission({ maxActive: 16, maxQueued: 0 })
    const result = await saturate(api)
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(false)
    expect(result.arrival.outcome).toBe('rejected')
    expect(result.arrival.errorCode).toBe('host_saturated')
  })

  it('fails a hanging acquire closed with a pending effect, not a hang', async () => {
    const api = createFakeAdmission({ hangAcquires: [3] })
    const result = await saturate(api, { acquireTimeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.holds[2].outcome).toBe('failed')
    expect(result.holds[2].reason).toBe('acquire_timeout')
    expect(result.pendingEffects).toHaveLength(1)
    expect(result.pendingEffects[0].commandId).toBe(result.holds[2].commandId)
    expect(result.arrival).toBeNull()
  })

  it('censors the schedule past an expired deadline', async () => {
    const api = createFakeAdmission()
    let calls = 0
    const slow = {
      ...api,
      acquire: async (input: { commandId: string; threadId: string }) => {
        calls += 1
        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 30))
        return api.acquire(input)
      }
    }
    const result = await saturate(slow, { deadlineMs: 10 })
    expect(result.ok).toBe(false)
    const censored = result.holds.filter((hold) => hold.outcome === 'censored')
    expect(censored.length).toBeGreaterThan(0)
    expect(result.arrival).toBeNull()
  })

  it('fails closed on adapter garbage without leaking payloads', async () => {
    const api = createFakeAdmission()
    const garbage = { ...api, acquire: async () => ({ kind: 'admitted' }) }
    const result = await saturate(garbage)
    expect(result.ok).toBe(false)
    expect(result.holds[0].outcome).toBe('failed')
    expect(result.holds[0].reason).toBe('adapter_invalid_result')
  })

  it('records adapter throws as adapter_threw, never the payload', async () => {
    const api = createFakeAdmission()
    const secret = 'secret-payload-' + Math.random()
    const throwing = {
      ...api,
      acquire: async () => {
        throw new Error(secret)
      }
    }
    const result = await saturate(throwing)
    expect(result.ok).toBe(false)
    expect(result.holds[0].reason).toBe('adapter_threw')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('reserves one run per adapter until effects settle', async () => {
    const api = createFakeAdmission()
    let releaseProbe!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const gated = { ...api, persistProbe: () => gate.then(() => ({ probed: true })) }
    const first = saturate(gated)
    await expect(saturate(gated)).rejects.toThrow(/owned by another saturation run/)
    releaseProbe()
    const result = await first
    expect(result.ok).toBe(true)
    await expect(saturate(gated)).resolves.toMatchObject({ ok: true })
  })

  it('marks the run failed when the persist probe hook is absent', async () => {
    const api = createFakeAdmission()
    const { persistProbe: _dropped, ...noProbe } = api
    const result = await saturate(noProbe)
    expect(result.ok).toBe(false)
    expect(result.probe.outcome).toBe('unsupported')
    expect(result.probe.reason).toBe('persist_probe_unavailable')
    expect(result.holds.every((hold) => hold.outcome === 'completed')).toBe(true)
    expect(result.drain.outcome).toBe('completed')
  })

  it('reports pending-but-unobserved arrival instead of claiming saturation', async () => {
    const api = createFakeAdmission()
    const lying = { ...api, queuedCount: () => 0 }
    const result = await saturate(lying)
    expect(result.saturationObserved).toBe(false)
    expect(result.notes).toContain('arrival_pending_queue_unobserved')
    expect(result.arrival.outcome).toBe('completed')
  })

  it('refuses to call a queued-but-unsettled arrival saturation', async () => {
    // The queue IS observed here; only the second half of the claim fails.
    const api = createFakeAdmission()
    const stuck = {
      ...api,
      acquire: async (input: { commandId: string; threadId: string }) => {
        const result = (await api.acquire(input)) as {
          kind: string
          lease?: { commandId: string; threadId: string; release: () => void }
        }
        // A pool whose releases free nothing: the arrival stays queued.
        return result.kind === 'admitted'
          ? { ...result, lease: { ...result.lease!, release: () => {} } }
          : result
      }
    }
    const result = await saturate(stuck, { acquireTimeoutMs: 20 })
    expect(result.arrival.queueObserved).toBe(true)
    expect(result.arrival.outcome).toBe('cancelled')
    expect(result.saturationObserved).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('fails closed when an admitted lease omits the commandId the report cites', async () => {
    const api = createFakeAdmission()
    const bare = {
      ...api,
      acquire: async () => ({ kind: 'admitted', lease: { release: () => {} } })
    }
    const result = await saturate(bare)
    expect(result.ok).toBe(false)
    expect(result.holds[0].outcome).toBe('failed')
    expect(result.holds[0].reason).toBe('adapter_invalid_result')
  })

  it('refuses a script and a seed together, and neither', async () => {
    const api = createFakeAdmission()
    const script = generateHostSaturationScript({ seed: 7 })
    await expect(saturate(api, { script, seed: 7 })).rejects.toThrow(/script.*seed|seed.*script/)
    await expect(
      runHostNativeSaturation({ api, seed: undefined as unknown as number })
    ).rejects.toThrow(/seed/)
  })
})

describe('production HostNodeRunAdmission bind', () => {
  it('observes saturation against createHostNodeRunAdmission, not the test double', async () => {
    const admission = createHostNodeRunAdmission()
    const persistProbe = vi.fn(async () => {
      expect(admission.queuedCount()).toBeGreaterThan(0)
      return { probed: true }
    })
    const api = bindHostNodeRunAdmissionForSaturation(admission, persistProbe)
    const result = await saturate(api)
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.arrival.queuedBeforeAdmit).toBe(true)
    expect(result.probe.whileQueued).toBe(true)
    expect(persistProbe).toHaveBeenCalledTimes(1)
    expect(result.drain.inflightCount).toBe(0)
    expect(result.drain.queuedCount).toBe(0)
    expect(admission.inflightCount()).toBe(0)
    expect(admission.queuedCount()).toBe(0)
  })
})

describe('host saturation scenario bounds', () => {
  it('pins the scripted targets to the production admission capacity', () => {
    // A capacity change in src must not silently turn the scenario into a
    // 16-of-24 fill that never queues.
    expect(DEFAULT_ACTIVE_TARGET).toBe(HOST_NODE_MAX_CONCURRENT_RUNS)
    expect(DEFAULT_QUEUED_TARGET).toBeGreaterThan(0)
    expect(DEFAULT_QUEUED_TARGET).toBeLessThanOrEqual(HOST_NODE_MAX_QUEUED_STARTS)
  })
})

describe('host saturation dry-run', () => {
  it('exercises the scripted scenario with zero production effects', async () => {
    const result = await runDryRun()
    expect(result.ok).toBe(true)
    expect(result.diagnosticOnly).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.holds).toHaveLength(16)
  })
})
