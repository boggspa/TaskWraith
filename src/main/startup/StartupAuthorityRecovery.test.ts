import { describe, expect, it, vi } from 'vitest'

import {
  classifyStartupAuthorityFailure,
  describeStartupAuthorityState,
  StartupAuthorityRecoverySupervisor,
  type StartupAuthorityRecoveryState
} from './StartupAuthorityRecovery'

/** Deterministic clock + scheduler so bounded backoff can be asserted exactly. */
function fakeScheduler() {
  let now = 1_000
  const pending: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    schedule: (run: () => void, delayMs: number) => {
      const entry = { at: now + delayMs, run, cancelled: false }
      pending.push(entry)
      return {
        cancel: () => {
          entry.cancelled = true
        }
      }
    },
    delays: () => pending.filter((entry) => !entry.cancelled).map((entry) => entry.at - now),
    async advance(): Promise<boolean> {
      const next = pending.find((entry) => !entry.cancelled && entry.at >= now)
      if (!next) return false
      next.cancelled = true
      now = next.at
      next.run()
      // The attempt chain is async IIFE -> await open -> .finally -> .then,
      // so a fixed handful of microtask turns is not enough to settle it.
      for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()
      return true
    }
  }
}

describe('classifyStartupAuthorityFailure', () => {
  it('separates transient contention from history corruption and filesystem faults', () => {
    const busy = new Error('Another TaskWraith instance is committing a workspace-lock transition.')
    busy.name = 'WorkspaceLockAuthorityBusyError'
    expect(classifyStartupAuthorityFailure(busy)).toMatchObject({
      failureClass: 'authority_busy',
      retryable: true
    })
    expect(
      classifyStartupAuthorityFailure(
        new Error('Workspace-lock WAL changed identity or revision while opening for append.')
      )
    ).toMatchObject({ failureClass: 'wal_identity_conflict', retryable: true })
    expect(
      classifyStartupAuthorityFailure(
        new Error('Workspace-lock WAL byte fence changed (expected 10, observed 12).')
      )
    ).toMatchObject({ failureClass: 'wal_identity_conflict', retryable: true })
    expect(
      classifyStartupAuthorityFailure(
        new Error('Workspace-lock generation changed repeatedly during startup.')
      )
    ).toMatchObject({ failureClass: 'wal_identity_conflict', retryable: true })

    expect(
      classifyStartupAuthorityFailure(
        new Error('Workspace-lock WAL is corrupt at line 5: digest mismatch')
      )
    ).toMatchObject({ failureClass: 'wal_corrupt', retryable: false })
    expect(
      classifyStartupAuthorityFailure(new Error('Workspace-lock checkpoint digest mismatch.'))
    ).toMatchObject({ failureClass: 'wal_corrupt', retryable: false })
    expect(
      classifyStartupAuthorityFailure(new Error("EACCES: permission denied, mkdir '/x'"))
    ).toMatchObject({ failureClass: 'authority_root_unavailable', retryable: false })
    expect(classifyStartupAuthorityFailure(new Error('something else'))).toMatchObject({
      failureClass: 'unknown',
      retryable: false
    })
  })
})

