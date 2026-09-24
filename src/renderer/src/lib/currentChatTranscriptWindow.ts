import { useMemo } from 'react'
import type { ChatListItem, ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { isOpenChatRun } from './activeRunSelection'
import { useChatTranscript, type ChatTranscriptPresentationOptions } from './useChatTranscript'

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
    const messages = Array.isArray(chat.messages) ? chat.messages : EMPTY_MESSAGES
    const runs = Array.isArray(chat.runs) ? chat.runs : EMPTY_RUNS
    // A summary row that is NOT a MARKED paged shell. `buildChatShell` is the
    // only producer that stamps `transcriptPaged`, so it is the only one the
    // paged branch below can serve. `demoteChatToSummary` (lib/chatByteLru),
    // `projectRendererChatListItem` (state/rendererChatListProjection) and
    // `ChatUpdateInterestRouter.projectCompactChat` all stamp
    // `summaryOnly: true` with `runs: []` while STRIPPING `transcriptPaged`,
    // so they land here with nothing for the live surfaces to read.
    //
    // Each of them keeps the tail run on `lastRun`, which on a SOLO thread is
    // the only surviving carrier of the live turn's `startedAt`. Ensemble
    // surfaces read `ensemble.activeRound.startedAt` from chat chrome and keep
    // ticking regardless, which is exactly why only solo threads painted
    // `TURN 00:00:00:00` and a `0s` Working chip under a live run.
    //
    // Gated on openness: a projection whose `lastRun` is the PREVIOUS completed
    // run must keep painting zero rather than counting up from an old start.
    // Canonical runs always win, so a hydrated record is returned unchanged.
    const lastRun = (chat as ChatRecord & Partial<ChatListItem>).lastRun
    return {
      paged: false,
      hasOlder: false,
      messages,
      runs: runs.length === 0 && isOpenChatRun(lastRun) ? [lastRun as ChatRun] : runs
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
 * The store id the hook below subscribes to for `chat`, or `null` for "do not
 * subscribe at all".
 *
 * Split out of the hook because it is the load-bearing half and there is no DOM
 * test env here to mount the hook in (same idiom as `useChatTranscript.test.ts`
 * — pin the helpers the hook wires into `useSyncExternalStore`). ChatViewPane
 * calls the hook on EVERY pane render, so if this ever returned an id for a
 * hydrated chat, every open multiview pane would re-render on any store write
 * for its chat.
 */
export function currentChatTranscriptSubscriptionId(
  chat: ChatRecord | null | undefined
): string | null {
  if (!chat || !isTranscriptPagedShell(chat)) return null
  return chat.appChatId || null
}

/**
 * React binding. Subscribes to the transcript store ONLY while the chat is a
 * paged shell, so fully hydrated chats (the common case) never re-render App
 * off store churn; escalation replaces the shell with the full record and
 * this hook unsubscribes on the same render.
 */
export function useCurrentChatTranscriptWindow(
  chat: ChatRecord | null | undefined,
  options?: ChatTranscriptPresentationOptions
): CurrentChatTranscriptWindow {
  const subscriptionId = currentChatTranscriptSubscriptionId(chat)
  const payload = useChatTranscript(subscriptionId, options)
  return useMemo(
    () => resolveCurrentChatTranscriptWindow(chat, subscriptionId === null ? null : payload),
    [chat, subscriptionId, payload]
  )
}
