import { describe, expect, it } from 'vitest'
import { decideExecutionGraphTerminalJoinWatchdog } from './ExecutionGraphTerminalJoinWatchdog'

describe('decideExecutionGraphTerminalJoinWatchdog', () => {
  it('does not start the containment clock merely because confirmation is required', () => {
    expect(
      decideExecutionGraphTerminalJoinWatchdog({
        active: true,
        nowMs: 60_000,
        state: { required: true, requiredAt: 0, conflict: false },
        timeoutMs: 15_000,
        pollMs: 1_000
      })
    ).toEqual({ kind: 'wait', delayMs: 1_000 })
  })

  it('waits only for the remaining bounded window after the first signal', () => {
    expect(
      decideExecutionGraphTerminalJoinWatchdog({
        active: true,
        nowMs: 24_500,
        state: {
          required: true,
          firstSignalAt: 10_000,
          lifecycleStatus: 'completed',
          conflict: false
        },
        timeoutMs: 15_000,
        pollMs: 1_000
      })
    ).toEqual({ kind: 'wait', delayMs: 500 })
  })

  it('contains a missing join side after the bounded window', () => {
    const decision = decideExecutionGraphTerminalJoinWatchdog({
      active: true,
      nowMs: 25_000,
      state: {
        required: true,
        firstSignalAt: 10_000,
        providerStatus: 'failed',
        conflict: false
      },
      timeoutMs: 15_000
    })

    expect(decision.kind).toBe('contain')
    expect(decision).toMatchObject({
      reason: expect.stringContaining('lifecycle=missing, provider=failed')
    })
  })

  it('reports conflicting immutable terminal evidence explicitly', () => {
    const decision = decideExecutionGraphTerminalJoinWatchdog({
      active: true,
      nowMs: 25_001,
      state: {
        required: true,
        firstSignalAt: 10_000,
        lifecycleStatus: 'failed',
        providerStatus: 'completed',
        conflict: true
      },
      timeoutMs: 15_000
    })

    expect(decision.kind).toBe('contain')
    expect(decision).toMatchObject({
      reason: expect.stringContaining('signals conflicted')
    })
  })

  it('stops once the session is inactive or no longer requires the join', () => {
    expect(
      decideExecutionGraphTerminalJoinWatchdog({
        active: false,
        nowMs: 0,
        state: { required: true, conflict: false }
      })
    ).toEqual({ kind: 'stop' })
    expect(
      decideExecutionGraphTerminalJoinWatchdog({
        active: true,
        nowMs: 0,
        state: { required: false, conflict: false }
      })
    ).toEqual({ kind: 'stop' })
  })
})
