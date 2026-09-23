import { describe, expect, it, vi } from 'vitest'
import {
  createResumeHostHealthCheck,
  type ResumeHostHealthCheckDeps,
  type ResumeHostProbeResult
} from './ResumeHostHealthCheck'

function makeCheck(overrides: { probe?: () => Promise<ResumeHostProbeResult> } = {}): {
  check: ReturnType<typeof createResumeHostHealthCheck>
  drop: ReturnType<typeof vi.fn>
  nudge: ReturnType<typeof vi.fn>
  lines: string[]
} {
  const drop = vi.fn()
  const nudge = vi.fn()
  const lines: string[] = []
  const deps: ResumeHostHealthCheckDeps = {
    probeHost: overrides.probe ?? (async () => ({ ok: true })),
    dropHostConnection: drop,
    nudgeCatalogueRecovery: nudge,
    probeTimeoutMs: 20,
    log: (line) => lines.push(line)
  }
  return { check: createResumeHostHealthCheck(deps), drop, nudge, lines }
}

describe('createResumeHostHealthCheck', () => {
  it('leaves a healthy connection alone', async () => {
    const { check, drop } = makeCheck()
    const outcome = await check('system resumed')
    expect(outcome.probe).toBe('ok')
    expect(outcome.droppedConnection).toBe(false)
    // Closing a healthy socket is the connection churn the broker explicitly
    // refuses to cause; this is the assertion that keeps us on that side.
    expect(drop).not.toHaveBeenCalled()
  })

  it('still re-enqueues recovery when the Host is reachable', async () => {
    // A socket that answers fine can sit behind a hold stranded before the
    // machine went away — the failure with no other escape inside ten minutes.
    const { check, nudge } = makeCheck()
    const outcome = await check('screen unlocked')
    expect(outcome.nudgedRecovery).toBe(true)
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('drops the connection when the probe reports failure', async () => {
    const { check, drop, nudge } = makeCheck({
      probe: async () => ({ ok: false, error: 'TaskWraith Host disconnected.' })
    })
    const outcome = await check('system resumed')
    expect(outcome.probe).toBe('failed')
    expect(outcome.droppedConnection).toBe(true)
    expect(outcome.detail).toBe('TaskWraith Host disconnected.')
    expect(drop).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('treats a probe that never answers as a dead Host, bounded by its own deadline', async () => {
    const { check, drop } = makeCheck({ probe: () => new Promise<ResumeHostProbeResult>(() => {}) })
    const outcome = await check('system resumed')
    expect(outcome.probe).toBe('timeout')
    expect(outcome.droppedConnection).toBe(true)
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('treats a rejecting probe as a dead Host rather than skipping the repair', async () => {
    const { check, drop, nudge } = makeCheck({
      probe: async () => {
        throw new Error('socket destroyed')
      }
    })
    const outcome = await check('system resumed')
    expect(outcome.probe).toBe('threw')
    expect(outcome.detail).toBe('socket destroyed')
    expect(drop).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('never rejects, so a powerMonitor handler cannot raise an unhandled rejection', async () => {
    const { check } = makeCheck({
      probe: async () => {
        throw new Error('boom')
      }
    })
    await expect(check('system resumed')).resolves.toMatchObject({ probe: 'threw' })
  })

  it('still re-enqueues recovery when dropping the connection throws', async () => {
    const nudge = vi.fn()
    const lines: string[] = []
    const check = createResumeHostHealthCheck({
      probeHost: async () => ({ ok: false, error: 'gone' }),
      dropHostConnection: () => {
        throw new Error('close failed')
      },
      nudgeCatalogueRecovery: nudge,
      probeTimeoutMs: 20,
      log: (line) => lines.push(line)
    })
    const outcome = await check('system resumed')
    expect(outcome.droppedConnection).toBe(false)
    expect(outcome.nudgedRecovery).toBe(true)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('could not drop the Host connection')
  })

  it('coalesces overlapping wake events onto one check', async () => {
    // macOS can deliver `resume` and `unlock-screen` milliseconds apart; two
    // concurrent probes would race to drop the same connection.
    let resolveProbe: ((result: ResumeHostProbeResult) => void) | null = null
    const probe = vi.fn(
      () =>
        new Promise<ResumeHostProbeResult>((resolve) => {
          resolveProbe = resolve
        })
    )
    const { check, drop } = makeCheck({ probe })
    const first = check('system resumed')
    const second = check('screen unlocked')
    expect(probe).toHaveBeenCalledTimes(1)
    resolveProbe!({ ok: false, error: 'gone' })
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.reason).toBe('system resumed')
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('runs again after the previous check settles', async () => {
    const probe = vi.fn(async () => ({ ok: true }))
    const { check } = makeCheck({ probe })
    await check('system resumed')
    await check('screen unlocked')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('logs one line naming the wake reason, reachable or not', async () => {
    const healthy = makeCheck()
    await healthy.check('system resumed')
    expect(healthy.lines).toEqual(['[resume-health] Host reachable after system resumed'])

    const broken = makeCheck({ probe: async () => ({ ok: false, error: 'gone' }) })
    await broken.check('screen unlocked')
    expect(broken.lines).toHaveLength(1)
    expect(broken.lines[0]).toContain('Host failed after screen unlocked')
    expect(broken.lines[0]).toContain('gone')
  })

  /**
   * D4: the Host resets every lease deadline once when it sees a suspend, but
   * main's own renew timer fires late after a wake. The check renews first, so
   * the lease lands inside the reset TTL; it never starts anything itself.
   */
  it("renews main's Host lease before it probes", async () => {
    const order: string[] = []
    const check = createResumeHostHealthCheck({
      renewLease: async () => {
        order.push('renew')
      },
      probeHost: async () => {
        order.push('probe')
        return { ok: true }
      },
      dropHostConnection: vi.fn(),
      nudgeCatalogueRecovery: () => order.push('nudge'),
      probeTimeoutMs: 20
    })
    const outcome = await check('system resumed')
    expect(order).toEqual(['renew', 'probe', 'nudge'])
    expect(outcome).toMatchObject({ renewedLease: true, probe: 'ok' })
  })

  it('still probes and nudges when the lease renewal throws or never answers', async () => {
    const lines: string[] = []
    const probe = vi.fn(async () => ({ ok: true }))
    const nudge = vi.fn()
    const failing = createResumeHostHealthCheck({
      renewLease: async () => {
        throw new Error('lease socket gone')
      },
      probeHost: probe,
      dropHostConnection: vi.fn(),
      nudgeCatalogueRecovery: nudge,
      probeTimeoutMs: 20,
      log: (line) => lines.push(line)
    })
    await expect(failing('system resumed')).resolves.toMatchObject({
      renewedLease: false,
      probe: 'ok'
    })
    expect(lines.join('\n')).toContain('could not renew the Host lease: lease socket gone')

    const hanging = createResumeHostHealthCheck({
      renewLease: () => new Promise<void>(() => {}),
      probeHost: probe,
      dropHostConnection: vi.fn(),
      nudgeCatalogueRecovery: nudge,
      probeTimeoutMs: 20
    })
    await expect(hanging('system resumed')).resolves.toMatchObject({ probe: 'ok' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(nudge).toHaveBeenCalledTimes(2)
  })

  it('reports no renewal when no lease is wired (the in-process Host)', async () => {
    const { check } = makeCheck()
    await expect(check('system resumed')).resolves.toMatchObject({ renewedLease: false })
  })
})
