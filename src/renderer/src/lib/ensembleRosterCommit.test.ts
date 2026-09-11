import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import {
  ENSEMBLE_SAVE_REBASE_ATTEMPTS,
  saveChatPreservingEnsembleIntent
} from './ensembleRosterCommit'

function seat(id: string, overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: '',
    order: 1,
    model: 'gpt-5.4',
    ...overrides
  } as EnsembleParticipant
}

function chat(
  seats: EnsembleParticipant[],
  overrides: {
    revision?: number
    maxContinuationHops?: number
    activeRound?: unknown
    messages?: ChatRecord['messages']
  } = {}
): ChatRecord {
  return {
    appChatId: 'chat-1',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Panel',
    scope: 'workspace',
    createdAt: 0,
    updatedAt: 0,
    persistenceRevision: overrides.revision ?? 0,
    messages: overrides.messages ?? [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 12,
      participants: seats.map((entry, index) => ({ ...entry, order: index + 1 })),
      maxContinuationHops: overrides.maxContinuationHops ?? 6,
      ...(overrides.activeRound ? { activeRound: overrides.activeRound } : {})
    }
  } as unknown as ChatRecord
}

describe('saveChatPreservingEnsembleIntent', () => {
  it('issues exactly one write when canonical accepts', async () => {
    const authored = chat([seat('seat-1'), seat('seat-2')])
    const saveChat = vi.fn(async (record: ChatRecord) => ({
      chat: { ...record, persistenceRevision: 8 },
      accepted: true
    }))

    const result = await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saveChat).toHaveBeenCalledTimes(1)
    expect(result?.persistenceRevision).toBe(8)
  })

  // The reported bug: main refuses the clone on revision skew and returns its
  // own record, so the removal is dropped and the seat comes back.
  it('rebases a refused seat removal onto canonical and saves again', async () => {
    const canonicalSeats = [seat('seat-1'), seat('seat-2'), seat('seat-3')]
    const authored = chat([seat('seat-1'), seat('seat-3')], { revision: 4 })
    const saved: ChatRecord[] = []
    const saveChat = vi.fn(async (record: ChatRecord) => {
      saved.push(record)
      if (saved.length === 1) {
        // Refusal: canonical unchanged, one revision ahead, seat still present.
        return { chat: chat(canonicalSeats, { revision: 5 }), accepted: false }
      }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    const result = await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saveChat).toHaveBeenCalledTimes(2)
    expect(saved[1].ensemble?.participants.map((entry) => entry.id)).toEqual(['seat-1', 'seat-3'])
    // The retry must carry canonical's revision, or it is stale by construction.
    expect(saved[1].persistenceRevision).toBe(5)
    expect(result?.ensemble?.participants.map((entry) => entry.id)).toEqual(['seat-1', 'seat-3'])
  })

  it('rebases a refused seat model pick without disturbing membership', async () => {
    const authored = chat([seat('seat-1', { model: 'gpt-5.4-codex' })], { revision: 4 })
    const saved: ChatRecord[] = []
    const saveChat = vi.fn(async (record: ChatRecord) => {
      saved.push(record)
      if (saved.length === 1) {
        return { chat: chat([seat('seat-1')], { revision: 5 }), accepted: false }
      }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saved[1].ensemble?.participants[0].model).toBe('gpt-5.4-codex')
  })

  it('rebases a refused panel setting', async () => {
    const authored = chat([seat('seat-1')], { revision: 4, maxContinuationHops: 200 })
    const saved: ChatRecord[] = []
    const saveChat = vi.fn(async (record: ChatRecord) => {
      saved.push(record)
      if (saved.length === 1) {
        return {
          chat: chat([seat('seat-1')], { revision: 5, maxContinuationHops: 6 }),
          accepted: false
        }
      }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saved[1].ensemble?.maxContinuationHops).toBe(200)
  })

  // The fence is right about transcripts and round state; the retry must not
  // undo what it was protecting.
  it('keeps canonical transcript and round state on the rebased write', async () => {
    const authored = chat([seat('seat-1')], { revision: 4 })
    const canonical = chat([seat('seat-1'), seat('seat-2')], {
      revision: 5,
      activeRound: { roundId: 'round-7', status: 'running' },
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Canonical append',
          timestamp: '2026-09-11T00:00:00.000Z'
        }
      ] as ChatRecord['messages']
    })
    const saved: ChatRecord[] = []
    const saveChat = vi.fn(async (record: ChatRecord) => {
      saved.push(record)
      if (saved.length === 1) return { chat: canonical, accepted: false }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saved[1].messages.map((message) => message.id)).toEqual(['message-1'])
    expect(saved[1].ensemble?.activeRound?.roundId).toBe('round-7')
    expect(saved[1].ensemble?.participants.map((entry) => entry.id)).toEqual(['seat-1'])
  })

  it('preserves main-authored per-seat bookkeeping across the rebase', async () => {
    const authored = chat([seat('seat-1', { model: 'gpt-5.4-codex' })], { revision: 4 })
    const canonicalSeat = seat('seat-1')
    ;(canonicalSeat as unknown as Record<string, unknown>).linkedProviderSessionId = 'session-9'
    const saved: ChatRecord[] = []
    const saveChat = vi.fn(async (record: ChatRecord) => {
      saved.push(record)
      if (saved.length === 1) {
        return { chat: chat([canonicalSeat], { revision: 5 }), accepted: false }
      }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    const rebasedSeat = saved[1].ensemble?.participants[0] as unknown as Record<string, unknown>
    expect(rebasedSeat.linkedProviderSessionId).toBe('session-9')
    expect(rebasedSeat.model).toBe('gpt-5.4-codex')
  })

  // "Accepted" ends it. Re-forcing the pre-normalized slice over whatever main
  // did to the record after taking it would be a fight with the normalizer.
  it('does not retry when canonical accepted and then normalized the record', async () => {
    const authored = chat([seat('seat-1'), seat('seat-2')], { revision: 4 })
    const saveChat = vi.fn(async () => ({
      chat: chat([seat('seat-1')], { revision: 5 }),
      accepted: true
    }))

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saveChat).toHaveBeenCalledTimes(1)
  })

  it('stops retrying at the attempt ceiling instead of saving forever', async () => {
    const authored = chat([seat('seat-1')], { revision: 4 })
    let revision = 5
    const saveChat = vi.fn(async () => ({
      chat: chat([seat('seat-1'), seat('seat-2')], { revision: (revision += 1) }),
      accepted: false
    }))

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saveChat).toHaveBeenCalledTimes(ENSEMBLE_SAVE_REBASE_ATTEMPTS)
  })

  it('does not retry a refusal whose canonical already carries the edit', async () => {
    const authored = chat([seat('seat-1')], { revision: 4 })
    const saveChat = vi.fn(async () => ({
      chat: chat([seat('seat-1')], { revision: 9 }),
      accepted: false
    }))

    await saveChatPreservingEnsembleIntent(authored, { saveChat })

    expect(saveChat).toHaveBeenCalledTimes(1)
  })

  it('republishes each rebased record so the next save is not stale by construction', async () => {
    const authored = chat([seat('seat-1')], { revision: 4 })
    const onRebased = vi.fn()
    let calls = 0
    const saveChat = vi.fn(async (record: ChatRecord) => {
      calls += 1
      if (calls === 1) {
        return { chat: chat([seat('seat-1'), seat('seat-2')], { revision: 5 }), accepted: false }
      }
      return { chat: { ...record, persistenceRevision: 6 }, accepted: true }
    })

    await saveChatPreservingEnsembleIntent(authored, { saveChat, onRebased })

    expect(onRebased).toHaveBeenCalledTimes(1)
    expect(onRebased.mock.calls[0][0].persistenceRevision).toBe(5)
  })
})
