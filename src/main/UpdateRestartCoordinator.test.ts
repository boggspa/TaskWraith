import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateRestartCoordinator } from './UpdateRestartCoordinator'

function createUpdateService(status: 'available' | 'downloading' | 'downloaded' = 'downloaded') {
  return {
    snapshot: vi.fn(() => ({ status })),
    setRestartPending: vi.fn(),
    quitAndInstall: vi.fn(() => true)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateRestartCoordinator', () => {
  it('restarts immediately after a user-requested download when no work is live', () => {
    const updateService = createUpdateService()
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      hasActiveWork: () => false
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(true)
    expect(updateService.setRestartPending).toHaveBeenNthCalledWith(1, true)
    expect(updateService.setRestartPending).toHaveBeenNthCalledWith(2, false)
    expect(updateService.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('waits for live work to settle, then restarts without another user action', () => {
    vi.useFakeTimers()
    const updateService = createUpdateService()
    let activeWork = true
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      hasActiveWork: () => activeWork,
      retryIntervalMs: 10
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).toHaveBeenCalledWith(true)
    expect(updateService.quitAndInstall).not.toHaveBeenCalled()

    activeWork = false
    vi.advanceTimersByTime(10)

    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(false)
    expect(updateService.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('does nothing until an update has finished downloading', () => {
    const updateService = createUpdateService('available')
    const coordinator = new UpdateRestartCoordinator({
      updateService,
      hasActiveWork: () => false
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
      hasActiveWork: () => false,
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
      hasActiveWork: () => false
    })

    expect(coordinator.requestRestartWhenIdle()).toBe(false)
    expect(updateService.setRestartPending).toHaveBeenLastCalledWith(false)
  })
})