describe('StartupAuthorityRecoverySupervisor', () => {
  it('reports available on a clean boot and schedules nothing', async () => {
    const clock = fakeScheduler()
    const states: StartupAuthorityRecoveryState[] = []
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {},
      now: clock.now,
      schedule: clock.schedule,
      onStateChange: (state) => states.push(state)
    })
    expect(await supervisor.runInitialAttempt()).toMatchObject({
      status: 'available',
      failure: null,
      attempts: 1,
      recoveredAfterRetry: false,
      bootRecoveryIncomplete: false
    })
    supervisor.startAutomaticRetries()
    expect(clock.delays()).toEqual([])
    expect(describeStartupAuthorityState(supervisor.state())).toBeNull()
    supervisor.dispose()
  })

  it('keeps mutation fail-closed and surfaces a degraded state on transient contention', async () => {
    const clock = fakeScheduler()
    const busy = new Error('Another TaskWraith instance is committing a workspace-lock transition.')
    busy.name = 'WorkspaceLockAuthorityBusyError'
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {
        throw busy
      },
      now: clock.now,
      schedule: clock.schedule
    })
    const state = await supervisor.runInitialAttempt()
    expect(state).toMatchObject({
      status: 'degraded',
      attempts: 1,
      failure: { failureClass: 'authority_busy', retryable: true }
    })
    // The message a person reads must say what is unavailable, not just "error".
    expect(describeStartupAuthorityState(state)).toMatch(
      /Workspace edits, run recovery and scheduling stay disabled/
    )
    supervisor.dispose()
  })

  it('retries a transient failure with bounded exponential backoff and then stops', async () => {
    const clock = fakeScheduler()
    const open = vi.fn(async () => {
      throw new Error('Workspace-lock WAL changed identity or revision while opening for append.')
    })
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open,
      now: clock.now,
      schedule: clock.schedule,
      maxAutomaticAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 250
    })
    await supervisor.runInitialAttempt()
    supervisor.startAutomaticRetries()

    expect(clock.delays()).toEqual([100])
    expect(await clock.advance()).toBe(true)
    expect(clock.delays()).toEqual([200])
    expect(await clock.advance()).toBe(true)
    expect(clock.delays()).toEqual([250]) // capped
    expect(await clock.advance()).toBe(true)

    // Budget exhausted: no further automatic attempt is scheduled, and the state
    // says so instead of spinning.
    expect(clock.delays()).toEqual([])
    expect(supervisor.state()).toMatchObject({ status: 'degraded', nextRetryAtMs: null })
    expect(open).toHaveBeenCalledTimes(4)
    supervisor.dispose()
  })

  it('never schedules an automatic retry for a permanent failure', async () => {
    const clock = fakeScheduler()
    const open = vi.fn(async () => {
      throw new Error('Workspace-lock WAL is corrupt at line 12: digest mismatch')
    })
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open,
      now: clock.now,
      schedule: clock.schedule
    })
    await supervisor.runInitialAttempt()
    supervisor.startAutomaticRetries()
    expect(clock.delays()).toEqual([])
    expect(supervisor.state()).toMatchObject({
      status: 'permanently_failed',
      failure: { failureClass: 'wal_corrupt', retryable: false }
    })
    expect(describeStartupAuthorityState(supervisor.state())).toMatch(/will not recover on its own/)
    expect(open).toHaveBeenCalledTimes(1)
    supervisor.dispose()
  })

  it('runs deferred recovery when a retry succeeds and nothing has started since boot', async () => {
    const clock = fakeScheduler()
    let attempts = 0
    const onRecovered = vi.fn()
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {
        attempts += 1
        if (attempts === 1)
          throw new Error('Workspace-lock WAL byte fence changed (expected 1, observed 2).')
      },
      now: clock.now,
      schedule: clock.schedule,
      baseDelayMs: 50,
      canRunBootOnlyRecovery: () => true,
      onRecovered
    })
    await supervisor.runInitialAttempt()
    supervisor.startAutomaticRetries()
    expect(await clock.advance()).toBe(true)

    expect(onRecovered).toHaveBeenCalledWith({ canRunBootOnlyRecovery: true })
    expect(supervisor.state()).toMatchObject({
      status: 'available',
      recoveredAfterRetry: true,
      bootRecoveryIncomplete: false
    })
    expect(describeStartupAuthorityState(supervisor.state())).toBeNull()
    supervisor.dispose()
  })

  it('restores authority but asks for a restart when boot-only recovery is no longer safe', async () => {
    const clock = fakeScheduler()
    let attempts = 0
    const onRecovered = vi.fn()
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {
        attempts += 1
        if (attempts === 1)
          throw new Error('Workspace-lock WAL byte fence changed (expected 1, observed 2).')
      },
      now: clock.now,
      schedule: clock.schedule,
      // A run started while the authority was down, so re-running run-queue
      // recovery would settle a live run as interrupted.
      canRunBootOnlyRecovery: () => false,
      onRecovered
    })
    await supervisor.runInitialAttempt()
    const state = await supervisor.retryNow()

    expect(onRecovered).toHaveBeenCalledWith({ canRunBootOnlyRecovery: false })
    expect(state).toMatchObject({
      status: 'available',
      recoveredAfterRetry: true,
      bootRecoveryIncomplete: true
    })
    expect(describeStartupAuthorityState(state)).toMatch(/Restart TaskWraith to finish recovering/)
    supervisor.dispose()
  })

  it('treats a failing deferred recovery as incomplete rather than as a healthy boot', async () => {
    const clock = fakeScheduler()
    let attempts = 0
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {
        attempts += 1
        if (attempts === 1)
          throw new Error('Workspace-lock WAL byte fence changed (expected 1, observed 2).')
      },
      now: clock.now,
      schedule: clock.schedule,
      canRunBootOnlyRecovery: () => true,
      onRecovered: async () => {
        throw new Error('queue recovery blew up')
      }
    })
    await supervisor.runInitialAttempt()
    const state = await supervisor.retryNow()
    expect(state).toMatchObject({ status: 'available', bootRecoveryIncomplete: true })
    supervisor.dispose()
  })

  it('coalesces a concurrent explicit retry into the attempt already in flight', async () => {
    const clock = fakeScheduler()
    const gate: { resolve: (() => void) | null } = { resolve: null }
    const open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          gate.resolve = resolve
        })
    )
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open,
      now: clock.now,
      schedule: clock.schedule
    })
    const first = supervisor.retryNow()
    const second = supervisor.retryNow()
    gate.resolve?.()
    await Promise.all([first, second])
    expect(open).toHaveBeenCalledTimes(1)
    supervisor.dispose()
  })

  it('stops scheduling once disposed', async () => {
    const clock = fakeScheduler()
    const supervisor = new StartupAuthorityRecoverySupervisor({
      open: async () => {
        throw new Error('Another TaskWraith instance is committing a workspace-lock transition.')
      },
      now: clock.now,
      schedule: clock.schedule,
      baseDelayMs: 10
    })
    await supervisor.runInitialAttempt()
    supervisor.dispose()
    supervisor.startAutomaticRetries()
    expect(clock.delays()).toEqual([])
  })
})
