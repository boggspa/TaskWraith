import { describe, expect, it, vi } from 'vitest'
import {
  cancelExecutionGraphsInitiatedByParentRun,
  type ExecutionGraphParentCancellationCoordinator
} from './ExecutionGraphParentCancellation'

function coordinator(): ExecutionGraphParentCancellationCoordinator & {
  cancelExecution: ReturnType<typeof vi.fn>
} {
  return {
    listExecutions: () => [
      {
        executionId: 'execution-b',
        state: 'running',
        owner: { threadId: 'chat-one', initiatingRunId: 'parent-run', seatId: 'kimi:k3' }
      },
      {
        executionId: 'execution-a',
        state: 'requires_action',
        owner: { threadId: 'chat-one', initiatingRunId: 'parent-run', seatId: 'kimi:k3' }
      },
      {
        executionId: 'another-run',
        state: 'running',
        owner: { threadId: 'chat-one', initiatingRunId: 'other-run', seatId: 'kimi:k3' }
      },
      {
        executionId: 'another-thread',
        state: 'running',
        owner: { threadId: 'chat-two', initiatingRunId: 'parent-run', seatId: 'kimi:k3' }
      }
    ],
    cancelExecution: vi.fn(async () => undefined)
  }
}

describe('ExecutionGraphParentCancellation', () => {
  it('cancels every graph owned by the exact parent run before parent teardown', async () => {
    const subject = coordinator()
    const result = await cancelExecutionGraphsInitiatedByParentRun(
      {
        parentRunId: 'parent-run',
        parentThreadId: 'chat-one',
        reason: 'Parent cancelled by user.'
      },
      subject
    )

    expect(subject.cancelExecution.mock.calls).toEqual([
      ['execution-a', 'Parent cancelled by user.'],
      ['execution-b', 'Parent cancelled by user.']
    ])
    expect(result).toEqual({
      matchedExecutionIds: ['execution-a', 'execution-b'],
      cancelledExecutionIds: ['execution-a', 'execution-b'],
      failures: []
    })
  })

  it('attempts every owned graph and reports bounded cancellation failures', async () => {
    const subject = coordinator()
    subject.cancelExecution.mockImplementation(async (executionId: string) => {
      if (executionId === 'execution-a') throw new Error('provider cleanup failed')
    })

    const result = await cancelExecutionGraphsInitiatedByParentRun(
      { parentRunId: 'parent-run', parentThreadId: 'chat-one' },
      subject
    )

    expect(subject.cancelExecution).toHaveBeenCalledTimes(2)
    expect(result.cancelledExecutionIds).toEqual(['execution-b'])
    expect(result.failures).toEqual([
      { executionId: 'execution-a', message: 'provider cleanup failed' }
    ])
  })

  it('requires exact parent run and thread identities', async () => {
    const subject = coordinator()
    await expect(
      cancelExecutionGraphsInitiatedByParentRun(
        { parentRunId: ' ', parentThreadId: 'chat-one' },
        subject
      )
    ).rejects.toThrow(/parent run id is required/i)
    expect(subject.cancelExecution).not.toHaveBeenCalled()
  })
})
