import { describe, expect, it, vi } from 'vitest'

import { collectCodexUserInput, type CodexUserInputBridgeCallbacks } from './CodexUserInputBridge'
import type { RemoteQuestionRecord, RemoteQuestionResolution } from '../RemoteQuestionRegistry'

function record(question: string, questionId: string): RemoteQuestionRecord {
  return {
    questionId,
    promptId: questionId,
    question,
    createdAt: new Date(0).toISOString(),
    status: 'pending'
  }
}

describe('CodexUserInputBridge', () => {
  it('collects multiple host questions sequentially and preserves ids', async () => {
    const resolvers: Array<(result: RemoteQuestionResolution) => void> = []
    const emitted: RemoteQuestionRecord[] = []
    const callbacks: CodexUserInputBridgeCallbacks = {
      registerQuestion: (question, resolve, _ttlMs, index) => {
        resolvers.push(resolve)
        return record(question.question, `registry-${index}`)
      },
      emitQuestion: (question) => emitted.push(question),
      now: () => 1_000
    }

    const pending = collectCodexUserInput(
      {
        questions: [
          { id: 'first', question: 'First?' },
          { id: 'second', question: 'Second?' }
        ]
      },
      callbacks
    )
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    expect(emitted).toHaveLength(1)
    resolvers[0]({ answer: 'one', is_custom: false })
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    expect(emitted).toHaveLength(2)
    resolvers[1]({ answer: 'two', is_custom: true })

    await expect(pending).resolves.toEqual({
      ok: true,
      response: { answers: { first: 'one', second: 'two' } }
    })
  })

  it('passes one overall timeout down to each sequential card', async () => {
    const ttls: Array<number | undefined> = []
    let resolveQuestion: ((result: RemoteQuestionResolution) => void) | undefined
    let nowMs = 1_000
    const callbacks: CodexUserInputBridgeCallbacks = {
      registerQuestion: (question, resolve, ttlMs, index) => {
        ttls.push(ttlMs)
        resolveQuestion = resolve
        return record(question.question, `registry-${index}`)
      },
      emitQuestion: vi.fn(),
      now: () => nowMs
    }

    const pending = collectCodexUserInput(
      { timeoutMs: 500, questions: [{ id: 'first', question: 'First?' }] },
      callbacks
    )
    await vi.waitFor(() => expect(resolveQuestion).toBeTypeOf('function'))
    expect(ttls).toEqual([500])
    nowMs = 1_501
    resolveQuestion?.({
      answer: '',
      is_custom: false,
      cancelled: true,
      cancellation_reason: 'timeout'
    })
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('does not register malformed host requests', async () => {
    const registerQuestion = vi.fn()
    const pending = collectCodexUserInput(
      {
        questions: [
          { id: 'duplicate', question: 'One' },
          { id: 'duplicate', question: 'Two' }
        ]
      },
      {
        registerQuestion,
        emitQuestion: vi.fn()
      }
    )
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('duplicated')
    })
    expect(registerQuestion).not.toHaveBeenCalled()
  })
})
