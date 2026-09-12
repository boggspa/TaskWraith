import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { ChatUpdateHydrationQueue } from './chatUpdateHydrationQueue'
import { applyEnsembleParticipantSelection } from './ensembleParticipantSelectionCommit'
import { SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY } from './sideChatLifecycle'

function chat(selectedParticipantId = 'seat-a'): ChatRecord {
  return {
    appChatId: 'chat-a',
    chatKind: 'ensemble',
    scope: 'global',
    provider: 'codex',
    title: 'Selection fixture',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    persistenceRevision: 7,
    providerMetadata: {
      [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: selectedParticipantId,
      unrelated: 'retained'
    },
    messages: [{ id: 'prompt-a', role: 'user', content: 'Synthetic prompt', timestamp: '1' }],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: ['seat-a', 'seat-b'].map((id, index) => ({
        id,
        provider: 'codex',
        enabled: true,
        role: id,
        instructions: '',
        order: index + 1
      }))
    }
  }
}

function selectedId(source: ChatRecord): unknown {
  return source.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
}

function hydratingSelection() {
  const queue = new ChatUpdateHydrationQueue<ChatRecord>()
  let resolve!: (value: ChatRecord | null) => void
  const hydration = new Promise<ChatRecord | null>((fulfil) => {
    resolve = fulfil
  })
  const hydrate = vi.fn(() => hydration)
  const state = {
    available: null as ChatRecord | null,
    appliedIds: [] as unknown[],
    committed: null as ChatRecord | null
  }
  const apply = vi.fn(
    (_key: string, base: ChatRecord, updater: (source: ChatRecord) => ChatRecord) => {
      state.committed = updater(base)
      state.available = state.committed
      return state.committed
    }
  )
  const enqueue = (participantId: string): ChatRecord | null =>
    queue.enqueue({
      key: 'chat-a',
      updater: (source) => {
        const next = applyEnsembleParticipantSelection(source, participantId, () => 3)
        state.appliedIds.push(selectedId(next))
        return next
      },
      hydrate,
      resolveAvailableBase: () => state.available,
      resolveBase: (_key, hydrated) => state.available || hydrated,
      apply
    })
  const finishHydration = async (value: ChatRecord | null): Promise<void> => {
    resolve(value)
    await hydration
    await Promise.resolve()
  }
  return { queue, hydrate, state, apply, enqueue, finishHydration }
}

describe('applyEnsembleParticipantSelection', () => {
  it('returns the exact canonical record for an already-selected seat', () => {
    const source = chat()
    const now = vi.fn(() => 10)

    expect(applyEnsembleParticipantSelection(source, 'seat-a', now)).toBe(source)
    expect(now).not.toHaveBeenCalled()
    expect(source.updatedAt).toBe(2)
  })

  it('changes only the selection metadata and timestamp while retaining history and revision', () => {
    const source = chat()
    const next = applyEnsembleParticipantSelection(source, 'seat-b', () => 10)

    expect(next).toEqual({
      ...source,
      providerMetadata: {
        ...source.providerMetadata,
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: 'seat-b'
      },
      updatedAt: 10
    })
    expect(next).not.toBe(source)
    expect(next.messages).toBe(source.messages)
    expect(next.runs).toBe(source.runs)
    expect(next.ensemble).toBe(source.ensemble)
    expect(next.persistenceRevision).toBe(7)
    expect(selectedId(source)).toBe('seat-a')
    expect(source.updatedAt).toBe(2)
  })

  it('rejects a missing seat and a source that is no longer an Ensemble', () => {
    const source = chat()
    const solo: ChatRecord = { ...source, chatKind: 'single' }
    const missingRoster: ChatRecord = { ...source, ensemble: undefined }
    const now = vi.fn(() => 10)

    expect(applyEnsembleParticipantSelection(source, 'removed-seat', now)).toBe(source)
    expect(applyEnsembleParticipantSelection(solo, 'seat-b', now)).toBe(solo)
    expect(applyEnsembleParticipantSelection(missingRoster, 'seat-b', now)).toBe(missingRoster)
    expect(now).not.toHaveBeenCalled()
  })

  it('keeps a configured disabled seat selectable for editing', () => {
    const source = chat()
    source.ensemble!.participants[1].enabled = false

    const next = applyEnsembleParticipantSelection(source, 'seat-b', () => 10)

    expect(selectedId(next)).toBe('seat-b')
    expect(next.ensemble).toBe(source.ensemble)
    expect(next.ensemble!.participants[1].enabled).toBe(false)
  })

  it('uses the canonical source supplied at application time instead of an earlier selection', () => {
    const beforeDelivery = chat('seat-a')
    const updater = (source: ChatRecord): ChatRecord =>
      applyEnsembleParticipantSelection(source, 'seat-a', () => 10)
    const canonical: ChatRecord = {
      ...chat('seat-b'),
      persistenceRevision: 8,
      messages: [
        ...beforeDelivery.messages,
        { id: 'reply-a', role: 'assistant', content: 'New canonical row', timestamp: '2' }
      ]
    }

    const next = updater(canonical)

    expect(selectedId(next)).toBe('seat-a')
    expect(next.messages).toBe(canonical.messages)
    expect(next.persistenceRevision).toBe(8)
    expect(next.updatedAt).toBe(10)
    expect(selectedId(canonical)).toBe('seat-b')
  })
})

