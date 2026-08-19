import { Fragment, createElement, type ReactNode } from 'react'

/**
 * Identity-preserving composer for a Multiview pane's top-left chrome.
 *
 * `ChatViewPane` is memo-bounded and compares `topLeftChromeExtra` by identity.
 * Building that node inline in the pane render — `<>{extra}{button}</>` — makes
 * a new element every App render, so `chatViewPanePropsEqual` can never bail
 * and every mounted pane re-runs its full transcript pipeline on every flush,
 * including panes showing other chats. The comparator's other ~60 clauses are
 * unreachable while that one prop churns.
 *
 * Panes with no host chrome get the trailing element back unchanged, so the
 * common (viewer) case allocates nothing at all. The single-entry cache is
 * per-composer and keyed on both halves by identity, so a caller that memoizes
 * its inputs gets one stable element for as long as those inputs hold.
 */
export type PaneTopLeftChromeComposer = (
  extra: ReactNode | undefined,
  trailing: ReactNode
) => ReactNode

export function createPaneTopLeftChromeComposer(): PaneTopLeftChromeComposer {
  let cache: { extra: ReactNode; trailing: ReactNode; combined: ReactNode } | null = null
  return (extra, trailing) => {
    // Nothing to merge: hand back the caller's own (memoized) element rather
    // than wrapping it, so the no-chrome pane path is allocation-free.
    if (extra === undefined || extra === null || extra === false) return trailing
    if (cache && cache.extra === extra && cache.trailing === trailing) return cache.combined
    const combined = createElement(Fragment, null, extra, trailing)
    cache = { extra, trailing, combined }
    return combined
  }
}
