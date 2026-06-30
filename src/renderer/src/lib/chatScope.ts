import type { ChatRecord, ProviderId, ChatScope } from '../../../main/store/types'

const GLOBAL_USAGE_WORKSPACE_ID = '__taskwraith_global_chats__'

const getChatProvider = (chat?: ChatRecord | null): ProviderId => chat?.provider || 'gemini'
// Display-only provider identity. Ensemble chats carry a seed `provider` (e.g. 'grok') for
// runtime routing, which made badges/labels mislabel the chat as that provider (W4). This
// helper returns 'ensemble' for ensemble chats so DISPLAY surfaces can render an ensemble
// identity. It deliberately delegates to getChatProvider for the fallback so both stay in
// sync. Never use this for runtime provider selection — that path must stay ProviderId-typed.
type ChatDisplayProvider = ProviderId | 'ensemble'
const getChatDisplayProvider = (chat?: ChatRecord | null): ChatDisplayProvider =>
  chat?.chatKind === 'ensemble' ? 'ensemble' : getChatProvider(chat)
const getChatScope = (chat?: Pick<ChatRecord, 'scope'> | null): ChatScope =>
  chat?.scope === 'global' ? 'global' : 'workspace'
const isGlobalChat = (chat?: Pick<ChatRecord, 'scope'> | null): boolean =>
  getChatScope(chat) === 'global'
const isSubThreadChat = (
  chat?: Pick<ChatRecord, 'parentChatId' | 'parentChatRelation'> | null
): boolean =>
  Boolean(
    chat?.parentChatId &&
      (chat.parentChatRelation === undefined || chat.parentChatRelation === 'subThread')
  )
const getUsageWorkspaceIdForChat = (chat?: ChatRecord | null): string | undefined =>
  isGlobalChat(chat) ? GLOBAL_USAGE_WORKSPACE_ID : chat?.workspaceId

export {
  GLOBAL_USAGE_WORKSPACE_ID,
  getChatProvider,
  getChatDisplayProvider,
  getChatScope,
  isGlobalChat,
  isSubThreadChat,
  getUsageWorkspaceIdForChat
}
export type { ChatDisplayProvider }
