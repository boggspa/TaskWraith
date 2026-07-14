import { describe, expect, it } from 'vitest'
import type { ExternalPathGrant } from '../../../main/store/types'
import {
  buildExternalWorkspaceOwnerTargets,
  externalWorkspaceOwnerKey,
  projectExternalWorkspaceOwnerCache,
  repositoryUiStateKey
} from './externalWorkspaceOwnerState'

const grant = (
  id: string,
  chatId: string,
  path: string,
  provider: ExternalPathGrant['provider'] = 'codex'
): ExternalPathGrant => ({
  id,
  chatId,
  workspaceId: 'workspace-1',
  path,
  provider,
  kind: 'directory',
  access: 'write',
  duration: 'thisThread',
  createdAt: '2026-07-13T00:00:00.000Z',
  signature: `signature-${id}`
})

describe('externalWorkspaceOwnerState', () => {
  it('keeps the same external path separate for different chats', () => {
    const grants = [
      grant('a', 'chat-a', '/shared/repo'),
      grant('b', 'chat-b', '/shared/repo'),
      grant('c', 'chat-a', '/shared/repo', 'claude')
    ]

    expect(buildExternalWorkspaceOwnerTargets(grants)).toEqual([
      {
        ownerKey: externalWorkspaceOwnerKey('chat-a', '/shared/repo'),
        chatId: 'chat-a',
        path: '/shared/repo'
      },
      {
        ownerKey: externalWorkspaceOwnerKey('chat-b', '/shared/repo'),
        chatId: 'chat-b',
        path: '/shared/repo'
      }
    ])
  })

  it('projects composite cache entries only through each chat grant', () => {
    const chatAGrants = [grant('a', 'chat-a', '/shared/repo')]
    const chatBGrants = [grant('b', 'chat-b', '/shared/repo')]
    const cache = {
      [externalWorkspaceOwnerKey('chat-a', '/shared/repo')]: 'snapshot-a',
      [externalWorkspaceOwnerKey('chat-b', '/shared/repo')]: 'snapshot-b'
    }

    expect(projectExternalWorkspaceOwnerCache(chatAGrants, cache)).toEqual({
      '/shared/repo': 'snapshot-a'
    })
    expect(projectExternalWorkspaceOwnerCache(chatBGrants, cache)).toEqual({
      '/shared/repo': 'snapshot-b'
    })
  })

  it('separates registered and external create-PR state ownership', () => {
    expect(repositoryUiStateKey('/shared/repo')).not.toBe(
      repositoryUiStateKey('/shared/repo', 'chat-a')
    )
    expect(repositoryUiStateKey('/shared/repo', 'chat-a')).not.toBe(
      repositoryUiStateKey('/shared/repo', 'chat-b')
    )
  })
})
