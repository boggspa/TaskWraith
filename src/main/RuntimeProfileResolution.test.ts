import { describe, expect, it } from 'vitest'
import { resolveRuntimeProfileIdForChat } from './RuntimeProfileResolution'
import type { ChatRecord, ChatScope, ProviderId, RuntimeProfile } from './store/types'

const now = '2026-01-01T00:00:00.000Z'

function profile(
  id: string,
  provider: ProviderId,
  scope: ChatScope,
  name = id
): RuntimeProfile {
  return {
    id,
    name,
    provider,
    scope,
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: now,
    updatedAt: now
  }
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('resolveRuntimeProfileIdForChat', () => {
  const profiles = [
    profile('codex-workspace', 'codex', 'workspace'),
    profile('codex-global', 'codex', 'global'),
    profile('kimi-workspace', 'kimi', 'workspace')
  ]

  it('returns the workspace-scoped provider default for workspace chats', () => {
    expect(
      resolveRuntimeProfileIdForChat({
        chat: chat({ scope: 'workspace' }),
        provider: 'codex',
        profiles
      })
    ).toBe('codex-workspace')
  })

  it('returns the global-scoped provider default for global chats', () => {
    expect(
      resolveRuntimeProfileIdForChat({
        chat: chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }),
        provider: 'codex',
        profiles
      })
    ).toBe('codex-global')
  })

  it('ignores stale metadata runtime profile ids and falls back to scoped default', () => {
    expect(
      resolveRuntimeProfileIdForChat({
        chat: chat({ providerMetadata: { runtimeProfileId: 'deleted-profile' } }),
        provider: 'codex',
        profiles
      })
    ).toBe('codex-workspace')
  })

  it('ignores stale cross-provider ids and falls back to the requested provider default', () => {
    expect(
      resolveRuntimeProfileIdForChat({
        chat: chat({ providerMetadata: { runtimeProfileId: 'kimi-workspace' } }),
        provider: 'codex',
        selectionByChatId: { 'chat-1': 'kimi-workspace' },
        profiles
      })
    ).toBe('codex-workspace')
  })

  it('ignores wrong-scope metadata ids and falls back to the chat-scope default', () => {
    expect(
      resolveRuntimeProfileIdForChat({
        chat: chat({
          scope: 'global',
          workspaceId: undefined,
          workspacePath: undefined,
          providerMetadata: { runtimeProfileId: 'codex-workspace' }
        }),
        provider: 'codex',
        profiles
      })
    ).toBe('codex-global')
  })
})
