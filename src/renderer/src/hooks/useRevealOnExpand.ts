import { useLayoutEffect, useRef, type RefObject } from 'react'
import { dispatchActivityReveal, isExpandRevealTransition } from '../lib/LiveActivityViewport'

/**
 * Disclosure side of the viewport reveal contract (`ACTIVITY_REVEAL_EVENT`):
 * attach the returned ref to the card's expanded detail element. On the
 * user-driven collapsed→expanded transition the detail dispatches the bubbling
 * reveal event on the next animation frame — post-layout, so every ancestor
 * `LiveActivityViewport` reads final geometry when it scrolls the detail into
 * its clamp and pauses auto-follow.
 *
 * Deliberately silent in the other two cases: collapse never scrolls, and a
 * mount that starts expanded (virtualised rows restoring persisted state) is
 * not a transition — the previous-state ref initialises to the current value,
 * so remounts cannot yank the transcript.
 */
export function useRevealOnExpand<T extends HTMLElement>(expanded: boolean): RefObject<T | null> {
  const detailRef = useRef<T | null>(null)
  const previousExpandedRef = useRef(expanded)
  useLayoutEffect(() => {
    const wasExpanded = previousExpandedRef.current
    previousExpandedRef.current = expanded
    if (!isExpandRevealTransition(wasExpanded, expanded)) return
    const frame = requestAnimationFrame(() => dispatchActivityReveal(detailRef.current))
    return () => cancelAnimationFrame(frame)
  }, [expanded])
  return detailRef
}
