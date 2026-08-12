import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import { appendContinuationHopsChangeTranscriptEvent } from './EnsembleContinuationHopsTranscript'

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
})
