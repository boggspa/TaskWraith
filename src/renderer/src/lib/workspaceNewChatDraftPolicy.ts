import { isReusableWelcomeChat, type ReusableChatLike } from './welcomeState'

export type WorkspaceNewChatOrigin = 'user' | 'startup'

export interface WorkspaceNewChatDraftLike extends ReusableChatLike {
  appChatId: string
  scope?: 'global' | 'workspace'
  chatKind?: 'single' | 'ensemble'
  workspaceId?: string
  archived?: boolean
}

export interface WorkspaceNewChatDraftContext {
  isExcluded?: (chatId: string) => boolean
}

/**
 * Select the pristine workspace draft a New Chat route may adopt. Cold startup
 * may reuse one to avoid minting a shell on every launch; an explicit user
 * action must create so the abandoned-chat reaper advances its rolling quota.
 */
export function findReusableWorkspaceNewChatDraft<T extends WorkspaceNewChatDraftLike>(
  chats: readonly T[],
  workspaceId: string,
  origin: WorkspaceNewChatOrigin,
  context: WorkspaceNewChatDraftContext = {}
): T | undefined {
  if (origin !== 'startup') return undefined
  return chats.find(
    (chat) =>
      chat.chatKind !== 'ensemble' &&
      chat.scope === 'workspace' &&
      chat.workspaceId === workspaceId &&
      !chat.archived &&
      isReusableWelcomeChat(chat) &&
      !context.isExcluded?.(chat.appChatId)
  )
}
