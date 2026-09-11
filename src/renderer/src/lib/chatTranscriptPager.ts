import type { ChatRecord } from '../../../main/store/types'
import {
  type ChatShell,
  type TranscriptPage,
  type TranscriptPageRequest
} from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from './chatRecordMerge'
import type { ChatTranscriptStore } from './chatTranscriptStore'

/**
 * Stage 1b — async pager for chats the store holds as main-produced pages.
 *
 * The transcript store is synchronous; paged entries have no local source
 * arrays to rewindow. These helpers fetch adjacent windows from main
 * (`get-chat-transcript-page`) and pass them to the store.
 *
 * For accumulated infinite scroll: requestOlderTranscriptPage calls
 * store.prependChatTranscriptPage, requestNewerTranscriptPage calls
 * store.appendChatTranscriptPage, and other operations call replaceWindow.
 * In-flight requests are deduplicated per chat + direction, and a
 * response is dropped if the chat stopped being paged mid-flight (a full
 * hydration escalation always wins over a stale page).
 */

export type TranscriptPageFetcher = (
  request: TranscriptPageRequest
) => Promise<TranscriptPage | null>

function defaultFetcher(): TranscriptPageFetcher | null {
  if (typeof window === 'undefined') return null
  const api = (window as { api?: { getChatTranscriptPage?: TranscriptPageFetcher } }).api
  return typeof api?.getChatTranscriptPage === 'function' ? api.getChatTranscriptPage : null
}

/**
 * How long one pager request may hold its dedup key.
 *
 * `schedule` drops a request outright while one is in flight for the same key.
 * With no deadline, a pull that never settles — a wedged main thread, a lost
 * channel — made that key permanently deaf: every later show-older,
 * show-newer, reveal or return-to-latest for that chat was discarded in
 * silence, and the affordance simply stopped working with no error anywhere.
 * This releases the KEY, never the fetch: a late page is still installed.
 */
export const TRANSCRIPT_PAGER_REQUEST_DEADLINE_MS = 10_000

const inFlight = new Map<string, Promise<void>>()
const inFlightDeadlines = new Map<string, ReturnType<typeof setTimeout>>()
let overdueRequests = 0

function releaseKey(key: string): void {
  inFlight.delete(key)
  const timer = inFlightDeadlines.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    inFlightDeadlines.delete(key)
  }
}

/** Pager requests that overran their deadline and released their dedup key. */
export function overdueTranscriptPagerRequests(): number {
  return overdueRequests
}

interface PagerFlightHandle {
  promise: Promise<void> | null
}

async function fetchAndInstall(
  ownFlight: PagerFlightHandle,
  key: string,
  store: ChatTranscriptStore,
  fetchPage: TranscriptPageFetcher,
  request: TranscriptPageRequest,
  operation: 'replace' | 'prepend' | 'append'
): Promise<void> {
  try {
    const page = await fetchPage(request)
    // A full ingest (escalation, live update) during the flight wins: the chat
    // is no longer paged and this window would silently downgrade it.
    if (!page || !store.isPaged(request.chatId)) return

    // Route to the appropriate store operation based on the requested operation
    switch (operation) {
      case 'prepend':
        store.prependChatTranscriptPage(request.chatId, page)
        break
      case 'append':
        store.appendChatTranscriptPage(request.chatId, page)
        break
      case 'replace':
      default:
        store.replaceChatTranscriptWindow(page)
        break
    }
  } catch {
    // Paging is best-effort chrome; the current window stays on screen.
  } finally {
    // Identity, not presence. Once the deadline can release a key mid-flight, a
    // newer request may already own it — and releasing THAT entry would leave
    // the new request both un-deduped and un-deadlined, i.e. able to wedge
    // forever with nothing left to free it.
    if (inFlight.get(key) === ownFlight.promise) releaseKey(key)
  }
}

