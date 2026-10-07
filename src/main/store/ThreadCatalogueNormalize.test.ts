import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './types'
import { normalizeCatalogueChatRecord } from './ThreadCatalogueNormalize'
import { resolveEnsembleFanoutPolicy } from '../services/EnsembleFanoutPolicy'

describe('Host-native draft normalization', () => {
  it('rejects a missing transcript instead of inventing empty history', () => {
    const stored = {
      appChatId: 'missing-transcript',
      scope: 'global',
      title: 'New Chat',
      provider: 'codex',
      archived: false,
      updatedAt: 100
    } as unknown as ChatRecord
    expect(() => normalizeCatalogueChatRecord(stored, () => 'codex')).toThrow(
      'Invalid chat messages: expected an array'
    )
  })

  it.each(['messages', 'runs'] as const)(
    'rejects present malformed %s instead of replacing history with an empty array',
    (field) => {
      for (const value of [null, 'private history', { content: 'private history' }]) {
        const stored = {
          appChatId: 'malformed-host-draft',
          scope: 'global',
          title: 'New Chat',
          provider: 'codex',
          archived: false,
          messages: [],
          runs: [],
          updatedAt: 100,
          [field]: value
        } as unknown as ChatRecord
        expect(() => normalizeCatalogueChatRecord(stored, () => 'codex')).toThrow(
          `Invalid chat ${field}: expected an array`
        )
        expect(stored[field]).toBe(value)
      }
    }
  )

  it.each(['global', 'workspace'] as const)(
    'completes a legacy %s Host draft without inventing history',
    (scope) => {
      const stored = {
        appChatId: 'legacy-host-draft',
        scope,
        workspaceId: scope === 'workspace' ? 'workspace-1' : undefined,
        workspacePath: scope === 'workspace' ? '/workspace' : undefined,
        title: 'New Chat',
        provider: 'codex',
        archived: false,
        messages: [],
        updatedAt: 100,
        persistenceRevision: 1
      } as unknown as ChatRecord
      const normalized = normalizeCatalogueChatRecord(stored, () => 'codex')
      expect(normalized).toMatchObject({ messages: [], runs: [], createdAt: 0 })
      expect(normalized.messages).toBe(stored.messages)
      expect(normalized.persistenceRevision).toBe(1)
      expect(stored).not.toHaveProperty('runs')
      expect(stored).not.toHaveProperty('createdAt')
    }
  )

  it('preserves existing history arrays and a known creation time', () => {
    const stored = {
      appChatId: 'existing-chat',
      scope: 'global',
      title: 'Existing',
      provider: 'codex',
      archived: false,
      createdAt: 50,
      updatedAt: 100,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Keep this',
          timestamp: '2026-09-12T00:00:00.000Z'
        }
      ],
      runs: [{ runId: 'run-1', provider: 'codex', status: 'success' }]
    } as ChatRecord
    const normalized = normalizeCatalogueChatRecord(stored, () => 'codex')
    expect(normalized.createdAt).toBe(50)
    expect(normalized.messages).toBe(stored.messages)
    expect(normalized.runs).toBe(stored.runs)
  })
})

describe('ensemble fan-out normalization', () => {
  function legacyEnsembleRecord(ensemble: Record<string, unknown> | undefined): ChatRecord {
    return {
      appChatId: 'legacy-ensemble',
      scope: 'global',
      chatKind: 'ensemble',
      title: 'Legacy ensemble',
      provider: 'codex',
      archived: false,
      messages: [],
      runs: [],
      createdAt: 1,
      updatedAt: 2,
      ...(ensemble ? { ensemble } : {})
    } as unknown as ChatRecord
  }

  const legacySeat = {
    id: 'seat-1',
    provider: 'codex',
    enabled: true,
    role: 'Boss',
    instructions: '',
    order: 1
  }

  it('does not turn fan-out on for a legacy record that never set a policy', () => {
    const normalized = normalizeCatalogueChatRecord(
      legacyEnsembleRecord({ enabled: true, maxParticipants: 20, participants: [legacySeat] }),
      () => 'codex'
    )
    expect(normalized.ensemble?.fanoutPolicy).toBeUndefined()
    expect(resolveEnsembleFanoutPolicy(normalized.ensemble)).toBe('off')
  })

  it('does not turn fan-out on for an ensemble record with no stored config', () => {
    const normalized = normalizeCatalogueChatRecord(legacyEnsembleRecord(undefined), () => 'codex')
    expect(normalized.ensemble?.participants.length).toBeGreaterThan(0)
    expect(resolveEnsembleFanoutPolicy(normalized.ensemble)).toBe('off')
  })

  it('keeps a stored policy and the legacy concurrent boolean as written', () => {
    const on = normalizeCatalogueChatRecord(
      legacyEnsembleRecord({ participants: [legacySeat], fanoutPolicy: 'all' }),
      () => 'codex'
    )
    const off = normalizeCatalogueChatRecord(
      legacyEnsembleRecord({ participants: [legacySeat], fanoutPolicy: 'off' }),
      () => 'codex'
    )
    const legacyOn = normalizeCatalogueChatRecord(
      legacyEnsembleRecord({ participants: [legacySeat], concurrentModeEnabled: true }),
      () => 'codex'
    )
    expect(resolveEnsembleFanoutPolicy(on.ensemble)).toBe('all')
    expect(resolveEnsembleFanoutPolicy(off.ensemble)).toBe('off')
    expect(resolveEnsembleFanoutPolicy(legacyOn.ensemble)).toBe('all')
  })
})
