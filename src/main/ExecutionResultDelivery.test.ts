import { describe, expect, it, vi } from 'vitest'
import { deliverExecutionResult } from './ExecutionResultDelivery'
import { emptyExecutionResultMailbox, enqueueExecutionResultMailboxEvent } from './ExecutionResultMailbox'

function projection(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'ultratask-1',
    title: 'UltraTask · gemini-3.1-pro',
    state: 'succeeded',
    rootChatId: 'chat-one',
    owner: { threadId: 'chat-one', seatId: 'antigravity:gemini-3.1-pro' },
    topology: { steps: [{ id: 'ultratask-output', kind: 'output' }], edges: [] },
    activations: {
      'activation-output': { id: 'activation-output', stepId: 'ultratask-output' }
    },
    attempts: {
      'attempt-output': {
        id: 'attempt-output',
        activationId: 'activation-output',
        state: 'succeeded',
        result: { summary: 'The reviewed synthesis.' }
      }
    },
    ...overrides
  } as never
}

function deps(overrides: Record<string, unknown> = {}) {
  const store = { mailbox: emptyExecutionResultMailbox('chat-one') }
  return {
    enqueueResult: vi.fn((input) => {
      const outcome = enqueueExecutionResultMailboxEvent(store.mailbox, input)
      store.mailbox = outcome.mailbox
      return outcome
    }),
    hasDeliveredCard: vi.fn(() => false),
    appendResultCard: vi.fn(),
    requestOwnerWake: vi.fn(),
    isOwnerTurnActive: vi.fn(() => false),
    ...overrides
  }
}

describe('deliverExecutionResult', () => {
  it('delivers a succeeded graph to its owning thread exactly once', () => {
    const d = deps()
    const first = deliverExecutionResult(projection(), d as never)

    expect(first.delivered).toBe(true)
    expect(d.enqueueResult).toHaveBeenCalledTimes(1)
    expect(d.appendResultCard).toHaveBeenCalledTimes(1)
    expect(d.appendResultCard.mock.calls[0][0]).toMatchObject({
      threadId: 'chat-one',
      executionId: 'ultratask-1',
      outcome: 'succeeded'
    })

    // Re-entry (a restart replay, or a second terminal notice) must not append
    // a second card or a second durable record.
    const replayDeps = { ...d, hasDeliveredCard: vi.fn(() => true) }
    const second = deliverExecutionResult(projection(), replayDeps as never)
    expect(second.delivered).toBe(false)
    expect(second.reason).toMatch(/already delivered/i)
    expect(replayDeps.appendResultCard).toHaveBeenCalledTimes(1)
  })

  // The failure that started all of this: a graph that stops for a human owes
  // its owner an explanation, not silence.
  it('delivers a paused graph with the blocker as its content', () => {
    const d = deps()
    const result = deliverExecutionResult(
      projection({
        state: 'requires_action',
        activations: {
          'activation-scout': {
            id: 'activation-scout',
            stepId: 'ultratask-scout-1',
            state: 'requires_action',
            reason: 'Provider dispatch did not create a RunManager session.'
          }
        },
        attempts: {}
      }),
      d as never
    )

    expect(result.delivered).toBe(true)
    expect(d.appendResultCard.mock.calls[0][0]).toMatchObject({ outcome: 'requires_action' })
    expect(d.appendResultCard.mock.calls[0][0].content).toMatch(/did not create a RunManager/i)
  })

  it('delivers a failed graph rather than dropping it', () => {
    const d = deps()
    const result = deliverExecutionResult(
      projection({
        state: 'failed',
        activations: {
          'activation-scout': {
            id: 'activation-scout',
            stepId: 'ultratask-scout-1',
            state: 'failed',
            reason: 'Scout 1 exhausted its retries.'
          }
        },
        attempts: {}
      }),
      d as never
    )
    expect(result.delivered).toBe(true)
    expect(d.appendResultCard.mock.calls[0][0]).toMatchObject({ outcome: 'failed' })
  })

  it('does not deliver while the graph is still running', () => {
    const d = deps()
    const result = deliverExecutionResult(projection({ state: 'running' }), d as never)

    expect(result.delivered).toBe(false)
    expect(d.enqueueResult).not.toHaveBeenCalled()
    expect(d.appendResultCard).not.toHaveBeenCalled()
  })

  it('refuses to deliver an execution that names no owner', () => {
    const d = deps()
    const result = deliverExecutionResult(projection({ owner: undefined }), d as never)

    expect(result.delivered).toBe(false)
    expect(result.reason).toMatch(/no owning thread/i)
    expect(d.appendResultCard).not.toHaveBeenCalled()
  })

  // Turn ownership: if the seat is still holding its turn (via ensemble_await)
  // the poll delivers the result, so waking it would start a redundant turn.
  it('wakes the owning seat only when its turn has already ended', () => {
    const held = deps({ isOwnerTurnActive: vi.fn(() => true) })
    deliverExecutionResult(projection(), held as never)
    expect(held.requestOwnerWake).not.toHaveBeenCalled()

    const ended = deps({ isOwnerTurnActive: vi.fn(() => false) })
    deliverExecutionResult(projection(), ended as never)
    expect(ended.requestOwnerWake).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'chat-one', executionId: 'ultratask-1' })
    )
  })

  it('still delivers when the graph has no output-stage result to read', () => {
    const d = deps()
    const result = deliverExecutionResult(
      projection({ attempts: {}, activations: {} }),
      d as never
    )

    expect(result.delivered).toBe(true)
    expect(d.appendResultCard.mock.calls[0][0].content).toBeTruthy()
  })
})
