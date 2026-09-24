/**
 * Single-read scroll geometry for one synchronous pass.
 *
 * Background — the redundancy this module exists to remove
 * (perf-transcript-geometry-fix, 2026-09-05): the transcript's
 * follow/disengage seams read `scrollTop` / `scrollHeight` / `clientHeight`
 * up to ~20 times inside ONE synchronous layout-effect or rAF pass —
 * `disengageIfLiveScrollShowsUserAway` ran twice per messages pass, and every
 * helper re-read the same three getters through its argument list. Each
 * getter is a forced-layout hazard: the FIRST one in a pass with dirty style
 * pays a synchronous whole-document UpdateLayoutTree (measured 298 events /
 * 8.74s at TranscriptPanel Phase-1 and 45 events / 1.53s at the disengage
 * `scrollTop` getter over a 60s 4-pane soak), and every later one is still a
 * real C++ property hop.
 *
 * Contract — a "valid read phase" is ONE synchronous pass:
 *
 *   - Create the phase inside the pass (layout-effect body, rAF callback,
 *     event handler) against the scroller it serves, and drop it when the
 *     pass returns. Nothing may hold a phase across an `await`, an animation
 *     frame, or a React commit boundary: scroll events, other writers, and
 *     layout changes can interleave there and the cache would serve stale
 *     geometry.
 *   - Reads are lazy: the first access per property reads the LIVE DOM (so a
 *     native scrollbar move that outran its scroll event is still observed
 *     exactly as an uncached read would observe it), and later accesses reuse
 *     that value.
 *   - `writeScrollTop` performs the DOM write and invalidates ONLY the cached
 *     `scrollTop`: a scroll write cannot change content or viewport size, but
 *     the browser may clamp the landed position, so the next `readScrollTop`
 *     re-reads the real landed value from the DOM.
 *
 * This module deliberately has NO shared or global cache and no cross-effect
 * invalidation hooks — those are where stale-geometry bugs live. Sharing is
 * explicit: a caller that owns a phase hands it to the callees of its own
 * synchronous pass and nowhere else.
 */

/** Structural source so tests and non-DOM harnesses can supply fakes. */
export interface TranscriptScrollGeometrySource {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface TranscriptGeometryReadPhaseStats {
  /** Live DOM getter invocations performed by this phase. */
  domReads: number
  /** Reads served from the phase cache instead of the DOM. */
  cacheHits: number
  /** scrollTop writes performed through the phase. */
  writes: number
}

export interface TranscriptGeometryReadPhase {
  readScrollTop(): number
  readScrollHeight(): number
  readClientHeight(): number
  /**
   * Write scrollTop through the phase and invalidate only the cached
   * scrollTop (see module contract). The next `readScrollTop()` returns the
   * browser-clamped landed value.
   */
  writeScrollTop(value: number): void
  readonly stats: TranscriptGeometryReadPhaseStats
}

export function createTranscriptGeometryReadPhase(
  scroller: TranscriptScrollGeometrySource
): TranscriptGeometryReadPhase {
  // `undefined` marks "not read yet". A NaN produced by a detached scroller
  // is a legitimate observed value: it caches like any other read, and the
  // consumers' existing Number.isFinite guards keep rejecting it.
  let scrollTop: number | undefined
  let scrollHeight: number | undefined
  let clientHeight: number | undefined
  const stats: TranscriptGeometryReadPhaseStats = { domReads: 0, cacheHits: 0, writes: 0 }

  const readScrollTop = (): number => {
    if (scrollTop === undefined) {
      scrollTop = scroller.scrollTop
      stats.domReads += 1
    } else {
      stats.cacheHits += 1
    }
    return scrollTop
  }
  const readScrollHeight = (): number => {
    if (scrollHeight === undefined) {
      scrollHeight = scroller.scrollHeight
      stats.domReads += 1
    } else {
      stats.cacheHits += 1
    }
    return scrollHeight
  }
  const readClientHeight = (): number => {
    if (clientHeight === undefined) {
      clientHeight = scroller.clientHeight
      stats.domReads += 1
    } else {
      stats.cacheHits += 1
    }
    return clientHeight
  }

  return {
    readScrollTop,
    readScrollHeight,
    readClientHeight,
    writeScrollTop: (value: number) => {
      stats.writes += 1
      scroller.scrollTop = value
      scrollTop = undefined
    },
    stats
  }
}
