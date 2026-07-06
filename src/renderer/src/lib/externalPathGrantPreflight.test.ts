import { describe, expect, it } from 'vitest'
import type { ChatRecord, ExternalPathGrant } from '../../../main/store/types'
import {
  externalPathGrantTargetsForChat,
  findExternalPathGrantGaps,
  missingExternalPathGrantProviders
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
    createdAt: partial.createdAt || new Date().toISOString()
  }
}

function ensembleChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Ensemble',
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
        { id: 'p3', provider: 'claude', role: 'Claude', order: 3, enabled: true, model: 'cli-default', instructions: '' }
      ],
      updatedAt: new Date().toISOString()
    }
  }
}

describe('externalPathGrantPreflight', () => {
  it('targets dispatch providers only (excludes Ollama)', () => {
    expect(externalPathGrantTargetsForChat(ensembleChat())).toEqual(['codex', 'claude'])
  })

  it('reports gaps when additional workspace lacks grants for panelists', () => {
    const chat = ensembleChat()
    const grants = [grant({ provider: 'codex', path: '/extra/repo' })]
    const result = findExternalPathGrantGaps({
      chat,
      grants,
      primaryWorkspacePath: '/primary'
    })
    expect(result.paths).toEqual(['/extra/repo'])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.missingProviders).toEqual(['claude'])
  })

  it('reports all dispatch panelists missing for a newly attached path', () => {
    const chat = ensembleChat()
    expect(
      missingExternalPathGrantProviders({
        chat,
        grants: [],
        path: '/new/workspace'
      })
    ).toEqual(['codex', 'claude'])
  })

  it('treats read grants as missing when a write grant is requested', () => {
    const chat = ensembleChat()
    expect(
      missingExternalPathGrantProviders({
        chat,
        grants: [
          grant({ provider: 'codex', path: '/new/workspace', access: 'read' }),
          grant({ provider: 'claude', path: '/new/workspace', access: 'write' })
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
        grant({ provider: 'codex', path: '/extra/repo', access: 'read' }),
        grant({ provider: 'claude', path: '/extra/repo', access: 'write' })
      ],
      primaryWorkspacePath: '/primary'
    })
    expect(result.gaps).toEqual([
      { path: '/extra/repo', access: 'write', missingProviders: ['codex'] }
    ])
  })

  it('returns no gaps when every dispatch panelist has a grant', () => {
    const chat = ensembleChat()
    const grants = [
      grant({ provider: 'codex', path: '/extra/repo' }),
      grant({ provider: 'claude', path: '/extra/repo' }),
      grant({ provider: 'ollama', path: '/extra/repo' })
    ]
    const result = findExternalPathGrantGaps({
      chat,
      grants,
      primaryWorkspacePath: '/primary'
    })
    expect(result.gaps).toEqual([])
  })
})
