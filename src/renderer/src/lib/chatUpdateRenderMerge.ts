import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { anchorPendingAgentQuestionMarkers } from './agentQuestionMarkerAnchor'
import { shouldPreferLiveAssistantContent } from './chatUpdatedAssistantMerge'
import { preserveOptimisticEnsembleQueue } from './queuedMessageRows'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'

export interface PendingChatUpdateRender {
  chat: ChatRecord
  messagesChanged: boolean
  hasActiveRun: boolean
  hadRecentRun: boolean
}

export interface ChatUpdateRenderMergeOptions {
  liveChat?: ChatRecord | null
  messagesChanged: boolean
  hasActiveRun: boolean
  hadRecentRun: boolean
  pendingMarkerIds?: ReadonlySet<string>
}

function mergeLiveMessages(
  incomingMessages: readonly ChatMessage[],
  liveMessages: readonly ChatMessage[]
): ChatMessage[] | null {
  const liveById = new Map(liveMessages.map((message) => [message.id, message]))
  let changed = false
  const mergedMessages = incomingMessages.map((message) => {
    const live = liveById.get(message.id)
    if (live && shouldPreferLiveAssistantContent(message, live)) {
      changed = true
      return { ...message, content: live.content }
    }
    return message
  })

  const incomingIds = new Set(incomingMessages.map((message) => message.id))
  const orphanedLiveAssistants = liveMessages.filter(
    (message) => message.role === 'assistant' && !incomingIds.has(message.id)
  )
  const orphanedAgentQuestionMarkers = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === 'agentQuestion' &&
      !incomingIds.has(message.id)
  )
  const orphanedContextCompactionCards = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === 'contextCompaction' &&
      !incomingIds.has(message.id)
  )
  const orphanedTaskWraithCloseouts = liveMessages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND &&
      !incomingIds.has(message.id)
  )
  const orphanIds = new Set(
    [
      ...orphanedLiveAssistants,
      ...orphanedAgentQuestionMarkers,
      ...orphanedContextCompactionCards,
      ...orphanedTaskWraithCloseouts
    ].map((message) => message.id)
  )
  const orphans = liveMessages.filter((message) => orphanIds.has(message.id))
  if (orphans.length > 0) changed = true
  if (!changed) return null
  return orphans.length > 0 ? [...mergedMessages, ...orphans] : mergedMessages
}

/**
 * Merge a main-owned chat update with renderer-only live content. This is
 * deliberately a separate frame-time operation: the IPC callback can accept
 * and queue a patch without blocking prompt input on transcript reconciliation.
 */
export function mergeChatUpdatedForRender(
  chat: ChatRecord,
  options: ChatUpdateRenderMergeOptions
): ChatRecord {
  const liveChat = options.liveChat
  let merged = chat
  if ((options.hasActiveRun || options.hadRecentRun) && liveChat) {
    if (!options.messagesChanged) {
      // The main patch changed metadata only. The live ref already contains
      // the renderer's newest transcript, including synthetic local rows.
      if (liveChat.messages !== chat.messages) {
        merged = { ...chat, messages: liveChat.messages }
      }
    } else if (liveChat.messages.length > 0) {
      const mergedMessages = mergeLiveMessages(chat.messages, liveChat.messages)
      if (mergedMessages) {
        merged = { ...chat, messages: mergedMessages }
      }
    }
  }

  merged = preserveOptimisticEnsembleQueue(merged, liveChat)
  const pendingMarkerIds = options.pendingMarkerIds
  if (pendingMarkerIds && pendingMarkerIds.size > 0) {
    const anchoredMessages = anchorPendingAgentQuestionMarkers(
      merged.messages,
      liveChat?.messages || [],
      pendingMarkerIds
    )
    if (anchoredMessages !== merged.messages) {
      merged = { ...merged, messages: anchoredMessages }
    }
  }
  return merged
}
