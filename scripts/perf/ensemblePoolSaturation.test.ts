import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  generateEnsembleSaturationScript,
  runEnsemblePoolSaturation,
  runDryRun
} = require('./ensemblePoolSaturation.cjs')

// Test double: a seat pool behind the control-action + status-read shape.
// `cap` models a capped pool (31st enable refused as pool_full); null absorbs.
// It is a double, not production Ensemble admission: attached adapters arrive
// with production binding (B1/M2, still owed).
function createFakePool(options: Record<string, unknown> = {}) {
  const cap = (options.cap as number | null) ?? null
  const hangCalls = new Set((options.hangCalls as number[]) ?? [])
  const seats = new Set((options.baseline as string[]) ?? [])
  const requests: Record<string, unknown>[] = []
  let calls = 0
  return {
    requests,
    async issueControlAction(request: {
      action: string
      args: { participantId: string; enabled: boolean }
    }) {
      calls += 1
      requests.push(request as unknown as Record<string, unknown>)
      if (hangCalls.has(calls)) return await new Promise(() => {})
      if (request.action !== 'seat_toggle') return { unsupported: 'only seat_toggle here' }
      if (request.args.enabled) {
        if (cap !== null && seats.size >= cap) return { ok: false, reason: 'pool_full' }
        seats.add(request.args.participantId)
        return { ok: true }
      }
      seats.delete(request.args.participantId)
      return { ok: true }
    },
    readPoolStatus: () => ({ seatCount: seats.size })
  }
}

function saturate(api: ReturnType<typeof createFakePool>, overrides = {}) {
  return runEnsemblePoolSaturation({
    api,
    seed: 4242,
    actionTimeoutMs: 1000,
    deadlineMs: 10_000,
    diagnosticOnly: true,
    ...overrides
  })
}

describe('generateEnsembleSaturationScript', () => {
  it('derives a deterministic 30-seat + arrival script from the seed', () => {
    const first = generateEnsembleSaturationScript({ seed: 4242 })
    const second = generateEnsembleSaturationScript({ seed: 4242 })
    expect(first).toEqual(second)
    expect(first.poolTarget).toBe(30)
    expect(first.seats).toHaveLength(30)
    const ids = [...first.seats.map((seat) => seat.participantId), first.arrival.participantId]
    expect(new Set(ids).size).toBe(31)
  })

  it('refuses a missing seed and non-positive targets', () => {
    expect(() => generateEnsembleSaturationScript({})).toThrow(/seed/)
    expect(() => generateEnsembleSaturationScript({ seed: 1, poolTarget: 0 })).toThrow(/poolTarget/)
  })

  it('scripts the thread identity the seat-toggle target requires', () => {
    const script = generateEnsembleSaturationScript({ seed: 4242 })
    expect(script.threadId).toBe('ens-sat-s4242-thread')
  })
})

