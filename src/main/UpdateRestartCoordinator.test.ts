import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATE_RESTART_DEFERRAL_TIMEOUT_MS,
  UpdateRestartCoordinator,
  type UpdateRestartBarrierResult
} from './UpdateRestartCoordinator'

function createUpdateService(status: 'available' | 'downloading' | 'downloaded' = 'downloaded') {
  return {
    snapshot: vi.fn(() => ({ status })),
    setRestartPending: vi.fn(),
    quitAndInstall: vi.fn(() => true)
  }
}

const ready: UpdateRestartBarrierResult = { ready: true }

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateRestartCoordinator', () => {
  it('restarts immediately after a user-requested download when no work is live', () => {
    const updateService = createUpdateService()
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(true)
    expect(updateService.setRestartPending).toHaveBeenCalledTimes(1)
    expect(updateService.setRestartPending).toHaveBeenCalledWith(false)
    expect(updateService.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('waits for live work, publishes why, then restarts without another user action', () => {
    vi.useFakeTimers()
    const updateService = createUpdateService()
    let reason: string | null = 'Waiting for 1 active agent run'
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => reason,
      retryIntervalMs: 10,
      now: () => 1_000
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(true, {
      reason: 'Waiting for 1 active agent run',
      since: new Date(1_000).toISOString(),
      expired: false
    })
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()

    reason = null
    vi.advanceTimersByTime(10)

    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(false)
    expect(updateService.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('stops waiting after the deferral timeout and reports the abandoned wait', () => {
    vi.useFakeTimers()
    const updateService = createUpdateService()
    let now = 5_000
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => 'Waiting for 2 active agent runs',
      retryIntervalMs: 10,
      deferralTimeoutMs: 100,
      now: () => now
    })

    coordinator.requestRestartWhenIdle()
    now += 50
    vi.advanceTimersByTime(10)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ expired: false })
    )

    now += 60
    vi.advanceTimersByTime(10)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(false, {
      reason: 'Waiting for 2 active agent runs',
      since: new Date(5_000).toISOString(),
      expired: true
    })
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()

    // The wait is over: later ticks do nothing until the user asks again.
    const publishes = updateService.setRestartPending.mock.calls.length
    now += 1_000
    vi.advanceTimersByTime(50)
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()
    expect(updateService.setRestartPending).toHaveBeenCalledTimes(publishes)
    expect(coordinator.tryRestart()).toBe(false)
  })

  it('defaults the deferral timeout to 30 minutes', () => {
    expect(UPDATE_RESTART_DEFERRAL_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('restarts immediately when forced and there is no Host barrier', () => {
    const updateService = createUpdateService()
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => 'Waiting for 1 active agent run'
    })

    expect(coordinator.requestRestartWhenIdle({ force: true })).toBe(true)
    expect(updateService.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('passes a forced restart through to the Host barrier past live work', async () => {
    const updateService = createUpdateService()
    const beforeRestart = vi.fn(async () => ready)
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => 'Waiting for 1 active agent run',
      beforeRestart
    })

    expect(coordinator.requestRestartWhenIdle({ force: true })).toBe(false)
    await vi.waitFor(() => expect(updateService.quitAndInstall).toHaveBeenCalledOnce())
    expect(beforeRestart).toHaveBeenCalledWith({ force: true })
  })

  it('does nothing until an update has finished downloading', () => {
    const updateService = createUpdateService('available')
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).not.toHaveBeenCalled()
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps the restart request armed while download completion is being published', () => {
    vi.useFakeTimers()
    let status: 'downloading' | 'downloaded' = 'downloading'
    const updateService = {
      snapshot: vi.fn(() => ({ status })),
      setRestartPending: vi.fn(),
      quitAndInstall: vi.fn(() => true)
    }
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null,
      retryIntervalMs: 10
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()

    status = 'downloaded'
    vi.advanceTimersByTime(10)

    expect(updateService.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does not report a restart when installer handoff is rejected', () => {
    const updateService = createUpdateService()
    updateService.quitAndInstall.mockReturnValue(false)
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(false)
  })

  it('awaits one async Host barrier before installer handoff and says so meanwhile', async () => {
    const updateService = createUpdateService()
    const beforeRestart = vi.fn(async () => ready)
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null,
      beforeRestart
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        reason: 'Preparing the TaskWraith Host for restart',
        expired: false
      })
    )
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(updateService.quitAndInstall).toHaveBeenCalledOnce())
    expect(beforeRestart).toHaveBeenCalledOnce()
    expect(beforeRestart).toHaveBeenCalledWith({ force: false })
  })

  it('keeps a failed Host barrier pending, surfaces its reason, and retries without overlapping it', async () => {
    vi.useFakeTimers()
    const updateService = createUpdateService()
    let releaseFirst!: (value: UpdateRestartBarrierResult) => void
    const beforeRestart = vi
      .fn<(request: { force: boolean }) => Promise<UpdateRestartBarrierResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<UpdateRestartBarrierResult>((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce(ready)
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null,
      beforeRestart,
      retryIntervalMs: 10
    })

    coordinator.requestRestartWhenIdle()
    await Promise.resolve()
    vi.advanceTimersByTime(30)
    expect(beforeRestart).toHaveBeenCalledOnce()
    releaseFirst({ ready: false, reason: '1 TaskWraith Host run still running' })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(updateService.setRestartPending).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: '1 TaskWraith Host run still running' })
    )
    expect(beforeRestart).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(updateService.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('reports a Host barrier that throws instead of waiting silently', async () => {
    vi.useFakeTimers()
    const updateService = createUpdateService()
    const beforeRestart = vi
      .fn<(request: { force: boolean }) => Promise<UpdateRestartBarrierResult>>()
      .mockRejectedValueOnce(new Error('broker closed'))
      .mockResolvedValue(ready)
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => null,
      beforeRestart,
      retryIntervalMs: 10
    })

    coordinator.requestRestartWhenIdle()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(updateService.setRestartPending).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: 'Host preparation failed: broker closed' })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(updateService.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not prepare the Host while work is active and ignores late completion after dispose', async () => {
    vi.useFakeTimers()
    let active = true
    let release!: (value: UpdateRestartBarrierResult) => void
    const beforeRestart = vi.fn(
      () =>
        new Promise<UpdateRestartBarrierResult>((resolve) => {
          release = resolve
        })
    )
    const updateService = createUpdateService()
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      activeWorkReason: () => (active ? 'Waiting for 1 active agent run' : null),
      beforeRestart,
      retryIntervalMs: 10
    })

    coordinator.requestRestartWhenIdle()
    expect(beforeRestart).not.toHaveBeenCalled()
    active = false
    vi.advanceTimersByTime(10)
    await Promise.resolve()
    expect(beforeRestart).toHaveBeenCalledOnce()
    coordinator.dispose()
    release(ready)
    await Promise.resolve()
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()
  })
})
