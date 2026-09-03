import type { ChatRecord } from '../../../main/store/types'
import {
  isTranscriptPagedShell,
  shouldPageTranscriptOnOpen,
  type ChatShell,
  type TranscriptPage
} from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from './chatRecordMerge'
import { hydratePagedChatShell, type PagedChatHydration } from './chatTranscriptPager'
import type { ChatTranscriptStore } from './chatTranscriptStore'

/**
 * Stage 1b parity for SECONDARY chat surfaces (chat pop-out / Compact
 * Companion boot, multiview panes, linked side chats).
 *
 * The focused main-window transcript already opens oversized chats as a
 * chrome-only shell plus one bounded tail page (`hydrateSelectedChatAfterPaint`
 * → `shouldPageTranscriptOnOpen` → `hydratePagedChatShell`), so its open cost
 * and renderer heap never scale with the whole history. Every other surface
 * still called the full `getChat` IPC unconditionally — the pop-out boot did
 * not even ingest the result into the transcript store, so an idle large chat
 * rendered its ENTIRE transcript through TranscriptPanel's derivation graph
 * for the whole window lifetime.
 *
 * This module is the one shared open-policy those surfaces route through. It
 * deliberately owns NO React state: committing a shell or a full record into
 * App state stays behind the injected callbacks (`commitPagedShell` is App's
 * `applyPagedHydratedChat`, `fullHydrate` is App's `refreshSingleChat`), so
 * the policy is unit-testable and App gains only wiring lines.
 */
export interface SurfaceChatHydratorDeps {
  /** Current renderer-known record for the id (summary row, shell, or full). */
  resolveChat(chatId: string): ChatRecord | null | undefined
  /** Store consulted for "shell already has a loaded window" idempotency. */
  transcriptStore: ChatTranscriptStore
  /**
   * Full-record hydration (App's `refreshSingleChat`). Already single-flight
   * per chat via App's ChatHydrationRequestPool — this module must NOT wrap it
   * in another per-chat gate keyed the same way, or the inner run would await
   * its own outer entry.
   */
  fullHydrate(chatId: string): Promise<ChatRecord | null>
  /**
   * Commit a paged open into renderer state (App's `applyPagedHydratedChat`):
   * install the shell record and ingest the tail page into the store.
   */
  commitPagedShell(shell: ChatShell, page: TranscriptPage): ChatRecord
  /** Test seam; defaults to the shared pager's `hydratePagedChatShell`. */
  fetchPagedShell?(chatId: string, summaryRow: ChatRecord): Promise<PagedChatHydration | null>
}

/**
 * Surface-aware "is this record ready to present?" — the `isHydrated` binding
 * for `useChatSurfaceHydration`. A full record is ready; a MARKED paged shell
 * is ready only while the store actually holds its window (a dropped/demoted
 * store entry makes the shell re-hydratable instead of permanently blank).
 *
 * A plain summary row is never ready. The previous binding
 * (`!isChatSummaryRecord(chat)`) treated shells as un-hydrated, which made the
 * surface coordinator immediately escalate every paged open back to a full
 * fetch — silently deleting the optimisation.
 */
export function isSurfaceChatHydrated(chat: ChatRecord, store: ChatTranscriptStore): boolean {
  if (!isChatSummaryRecord(chat)) return true
  return isTranscriptPagedShell(chat) && store.isPaged(chat.appChatId)
}

/**
 * Build the open-path hydrator shared by secondary chat surfaces.
 *
 * Policy, in order:
 * 1. Already presentable (full record, or shell with a loaded window) → return
 *    it untouched. Makes direct calls (the pop-out boot) idempotent with the
 *    coordinator-gated calls (panes).
 * 2. Summary row over the page budget (`shouldPageTranscriptOnOpen`) → fetch
 *    shell + tail page, commit via `commitPagedShell`. Fetch failure or a
 *    missing page falls back to full hydration — paging is an optimisation,
 *    never a correctness gate.
 * 3. Everything else (small chats, ids the renderer has no row for) → full
 *    hydration, exactly as before.
 *
 * The paged branch is single-flight per chat id; concurrent callers share one
 * fetch+commit. The full branch relies on `fullHydrate`'s own pool.
 */
export function createSurfaceChatHydrator(
  deps: SurfaceChatHydratorDeps
): (chatId: string) => Promise<ChatRecord | null> {
  const pagedInFlight = new Map<string, Promise<ChatRecord | null>>()

  return (chatId: string): Promise<ChatRecord | null> => {
    if (!chatId) return Promise.resolve(null)
    const existing = deps.resolveChat(chatId)
    if (existing && isSurfaceChatHydrated(existing, deps.transcriptStore)) {
      return Promise.resolve(existing)
    }
    const summaryRow = existing && isChatSummaryRecord(existing) ? existing : null
    if (!summaryRow || !shouldPageTranscriptOnOpen(summaryRow)) {
      return deps.fullHydrate(chatId)
    }

    const inFlight = pagedInFlight.get(chatId)
    if (inFlight) return inFlight

    const request = (async (): Promise<ChatRecord | null> => {
      let paged: PagedChatHydration | null = null
      try {
        paged = await (deps.fetchPagedShell ?? hydratePagedChatShell)(chatId, summaryRow)
      } catch {
        paged = null
      }
      if (!paged) return deps.fullHydrate(chatId)
      return deps.commitPagedShell(paged.shell, paged.page)
    })().finally(() => {
      pagedInFlight.delete(chatId)
    })
    pagedInFlight.set(chatId, request)
    return request
  }
}
