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
  it('hands the answers back only once what recorded them is on the disk', async () => {
    let release!: () => void
    const answered = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const callbacks: CodexUserInputBridgeCallbacks = {
      registerQuestion: (question, resolve, _ttlMs, index) => {
        resolve({ answer: 'yes', is_custom: false })
        return record(question.question, `registry-${index}`)
      },
      emitQuestion: () => {},
      answered,
      now: () => 1_000
    }
    let settled = false
    const pending = collectCodexUserInput(
      { questions: [{ id: 'only', question: 'Proceed?' }] },
      callbacks
    ).then((result) => {
      settled = true
      return result
    })

    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    release()
    await expect(pending).resolves.toEqual({ ok: true, response: { answers: { only: 'yes' } } })
  })

  it('waits for nothing more when an answer was cancelled', async () => {
    const answered = vi.fn(() => null)
    const callbacks: CodexUserInputBridgeCallbacks = {
      registerQuestion: (question, resolve, _ttlMs, index) => {
        resolve({ answer: '', is_custom: false, cancelled: true, cancellation_reason: 'dismissed' })
        return record(question.question, `registry-${index}`)
      },
      emitQuestion: () => {},
      answered
    }

    await expect(
      collectCodexUserInput({ questions: [{ id: 'only', question: 'Proceed?' }] }, callbacks)
    ).resolves.toEqual({ ok: false, reason: 'dismissed' })
    expect(answered).not.toHaveBeenCalled()
  })

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
