import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'
import type { ChatRecord, EnsembleParticipant } from './store/types'

const userDataPath = vi.hoisted(() => {
  const tmpRoot =
    process.platform === 'win32' && /^[A-Za-z]:/.test(process.cwd())
      ? `${process.cwd().slice(0, 2)}/tmp`
      : '/tmp'
  return `${tmpRoot}/taskwraith-set-chat-kind-test-${process.pid}`
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function seedParticipant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seed-1',
    provider: 'codex',
    enabled: true,
    role: 'Primary',
    instructions: '',
    order: 0,
    model: 'gpt-5-codex',
    ...overrides
  }
}

describe('AppStore.setChatKind (Slice C — mid-thread ensemble toggle)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('converts solo→ensemble in place, seeding EXACTLY one participant and preserving history', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Keep this in the transcript.',
          timestamp: '2026-07-04T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-07-04T00:00:00.000Z',
          endedAt: '2026-07-04T00:00:01.000Z',
          status: 'success'
        }
      ]
    } as ChatRecord)

    const converted = AppStore.setChatKind(solo.appChatId, 'ensemble', {
      seedParticipant: seedParticipant()
    })

    // In place: same record id.
    expect(converted.appChatId).toBe(solo.appChatId)
    expect(converted.chatKind).toBe('ensemble')
    // The normalizeChatRecord 6-provider auto-fill landmine must NOT fire.
    expect(converted.ensemble?.participants).toHaveLength(1)
    expect(converted.ensemble?.participants[0]?.id).toBe('seed-1')
    expect(converted.ensemble?.participants[0]?.provider).toBe('codex')
    // History preserved.
    expect(converted.messages).toHaveLength(1)
    expect(converted.runs).toHaveLength(1)

    // Persisted, not just returned.
    const reloaded = AppStore.getChat(solo.appChatId)
    expect(reloaded?.chatKind).toBe('ensemble')
    expect(reloaded?.ensemble?.participants).toHaveLength(1)
    expect(reloaded?.messages).toHaveLength(1)
  })

  it('converts ensemble→solo in place, stripping the ensemble block and setting the canonical provider', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'gemini',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Ensemble history stays.',
          timestamp: '2026-07-04T00:00:00.000Z'
        }
      ]
    } as ChatRecord)

    const converted = AppStore.setChatKind(ensemble.appChatId, 'single', {
      canonicalProvider: 'codex'
    })

    expect(converted.appChatId).toBe(ensemble.appChatId)
    expect(converted.chatKind).toBe('single')
    expect(converted.ensemble).toBeUndefined()
    expect(converted.provider).toBe('codex')
    expect(converted.messages).toHaveLength(1)

    const reloaded = AppStore.getChat(ensemble.appChatId)
    expect(reloaded?.chatKind).toBe('single')
    expect(reloaded?.ensemble).toBeUndefined()
    expect(reloaded?.provider).toBe('codex')
    expect(reloaded?.messages).toHaveLength(1)
  })

  it('is a no-op when the target kind already matches', () => {
    const solo = AppStore.createGlobalChat()
    const result = AppStore.setChatKind(solo.appChatId, 'single')
    expect(result.appChatId).toBe(solo.appChatId)
    expect(result.chatKind).not.toBe('ensemble')
  })

  it('rejects solo→ensemble without a seed participant', () => {
    const solo = AppStore.createGlobalChat()
    expect(() => AppStore.setChatKind(solo.appChatId, 'ensemble')).toThrow(/seed participant/)
  })

  it('rejects a conversion while a run is still running (idle-only guard)', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      runs: [
        {
          runId: 'run-live',
          provider: 'codex',
          startedAt: '2026-07-04T00:00:00.000Z',
          status: 'running'
        }
      ]
    } as ChatRecord)

    expect(() =>
      AppStore.setChatKind(solo.appChatId, 'ensemble', { seedParticipant: seedParticipant() })
    ).toThrow(/turn is active/)

    // Unchanged.
    expect(AppStore.getChat(solo.appChatId)?.chatKind).not.toBe('ensemble')
  })

  it('rejects a conversion while an ensemble round dispatch is live', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      ensemble: {
        ...ensemble.ensemble!,
        activeRound: {
          status: 'running',
          participants: [{ participantId: 'p1', status: 'running' }]
        }
      }
    } as ChatRecord)

    expect(() =>
      AppStore.setChatKind(ensemble.appChatId, 'single', { canonicalProvider: 'codex' })
    ).toThrow(/turn is active/)

    expect(AppStore.getChat(ensemble.appChatId)?.chatKind).toBe('ensemble')
  })

  it('throws when the chat does not exist', () => {
    expect(() =>
      AppStore.setChatKind('missing-chat', 'ensemble', { seedParticipant: seedParticipant() })
    ).toThrow(/not found/)
  })

  it('E3 — ensemble→solo stashes the roster under providerMetadata (not chat.ensemble), and solo→ensemble restores it when the provider is unchanged', () => {
    const ensemble = AppStore.createEnsembleChat()
    const roster: EnsembleParticipant[] = [
      seedParticipant({ id: 'p1', provider: 'claude', role: 'Boss', order: 1 }),
      seedParticipant({ id: 'p2', provider: 'codex', role: 'Worker', order: 2 }),
      seedParticipant({ id: 'p3', provider: 'grok', role: 'Reviewer', order: 3 })
    ]
    AppStore.saveChat({
      ...ensemble,
      provider: 'claude',
      ensemble: {
        ...ensemble.ensemble!,
        participants: roster,
        bossmanParticipantId: 'p1'
      },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Preserve my roster.',
          timestamp: '2026-07-04T00:00:00.000Z'
        }
      ]
    } as ChatRecord)

    // Collapse to solo (canonical provider matches the chat/Boss provider).
    const solo = AppStore.setChatKind(ensemble.appChatId, 'single', {
      canonicalProvider: 'claude'
    })
    expect(solo.chatKind).toBe('single')
    // Leak-prevention invariant: the roster must NOT remain on chat.ensemble
    // (its presence keys the remote/iOS ensemble projection).
    expect(solo.ensemble).toBeUndefined()
    // ...but it IS preserved under providerMetadata for a later toggle back.
    const stash = solo.providerMetadata?.stashedEnsemble as
      | { config?: { participants?: unknown[]; bossmanParticipantId?: string }; provider?: string }
      | undefined
    expect(stash?.provider).toBe('claude')
    expect(stash?.config?.participants).toHaveLength(3)
    expect(stash?.config?.bossmanParticipantId).toBe('p1')
    expect(solo.messages).toHaveLength(1)

    // Toggle back to ensemble — the FULL roster is restored, not a 1-seat seed.
    const restored = AppStore.setChatKind(ensemble.appChatId, 'ensemble', {
      seedParticipant: seedParticipant({ id: 'ignored-seed', provider: 'claude' })
    })
    expect(restored.chatKind).toBe('ensemble')
    expect(restored.ensemble?.participants).toHaveLength(3)
    expect(restored.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'p1',
      'p2',
      'p3'
    ])
    expect(restored.ensemble?.bossmanParticipantId).toBe('p1')
    // Stash consumed on restore.
    expect(restored.providerMetadata?.stashedEnsemble).toBeUndefined()
    // History intact throughout.
    expect(restored.messages).toHaveLength(1)

    const reloaded = AppStore.getChat(ensemble.appChatId)
    expect(reloaded?.ensemble?.participants).toHaveLength(3)
    expect(reloaded?.providerMetadata?.stashedEnsemble).toBeUndefined()
  })

  it('E3 — a provider change while solo invalidates the stash, so toggle-back re-seeds a single participant', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'claude',
      ensemble: {
        ...ensemble.ensemble!,
        participants: [
          seedParticipant({ id: 'p1', provider: 'claude', role: 'Boss', order: 1 }),
          seedParticipant({ id: 'p2', provider: 'codex', role: 'Worker', order: 2 })
        ],
        bossmanParticipantId: 'p1'
      }
    } as ChatRecord)

    AppStore.setChatKind(ensemble.appChatId, 'single', { canonicalProvider: 'claude' })

    // User switches provider while solo (Slice B) — the stash-time provider no
    // longer matches the current solo provider.
    const afterCollapse = AppStore.getChat(ensemble.appChatId)!
    AppStore.saveChat({ ...afterCollapse, provider: 'codex' } as ChatRecord)

    const restored = AppStore.setChatKind(ensemble.appChatId, 'ensemble', {
      seedParticipant: seedParticipant({ id: 'fresh-seed', provider: 'codex' })
    })
    // Stale stash (claude !== codex) → fresh single-participant seed.
    expect(restored.ensemble?.participants).toHaveLength(1)
    expect(restored.ensemble?.participants[0]?.id).toBe('fresh-seed')
    expect(restored.ensemble?.participants[0]?.provider).toBe('codex')
    // Stash consumed either way.
    expect(restored.providerMetadata?.stashedEnsemble).toBeUndefined()
  })

  it('E2 — ensemble→solo with no canonicalProvider derives the Boss participant provider + model/reasoning', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'gemini', // stale legacy top-level provider — must NOT win over the Boss
      ensemble: {
        ...ensemble.ensemble!,
        participants: [
          // Worker has the lower order, but the Boss marker takes precedence.
          seedParticipant({ id: 'w', provider: 'codex', role: 'Worker', order: 1 }),
          seedParticipant({
            id: 'boss',
            provider: 'claude',
            role: 'Boss',
            order: 2,
            model: 'claude-opus-x',
            reasoningEffort: 'high'
          })
        ],
        bossmanParticipantId: 'boss'
      }
    } as ChatRecord)

    // No canonicalProvider passed → backend fallback must derive from the Boss.
    const solo = AppStore.setChatKind(ensemble.appChatId, 'single')
    expect(solo.chatKind).toBe('single')
    expect(solo.provider).toBe('claude') // Boss — not stale gemini, not lowest-order codex worker
    expect(solo.providerMetadata?.selectedModelType).toBe('claude-opus-x')
    expect(solo.providerMetadata?.claudeReasoningEffort).toBe('high')
  })

  it('E2 — with no Boss marker, ensemble→solo derives the lowest-order ENABLED participant (first-to-speak)', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'gemini',
      ensemble: {
        ...ensemble.ensemble!,
        participants: [
          // Lowest order (1) but DISABLED — must be skipped.
          seedParticipant({ id: 'disabled', provider: 'claude', role: 'A', order: 1, enabled: false }),
          // Lowest-order ENABLED — the real first-to-speak.
          seedParticipant({ id: 'first', provider: 'kimi', role: 'B', order: 2, enabled: true }),
          seedParticipant({ id: 'third', provider: 'codex', role: 'C', order: 3, enabled: true })
        ]
        // no bossmanParticipantId
      }
    } as ChatRecord)

    const solo = AppStore.setChatKind(ensemble.appChatId, 'single')
    expect(solo.provider).toBe('kimi') // lowest-order ENABLED, skipping the disabled order-1 seat
  })

  it('E2 — an explicit canonicalProvider overrides the Boss-derived fallback', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'gemini',
      ensemble: {
        ...ensemble.ensemble!,
        participants: [seedParticipant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 })],
        bossmanParticipantId: 'boss'
      }
    } as ChatRecord)

    const solo = AppStore.setChatKind(ensemble.appChatId, 'single', { canonicalProvider: 'codex' })
    expect(solo.provider).toBe('codex') // explicit modal choice wins over Boss-derived 'claude'
  })
})
