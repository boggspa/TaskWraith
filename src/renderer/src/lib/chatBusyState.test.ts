import { describe, expect, it } from 'vitest'
import { isChatBusyForDispatch } from './chatBusyState'

describe('isChatBusyForDispatch', () => {
  it('reports busy when the chat has an active run context', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [{ chatId: 'chat-1' }],
        runQueueJobs: []
      })
    ).toBe(true)
  })

  it('reports busy when another active queue job targets the chat', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [{ runId: 'run-2', chatId: 'chat-1', status: 'starting' }]
      })
    ).toBe(true)
  })

  it('ignores the current run queue job while dispatching a leased steer replacement', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [{ runId: 'run-1', chatId: 'chat-1', status: 'starting' }],
        ignoreQueueRunId: 'run-1'
      })
    ).toBe(false)
  })

  it('does not ignore a different active queue job for the same chat', () => {
    expect(
      isChatBusyForDispatch({
        chatId: 'chat-1',
        activeRuns: [],
        runQueueJobs: [
          { runId: 'run-1', chatId: 'chat-1', status: 'starting' },
          { runId: 'run-2', chatId: 'chat-1', status: 'active' }
        ],
        ignoreQueueRunId: 'run-1'
      })
    ).toBe(true)
  })
})
