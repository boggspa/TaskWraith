import { describe, expect, it } from 'vitest'
import { resolveRemoteSoloRuntimeProfileId } from './RemoteRuntimeProfileSelection'
import type { ChatRecord, ProviderId, RuntimeProfile } from './store/types'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    workspacePath: '/repo',
    ...overrides
  }
}

function profile(id: string, provider: ProviderId = 'codex'): RuntimeProfile {
  return {
    id,
    name: id,
    provider,
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    builtin: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }
}

describe('resolveRemoteSoloRuntimeProfileId', () => {
  it('uses the desktop remembered selection before prior-run and default profiles', () => {
    expect(
      resolveRemoteSoloRuntimeProfileId({
        chat: chat({
          providerMetadata: { runtimeProfileId: 'remembered' },
          runs: [
            {
              runId: 'run-1',
              provider: 'codex',
              runtimeProfileId: 'previous',
              startedAt: '2026-08-01T00:00:00.000Z'
            }
          ]
        }),
        provider: 'codex',
        runtimeProfiles: [profile('default'), profile('remembered'), profile('previous')]
      })
    ).toBe('remembered')
  })

  it('inherits the latest matching-provider run when no selection is remembered', () => {
    expect(
      resolveRemoteSoloRuntimeProfileId({
        chat: chat({
          runs: [
            {
              runId: 'run-1',
              provider: 'codex',
              runtimeProfileId: 'older',
              startedAt: '2026-08-01T00:00:00.000Z'
            },
            {
              runId: 'run-2',
              provider: 'claude',
              runtimeProfileId: 'other-provider',
              startedAt: '2026-08-01T00:01:00.000Z'
            },
            {
              runId: 'run-3',
              provider: 'codex',
              runtimeProfileId: 'latest',
              startedAt: '2026-08-01T00:02:00.000Z'
            }
          ]
        }),
        provider: 'codex',
        runtimeProfiles: [profile('default'), profile('older'), profile('latest')]
      })
    ).toBe('latest')
  })

  it('selects the desktop default workspace profile for a fresh chat', () => {
    expect(
      resolveRemoteSoloRuntimeProfileId({
        chat: chat(),
        provider: 'codex',
        runtimeProfiles: [profile('default')]
      })
    ).toBe('default')
  })

  it('does not attach a workspace default to a global chat', () => {
    expect(
      resolveRemoteSoloRuntimeProfileId({
        chat: chat({
          scope: 'global',
          workspacePath: undefined,
          providerMetadata: { runtimeProfileId: 'default' }
        }),
        provider: 'codex',
        runtimeProfiles: [profile('default')]
      })
    ).toBeUndefined()
  })

  it('ignores stale and cross-provider remembered profile ids', () => {
    expect(
      resolveRemoteSoloRuntimeProfileId({
        chat: chat({ providerMetadata: { runtimeProfileId: 'kimi-profile' } }),
        provider: 'codex',
        runtimeProfiles: [profile('codex-default'), profile('kimi-profile', 'kimi')]
      })
    ).toBe('codex-default')
  })
})
