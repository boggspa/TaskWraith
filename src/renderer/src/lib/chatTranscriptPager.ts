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

const inFlight = new Map<string, Promise<void>>()

async function fetchAndInstall(
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
    if (inFlight.get(key) !== undefined) inFlight.delete(key)
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
  const flight = fetchAndInstall(dedupKey, store, fetcher, request, operation)
  inFlight.set(dedupKey, flight)
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
}