describe('runEnsemblePoolSaturation', () => {
  it('fills 30, arrives the new chat, drains clean on an absorbing pool', async () => {
    const result = await saturate(createFakePool())
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.baseline).toMatchObject({ outcome: 'completed', seatCount: 0 })
    expect(result.fills.every((fill) => fill.outcome === 'completed')).toBe(true)
    expect(result.postFill).toMatchObject({ outcome: 'completed', seatCount: 30 })
    expect(result.arrival.outcome).toBe('completed')
    expect(result.postArrival).toMatchObject({ outcome: 'completed', seatCount: 31 })
    expect(result.drain).toMatchObject({ outcome: 'completed', seatCount: 0 })
    expect(result.pendingEffects).toEqual([])
    // The flag is an occupancy claim: an absorbing pool refused nothing.
    expect(result.occupancyDelta).toBe(30)
    expect(result.arrivalRefused).toBe(false)
  })

  it('observes saturation when a capped pool refuses the arrival as pool_full', async () => {
    const result = await saturate(createFakePool({ cap: 30 }))
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.arrival.outcome).toBe('rejected')
    expect(result.arrival.reason).toBe('pool_full')
    expect(result.arrivalRefused).toBe(true)
    expect(result.drain).toMatchObject({ outcome: 'completed', seatCount: 0 })
  })

  it('reads the fill relative to pre-existing occupancy', async () => {
    const result = await saturate(createFakePool({ baseline: ['a', 'b', 'c'] }))
    expect(result.ok).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.baseline.seatCount).toBe(3)
    expect(result.postFill.seatCount).toBe(33)
    expect(result.drain.seatCount).toBe(3)
  })

  it('fails the run when the pool refuses below target', async () => {
    const result = await saturate(createFakePool({ cap: 5 }))
    expect(result.ok).toBe(false)
    expect(result.saturationObserved).toBe(false)
    expect(result.fills[5].outcome).toBe('rejected')
    expect(result.fills[5].reason).toBe('pool_full')
    expect(result.arrival).toBeNull()
    expect(result.notes).toContain('pool_refused_below_target')
    expect(result.drain).toMatchObject({ outcome: 'completed', seatCount: 0 })
  })

  it('issues seat toggles in the shape ensemble.seat.toggle decodes', async () => {
    // validateEnsembleSeatToggle takes an exact string threadId target and
    // arguments of exactly { participantId, enabled }: a pass-through adapter
    // must not have to invent the thread identity.
    const pool = createFakePool()
    const result = await saturate(pool)
    expect(result.threadId).toBe('ens-sat-s4242-thread')
    expect(pool.requests).toHaveLength(62)
    for (const request of pool.requests) {
      expect(request.action).toBe('seat_toggle')
      expect(request.target).toEqual({ threadId: 'ens-sat-s4242-thread' })
      expect(Object.keys(request.args as object).sort()).toEqual(['enabled', 'participantId'])
    }
  })

  it('refuses to call an off-target fill saturation', async () => {
    // A seat that joins from outside the run makes the fill 31, not 30.
    const pool = createFakePool()
    let reads = 0
    const drifting = {
      ...pool,
      readPoolStatus: () => {
        reads += 1
        const status = pool.readPoolStatus()
        return reads === 2 ? { seatCount: status.seatCount + 1 } : status
      }
    }
    const result = await saturate(drifting)
    expect(result.ok).toBe(true)
    expect(result.occupancyDelta).toBe(31)
    expect(result.saturationObserved).toBe(false)
    expect(result.notes).toContain('fill_not_exactly_target')
  })

  it('refuses to call an unsettled arrival saturation', async () => {
    // The fill is exactly on target; only the arrival half fails.
    const pool = createFakePool()
    const brokenArrival = {
      ...pool,
      issueControlAction: async (request: {
        action: string
        args: { participantId: string; enabled: boolean }
      }) =>
        request.args.participantId.includes('arrival') && request.args.enabled
          ? { ok: 'yes' }
          : pool.issueControlAction(request)
    }
    const result = await saturate(brokenArrival)
    expect(result.occupancyDelta).toBe(30)
    expect(result.arrival.outcome).toBe('failed')
    expect(result.arrival.reason).toBe('adapter_invalid_result')
    expect(result.arrivalRefused).toBe(false)
    expect(result.saturationObserved).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('fails a hanging toggle closed with a pending effect, not a hang', async () => {
    const result = await saturate(createFakePool({ hangCalls: [5] }), { actionTimeoutMs: 20 })
    expect(result.ok).toBe(false)
    expect(result.fills[4].outcome).toBe('failed')
    expect(result.fills[4].reason).toBe('action_timeout')
    expect(result.pendingEffects).toHaveLength(1)
    expect(result.arrival).toBeNull()
  })

  it('censors the schedule past an expired deadline', async () => {
    const pool = createFakePool()
    let calls = 0
    const slow = {
      ...pool,
      issueControlAction: async (request: {
        action: string
        args: { participantId: string; enabled: boolean }
      }) => {
        calls += 1
        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 30))
        return pool.issueControlAction(request)
      }
    }
    const result = await saturate(slow, { deadlineMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.fills.some((fill) => fill.outcome === 'censored')).toBe(true)
    expect(result.arrival).toBeNull()
  })

  it('fails closed on adapter garbage without leaking payloads', async () => {
    const pool = createFakePool()
    const garbage = { ...pool, issueControlAction: async () => ({ ok: 'yes' }) }
    const result = await saturate(garbage)
    expect(result.ok).toBe(false)
    expect(result.fills[0].outcome).toBe('failed')
    expect(result.fills[0].reason).toBe('adapter_invalid_result')
  })

  it('records adapter throws as adapter_threw, never the payload', async () => {
    const pool = createFakePool()
    const secret = 'secret-payload-' + Math.random()
    const throwing = {
      ...pool,
      issueControlAction: async () => {
        throw new Error(secret)
      }
    }
    const result = await saturate(throwing)
    expect(result.ok).toBe(false)
    expect(result.fills[0].reason).toBe('adapter_threw')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('reserves one run per adapter until the run returns', async () => {
    const pool = createFakePool()
    let releaseToggle!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseToggle = resolve
    })
    let calls = 0
    const gated = {
      ...pool,
      issueControlAction: (request: {
        action: string
        args: { participantId: string; enabled: boolean }
      }) => {
        calls += 1
        if (calls === 1) return gate.then(() => pool.issueControlAction(request))
        return pool.issueControlAction(request)
      }
    }
    const first = saturate(gated)
    await expect(saturate(gated)).rejects.toThrow(/owned by another saturation run/)
    releaseToggle()
    await expect(first).resolves.toMatchObject({ ok: true })
    await expect(saturate(gated)).resolves.toMatchObject({ ok: true })
  })

  it('fails the run when the pool status read is unusable', async () => {
    const pool = createFakePool()
    const blind = { ...pool, readPoolStatus: () => ({ seatCount: -1 }) }
    const result = await saturate(blind)
    expect(result.ok).toBe(false)
    expect(result.baseline.outcome).toBe('failed')
    expect(result.baseline.reason).toBe('pool_status_invalid')
  })

  it('refuses a script and a seed together, and neither', async () => {
    const pool = createFakePool()
    const script = generateEnsembleSaturationScript({ seed: 7 })
    await expect(saturate(pool, { script, seed: 7 })).rejects.toThrow(/script.*seed|seed.*script/)
    const { threadId: _dropped, ...noThread } = script
    await expect(runEnsemblePoolSaturation({ api: pool, script: noThread })).rejects.toThrow(
      /threadId/
    )
    await expect(
      runEnsemblePoolSaturation({ api: pool, seed: undefined as unknown as number })
    ).rejects.toThrow(/seed/)
  })
})

describe('ensemble saturation dry-run', () => {
  it('exercises the scripted scenario with zero production effects', async () => {
    const result = await runDryRun()
    expect(result.ok).toBe(true)
    expect(result.diagnosticOnly).toBe(true)
    expect(result.saturationObserved).toBe(true)
    expect(result.fills).toHaveLength(30)
  })
})
