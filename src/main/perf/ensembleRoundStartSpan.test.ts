import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from './WorkSpanRecorder'
import { beginEnsembleRoundStart, recordEnsembleRoundStartDispatch } from './ensembleRoundStartSpan'

describe('ensembleRoundStartSpan', () => {
  it('records one round_start at the first dispatch and ignores later ones', () => {
    const runtime = { id: 'round' }
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 16, now: () => 50 })
    beginEnsembleRoundStart(runtime, { chatId: 'chat-a', roundId: 'round-1', startedAt: 10 })
    recordEnsembleRoundStartDispatch(
      runtime,
      { runId: 'run-1', participantId: 'p1' },
      recorder,
      () => 40
    )
    recordEnsembleRoundStartDispatch(
      runtime,
      { runId: 'run-2', participantId: 'p2', laneId: 'lane-2' },
      recorder,
      () => 90
    )
    const snapshot = recorder.snapshot()
    expect(snapshot.spans).toHaveLength(1)
    expect(snapshot.spans[0]).toMatchObject({
      chatId: 'chat-a',
      runId: 'run-1',
      participantId: 'p1',
      kind: 'round_start',
      startedAt: 10,
      durationMs: 30,
      process: 'main',
      resource: 'none'
    })
    expect(snapshot.spans[0]?.laneId).toBe('')
    expect(snapshot.byKind.round_start?.count).toBe(1)
  })

  it('does nothing when there is no sink or no begin', () => {
    const runtime = { id: 'round' }
    expect(() =>
      recordEnsembleRoundStartDispatch(runtime, { runId: 'run-1' }, undefined, () => 1)
    ).not.toThrow()
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    recordEnsembleRoundStartDispatch(runtime, { runId: 'run-1' }, recorder, () => 1)
    expect(recorder.snapshot().spans).toEqual([])
  })

  it('contains a throwing sink and a throwing clock', () => {
    const runtime = { id: 'round' }
    beginEnsembleRoundStart(runtime, { chatId: 'chat-a', roundId: 'round-1', startedAt: 1 })
    expect(() =>
      recordEnsembleRoundStartDispatch(
        runtime,
        { runId: 'run-1' },
        {
          record: () => {
            throw new Error('recorder must not break dispatch')
          }
        },
        () => 2
      )
    ).not.toThrow()

    const other = { id: 'other' }
    beginEnsembleRoundStart(other, { chatId: 'chat-b', roundId: 'round-2', startedAt: 1 })
    const recorder = createWorkSpanRecorder({ process: 'main', maxRetained: 8 })
    expect(() =>
      recordEnsembleRoundStartDispatch(other, { runId: 'run-2' }, recorder, () => {
        throw new Error('clock failed')
      })
    ).not.toThrow()
    expect(recorder.snapshot().spans).toEqual([])
  })
})
