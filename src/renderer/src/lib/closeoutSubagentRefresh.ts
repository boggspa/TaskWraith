import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { isSubThreadChat } from './chatScope'
import { collectCloseoutSubagentDelegations } from './taskWraithCloseoutMessage'

export type CloseoutSubagentRefreshFingerprintInput = {
  messages: readonly ChatMessage[]
  parentRunIds: ReadonlySet<string> | readonly string[]
  window?: { startedAt: string; completedAt: string }
  childChats?: readonly ChatRecord[]
}

/**
 * Stable rebuild key for Task-complete Sub-threads. Changes only when
 * in-scope delegation/return harvest or child-chat status enrichment would
 * change the tombstoned table — not on ordinary assistant/tool streaming.
 */
export function closeoutSubagentRefreshFingerprint(
  input: CloseoutSubagentRefreshFingerprintInput
): string {
  const parentRunIds =
    input.parentRunIds instanceof Set
      ? input.parentRunIds
      : new Set(Array.from(input.parentRunIds))
  const rows = collectCloseoutSubagentDelegations({
    messages: input.messages as ChatMessage[],
    parentRunIds,
    window: input.window,
    childChats: input.childChats ? Array.from(input.childChats) : undefined
  })
  if (rows.length === 0) return ''
  return rows
    .map((row) => `${row.subThreadId}:${row.status}`)
    .sort()
    .join('|')
}

/** In-memory sub-thread children of a parent (excludes side chats). */
export function childChatsForCloseout(
  parentChatId: string | null | undefined,
  chats: readonly ChatRecord[]
): ChatRecord[] {
  if (!parentChatId) return []
  return chats.filter(
    (chat) => chat.parentChatId === parentChatId && isSubThreadChat(chat)
  )
}
