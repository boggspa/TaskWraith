import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import {
  appendContinuationHopsChangeTranscriptEvent,
  buildContinuationHopsAdvanceTranscriptEvent
} from './EnsembleContinuationHopsTranscript'

function chat(): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    title: 'Hop changes',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

describe('appendContinuationHopsChangeTranscriptEvent', () => {
  it('persists a round-owned structured event with a plaintext fallback', () => {
    const updated = appendContinuationHopsChangeTranscriptEvent(chat(), {
      id: 'hops-1',
      before: 6,
      after: 76,
      actor: 'captain',
      actorParticipantId: 'captain-1',
      actorRole: 'Release Captain',
      reason: 'The investigation needs more room.',
      changedAt: '2026-08-12T00:09:39.000Z',
      changedAtMs: 42,
      roundId: 'round-1'
    })

    expect(updated.updatedAt).toBe(42)
    expect(updated.messages).toEqual([
      expect.objectContaining({
        id: 'hops-1',
        role: 'system',
        content:
          'Captain changed max handoff turns from 6 to 76. Reason: The investigation needs more room.',
        metadata: {
          kind: 'ensembleContinuationHopsChange',
          ensembleRoundId: 'round-1',
          continuationHopsChange: {
            event: 'limit',
            before: 6,
            after: 76,
            actor: 'captain',
            actorParticipantId: 'captain-1',
            actorRole: 'Release Captain',
            reason: 'The investigation needs more room.',
            changedAt: '2026-08-12T00:09:39.000Z'
          }
        }
      })
    ])
  })

  it('does not claim a change when the limit is unchanged', () => {
    const original = chat()
    expect(
      appendContinuationHopsChangeTranscriptEvent(original, {
        id: 'hops-noop',
        before: 6,
        after: 6,
        actor: 'user',
        changedAt: '2026-08-12T00:09:39.000Z',
        changedAtMs: 42
      })
    ).toBe(original)
  })

  it('builds an advancing n/max promotion while preserving the plain status fallback', () => {
    expect(
      buildContinuationHopsAdvanceTranscriptEvent({
        before: 48,
        after: 49,
        maxHops: 124,
        changedAt: '2026-08-29T22:05:00.000Z',
        roundId: 'round-49',
        statusMessage: '@-mention: extra turn appended for Boss.',
        targetLabel: ' Boss ',
        sourceLabel: ' @-mention '
      })
    ).toEqual({
      content: '@-mention: extra turn appended for Boss. Continuous handoff 49/124.',
      metadata: {
        kind: 'ensembleContinuationHopsChange',
        ensembleRoundId: 'round-49',
        continuationHopsChange: {
          event: 'advance',
          before: 48,
          after: 49,
          maxHops: 124,
          changedAt: '2026-08-29T22:05:00.000Z',
          targetLabel: 'Boss',
          sourceLabel: '@-mention'
        }
      }
    })
  })

  it('supports the first handoff and a fallback without optional presentation labels', () => {
    expect(
      buildContinuationHopsAdvanceTranscriptEvent({
        before: 0,
        after: 1,
        maxHops: 6,
        changedAt: '2026-08-29T22:06:00.000Z',
        statusMessage: '  '
      })
    ).toEqual({
      content: 'Continuous handoff 1/6.',
      metadata: {
        kind: 'ensembleContinuationHopsChange',
        continuationHopsChange: {
          event: 'advance',
          before: 0,
          after: 1,
          maxHops: 6,
          changedAt: '2026-08-29T22:06:00.000Z'
        }
      }
    })
  })
})
