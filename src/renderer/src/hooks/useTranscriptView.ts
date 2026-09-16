import { useMemo, useSyncExternalStore } from 'react'
import {
  DEFAULT_TRANSCRIPT_VIEW,
  getTranscriptViewSnapshot,
  subscribeTranscriptView,
  transcriptViewForChat,
  type TranscriptView
} from '../lib/transcriptViewOverride'

/**
 * How much of each turn this chat's transcript renders.
 *
 * A subscription rather than a prop, for two reasons. One chat can be open in
 * the main pane, the side chat and a multiview pane simultaneously, and all
 * three must agree — which a `:root` attribute cannot do and three separate
 * `useState` calls would let drift. And the cards that render their own
 * activity stacks (`EnsembleFanoutResultCard`, `SubThreadReturnCard`) sit
 * outside TranscriptPanel's prop flow entirely, so threading would mean
 * widening every intermediate component that happens to sit between them.
 *
 * The snapshot getter is passed a THIRD time as `getServerSnapshot`: every
 * renderer test in this repo is a `renderToStaticMarkup` server render, and
 * React's server shim throws "Missing getServerSnapshot" without it.
 *
 * Until the Appearance default lands, a chat with no explicit override
 * resolves to `DEFAULT_TRANSCRIPT_VIEW` — that argument is the single seam
 * the settings slice replaces.
 */
export function useTranscriptView(chatId: string | null | undefined): TranscriptView {
  const viewByChatId = useSyncExternalStore(
    subscribeTranscriptView,
    getTranscriptViewSnapshot,
    getTranscriptViewSnapshot
  )
  return useMemo(
    () => transcriptViewForChat(viewByChatId, chatId ?? null, DEFAULT_TRANSCRIPT_VIEW),
    [viewByChatId, chatId]
  )
}
