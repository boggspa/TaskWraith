import type { ChatRecord, ChatWorkflowMode } from '../../../main/store/types'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from './chatRecordMerge'

/**
 * Ensemble dispatch sends a chat id to main, which owns its transcript. A full
 * chrome shell already carries the roster, workspace and permission metadata
 * used by renderer preflight. Hydrating history first only serializes Send
 * behind a full-record catalogue read.
 *
 * Solo dispatch still appends/persists transcript rows in the renderer, and a
 * workflow-mode change still uses a whole-record save, so both need hydration.
 * A catalogue-only fallback shell is not the full preflight metadata either.
 */
export function needsDispatchHistoryHydration(
  chat: ChatRecord,
  workflowMode: ChatWorkflowMode | undefined
): boolean {
  if (
    chat.chatKind === 'ensemble' &&
    chat.ensemble &&
    isTranscriptPagedShell(chat) &&
    chat.catalogueProjection !== true &&
    chat.workflowMode === (workflowMode || 'normal')
  ) {
    return false
  }
  return isChatSummaryRecord(chat) || !Array.isArray(chat.messages) || !Array.isArray(chat.runs)
}
