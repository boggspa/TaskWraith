import type { ChatRecord, ChatListItem } from '../../../main/store/types'
import { retainChatsWithinByteBudget, type ChatByteLru } from './chatByteLru'

/*
 * reconcileChatRefMap — pure core of the "token-drop reconcile".
 *
 * This is the verbatim decision logic extracted out of the App.tsx effect
 * keyed on `[chats, currentChat]` (the one headed "Phase L2 — fix
 * streaming transcript content loss"). That effect rebuilds the live
 * `chatByIdRef` map from React `chats` state on every commit, which would
 * clobber in-flight streamed content because the effect's closure captures
 * a STALE `chats` snapshot while the ref has already advanced several
 * deltas ahead (see the App.tsx comment for the full delta-6/7-dropped
 * sequence). The fix preserves the ref's entry for any chat with an
 * active or recently-completed run, because that ref content is strictly
 * more up-to-date than any React-state-derived snapshot.
 *
 * Three preserve predicates (OR), mirroring the inline effect exactly:
 *   1. `activeRunChatId` — the EARLY-set single-active-run marker. This is
 *      the sole guard during the run-start window (the "Phase K gap")
 *      where the run's setChats has fired but the activeRuns registry
 *      entry has not yet been written. Dropping this predicate silently
 *      regresses token loss at the very start of every run.
 *   2. `activeRunChatIds` — the set of chatIds with a registered run
 *      context (App: `activeRunsRef.current.values()` mapped to chatId).
 *   3. `recentlyCompleted` — chatId → completedAt(ms); preserved for
 *      `recentlyCompletedWindowMs` after provider exit so the final
 *      streamed content survives until the durable broadcast lands.
 *
 * Extracted so the token-drop behavior is locked by unit tests before the
 * planned rAF render-coalescer changes the commit timing around it. Pure +
 * side-effect free: builds and returns a NEW map; the caller assigns it to
 * `chatByIdRef.current`.
 */

/** Default post-completion preserve window (App.tsx mirrors this value). */
export const RECENTLY_COMPLETED_WINDOW_MS = 2000

function isChatSummaryRecord(chat: ChatRecord | null | undefined): chat is ChatListItem {
  return Boolean((chat as ChatListItem | null | undefined)?.summaryOnly === true)
}

export interface ReconcileChatRefMapInput {
  /** Current React `chats` state (the snapshot the effect closed over). */
  chats: ChatRecord[]
  /** Current visible chat — overrides the seeded entry when present. */
  currentChat: ChatRecord | null | undefined
  /** The live ref map prior to reconcile (App: `chatByIdRef.current`). */
  prev: ReadonlyMap<string, ChatRecord>
  /** Early-set single-active-run chat id (App: `activeRunChatIdRef.current`). */
  activeRunChatId: string | null
  /** Chat ids with a registered run context (App: activeRuns values → chatId). */
  activeRunChatIds: ReadonlySet<string>
  /** chatId → completedAt epoch-ms (App: `recentlyCompletedChatIdsRef.current`). */
  recentlyCompleted: ReadonlyMap<string, number>
  /** Reconcile timestamp (App: `Date.now()`). */
  now: number
  /** Post-completion preserve window; defaults to RECENTLY_COMPLETED_WINDOW_MS. */
  recentlyCompletedWindowMs?: number
  /**
   * T7b — optional byte budget for hydrated full chats. When set, unpinned
   * full records are demoted to summary projections (oldest first) until the
   * budget fits. Omitted → legacy unbounded retention (backward compatible).
   */
  maxHydratedMessageBytes?: number
  /** Extra pin ids (popout / side / approval). Focused + active runs always pin. */
  pinnedChatIds?: ReadonlySet<string>
  /**
   * Renderer-lifetime retention authority. Supplying it preserves byte-estimate
   * cache + LRU touch order across reconciles instead of deep-scanning every
   * hydrated transcript after each click.
   */
  hydrationRetention?: Pick<ChatByteLru, 'retain'>
}

export function reconcileChatRefMap(input: ReconcileChatRefMapInput): Map<string, ChatRecord> {
  const {
    chats,
    currentChat,
    prev,
    activeRunChatId,
    activeRunChatIds,
    recentlyCompleted,
    now,
    recentlyCompletedWindowMs = RECENTLY_COMPLETED_WINDOW_MS,
    maxHydratedMessageBytes,
    pinnedChatIds,
    hydrationRetention
  } = input

  // General case: rebuild from React state. A live non-summary entry wins
  // over an incoming summary stub so a summary broadcast never wipes loaded
  // content.
  const next = new Map<string, ChatRecord>()
  chats.forEach((chat) => {
    const existing = prev.get(chat.appChatId)
    next.set(
      chat.appChatId,
      existing && !isChatSummaryRecord(existing) && isChatSummaryRecord(chat) ? existing : chat
    )
  })
  if (currentChat?.appChatId) {
    next.set(currentChat.appChatId, currentChat)
  }

  // Preserve loop has the LAST word: any chat being streamed into keeps its
  // (more up-to-date) live ref entry, even over the currentChat override.
  for (const [chatId, liveEntry] of prev.entries()) {
    let preserve = false
    if (activeRunChatId === chatId) {
      preserve = true
    }
    if (!preserve && activeRunChatIds.has(chatId)) {
      preserve = true
    }
    if (!preserve) {
      const completedAt = recentlyCompleted.get(chatId)
      if (completedAt !== undefined && now - completedAt < recentlyCompletedWindowMs) {
        preserve = true
      }
    }
    if (preserve) {
      next.set(chatId, liveEntry)
    }
  }

  // T7b — optional byte-budget demotion. Default path (budget omitted) is
  // unchanged. Pinned = focused + live/recent runs + caller extras (popout/side).
  if (
    hydrationRetention ||
    (typeof maxHydratedMessageBytes === 'number' && maxHydratedMessageBytes >= 0)
  ) {
    const pins = new Set<string>(pinnedChatIds ?? [])
    if (currentChat?.appChatId) pins.add(currentChat.appChatId)
    if (activeRunChatId) pins.add(activeRunChatId)
    for (const chatId of activeRunChatIds) pins.add(chatId)
    for (const [chatId, completedAt] of recentlyCompleted) {
      if (now - completedAt < recentlyCompletedWindowMs) pins.add(chatId)
    }
    const records = Array.from(next.values())
    const retained = hydrationRetention
      ? hydrationRetention.retain(records, pins)
      : retainChatsWithinByteBudget({
          chats: records,
          pinnedIds: pins,
          maxBytes: maxHydratedMessageBytes
        })
    for (const chat of retained.chats) {
      next.set(chat.appChatId, chat)
    }
  }

  return next
}
