import { describe, expect, it } from 'vitest'
import { resolveRemoveWorkspaceFocusTeardown } from './removeWorkspaceFocusTeardown'

describe('resolveRemoveWorkspaceFocusTeardown', () => {
  it('does not clear the focused chat when only the stale app-global primary is removed', () => {
    // Regression: chat on Test 1, app-global still AGBench — removing AGBench
    // must not null the open Test 1 chat.
    expect(
      resolveRemoveWorkspaceFocusTeardown({
        removedWorkspaceId: 'ws-agbench',
        currentWorkspaceId: 'ws-agbench',
        currentChatWorkspaceId: 'ws-test1'
      })
    ).toEqual({
      clearAppGlobalWorkspace: true,
      clearFocusedChat: false,
      resyncAppGlobalFromChat: true
    })
  })

  it('clears the focused chat when its primary is removed even if app-global differs', () => {
    expect(
      resolveRemoveWorkspaceFocusTeardown({
        removedWorkspaceId: 'ws-test1',
        currentWorkspaceId: 'ws-agbench',
        currentChatWorkspaceId: 'ws-test1'
      })
    ).toEqual({
      clearAppGlobalWorkspace: false,
      clearFocusedChat: true,
      resyncAppGlobalFromChat: false
    })
  })

  it('clears both when app-global and chat primary match the removed id', () => {
    expect(
      resolveRemoveWorkspaceFocusTeardown({
        removedWorkspaceId: 'ws-agbench',
        currentWorkspaceId: 'ws-agbench',
        currentChatWorkspaceId: 'ws-agbench'
      })
    ).toEqual({
      clearAppGlobalWorkspace: true,
      clearFocusedChat: true,
      resyncAppGlobalFromChat: false
    })
  })

  it('no-ops when neither binding matches', () => {
    expect(
      resolveRemoveWorkspaceFocusTeardown({
        removedWorkspaceId: 'ws-other',
        currentWorkspaceId: 'ws-agbench',
        currentChatWorkspaceId: 'ws-test1'
      })
    ).toEqual({
      clearAppGlobalWorkspace: false,
      clearFocusedChat: false,
      resyncAppGlobalFromChat: false
    })
  })
})
