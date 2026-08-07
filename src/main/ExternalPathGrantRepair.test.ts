import { describe, expect, it, vi } from 'vitest'
import { EXTERNAL_PATH_GRANT_BINDING_VERSION } from './ExternalPathGrantBinding'
import { repairStaleExternalPathGrantsForChat } from './ExternalPathGrantRepair'
import type { ChatRecord, ExternalPathGrant, ProviderId } from './store/types'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Ensemble',
    workspaceId: 'ws-new',
    workspacePath: '/primary',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      participants: [
        {
          id: 'p1',
          provider: 'codex',
          role: 'Codex',
          order: 1,
          enabled: true,
          model: 'cli-default',
          instructions: ''
        },
        {
          id: 'p2',
          provider: 'ollama',
          role: 'Local',
          order: 2,
          enabled: true,
          model: 'cli-default',
          instructions: ''
        }
      ],
      updatedAt: new Date().toISOString()
    },
    ...overrides
  }
}

function grant(partial: Partial<ExternalPathGrant> & Pick<ExternalPathGrant, 'provider'>): ExternalPathGrant {
  return {
    id: partial.id || `g-${partial.provider}`,
    provider: partial.provider,
    path: partial.path || '/extra',
    kind: 'directory',
    access: partial.access || 'write',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'a'.repeat(64),
    createdAt: '2026-08-07T00:00:00.000Z',
    bindingVersion: EXTERNAL_PATH_GRANT_BINDING_VERSION,
    chatId: 'chat-1',
    workspaceId: partial.workspaceId || 'ws-old',
    ...partial
  }
}

describe('repairStaleExternalPathGrantsForChat', () => {
  it('remints every active provider when prior consent exists under a stale primary workspace id', async () => {
    let saved: ChatRecord | null = null
    const issued: ExternalPathGrant[] = []
    const seed = chat({
      providerMetadata: {
        externalPathGrants: [
          grant({ provider: 'codex', workspaceId: 'ws-old' }),
          grant({ provider: 'ollama', workspaceId: 'ws-old' })
        ]
      }
    })
    const result = await repairStaleExternalPathGrantsForChat('chat-1', {
      getChat: () => saved || seed,
      saveChat: (next) => {
        saved = next
      },
      broadcastChatUpdated: vi.fn(),
      collectExternalPathGrantsFromMetadata: (metadata) =>
        Array.isArray(metadata?.externalPathGrants)
          ? (metadata.externalPathGrants as ExternalPathGrant[])
          : [],
      canonicalizeExternalPathGrantMetadata: (_metadata, nextGrants) => ({
        externalPathGrants: nextGrants || []
      }),
      grantProvidersForChat: () => ['codex', 'ollama'] as ProviderId[],
      issueExternalPathGrant: (input) => {
        const minted = {
          ...input,
          issuedBy: 'main' as const,
          signature: 'b'.repeat(64),
          bindingVersion: EXTERNAL_PATH_GRANT_BINDING_VERSION,
          workspaceId: 'ws-new',
          chatId: 'chat-1'
        }
        issued.push(minted)
        return minted
      },
      verifyExternalPathGrantSignatureForGrant: () => true,
      realpath: async (pathValue) => pathValue,
      stat: async () => ({ isDirectory: () => true }),
      primaryWorkspacePathForChat: () => '/primary'
    })

    expect('ok' in result && result.ok === false).toBe(false)
    if ('ok' in result) throw new Error('expected repair result')
    expect(result.repairedPaths).toEqual(['/extra'])
    expect(result.remainingGaps).toEqual([])
    expect(issued.map((entry) => entry.provider).sort()).toEqual(['codex', 'ollama'])
    expect(issued.every((entry) => entry.workspaceId === 'ws-new')).toBe(true)
  })

  it('leaves a remaining gap when the path has no prior signed consent', async () => {
    const seed = chat({
      providerMetadata: {
        externalPathGrants: [
          {
            id: 'forged',
            provider: 'codex',
            path: '/extra',
            kind: 'directory',
            access: 'read',
            duration: 'thisThread',
            createdAt: '2026-08-07T00:00:00.000Z'
          }
        ]
      }
    })
    const result = await repairStaleExternalPathGrantsForChat('chat-1', {
      getChat: () => seed,
      saveChat: vi.fn(),
      broadcastChatUpdated: vi.fn(),
      collectExternalPathGrantsFromMetadata: (metadata) =>
        Array.isArray(metadata?.externalPathGrants)
          ? (metadata.externalPathGrants as ExternalPathGrant[])
          : [],
      canonicalizeExternalPathGrantMetadata: (_metadata, nextGrants) => ({
        externalPathGrants: nextGrants || []
      }),
      grantProvidersForChat: () => ['codex', 'ollama'] as ProviderId[],
      issueExternalPathGrant: vi.fn(),
      verifyExternalPathGrantSignatureForGrant: () => false,
      realpath: async (pathValue) => pathValue,
      stat: async () => ({ isDirectory: () => true }),
      primaryWorkspacePathForChat: () => '/primary'
    })

    expect('ok' in result && result.ok === false).toBe(false)
    if ('ok' in result) throw new Error('expected repair result')
    expect(result.repairedPaths).toEqual([])
    expect(result.remainingGaps).toEqual([
      {
        path: '/extra',
        access: 'read',
        missingProviders: ['codex', 'ollama']
      }
    ])
  })
})
