import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from './WorkSpanRecorder'
import { recordPromptBuildSpan } from './promptBuildSpan'

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

describe('recordPromptBuildSpan', () => {
  it('records prompt_build with prompt byte length', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(5_000, 25)
    })
    const result = recordPromptBuildSpan(
      recorder,
      { chatId: ' chat-light ', runId: 'run-1', participantId: 'seat-3', laneId: 'lane-2' },
      () => ({ prompt: 'hello world' }),
      tickingClock(5_000, 25)
    )
    expect(result).toEqual({ prompt: 'hello world' })
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'prompt_build',
        chatId: 'chat-light',
        runId: 'run-1',
        participantId: 'seat-3',
        laneId: 'lane-2',
        startedAt: 5_000,
        durationMs: 25,
        bytes: 11
      })
    ])
  })

  it('runs the builder without a sink or chatId and contains a throwing sink', () => {
    expect(recordPromptBuildSpan(undefined, { chatId: 'chat-a' }, () => ({ prompt: 'x' }))).toEqual(
      { prompt: 'x' }
    )
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(recordPromptBuildSpan(recorder, { chatId: '  ' }, () => ({ prompt: 'y' }))).toEqual({
      prompt: 'y'
    })
    expect(recorder.snapshot().spans).toEqual([])
    expect(() =>
      recordPromptBuildSpan(
        {
          record: () => {
            throw new Error('recorder must not break prompt construction')
          }
        },
        { chatId: 'chat-a' },
        () => ({ prompt: 'z' })
      )
    ).not.toThrow()
  })

  it('records a failed build then rethrows', () => {
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(() =>
      recordPromptBuildSpan(
        recorder,
        { chatId: 'chat-a', runId: 'run-1' },
        () => {
          throw new Error('projection failed')
        },
        tickingClock()
      )
    ).toThrow('projection failed')
    expect(recorder.snapshot().spans).toEqual([
      expect.objectContaining({
        kind: 'prompt_build',
        chatId: 'chat-a',
        runId: 'run-1',
        bytes: 0,
        durationMs: 10
      })
    ])
  })
})
