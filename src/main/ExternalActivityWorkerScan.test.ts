import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageRecord } from './store/types'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  setPriority: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/taskwraith-external-worker-test' },
  utilityProcess: { fork: mocks.fork }
}))

vi.mock('os', () => ({
  default: { homedir: () => '/tmp' },
  constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
  setPriority: mocks.setPriority
}))

import { createExternalActivityWorkerDriver } from './ExternalActivityWorkerScan'

class FakeUtilityProcess extends EventEmitter {
  pid = 4242
  kill = vi.fn()
  postMessage = vi.fn()
}

function usageRecord(): UsageRecord {
  return {
    id: 'external-test',
    provider: 'codex',
    workspaceId: 'external',
    chatId: 'external-codex',
    runId: 'external-codex',
    usageKind: 'run',
    model: 'gpt-5.6',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 0,
    timestamp: Date.now()
  }
}

describe('ExternalActivityWorkerScan', () => {
  beforeEach(() => {
    mocks.fork.mockReset()
    mocks.setPriority.mockReset()
  })

  it('deprioritizes the utility process before starting its scan', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    const driver = createExternalActivityWorkerDriver('/worker.js')
    const records = [usageRecord()]

    const result = driver({ options: {}, partialLookbackDays: null }, vi.fn())

    expect(mocks.fork).toHaveBeenCalledWith('/worker.js', [], {
      serviceName: 'taskwraith-external-activity-scan',
      execArgv: ['--max-old-space-size=256']
    })
    expect(mocks.setPriority).toHaveBeenCalledWith(4242, 10)
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'scan',
      request: expect.objectContaining({ partialLookbackDays: null })
    })
    child.emit('message', { type: 'complete', records })
    await expect(result).resolves.toEqual(records)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('keeps scanning when the host rejects the best-effort priority change', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    mocks.setPriority.mockImplementation(() => {
      throw new Error('not permitted')
    })
    const driver = createExternalActivityWorkerDriver('/worker.js')

    const result = driver({ options: {}, partialLookbackDays: null }, vi.fn())
    child.emit('message', { type: 'complete', records: [] })

    await expect(result).resolves.toEqual([])
  })
})
