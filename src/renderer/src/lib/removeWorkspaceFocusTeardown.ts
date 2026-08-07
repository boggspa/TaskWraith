/**
 * When a workspace is removed from the registry, decide which focused UI
 * state must tear down. App-global currentWorkspace and the open chat's
 * primary can diverge after a thread switch; matching only the global id
 * can clear the wrong chat or leave an orphaned chat on a deleted primary.
 */

export function resolveRemoveWorkspaceFocusTeardown(input: {
  removedWorkspaceId: string
  currentWorkspaceId?: string | null
  currentChatWorkspaceId?: string | null
}): {
  clearAppGlobalWorkspace: boolean
  clearFocusedChat: boolean
  /** Global pointed at the removed id but the open chat is on another primary. */
  resyncAppGlobalFromChat: boolean
} {
  const removed = String(input.removedWorkspaceId || '').trim()
  const globalId = String(input.currentWorkspaceId || '').trim()
  const chatId = String(input.currentChatWorkspaceId || '').trim()
  const clearAppGlobalWorkspace = Boolean(removed && globalId && globalId === removed)
  const clearFocusedChat = Boolean(removed && chatId && chatId === removed)
  return {
    clearAppGlobalWorkspace,
    clearFocusedChat,
    resyncAppGlobalFromChat: clearAppGlobalWorkspace && !clearFocusedChat && Boolean(chatId)
  }
}
