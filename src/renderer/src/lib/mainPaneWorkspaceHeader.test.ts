import { describe, expect, it } from 'vitest'
import { resolveMainPaneWorkspaceLabel } from './mainPaneWorkspaceHeader'

const test2 = {
  id: 'workspace-test-2',
  path: '/Users/chrisizatt/Documents/Test 2',
  displayName: 'Test 2'
}
const test3 = {
  id: 'workspace-test-3',
  path: '/Users/chrisizatt/Documents/Test 3',
  displayName: 'Test 3'
}

describe('resolveMainPaneWorkspaceLabel', () => {
  it('prefers the focused chat workspace over stale app-global workspace state', () => {
    expect(
      resolveMainPaneWorkspaceLabel({
        chat: { workspaceId: test2.id, workspacePath: test2.path },
        isGlobalChat: false,
        workspaces: [test2, test3],
        currentWorkspace: test3,
        snapshotRepoRoot: test3.path
      })
    ).toBe('Test 2')
  })

  it('falls back to the chat path when its workspace record is unavailable', () => {
    expect(
      resolveMainPaneWorkspaceLabel({
        chat: { workspaceId: 'missing', workspacePath: test2.path },
        isGlobalChat: false,
        workspaces: [test3],
        currentWorkspace: test3
      })
    ).toBe('Test 2')
  })

  it('suppresses stale workspace state for global chats', () => {
    expect(
      resolveMainPaneWorkspaceLabel({
        chat: {},
        isGlobalChat: true,
        workspaces: [test3],
        currentWorkspace: test3
      })
    ).toBeNull()
  })

  it('uses the current workspace when no chat has been selected yet', () => {
    expect(
      resolveMainPaneWorkspaceLabel({
        chat: null,
        isGlobalChat: false,
        workspaces: [test3],
        currentWorkspace: test3
      })
    ).toBe('Test 3')
  })

  it('does not let stale git snapshot metadata rename another chat workspace', () => {
    expect(
      resolveMainPaneWorkspaceLabel({
        chat: { workspaceId: test2.id, workspacePath: test2.path },
        isGlobalChat: false,
        workspaces: [test2, test3],
        currentWorkspace: test3,
        snapshotRepoRoot: '/Users/chrisizatt/Documents/Stale Repo',
        snapshotRemoteUrl: 'git@github.com:example/stale-repo.git'
      })
    ).toBe('Test 2')
  })
})
