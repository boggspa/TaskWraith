import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startAntigravityGeminiApiSeatSummary,
  type AntigravityGeminiApiSeatSummaryClient
} from './AntigravityGeminiApiSeatCompactionLifecycle'
import { MaintenanceCompactionRegistry } from '../services/MaintenanceCompactionRegistry'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function constructorFor(client: AntigravityGeminiApiSeatSummaryClient) {
  return class {
    readonly models = client.models

    constructor(options: { apiKey: string }) {
      void options
    }
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startAntigravityGeminiApiSeatSummary', () => {
  it('passes its exact AbortSignal to the request and exposes joined terminal evidence', async () => {
    const generateContentStream = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'hidden', thought: true }, { text: ' durable summary ' }]
              }
            }
          ]
        }
      }
    }))
    const operation = startAntigravityGeminiApiSeatSummary({
      GoogleGenAI: constructorFor({ models: { generateContentStream } }),
      apiKey: 'secret',
      model: 'gemini-2.5-flash',
      prompt: 'summarize',
      timeoutMs: 10_000
    })

    await expect(operation.result).resolves.toEqual({ ok: true, text: 'durable summary' })
    await expect(operation.terminal).resolves.toBeUndefined()
    expect(generateContentStream).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'summarize' }] }],
      config: { abortSignal: operation.signal }
    })
  })

  it('aborts on timeout, joins a pending iterator, and drops its post-timeout chunk', async () => {
    vi.useFakeTimers()
    const next = deferred<IteratorResult<unknown>>()
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }))
    const generateContentStream = vi.fn(async () => ({
      [Symbol.asyncIterator]() {
        return { next: () => next.promise, return: iteratorReturn }
      }
    }))
    const operation = startAntigravityGeminiApiSeatSummary({
      GoogleGenAI: constructorFor({ models: { generateContentStream } }),
      apiKey: 'secret',
      model: 'gemini-2.5-flash',
      prompt: 'summarize',
      timeoutMs: 2_000
    })
    let terminal = false
    void operation.terminal.then(() => {
      terminal = true
    })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(operation.signal.aborted).toBe(true)
    expect(terminal).toBe(false)

    next.resolve({ done: false, value: { text: 'must not survive timeout' } })
    await expect(operation.result).resolves.toEqual({
      ok: false,
      text: '',
      timedOut: true,
      error: 'Summarize turn timed out after 2s.'
    })
    await operation.terminal
    expect(iteratorReturn).toHaveBeenCalledTimes(1)
    expect(terminal).toBe(true)
  })

  it('joins a request promise that resolves after timeout without starting iteration', async () => {
    vi.useFakeTimers()
    const request = deferred<AsyncIterable<unknown>>()
    const next = vi.fn(async () => ({ done: true, value: undefined }))
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }))
    const operation = startAntigravityGeminiApiSeatSummary({
      GoogleGenAI: constructorFor({
        models: { generateContentStream: vi.fn(() => request.promise) }
      }),
      apiKey: 'secret',
      model: 'gemini-2.5-flash',
      prompt: 'summarize',
      timeoutMs: 1_000
    })
    let terminal = false
    void operation.terminal.then(() => {
      terminal = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(terminal).toBe(false)

    request.resolve({
      [Symbol.asyncIterator]() {
        return { next, return: iteratorReturn }
      }
    })
    await operation.terminal
    expect(next).not.toHaveBeenCalled()
    expect(iteratorReturn).toHaveBeenCalledTimes(1)
    await expect(operation.result).resolves.toMatchObject({ ok: false, timedOut: true })
  })

  it('bridges history-deletion cancellation and still waits for exact iterator cleanup', async () => {
    const cancellation = new AbortController()
    const next = deferred<IteratorResult<unknown>>()
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }))
    const operation = startAntigravityGeminiApiSeatSummary({
      GoogleGenAI: constructorFor({
        models: {
          generateContentStream: vi.fn(async () => ({
            [Symbol.asyncIterator]() {
              return { next: () => next.promise, return: iteratorReturn }
            }
          }))
        }
      }),
      apiKey: 'secret',
      model: 'gemini-2.5-flash',
      prompt: 'summarize',
      timeoutMs: 10_000,
      cancellationSignal: cancellation.signal
    })
    await flush()
    cancellation.abort('history-deletion')
    expect(operation.signal.aborted).toBe(true)

    next.resolve({ done: false, value: { text: 'late' } })
    await expect(operation.result).resolves.toEqual({
      ok: false,
      text: '',
      error: 'Compaction was cancelled for history deletion.'
    })
    expect(iteratorReturn).toHaveBeenCalledTimes(1)
  })

  it('keeps maintenance native activity live until the terminal operation joins', async () => {
    const registry = new MaintenanceCompactionRegistry()
    const reservation = registry.reserve({
      chatId: 'chat-ag',
      participantId: 'seat-ag',
      provider: 'antigravity'
    })
    expect(registry.beginNativeActivity(reservation)).toBe(true)
    const next = deferred<IteratorResult<unknown>>()
    const operation = startAntigravityGeminiApiSeatSummary({
      GoogleGenAI: constructorFor({
        models: {
          generateContentStream: vi.fn(async () => ({
            [Symbol.asyncIterator]() {
              return {
                next: () => next.promise,
                return: async () => ({ done: true, value: undefined })
              }
            }
          }))
        }
      }),
      apiKey: 'secret',
      model: 'gemini-2.5-flash',
      prompt: 'summarize',
      timeoutMs: 10_000,
      cancellationSignal: reservation.signal
    })
    void operation.terminal.then(() => {
      registry.endNativeActivity(reservation)
      registry.finish(reservation)
    })
    await flush()

    const hold = registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-ag'] })
    let joined = false
    const join = registry.cancelAndJoinHold(hold).then((value) => {
      joined = value
    })
    await flush()
    expect(joined).toBe(false)

    next.resolve({ done: true, value: undefined })
    await join
    expect(joined).toBe(true)
  })
})
