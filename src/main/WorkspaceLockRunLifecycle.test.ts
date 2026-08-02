import { describe, expect, it, vi } from 'vitest'

import { WorkspaceLockRunLifecycleTracker } from './WorkspaceLockRunLifecycle'

async function flushPromises(): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await Promise.resolve()
  }
}

describe('WorkspaceLockRunLifecycleTracker', () => {
  it('releases a terminal run exactly once when no operation is active', async () => {
    const releaseRun = vi.fn(async () => undefined)
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun,
      onReleaseFailure: vi.fn(),
      onFailClosed: vi.fn()
    })

    tracker.terminal('run-1')
    tracker.terminal('run-1')
    await flushPromises()

    expect(releaseRun).toHaveBeenCalledTimes(1)
    expect(releaseRun).toHaveBeenCalledWith('run-1')
    expect(tracker.snapshot('run-1')?.releaseState).toBe('released')
  })

  it('defers terminal release until every active operation finishes', async () => {
    const releaseRun = vi.fn(async () => undefined)
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun,
      onReleaseFailure: vi.fn(),
      onFailClosed: vi.fn()
    })
    const first = tracker.begin('run-2')
    const second = tracker.begin('run-2')

    tracker.terminal('run-2')
    first.finish()
    await flushPromises()
    expect(releaseRun).not.toHaveBeenCalled()

    second.finish()
    second.finish()
    await flushPromises()
    expect(releaseRun).toHaveBeenCalledTimes(1)
  })

  it('finishes a wrapped operation even when the executor rejects', async () => {
    const releaseRun = vi.fn(async () => undefined)
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun,
      onReleaseFailure: vi.fn(),
      onFailClosed: vi.fn()
    })
    const operation = tracker.run('run-3', async () => {
      tracker.terminal('run-3')
      throw new Error('executor failed')
    })

    await expect(operation).rejects.toThrow('executor failed')
    await flushPromises()
    expect(releaseRun).toHaveBeenCalledTimes(1)
  })

  it('reports release failure without retrying or pretending the run released', async () => {
    const error = new Error('authority unavailable')
    const onReleaseFailure = vi.fn()
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun: vi.fn(async () => {
        throw error
      }),
      onReleaseFailure,
      onFailClosed: vi.fn()
    })

    tracker.terminal('run-4')
    await flushPromises()
    tracker.terminal('run-4')
    await flushPromises()

    expect(onReleaseFailure).toHaveBeenCalledWith({
      runId: 'run-4',
      error
    })
    expect(tracker.snapshot('run-4')?.releaseState).toBe('failed')
  })

  it('captures a synchronous release callback failure', async () => {
    const error = new Error('runtime missing')
    const onReleaseFailure = vi.fn()
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun: () => {
        throw error
      },
      onReleaseFailure,
      onFailClosed: vi.fn()
    })

    tracker.terminal('run-sync-failure')
    await flushPromises()

    expect(onReleaseFailure).toHaveBeenCalledWith({
      runId: 'run-sync-failure',
      error
    })
    expect(tracker.snapshot('run-sync-failure')?.releaseState).toBe('failed')
  })

  it('retains the lease and fails closed when an operation remains unresolved', async () => {
    let timeoutCallback: (() => void) | undefined
    let now = 100
    const releaseRun = vi.fn(async () => undefined)
    const onFailClosed = vi.fn()
    const setTimer = vi.fn((callback: () => void) => {
      timeoutCallback = callback
      return 1
    })
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun,
      onReleaseFailure: vi.fn(),
      onFailClosed,
      unresolvedOperationTimeoutMs: 50,
      now: () => now,
      setTimer,
      clearTimer: vi.fn()
    })
    const operation = tracker.begin('run-5')
    expect(setTimer).not.toHaveBeenCalled()
    tracker.terminal('run-5')
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 50)

    now = 151
    timeoutCallback?.()
    timeoutCallback?.()
    await flushPromises()

    expect(onFailClosed).toHaveBeenCalledTimes(1)
    expect(onFailClosed).toHaveBeenCalledWith({
      kind: 'unresolved-operation',
      runId: 'run-5',
      operationId: operation.operationId,
      startedAt: 100,
      observedAt: 151
    })
    expect(releaseRun).not.toHaveBeenCalled()
    expect(tracker.snapshot('run-5')?.operations[0]?.unresolved).toBe(true)

    operation.finish()
    await flushPromises()
    expect(releaseRun).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a mutation tries to start after terminal transition', () => {
    const onFailClosed = vi.fn()
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun: vi.fn(() => new Promise<void>(() => undefined)),
      onReleaseFailure: vi.fn(),
      onFailClosed
    })
    tracker.terminal('run-6')

    expect(() => tracker.begin('run-6')).toThrow('cannot begin after')
    expect(onFailClosed).toHaveBeenCalledWith({
      kind: 'operation-after-terminal',
      runId: 'run-6'
    })
  })

  it('cancels unresolved-operation timers after authority-confirmed external release', () => {
    const onReleased = vi.fn()
    const onFailClosed = vi.fn()
    const clearTimer = vi.fn()
    const tracker = new WorkspaceLockRunLifecycleTracker({
      releaseRun: vi.fn(async () => undefined),
      onReleased,
      onReleaseFailure: vi.fn(),
      onFailClosed,
      unresolvedOperationTimeoutMs: 50,
      setTimer: vi.fn(() => 17),
      clearTimer
    })
    const operation = tracker.begin('run-recovered')
    tracker.terminal('run-recovered')

    tracker.reconcileExternallyReleasedRun('run-recovered')

    expect(clearTimer).toHaveBeenCalledWith(17)
    expect(onReleased).toHaveBeenCalledWith('run-recovered')
    expect(onFailClosed).not.toHaveBeenCalled()
    expect(tracker.snapshot('run-recovered')).toMatchObject({
      terminalRequested: true,
      releaseState: 'released',
      operations: []
    })
    operation.finish()
    expect(onReleased).toHaveBeenCalledTimes(1)
  })
})
