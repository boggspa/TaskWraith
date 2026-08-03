import type { ChatRecord } from '../../../main/store/types'

export function sideChatAuthorityReturnEnabled(chat: ChatRecord | null | undefined): boolean {
  return (
    chat?.parentChatRelation === 'sideChat' && chat.sideChatContext?.returnResultToParent === true
  )
}

/** Persist the user's explicit side-chat return choice without changing the
 * child provider session, permissions, transcript, or parent run state. */
export function setSideChatAuthorityReturn(
  chat: ChatRecord,
  enabled: boolean,
  now = Date.now()
): ChatRecord {
  if (chat.parentChatRelation !== 'sideChat' || !chat.parentChatId) return chat
  return {
    ...chat,
    sideChatContext: {
      createdAt: chat.sideChatContext?.createdAt || now,
      ...(chat.sideChatContext || {}),
      returnResultToParent: enabled,
      ...(enabled ? { returnResultEnabledAt: now } : { returnResultEnabledAt: undefined })
    },
    updatedAt: now
  }
}
