import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  setPriority: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork }
}))

vi.mock('node:os', () => ({
  constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
  setPriority: mocks.setPriority
}))

import { createProjectReferenceOwnershipWorkerLoader } from './ProjectReferenceOwnershipWorkerScan'

class FakeUtilityProcess extends EventEmitter {
  pid = 4242
  kill = vi.fn()
  postMessage = vi.fn()
}

const reference = {
  sha256: 'a'.repeat(64),
  path: '/private/snapshots/' + 'a'.repeat(64) + '.snapshot',
  sizeBytes: 12,
  appChatId: 'chat-a',
  runId: 'run-a'
}

describe('ProjectReferenceOwnershipWorkerScan', () => {
  beforeEach(() => {
    mocks.fork.mockReset()
    mocks.setPriority.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs below normal priority and returns the validated projection', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    const load = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })

    const result = load()

    expect(mocks.fork).toHaveBeenCalledWith('/worker.js', [], {
      serviceName: 'taskwraith-project-reference-ownership-scan',
      execArgv: ['--max-old-space-size=256']
    })
    expect(mocks.setPriority).toHaveBeenCalledWith(4242, 10)
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'scan',
      request: { runEventsDirectory: '/private/run-events' }
    })
    child.emit('message', {
      type: 'complete',
      integrity: 'legacy-parse-only',
      references: [reference]
    })

    await expect(result).resolves.toEqual([reference])
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('rejects a malformed worker projection instead of reconciling it', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    const load = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })

    const result = load()
    child.emit('message', {
      type: 'complete',
      integrity: 'legacy-parse-only',
      references: [{ ...reference, sizeBytes: 0 }]
    })

    await expect(result).rejects.toThrow('invalid projection')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('continues when process priority cannot be lowered', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    mocks.setPriority.mockImplementation(() => {
      throw new Error('not permitted')
    })
    const load = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })

    const result = load()
    child.emit('message', {
      type: 'complete',
      integrity: 'legacy-parse-only',
      references: []
    })

    await expect(result).resolves.toEqual([])
  })

  it('rejects worker errors, early exits, and postMessage failures without fallback', async () => {
    const errored = new FakeUtilityProcess()
    mocks.fork.mockReturnValueOnce(errored)
    const loadErrored = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })
    const erroredResult = loadErrored()
    errored.emit('error', new Error('utility crashed'))
    await expect(erroredResult).rejects.toThrow('utility crashed')

    const exited = new FakeUtilityProcess()
    mocks.fork.mockReturnValueOnce(exited)
    const loadExited = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })
    const exitedResult = loadExited()
    exited.emit('exit', 9)
    await expect(exitedResult).rejects.toThrow('exited (code 9)')

    const postFailed = new FakeUtilityProcess()
    postFailed.postMessage.mockImplementation(() => {
      throw new Error('post failed')
    })
    mocks.fork.mockReturnValueOnce(postFailed)
    const loadPostFailed = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })
    await expect(loadPostFailed()).rejects.toThrow('post failed')
  })

  it('times out a worker that never produces a complete projection', async () => {
    vi.useFakeTimers()
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    const load = createProjectReferenceOwnershipWorkerLoader('/worker.js', {
      runEventsDirectory: '/private/run-events'
    })

    const result = expect(load()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    await result
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
