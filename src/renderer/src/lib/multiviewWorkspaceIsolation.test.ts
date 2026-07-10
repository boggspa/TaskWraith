import { describe, expect, it } from 'vitest'
import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatRecord, ExternalPathGrant, ProviderId } from '../../../main/store/types'
import {
  applyExternalPathGrantsToChat,
  deriveChatExternalWorkspaceState
} from './multiviewWorkspaceIsolation'

const grant = (id: string, path: string, provider: ProviderId = 'codex'): ExternalPathGrant => ({
  id,
  provider,
  path,
  kind: 'directory',
  access: 'write',
  duration: 'thisThread',
  issuedBy: 'main',
  signature: `signed-${id}`,
  createdAt: '2026-07-10T10:00:00.000Z'
})

const chat = (
  appChatId: string,
  workspaceId: string,
  grants: ExternalPathGrant[],
  scope: ChatRecord['scope'] = 'workspace'
): ChatRecord => ({
  appChatId,
  scope,
  title: appChatId,
  workspaceId,
  workspacePath: `/workspaces/${workspaceId}`,
  providerMetadata: { externalPathGrants: grants },
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  messages: [],
  runs: []
})

describe('Multiview secondary-workspace isolation', () => {
  it('projects only the viewer chat grants from shared visible-pane caches', () => {
    const focused = chat('focused', 'workspace-a', [grant('alpha', '/repos/alpha')])
    const viewer = chat('viewer', 'workspace-b', [
      grant('beta-codex', '/repos/beta'),
      grant('beta-claude', '/repos/beta', 'claude'),
      grant('gamma', '/repos/gamma')
    ])
    const repoMetadataByPath = {
      '/repos/alpha': { isRepo: true, repoRoot: '/repos/alpha', branch: 'alpha-branch' },
      '/repos/beta': { isRepo: true, repoRoot: '/repos/beta', branch: 'beta-branch' },
      '/repos/gamma': { isRepo: true, repoRoot: '/repos/gamma', branch: 'gamma-branch' }
    }
    const gitSnapshotsByPath = {
      '/repos/alpha': { branch: 'alpha-branch' } as GitRepositorySnapshot,
      '/repos/beta': { branch: 'beta-branch' } as GitRepositorySnapshot,
      '/repos/gamma': { branch: 'gamma-branch' } as GitRepositorySnapshot
    }
    const prByPath = {
      '/repos/alpha': { number: 1 } as GitPrSummary,
      '/repos/beta': { number: 2 } as GitPrSummary,
      '/repos/gamma': { number: 3 } as GitPrSummary
    }

    const focusedState = deriveChatExternalWorkspaceState(focused, {
      repoMetadataByPath,
      gitSnapshotsByPath,
      prByPath
    })
    const viewerState = deriveChatExternalWorkspaceState(viewer, {
      repoMetadataByPath,
      gitSnapshotsByPath,
      prByPath
    })

    expect(focusedState.externalPathGrants.map((item) => item.path)).toEqual(['/repos/alpha'])
    expect(Object.keys(viewerState.externalPathRepoMetadata)).toEqual([
      'beta-claude',
      'beta-codex',
      'gamma'
    ])
    expect(viewerState.externalWorkspaceGroups.map((group) => group.path)).toEqual([
      '/repos/beta',
      '/repos/gamma'
    ])
    expect(viewerState.externalWorkspaceGroups[0].providers).toEqual(['claude', 'codex'])
    expect(Object.keys(viewerState.externalGitSnapshots)).toEqual(['/repos/beta', '/repos/gamma'])
    expect(Object.keys(viewerState.externalPrByPath)).toEqual(['/repos/beta', '/repos/gamma'])
    expect(viewerState.externalPathRepoMetadata['beta-codex']?.branch).toBe('beta-branch')
    expect(viewerState.externalGitSnapshots['/repos/alpha']).toBeUndefined()
    expect(viewerState.externalPrByPath['/repos/alpha']).toBeUndefined()
  })

  it('ignores persisted secondary-workspace metadata on global chats', () => {
    const globalChat = chat('global', 'stale-workspace', [grant('stale', '/repos/stale')], 'global')
    expect(deriveChatExternalWorkspaceState(globalChat)).toEqual({
      externalPathGrants: [],
      externalWorkspaceGroups: [],
      externalPathRepoMetadata: {},
      externalGitSnapshots: {},
      externalPrByPath: {}
    })
  })

  it('binds pane mutations to the viewer chat and workspace', () => {
    const viewer = chat('viewer', 'workspace-b', [])
    const incoming = grant('beta', '/repos/beta')
    incoming.chatId = 'focused'
    incoming.workspaceId = 'workspace-a'

    const updated = applyExternalPathGrantsToChat(viewer, [incoming], 42)
    const persisted = updated.providerMetadata?.externalPathGrants as ExternalPathGrant[]

    expect(updated.updatedAt).toBe(42)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      id: 'beta',
      chatId: 'viewer',
      workspaceId: 'workspace-b',
      path: '/repos/beta'
    })
  })
})
