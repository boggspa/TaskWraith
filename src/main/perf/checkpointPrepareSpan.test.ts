import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from './WorkSpanRecorder'
import { recordCheckpointPrepareSpan } from './checkpointPrepareSpan'

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

describe('recordCheckpointPrepareSpan', () => {
  it('records checkpoint_prepare with publisher byte length', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(5_000, 25)
    })
    const result = recordCheckpointPrepareSpan(
      recorder,
      { chatId: ' chat-heavy ', runId: 'cmd-1' },
      () => ({ transferId: 't1', byteLength: 4096 }),
      (published) => published.byteLength,
      tickingClock(5_000, 25)
    )
    expect(result.byteLength).toBe(4096)
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'checkpoint_prepare',
        chatId: 'chat-heavy',
        runId: 'cmd-1',
        startedAt: 5_000,
        durationMs: 25,
        bytes: 4096
      })
    ])
  })

  it('runs the publisher without a sink or chatId and contains a throwing sink', () => {
    expect(recordCheckpointPrepareSpan(undefined, { chatId: 'chat-a' }, () => 1)).toBe(1)
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(recordCheckpointPrepareSpan(recorder, {}, () => 2)).toBe(2)
    expect(recorder.snapshot().spans).toEqual([])
    expect(() =>
      recordCheckpointPrepareSpan(
        {
          record: () => {
            throw new Error('recorder must not break checkpoint publish')
          }
        },
        { chatId: 'chat-a' },
        () => 3
      )
    ).not.toThrow()
  })

  it('records a failed publish then rethrows', () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(() =>
      recordCheckpointPrepareSpan(
        recorder,
        { chatId: 'chat-a' },
        () => {
          throw new Error('publish failed')
        },
        () => 0,
        tickingClock()
      )
    ).toThrow('publish failed')
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'checkpoint_prepare',
        chatId: 'chat-a',
        bytes: 0,
        durationMs: 10
      })
    ])
  })
})
