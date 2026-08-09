import { describe, expect, it } from 'vitest'
import { projectHostSnapshot } from '../renderer/src/lib/host/hostSnapshotProjection'
import { emptyHostSnapshotForTests } from './hostProjectionMap'
import { buildTaskWraithTuiJsonProjection } from './jsonProjection'

describe('buildTaskWraithTuiJsonProjection', () => {
  it('preserves Desktop generation/cursor and exact body-free question receipt parity', () => {
    const snapshot = emptyHostSnapshotForTests({
      generation: 9,
      cursor: 27,
      questions: [
        {
          questionId: 'question-1',
          threadId: 'thread-1',
          status: 'answered',
          promptPreview: 'Which route?',
          askedAt: 100,
          answeredAt: 200,
          receiptId: '11111111-1111-4111-8111-111111111111'
        }
      ]
    })
    const tui = buildTaskWraithTuiJsonProjection(
      {
        hostProjection: snapshot,
        hostVersion: '1.9.4',
        selectedThreadId: 'thread-1'
      },
      'host'
    )
    const desktop = projectHostSnapshot(snapshot, 'live')

    expect({ generation: tui.generation, cursor: tui.cursor }).toEqual({
      generation: desktop.generation,
      cursor: desktop.cursor
    })
    expect(tui.snapshot.questions[0]?.receiptId).toBe(desktop.questions[0]?.receiptId)
    expect(tui.snapshot.questions[0]?.receiptId).toBe('11111111-1111-4111-8111-111111111111')
    expect(tui.snapshot.questions[0]).not.toHaveProperty('answer')
  })

  it('refuses to fabricate JSON when no coherent Host snapshot exists', () => {
    expect(() => buildTaskWraithTuiJsonProjection({}, 'host')).toThrow(
      'No coherent Host projection is available for JSON output.'
    )
  })
})
