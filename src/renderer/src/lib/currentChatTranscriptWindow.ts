import { useMemo } from 'react'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { useChatTranscript } from './useChatTranscript'

/**
 * Read-path fix for paged opens (Stage 1b follow-up): ONE shared seam for
 * features that need the current chat's transcript. On a transcriptPaged
 * shell the record's `messages`/`runs` are empty arrays; this hook exposes
 * the store's loaded window instead, marked `paged` so callers can tell a
 * window from the canonical arrays.
 *
 * Class discipline (blackboard `renderer-read-path-rule`):
 * - CLASS T (tail-sufficient: current-run / latest-message features) read
 *   `messages`/`runs` here directly.
 * - CLASS W (whole-transcript features) must NOT compute from this window:
 *   escalate to full hydration first (the App-side refreshSingleChat path),
 *   then read the hydrated record.
 */
export interface CurrentChatTranscriptWindow {
  /** True when the chat record is a paged shell and messages/runs come from the store window. */
  paged: boolean
  /** Window has unloaded older history (only meaningful while paged). */
  hasOlder: boolean
  messages: ChatMessage[]
  runs: ChatRun[]
}

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_RUNS: ChatRun[] = []

/** Pure derivation, split from the hook so the decision logic is unit-testable. */
export function resolveCurrentChatTranscriptWindow(
  chat: ChatRecord | null | undefined,
  payload: { messages: ChatMessage[]; runs: ChatRun[]; hasOlder: boolean } | null
): CurrentChatTranscriptWindow {
  if (!chat) {
    return { paged: false, hasOlder: false, messages: EMPTY_MESSAGES, runs: EMPTY_RUNS }
  }
  if (!isTranscriptPagedShell(chat)) {
    return {
      paged: false,
      hasOlder: false,
      messages: Array.isArray(chat.messages) ? chat.messages : EMPTY_MESSAGES,
      runs: Array.isArray(chat.runs) ? chat.runs : EMPTY_RUNS
    }
  }
  return {
    paged: true,
    hasOlder: payload?.hasOlder ?? false,
    messages: payload?.messages ?? EMPTY_MESSAGES,
    runs: payload?.runs ?? EMPTY_RUNS
  }
}

/**
 * React binding. Subscribes to the transcript store ONLY while the chat is a
 * paged shell, so fully hydrated chats (the common case) never re-render App
 * off store churn; escalation replaces the shell with the full record and
 * this hook unsubscribes on the same render.
 */
export function useCurrentChatTranscriptWindow(
  chat: ChatRecord | null | undefined
): CurrentChatTranscriptWindow {
  const paged = chat ? isTranscriptPagedShell(chat) : false
  const payload = useChatTranscript(paged && chat ? chat.appChatId : null)
  return useMemo(
    () => resolveCurrentChatTranscriptWindow(chat, paged ? payload : null),
    [chat, paged, payload]
  )
}
