import { useMemo, useSyncExternalStore } from 'react'
import {
  getTranscriptViewSnapshot,
  hasTranscriptViewOverride,
  resolveTranscriptView,
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
 * A chat with no explicit override resolves to `defaultView` — the Settings →
 * Appearance default, threaded in as a PROP rather than read from a second
 * subscription. One store subscription per transcript, and the settings half
 * stays a one-argument change in one place.
 *
 * `defaultView` is optional and run through `resolveTranscriptView`, so a
 * caller that has not threaded it yet lands on the same view the rest of the
 * app is using rather than silently on a different one.
 */
export function useTranscriptView(
  chatId: string | null | undefined,
  defaultView?: TranscriptView
): TranscriptView {
  const viewByChatId = useSyncExternalStore(
    subscribeTranscriptView,
    getTranscriptViewSnapshot,
    getTranscriptViewSnapshot
  )
  return useMemo(
    () => transcriptViewForChat(viewByChatId, chatId ?? null, resolveTranscriptView(defaultView)),
    // `defaultView` belongs in the deps: left out, the resolved view freezes at
    // whatever the default was on first mount and no type or test notices.
    [viewByChatId, chatId, defaultView]
  )
}

/**
 * The same subscription, plus whether this chat is following the Appearance
 * default or pinned to a view of its own.
 *
 * Separate from `useTranscriptView` because only the MENU needs the second
 * fact, and everything that merely RENDERS a transcript would be re-rendered
 * by a change it does not care about. Rendering asks "what view is this chat
 * at"; the menu also has to ask "and did the user say so", because those two
 * states resolve identically and must tick different rows.
 *
 * The snapshot getter is passed a THIRD time as `getServerSnapshot` for the
 * same reason as above: every renderer test here is a server render, and
 * React's server shim throws "Missing getServerSnapshot" without it — which
 * would red every suite mounting the composer at once rather than failing
 * anywhere near this file.
 */
export function useTranscriptViewSelection(
  chatId: string | null | undefined,
  defaultView?: TranscriptView
): {
  view: TranscriptView
  hasOverride: boolean
} {
  const viewByChatId = useSyncExternalStore(
    subscribeTranscriptView,
    getTranscriptViewSnapshot,
    getTranscriptViewSnapshot
  )
  return useMemo(
    () => ({
      view: transcriptViewForChat(viewByChatId, chatId ?? null, resolveTranscriptView(defaultView)),
      hasOverride: hasTranscriptViewOverride(viewByChatId, chatId ?? null)
    }),
    // Without `defaultView` here the menu's "Follow default" row keeps naming
    // the default the window mounted with, which is the exact wrong-but-
    // confident state this row exists to prevent.
    [viewByChatId, chatId, defaultView]
  )
}
