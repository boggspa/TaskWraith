import { useEffect, useLayoutEffect, type RefObject } from 'react'

/** Short belt after the reactive triggers, for async roster mount / font settle. */
const RAIL_SETTLE_TIMEOUT_MS = 160
/** Only geometry-affecting transitions should re-measure (skip colour/opacity). */
const RAIL_TRANSITION_PROPERTY_RE = /^(width|left|right|transform|flex-basis|margin-left)$/

/** Air kept between a flank rail's bottom edge and the workspace terminal. */
export const RAIL_TERMINAL_CLEARANCE_PX = 10

/**
 * Lowest viewport y a flank rail may paint to, for the pane that owns
 * `scroller`. Normally the scroller's own bottom — but when the workspace
 * terminal is open it is the terminal's top edge, less a clearance.
 *
 * Why the rail can't read this off the scroller: the terminal
 * (`.workspace-terminal-split`) is `position:absolute` inside `.app-transcript`
 * and opening it only grows the scroller's `padding-bottom` (plus lifts the
 * absolutely-positioned composer via `bottom`), so `scroller`'s own rect never
 * changes. The gutter rail is a body-portaled `position:fixed` element painting
 * ABOVE the terminal's z-index, and it sits in the pane's flank gutter —
 * which the terminal spans, since it stretches nearly the full pane width
 * rather than being capped to the composer column. So any rail geometry taken
 * from the scroller rect alone runs down over the open terminal.
 *
 * Measures the live element rather than reading `--workspace-terminal-height`:
 * that var is overridden per-surface (welcome mode, narrow-pane media query),
 * and the rect is the only source that can't drift from what actually painted.
 * The lookup is scoped to the scroller's own `.app-transcript`, so the right
 * dock's terminal (same class, outside the pane) is never picked up.
 */
export function railClearBottomPx(scroller: HTMLElement, scrollerBottomPx: number): number {
  const terminal = scroller.closest('.app-transcript')?.querySelector('.workspace-terminal-split')
  if (!(terminal instanceof HTMLElement)) return scrollerBottomPx
  const rect = terminal.getBoundingClientRect()
  // A just-portaled terminal can measure 0×0 for a frame; treat it as closed
  // until it has a real box (the next re-measure pass picks it up).
  if (rect.width <= 0 || rect.height <= 0) return scrollerBottomPx
  return Math.min(scrollerBottomPx, rect.top - RAIL_TERMINAL_CLEARANCE_PX)
}

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
 * Re-measure lifecycle for a body-portaled, `position: fixed` transcript
 * flank rail. Sole consumer today: the left `TranscriptUserMessageGutter`
 * (go-to-message). The right participant-filter rail used to share it, but is
 * now a pane-anchored bottom dock positioned purely in CSS and needs no
 * frame measurement.
 *
 * A frame-measured rail places itself from a JS `getBoundingClientRect()`
 * snapshot (`updateFrame`), so it MUST re-run it on every event that shifts
 * the transcript / composer geometry — otherwise the mount-time snapshot
 * (taken before the composer/roster/fonts finish growing) stays stale until
 * an incidental scroll. Previously each rail wired its own ad-hoc trigger set
 * and they drifted apart (one shipped with NO ResizeObserver at all).
 * Owning the trigger set here keeps any future rail in lockstep. The set:
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
      // Observed at the DEFAULT content-box — load-bearing for
      // `railClearBottomPx`. Opening the workspace terminal leaves the
      // scroller's border-box untouched and only grows its `padding-bottom`
      // (`--composer-terminal-scroll-under-padding`), so a content-box
      // observation is the signal that the terminal appeared/vanished; a
      // border-box switch here would silently strand both rails over the open
      // terminal until an incidental scroll.
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
