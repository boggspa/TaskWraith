import { describe, expect, it } from 'vitest'
import type { ChatRecord, ExternalPathGrant } from '../../../main/store/types'
import {
  externalPathGrantTargetsForChat,
  findExternalPathGrantGaps,
  missingExternalPathGrantProviders,
  pathHasPriorConsentExternalPathGrant
} from './externalPathGrantPreflight'

function grant(partial: Partial<ExternalPathGrant> & Pick<ExternalPathGrant, 'provider' | 'path'>): ExternalPathGrant {
  return {
    id: partial.id || 'g-1',
    provider: partial.provider,
    path: partial.path,
    kind: partial.kind || 'directory',
    access: partial.access || 'read',
    duration: partial.duration || 'thisThread',
    issuedBy: partial.issuedBy || 'main',
    signature: partial.signature || 'abc',
    createdAt: partial.createdAt || new Date().toISOString(),
    ...(partial.bindingVersion !== undefined ? { bindingVersion: partial.bindingVersion } : {}),
    ...(partial.chatId !== undefined ? { chatId: partial.chatId } : {}),
    ...(partial.workspaceId !== undefined ? { workspaceId: partial.workspaceId } : {})
  }
}

function boundGrant(
  partial: Partial<ExternalPathGrant> & Pick<ExternalPathGrant, 'provider' | 'path'>
): ExternalPathGrant {
  return grant({
    bindingVersion: 2,
    chatId: 'chat-1',
    workspaceId: 'ws-primary',
    ...partial
  })
}

function ensembleChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Ensemble',
    workspaceId: 'ws-primary',
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
        { id: 'p1', provider: 'codex', role: 'Codex', order: 1, enabled: true, model: 'cli-default', instructions: '' },
        { id: 'p2', provider: 'ollama', role: 'Local', order: 2, enabled: true, model: 'cli-default', instructions: '' },
        { id: 'p3', provider: 'gemini', role: 'Historical', order: 3, enabled: true, model: 'cli-default', instructions: '' },
        { id: 'p4', provider: 'claude', role: 'Claude', order: 4, enabled: true, model: 'cli-default', instructions: '' }
      ],
      updatedAt: new Date().toISOString()
    }
  }
}

describe('externalPathGrantPreflight', () => {
  it('targets every active live provider and excludes retired Gemini', () => {
    expect(externalPathGrantTargetsForChat(ensembleChat())).toEqual([
      'codex',
      'ollama',
      'claude'
    ])
  })

  it('reports gaps when an additional workspace lacks active-provider grants', () => {
    const chat = ensembleChat()
    const grants = [boundGrant({ provider: 'codex', path: '/extra/repo' })]
    const result = findExternalPathGrantGaps({
      chat,
      grants,
      primaryWorkspacePath: '/primary'
    })
    expect(result.paths).toEqual(['/extra/repo'])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.missingProviders).toEqual(['ollama', 'claude'])
  })

  it('reports every active live provider missing for a newly attached path', () => {
    const chat = ensembleChat()
    expect(
      missingExternalPathGrantProviders({
        chat,
        grants: [],
        path: '/new/workspace'
      })
    ).toEqual(['codex', 'ollama', 'claude'])
  })

  it('treats read grants as missing when a write grant is requested', () => {
    const chat = ensembleChat()
    expect(
      missingExternalPathGrantProviders({
        chat,
        grants: [
          boundGrant({ provider: 'codex', path: '/new/workspace', access: 'read' }),
          boundGrant({ provider: 'ollama', path: '/new/workspace', access: 'write' }),
          boundGrant({ provider: 'claude', path: '/new/workspace', access: 'write' })
        ],
        path: '/new/workspace',
        access: 'write'
      })
    ).toEqual(['codex'])
  })

  it('reports write gaps when a path has mixed read and write provider grants', () => {
    const chat = ensembleChat()
    const result = findExternalPathGrantGaps({
      chat,
      grants: [
        boundGrant({ provider: 'codex', path: '/extra/repo', access: 'read' }),
        boundGrant({ provider: 'ollama', path: '/extra/repo', access: 'write' }),
        boundGrant({ provider: 'claude', path: '/extra/repo', access: 'write' })
      ],
      primaryWorkspacePath: '/primary'
    })
    expect(result.gaps).toEqual([
      { path: '/extra/repo', access: 'write', missingProviders: ['codex'] }
    ])
  })

  it('returns no gaps when every active live provider has a chat-bound grant', () => {
    const chat = ensembleChat()
    const grants = [
      boundGrant({ provider: 'codex', path: '/extra/repo' }),
      boundGrant({ provider: 'claude', path: '/extra/repo' }),
      boundGrant({ provider: 'ollama', path: '/extra/repo' })
    ]
    const result = findExternalPathGrantGaps({
      chat,
      grants,
      primaryWorkspacePath: '/primary'
    })
    expect(result.gaps).toEqual([])
  })

  it('treats grants bound to a previous primary workspace id as gaps', () => {
    const chat = ensembleChat()
    chat.workspaceId = 'ws-readded'
    const grants = [
      grant({
        provider: 'codex',
        path: '/extra/repo',
        bindingVersion: 2,
        chatId: 'chat-1',
        workspaceId: 'ws-original'
      }),
      grant({
        provider: 'ollama',
        path: '/extra/repo',
        bindingVersion: 2,
        chatId: 'chat-1',
        workspaceId: 'ws-original'
      }),
      grant({
        provider: 'claude',
        path: '/extra/repo',
        bindingVersion: 2,
        chatId: 'chat-1',
        workspaceId: 'ws-original'
      })
    ]
    const result = findExternalPathGrantGaps({
      chat,
      grants,
      primaryWorkspacePath: '/primary'
    })
    expect(result.gaps).toEqual([
      {
        path: '/extra/repo',
        access: 'read',
        missingProviders: ['codex', 'ollama', 'claude']
      }
    ])
    expect(pathHasPriorConsentExternalPathGrant(grants, '/extra/repo')).toBe(true)
  })
})
