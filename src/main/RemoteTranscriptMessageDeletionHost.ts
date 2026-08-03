import type { ChatRecord } from './store/types'
import { deleteTranscriptMessage } from './RemoteTranscriptMessageDeletion'

export interface RemoteTranscriptMessageDeletionAction {
  workspaceId: string
  threadId: string
  messageId: string
}

export interface RemoteTranscriptMessageDeletionHostDeps {
  getChat(threadId: string): ChatRecord | null | undefined
  canonicalWorkspaceId(workspaceId: string | null | undefined): string | null
  listPendingQuestionIds(threadId: string): readonly string[]
  saveChat(chat: ChatRecord): void
  broadcastChatUpdated(chat: ChatRecord): void
  pushRemoteThreadSnapshot(chat: ChatRecord, workspaceId: string): void
  now?: () => number
}

export type RemoteTranscriptMessageDeletionHostResult = { ok: true } | { ok: false; error: string }

const OPEN_ANCHOR_ERROR = 'Answer or dismiss the open prompt before deleting this message.'

/**
 * Revalidate, persist, and broadcast one remote transcript deletion.
 *
 * The composition root supplies canonical workspace identity, pending-question
 * state, and the existing AppStore save/broadcast hooks. Saving through the
 * ordinary AppStore path is load-bearing: its feedback-ledger hook removes
 * receipts for a deleted rated assistant message.
 */
export function handleRemoteTranscriptMessageDeletion(
  action: RemoteTranscriptMessageDeletionAction,
  deps: RemoteTranscriptMessageDeletionHostDeps
): RemoteTranscriptMessageDeletionHostResult {
  const chat = deps.getChat(action.threadId)
  if (!chat) return { ok: false, error: 'Thread not found' }

  const workspaceId = deps.canonicalWorkspaceId(chat.workspaceId)
  if (!workspaceId || workspaceId !== action.workspaceId) {
    return { ok: false, error: 'Thread does not belong to this workspace' }
  }

  const result = deleteTranscriptMessage(chat, action.messageId, {
    pendingQuestionIds: new Set(deps.listPendingQuestionIds(action.threadId)),
    now: deps.now
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.reason === 'open-prompt-anchor' ? OPEN_ANCHOR_ERROR : 'Message not found'
    }
  }

  deps.saveChat(result.chat)
  deps.broadcastChatUpdated(result.chat)
  deps.pushRemoteThreadSnapshot(result.chat, workspaceId)
  return { ok: true }
}
