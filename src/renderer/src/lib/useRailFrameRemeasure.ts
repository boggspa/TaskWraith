import { useEffect, useLayoutEffect, type RefObject } from 'react'

/** Short belt after the reactive triggers, for async roster mount / font settle. */
const RAIL_SETTLE_TIMEOUT_MS = 160
/** Only geometry-affecting transitions should re-measure (skip colour/opacity). */
const RAIL_TRANSITION_PROPERTY_RE = /^(width|left|right|transform|flex-basis|margin-left)$/

export interface RailFrameRemeasureRefs {
  /** The transcript scroll container (`.transcript-scroll`). */
  scrollRef: RefObject<HTMLDivElement | null>
  /** The transcript inner content (`.transcript-inner`). */
  contentRef: RefObject<HTMLDivElement | null>
  /**
   * The rail's own root element. Used ONLY to skip `transitionend` events that
   * originate INSIDE the rail (e.g. a marker's hover width/transform
   * transition), so hovering the rail never triggers a re-measure. Optional —
   * omit it and no rail-internal filtering happens (fine for rails whose
   * children don't animate a geometry property).
   */
  railRef?: RefObject<HTMLDivElement | null>
}

/**
 * Shared re-measure lifecycle for the two body-portaled, `position: fixed`
 * transcript flank rails — the left `TranscriptUserMessageGutter` (go-to-message)
 * and the right `TranscriptParticipantFilterRail` (filter-by-participant).
 *
 * Both rails place themselves from a JS `getBoundingClientRect()` snapshot
 * (`updateFrame`), so they MUST re-run it on every event that shifts the
 * transcript / composer geometry — otherwise the mount-time snapshot (taken
 * before the composer/roster/fonts finish growing) stays stale until an
 * incidental scroll. Previously each rail wired its own ad-hoc trigger set and
 * they drifted apart (the right rail shipped with NO ResizeObserver at all).
 * Owning the trigger set here keeps them in lockstep. The set:
 *
 *  - synchronous measure + a nested rAF (this frame + the next) + a 160ms settle
 *    belt — catches virtualized-row mount, async ensemble-roster mount, and the
 *    composer growing a frame or two after first paint;
 *  - a `ResizeObserver` on the scroller, the transcript inner, and
 *    `.composer-area` — re-clamps on column-width / content-height / composer
 *    growth WITHOUT waiting for a window resize;
 *  - `document.fonts.ready` — closes the web-font-swap reflow gap;
 *  - `window` `resize` + capture-phase `scroll` — viewport + any-scroller changes;
 *  - a filtered `transitionend` — pins the resting frame after sidebar-collapse /
 *    dock transitions whose settled geometry lands between ResizeObserver ticks.
 *
 * Safe to call redundantly: each rail's `updateFrame` bails when the newly
 * computed frame is within <0.5px of the current one, so extra passes cause no
 * re-render, and the rails never resize what they observe (no observer feedback
 * loop). Pass a memoized `updateFrame` (its identity gates the effects).
 */
export function useRailFrameRemeasure(
  updateFrame: () => void,
  { scrollRef, contentRef, railRef }: RailFrameRemeasureRefs
): void {
  useLayoutEffect(() => {
    updateFrame()
    const frameIds: number[] = []
    let timeoutId: number | null = null
    let observer: ResizeObserver | null = null
    let fontsCancelled = false
    if (typeof window !== 'undefined') {
      // Nested rAF: measure next frame, then once more after it paints.
      frameIds.push(
        window.requestAnimationFrame(() => {
          updateFrame()
          frameIds.push(window.requestAnimationFrame(updateFrame))
        })
      )
      timeoutId = window.setTimeout(updateFrame, RAIL_SETTLE_TIMEOUT_MS)
      window.addEventListener('resize', updateFrame)
      window.addEventListener('scroll', updateFrame, true)
    }
    const scroller = scrollRef.current
    const content = contentRef.current
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateFrame())
      if (scroller) observer.observe(scroller)
      if (content) observer.observe(content)
      // `.composer-area` height tracks composer/roster growth (its width is
      // pane-pinned). Observe it so an ensemble roster mounting / a composer
      // grows re-clamps the rail without a window resize. Note: the centred
      // `.composer-primary-stack` only exists on the welcome state, so the
      // always-present `.composer-area` is the reliable observe target.
      const composerArea = scroller?.closest('.app-transcript')?.querySelector('.composer-area')
      if (composerArea instanceof HTMLElement) observer.observe(composerArea)
    }
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsCancelled) updateFrame()
      })
    }
    return () => {
      fontsCancelled = true
      observer?.disconnect()
      for (const id of frameIds) window.cancelAnimationFrame(id)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      window.removeEventListener('resize', updateFrame)
      window.removeEventListener('scroll', updateFrame, true)
    }
  }, [contentRef, scrollRef, updateFrame])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleTransitionEnd = (event: TransitionEvent): void => {
      if (!RAIL_TRANSITION_PROPERTY_RE.test(event.propertyName)) return
      if (event.target instanceof Node && railRef?.current?.contains(event.target)) return
      updateFrame()
    }
    document.addEventListener('transitionend', handleTransitionEnd, true)
    return () => document.removeEventListener('transitionend', handleTransitionEnd, true)
  }, [railRef, updateFrame])
}
