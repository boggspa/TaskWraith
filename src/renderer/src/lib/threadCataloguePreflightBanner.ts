/**
 * The thread-catalogue bubble is a PREFLIGHT surface.
 *
 * `ThreadCatalogueMirror.poll()` swallows any throw from `refresh()` into
 * `status.error` and retries forever, so the bubble it drives had no end
 * condition either: it polled `thread-catalogue:status` every 1.5 s for the life
 * of the window and floated over the running app — bottom-left, on top of the
 * transcript — for as long as the mirror stayed degraded. It also sat at
 * `z-index: 1000` against the boot mask's `10001`, so it was hidden during the
 * only phase where "history is still loading" is the honest thing to say, and
 * visible for every phase after it.
 *
 * This inverts both halves: the bubble belongs to the launch screen, and once
 * the app is revealed it is gone regardless of what the mirror reports. A
 * degraded mirror after reveal is still real (the sidebar list and the sidebar
 * search both read the mirror, so an aborted listing silently shows an
 * arbitrary old subset) — it is just no longer stated as a permanent overlay.
 */

export interface ThreadCatalogueStatusSnapshot {
  complete: boolean
  loaded: number
  failed: number
  error: string | null
}

/** True once the mirror is reporting anything a user would want said out loud. */
export function threadCatalogueStatusIsDegraded(
  status: ThreadCatalogueStatusSnapshot | null
): boolean {
  if (!status) return false
  return Boolean(status.error) || status.failed > 0 || !status.complete
}

/**
 * The line to show on the launch screen, or `null` for no bubble at all.
 *
 * `bootRevealed` is the single gate: after reveal this returns `null` for every
 * status, including an outright error.
 */
export function threadCataloguePreflightBanner(input: {
  bootRevealed: boolean
  status: ThreadCatalogueStatusSnapshot | null
}): string | null {
  if (input.bootRevealed) return null
  const status = input.status
  if (!threadCatalogueStatusIsDegraded(status) || !status) return null
  if (status.error) return 'History is temporarily unavailable. Retrying…'
  if (status.failed)
    return `${status.loaded} threads ready. ${status.failed} could not be read; their saved history is retained.`
  return `Loading history… ${status.loaded} threads ready.`
}
