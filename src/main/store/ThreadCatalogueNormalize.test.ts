import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './types'
import { normalizeCatalogueChatRecord } from './ThreadCatalogueNormalize'

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
