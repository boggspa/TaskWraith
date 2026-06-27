import type { ChatRecord, ProviderId } from '../../../main/store/types'
import { getChatProvider } from './chatScope'
import {
  getSideChatMode,
  getSideChatSelectedParticipantId,
  isTerminatedSideChat,
  type SideChatCreateMode
} from './sideChatLifecycle'

export interface FindReusableSideChatFilters {
  mode?: SideChatCreateMode
  provider?: ProviderId
  selectedParticipantId?: string
}

export function findReusableSideChat(
  parentChatId: string | null | undefined,
  chats: readonly ChatRecord[],
  filters: FindReusableSideChatFilters = {}
): ChatRecord | null {
  if (!parentChatId) return null
  const { mode, provider, selectedParticipantId } = filters
  const linked = chats
    .filter(
      (chat) =>
        !chat.archived &&
        !isTerminatedSideChat(chat) &&
        chat.parentChatId === parentChatId &&
        chat.parentChatRelation === 'sideChat' &&
        (!mode || getSideChatMode(chat) === mode) &&
        (!provider || getChatProvider(chat) === provider) &&
        (!selectedParticipantId ||
          getSideChatSelectedParticipantId(chat) === selectedParticipantId)
    )
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  return linked[0] || null
}
