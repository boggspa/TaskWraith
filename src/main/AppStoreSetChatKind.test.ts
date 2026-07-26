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

  it('converts solo→ensemble in place, seeding the renderer seat + the floor companion and preserving history', () => {
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
    // Exactly the floor: the renderer's seat first, one companion behind it.
    // The normalizeChatRecord 6-provider auto-fill landmine must NOT fire.
    expect(converted.ensemble?.participants).toHaveLength(2)
    expect(converted.ensemble?.participants[0]?.id).toBe('seed-1')
    expect(converted.ensemble?.participants[0]?.provider).toBe('codex')
    // The companion is a DIFFERENT agent — a panel of one provider twice would
    // not be much of a panel when the seed already covers it.
    expect(converted.ensemble?.participants[1]?.provider).not.toBe('codex')
    expect(converted.ensemble?.participants[1]?.enabled).toBe(true)
    expect(converted.ensemble?.participants[1]?.order).toBe(2)
    // History preserved.
    expect(converted.messages).toHaveLength(1)
    expect(converted.runs).toHaveLength(1)

    // Persisted, not just returned.
    const reloaded = AppStore.getChat(solo.appChatId)
    expect(reloaded?.chatKind).toBe('ensemble')
    expect(reloaded?.ensemble?.participants).toHaveLength(2)
    expect(reloaded?.messages).toHaveLength(1)
  })

  it('starts fresh at the solo→ensemble boundary and rejects a renderer-authored seat receipt', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      linkedProviderSessionId: 'solo-codex-session',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-core-v1',
        provider: 'codex',
        providerSessionId: 'solo-codex-session',
        pinnedAt: '2026-07-11T00:00:00.000Z'
      }
    } as ChatRecord)

    const converted = AppStore.setChatKind(solo.appChatId, 'ensemble', {
      seedParticipant: seedParticipant({
        linkedProviderSessionId: 'renderer-supplied-session',
        taskWraithMcpProfileReceipt: {
          schemaVersion: 1,
          profileId: 'taskwraith-full-v1',
          provider: 'codex',
          providerSessionId: 'renderer-supplied-session',
          pinnedAt: '2026-07-11T00:01:00.000Z'
        }
      })
    })

    expect(converted.linkedProviderSessionId).toBeUndefined()
    expect(converted.taskWraithMcpProfileReceipt).toBeUndefined()
    expect(converted.ensemble?.participants[0].linkedProviderSessionId).toBeNull()
    expect(converted.ensemble?.participants[0].taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('makes TaskWraith authoritative when a native-goal chat becomes an ensemble', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      activeGoal: {
        id: 'goal-1',
        objective: 'Keep the ensemble coordinated',
        status: 'active',
        mode: 'codex_native',
        provider: 'codex',
        createdAt: '2026-07-10T10:00:00.000Z',
        updatedAt: '2026-07-10T10:00:00.000Z'
      }
    } as ChatRecord)

    const converted = AppStore.setChatKind(solo.appChatId, 'ensemble', {
      seedParticipant: seedParticipant()
    })

    expect(converted.activeGoal).toMatchObject({
      id: 'goal-1',
      objective: 'Keep the ensemble coordinated',
      status: 'active',
      provider: 'codex',
      mode: 'taskwraith_steered'
    })
    expect(AppStore.getChat(solo.appChatId)?.activeGoal?.mode).toBe('taskwraith_steered')
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

  it('drops participant session/profile pairs when an ensemble is stashed or collapsed to solo', () => {
    const ensemble = AppStore.createEnsembleChat()
    const receipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-seat-session',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    AppStore.saveChat({
      ...ensemble,
      provider: 'claude',
      linkedProviderSessionId: 'stale-top-level-session',
      taskWraithMcpProfileReceipt: {
        ...receipt,
        providerSessionId: 'stale-top-level-session'
      },
      ensemble: {
        ...ensemble.ensemble!,
        participants: [
          seedParticipant({
            id: 'claude-seat',
            provider: 'claude',
            linkedProviderSessionId: 'claude-seat-session',
            taskWraithMcpProfileReceipt: receipt
          })
        ]
      }
    } as ChatRecord)

    const solo = AppStore.setChatKind(ensemble.appChatId, 'single', {
      canonicalProvider: 'claude'
    })
    const stash = solo.providerMetadata?.stashedEnsemble as
      | { config?: { participants?: EnsembleParticipant[] } }
      | undefined

    expect(solo.linkedProviderSessionId).toBeUndefined()
    expect(solo.taskWraithMcpProfileReceipt).toBeUndefined()
    expect(stash?.config?.participants?.[0].linkedProviderSessionId).toBeNull()
    expect(stash?.config?.participants?.[0].taskWraithMcpProfileReceipt).toBeUndefined()
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

  it('E3 — a provider change while solo invalidates the stash, so toggle-back re-seeds from scratch', () => {
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
    // Stale stash (claude !== codex) → fresh seed, topped up to the floor.
    expect(restored.ensemble?.participants).toHaveLength(2)
    expect(restored.ensemble?.participants[0]?.id).toBe('fresh-seed')
    expect(restored.ensemble?.participants[0]?.provider).toBe('codex')
    expect(restored.ensemble?.participants[1]?.provider).not.toBe('codex')
    // Stash consumed either way.
    expect(restored.providerMetadata?.stashedEnsemble).toBeUndefined()
  })

  it('tops a restored one-seat stash back up to the roster floor', () => {
    // A one-seat roster is legal while it lives (an Agent-MCP roster edit or a
    // one-participant preset import can produce one). Collapsing it stashes it
    // verbatim — but switching Ensemble back ON is a fresh request for a panel,
    // so the restore must not hand back the degenerate roster.
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'claude',
      ensemble: {
        ...ensemble.ensemble!,
        participants: [seedParticipant({ id: 'p1', provider: 'claude', role: 'Boss', order: 1 })],
        bossmanParticipantId: 'p1'
      }
    } as ChatRecord)

    AppStore.setChatKind(ensemble.appChatId, 'single', { canonicalProvider: 'claude' })
    const restored = AppStore.setChatKind(ensemble.appChatId, 'ensemble', {
      seedParticipant: seedParticipant({ id: 'ignored-seed', provider: 'claude' })
    })

    expect(restored.ensemble?.participants).toHaveLength(2)
    // The stashed seat still leads; the floor only appends behind it.
    expect(restored.ensemble?.participants[0]?.id).toBe('p1')
    expect(restored.ensemble?.participants[1]?.provider).not.toBe('claude')
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