describe('participant selection across ChatUpdateHydrationQueue', () => {
  it('retains A -> B -> A intent while the visible summary still says A', async () => {
    const fixture = hydratingSelection()
    const canonical = chat('seat-a')

    expect(fixture.enqueue('seat-b')).toBeNull()
    expect(fixture.enqueue('seat-a')).toBeNull()
    expect(fixture.queue.hasPending('chat-a')).toBe(true)
    expect(fixture.hydrate).toHaveBeenCalledTimes(1)

    await fixture.finishHydration(canonical)

    expect(fixture.state.appliedIds).toEqual(['seat-b', 'seat-a'])
    expect(fixture.apply).toHaveBeenCalledTimes(1)
    expect(selectedId(fixture.state.committed!)).toBe('seat-a')
    expect(fixture.state.committed!.messages).toBe(canonical.messages)
    expect(fixture.state.committed!.runs).toBe(canonical.runs)
    expect(fixture.queue.hasPending('chat-a')).toBe(false)
  })

  it('retains A -> B -> A when a full base takes over before hydration finishes', async () => {
    const fixture = hydratingSelection()
    fixture.enqueue('seat-b')
    fixture.state.available = chat('seat-a')

    const committed = fixture.enqueue('seat-a')

    expect(committed).toBe(fixture.state.committed)
    expect(selectedId(committed!)).toBe('seat-a')
    expect(fixture.state.appliedIds).toEqual(['seat-b', 'seat-a'])
    expect(fixture.apply).toHaveBeenCalledTimes(1)

    await fixture.finishHydration(chat('seat-b'))

    expect(fixture.state.committed).toBe(committed)
    expect(fixture.apply).toHaveBeenCalledTimes(1)
  })

  it('does not restore a participant removed from the canonical roster during hydration', async () => {
    const fixture = hydratingSelection()
    fixture.enqueue('seat-b')
    const canonical = chat('seat-a')
    canonical.ensemble!.participants = canonical.ensemble!.participants.filter(
      (participant) => participant.id !== 'seat-b'
    )

    await fixture.finishHydration(canonical)

    expect(fixture.state.committed).toBe(canonical)
    expect(fixture.state.appliedIds).toEqual(['seat-a'])
    expect(canonical.updatedAt).toBe(2)
  })

  it('does not apply a queued selection after the chat queue is cancelled', async () => {
    const fixture = hydratingSelection()
    fixture.enqueue('seat-b')
    fixture.queue.cancel('chat-a')

    await fixture.finishHydration(chat())

    expect(fixture.apply).not.toHaveBeenCalled()
    expect(fixture.state.appliedIds).toEqual([])
    expect(fixture.state.committed).toBeNull()
  })
})
