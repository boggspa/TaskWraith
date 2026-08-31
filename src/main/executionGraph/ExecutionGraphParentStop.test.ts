import { describe, expect, it, vi } from 'vitest'
import { stopParentRunAndOwnedExecutions } from './ExecutionGraphParentStop'

describe('ExecutionGraphParentStop', () => {
  it('cancels owned graphs before the explicit parent transport stop', async () => {
    const order: string[] = []
    const result = await stopParentRunAndOwnedExecutions(
      { parentRunId: 'parent-run', parentThreadId: 'parent-chat' },
      {
        claimParentCancellation: () => {
          order.push('claim')
          return true
        },
        cancelParentPrompts: () => order.push('prompts'),
        coordinator: {
          listExecutions: () => [
            {
              executionId: 'graph-one',
              state: 'running',
              owner: { threadId: 'parent-chat', initiatingRunId: 'parent-run' }
            }
          ],
          cancelExecution: async () => {
            order.push('graph')
          }
        },
        cancelParentTransport: async () => {
          order.push('parent')
          return true
        }
      }
    )

    expect(order).toEqual(['claim', 'prompts', 'graph', 'parent'])
    expect(result).toMatchObject({ accepted: true, parentCancelled: true })
  })

  it('still stops the parent when one graph cleanup needs operator attention', async () => {
    const cancelParentTransport = vi.fn(async () => true)
    const result = await stopParentRunAndOwnedExecutions(
      { parentRunId: 'parent-run', parentThreadId: 'parent-chat' },
      {
        claimParentCancellation: () => true,
        cancelParentPrompts: () => {},
        coordinator: {
          listExecutions: () => [
            {
              executionId: 'graph-one',
              state: 'running',
              owner: { threadId: 'parent-chat', initiatingRunId: 'parent-run' }
            }
          ],
          cancelExecution: async () => {
            throw new Error('cleanup not confirmed')
          }
        },
        cancelParentTransport
      }
    )

    expect(cancelParentTransport).toHaveBeenCalledOnce()
    expect(result.graphCancellation?.failures).toEqual([
      { executionId: 'graph-one', message: 'cleanup not confirmed' }
    ])
  })

  it('does nothing when the exact parent terminal intent cannot be fenced', async () => {
    const cancelParentTransport = vi.fn(async () => true)
    const result = await stopParentRunAndOwnedExecutions(
      { parentRunId: 'parent-run', parentThreadId: 'parent-chat' },
      {
        claimParentCancellation: () => false,
        cancelParentPrompts: () => {},
        cancelParentTransport
      }
    )
    expect(result).toEqual({ accepted: false, parentCancelled: false })
    expect(cancelParentTransport).not.toHaveBeenCalled()
  })
})
