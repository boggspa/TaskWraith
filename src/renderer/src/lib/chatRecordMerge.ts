import type { ChatListItem, ChatRecord } from '../../../main/store/types'

export function isChatSummaryRecord(
  chat: ChatRecord | null | undefined
): chat is ChatListItem {
  return Boolean((chat as ChatListItem | null | undefined)?.summaryOnly === true)
}

export function mergeChatRecordValue(
  existing: ChatRecord | undefined,
  incoming: ChatRecord
): ChatRecord {
  if (existing && isChatSummaryRecord(incoming) && !isChatSummaryRecord(existing)) {
    const {
      summaryOnly: _summaryOnly,
      messageCount: _messageCount,
      runCount: _runCount,
      lastRun: _lastRun,
      searchText: _searchText,
      searchPreview: _searchPreview,
      messages: _messages,
      runs: _runs,
      ...summaryFields
    } = incoming
    return {
      ...existing,
      ...summaryFields,
      messages: existing.messages,
      runs: existing.runs
    }
  }
  return incoming
}

export function mergeChatRecord(chats: ChatRecord[], chat: ChatRecord): ChatRecord[] {
  const existing = chats.find((item) => item.appChatId === chat.appChatId)
  const merged = mergeChatRecordValue(existing, chat)
  const next = [merged, ...chats.filter((item) => item.appChatId !== chat.appChatId)]
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function reconcileChatRecords(
  existing: ChatRecord[],
  incoming: ChatRecord[]
): ChatRecord[] {
  return incoming
    .map((chat) =>
      mergeChatRecordValue(
        existing.find((item) => item.appChatId === chat.appChatId),
        chat
      )
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