function schedule(
  store: ChatTranscriptStore,
  request: TranscriptPageRequest,
  dedupKey: string,
  fetchPage?: TranscriptPageFetcher,
  operation: 'replace' | 'prepend' | 'append' = 'replace'
): void {
  if (inFlight.has(dedupKey)) return
  const fetcher = fetchPage ?? defaultFetcher()
  if (!fetcher) return
  const ownFlight: PagerFlightHandle = { promise: null }
  const flight = fetchAndInstall(ownFlight, dedupKey, store, fetcher, request, operation)
  ownFlight.promise = flight
  inFlight.set(dedupKey, flight)
  if (TRANSCRIPT_PAGER_REQUEST_DEADLINE_MS > 0) {
    const timer = setTimeout(() => {
      inFlightDeadlines.delete(dedupKey)
      if (inFlight.get(dedupKey) !== flight) return
      ownFlight.promise = null
      inFlight.delete(dedupKey)
      overdueRequests += 1
    }, TRANSCRIPT_PAGER_REQUEST_DEADLINE_MS)
    // Never hold the process open for a paging affordance.
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
    inFlightDeadlines.set(dedupKey, timer)
  }
}

/** Fetch the page ending just before the current window's oldest message. */
export function requestOlderTranscriptPage(
  chatId: string,
  store: ChatTranscriptStore,
  fetchPage?: TranscriptPageFetcher
): void {
  const current = store.get(chatId)
  const oldestMessageId = current?.messages[0]?.id
  if (!current?.hasOlder || !oldestMessageId) return
  schedule(
    store,
    { chatId, beforeMessageId: oldestMessageId },
    `${chatId}:older`,
    fetchPage,
    'prepend'
  )
}

/** Fetch the page starting just after the current window's newest message. */
export function requestNewerTranscriptPage(
  chatId: string,
  store: ChatTranscriptStore,
  fetchPage?: TranscriptPageFetcher
): void {
  const current = store.get(chatId)
  const newestMessageId = current?.messages[current.messages.length - 1]?.id
  if (!current?.hasNewer || !newestMessageId) return
  schedule(
    store,
    { chatId, afterMessageId: newestMessageId },
    `${chatId}:newer`,
    fetchPage,
    'append'
  )
}

/** Jump back to the live tail. */
export function requestLatestTranscriptPage(
  chatId: string,
  store: ChatTranscriptStore,
  fetchPage?: TranscriptPageFetcher
): void {
  schedule(store, { chatId }, `${chatId}:latest`, fetchPage, 'replace')
}

/** Page around a jump target (pins, search hits, deep links). */
export function requestRevealTranscriptMessage(
  chatId: string,
  messageId: string,
  store: ChatTranscriptStore,
  fetchPage?: TranscriptPageFetcher
): void {
  if (!messageId) return
  schedule(store, { chatId, aroundMessageId: messageId }, `${chatId}:reveal`, fetchPage, 'replace')
}

export interface PagedChatHydration {
  shell: ChatShell
  page: TranscriptPage
}

/**
 * Open-path hydration for oversized transcripts: one tail page plus the
 * chat's shell (full chrome, no transcript arrays). When main predates shell
 * support, falls back to stamping the provided summary row as paged — lean
 * ensemble chrome until the next full-hydration escalation.
 */
export async function hydratePagedChatShell(
  chatId: string,
  summaryRow: ChatRecord | null | undefined,
  fetchPage?: TranscriptPageFetcher
): Promise<PagedChatHydration | null> {
  const fetcher = fetchPage ?? defaultFetcher()
  if (!fetcher) return null
  const page = await fetcher({ chatId, includeShell: true })
  if (!page) return null
  if (page.shell) return { shell: page.shell, page }
  if (!summaryRow || !isChatSummaryRecord(summaryRow)) return null
  return { shell: { ...summaryRow, transcriptPaged: true }, page }
}

/** Test helper — drop in-flight dedup state between specs. */
export function resetChatTranscriptPagerForTests(): void {
  inFlight.clear()
  for (const timer of inFlightDeadlines.values()) clearTimeout(timer)
  inFlightDeadlines.clear()
  overdueRequests = 0
}
