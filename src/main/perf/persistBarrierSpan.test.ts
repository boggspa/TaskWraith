import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from './WorkSpanRecorder'
import { observePersistBarrierSpan } from './persistBarrierSpan'

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

describe('observePersistBarrierSpan', () => {
  it('records persist_barrier/barrier on the same promise instance', async () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(5_000, 25)
    })
    const inner = Promise.resolve('ok')
    const clock = tickingClock(5_000, 25)
    const observed = observePersistBarrierSpan(
      recorder,
      { chatId: ' chat-barrier ', reason: 'barrier' },
      () => inner,
      clock
    )
    expect(observed).toBe(inner)
    await expect(observed).resolves.toBe('ok')
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'persist_barrier',
        reason: 'barrier',
        chatId: 'chat-barrier',
        resource: 'host_chain',
        startedAt: 5_000,
        durationMs: 25,
        runId: ''
      })
    ])
  })

  it('records receipt_poll with the Host command id and keeps a rejection', async () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    const inner = Promise.reject(new Error('poll timeout'))
    const observed = observePersistBarrierSpan(
      recorder,
      { chatId: 'chat-poll', runId: ' cmd-9 ', reason: 'receipt_poll' },
      () => inner,
      tickingClock()
    )
    expect(observed).toBe(inner)
    await expect(observed).rejects.toThrow('poll timeout')
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'persist_barrier',
        reason: 'receipt_poll',
        chatId: 'chat-poll',
        runId: 'cmd-9',
        resource: 'host_chain',
        durationMs: 10
      })
    ])
  })

  it('gives each waiter its own span on one shared drain', async () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    let release: () => void = () => undefined
    const shared = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = observePersistBarrierSpan(
      recorder,
      { chatId: 'chat-join', reason: 'barrier' },
      () => shared,
      tickingClock(1_000, 5)
    )
    const second = observePersistBarrierSpan(
      recorder,
      { chatId: 'chat-join', reason: 'barrier' },
      () => shared,
      tickingClock(2_000, 5)
    )
    expect(second).toBe(first)
    expect(first).toBe(shared)
    release()
    await shared
    const spans = recorder.snapshot().spans
    expect(spans).toHaveLength(2)
    expect(
      spans.every((span) => span.kind === 'persist_barrier' && span.reason === 'barrier')
    ).toBe(true)
    expect(spans.map((span) => span.startedAt).sort((a, b) => a - b)).toEqual([1_000, 2_000])
  })

  it('runs the work without a sink, chatId, or reason and contains a throwing sink', async () => {
    const inner = Promise.resolve(1)
    expect(
      observePersistBarrierSpan(undefined, { chatId: 'chat-a', reason: 'barrier' }, () => inner)
    ).toBe(inner)
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(
      observePersistBarrierSpan(recorder, { chatId: '', reason: 'barrier' }, () => inner)
    ).toBe(inner)
    expect(
      observePersistBarrierSpan(
        recorder,
        { chatId: 'chat-a', reason: 'nope' as never },
        () => inner
      )
    ).toBe(inner)
    await inner
    expect(recorder.snapshot().spans).toEqual([])
    const throwing = Promise.resolve(3)
    expect(
      observePersistBarrierSpan(
        {
          record: () => {
            throw new Error('recorder must not break the barrier')
          }
        },
        { chatId: 'chat-a', reason: 'barrier' },
        () => throwing
      )
    ).toBe(throwing)
    await expect(throwing).resolves.toBe(3)
  })

  it('records a synchronous throw then rethrows', () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(() =>
      observePersistBarrierSpan(
        recorder,
        { chatId: 'chat-a', reason: 'barrier' },
        () => {
          throw new Error('materialize failed')
        },
        tickingClock()
      )
    ).toThrow('materialize failed')
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'persist_barrier',
        chatId: 'chat-a',
        reason: 'barrier',
        durationMs: 10
      })
    ])
  })
})
