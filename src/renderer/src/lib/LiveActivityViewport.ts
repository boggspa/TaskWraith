/**
 * Pure helpers for the {@link LiveActivityViewport} auto-follow ("stick to
 * bottom") behaviour. Extracted so the threshold logic can be unit tested
 * without a DOM. Mirrors the philosophy of `TranscriptScroll.ts` but uses a
 * slightly more forgiving threshold: the live activity viewport is a small,
 * fast-streaming masked region where a 4px tolerance would flicker between
 * following / not-following as reasoning text and tool rows stream in.
 */

/**
 * Distance, in CSS pixels, within which the viewport counts as pinned to the
 * live edge. Larger than the main transcript's 4px because the viewport is
 * short and streams quickly; we want to keep following through sub-row layout
 * jitter while still releasing the moment the user deliberately scrolls up.
 */
export const VIEWPORT_STICK_PX = 24

/** Compute how far a scroll container is from its bottom edge. */
export function distanceFromBottom(metrics: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

/**
 * Resolve the next auto-follow state from the current distance-from-bottom.
 * Symmetric around {@link VIEWPORT_STICK_PX}: the viewport follows whenever the
 * user is within the threshold of the bottom, and releases otherwise. Defensive
 * against non-finite inputs (detached container / mid-reflow metrics) — those
 * preserve the current state rather than thrashing it.
 */
export function nextAutoFollow(distance: number, current: boolean): boolean {
  if (!Number.isFinite(distance)) return current
  return distance <= VIEWPORT_STICK_PX
}

/**
 * Whether the "jump to latest" affordance should show: only when the viewport
 * is collapsed (masked, fixed-height) AND the user has scrolled away from the
 * live edge. When expanded the whole region is freely scrollable, and when
 * following the bottom is already visible — in both cases the pill is noise.
 */
export function shouldShowViewportJump(input: {
  expanded: boolean
  following: boolean
}): boolean {
  return !input.expanded && !input.following
}

/**
 * DOM event name for the disclosure→viewport reveal contract. A card that the
 * user just expanded dispatches this (bubbling) from its detail element; every
 * `LiveActivityViewport` on the ancestor chain pauses auto-follow and scrolls
 * the detail into its clamped window. A bubbled DOM event — rather than a
 * React context/prop — because the dispatchers render inside cached segment
 * bodies and nested viewports (fan-out lanes) that a prop thread would have to
 * tunnel through; the DOM already knows the ancestor chain.
 */
export const ACTIVITY_REVEAL_EVENT = 'live-activity-reveal'

/**
 * Space (px) kept visible above a revealed detail so the row header that was
 * clicked stays on screen — a reveal that shows detail with no label reads as
 * a jump to unrelated content.
 */
export const REVEAL_HEADER_ALLOWANCE_PX = 28

/**
 * Whether a disclosure state change is the user opening the card. Only the
 * collapsed→expanded transition reveals: collapse must never scroll, and a
 * remount that starts expanded (virtualised rows restoring persisted state)
 * must initialise its previous-state ref to the current value so mounting
 * never counts as a transition.
 */
export function isExpandRevealTransition(previous: boolean, next: boolean): boolean {
  return next && !previous
}

/**
 * `scrollIntoView({ block: 'nearest' })` semantics for ONE scroller, done by
 * hand: returns the next scrollTop that makes `[targetTop - headerAllowance,
 * targetBottom]` visible, or null when it already is. Manual math instead of
 * the platform call because scrollIntoView walks EVERY scrollable ancestor —
 * including overflow:hidden wrappers between the card and the transcript,
 * which it would silently shift with no way for the user to shift back. The
 * viewport applies this to itself only; nested viewports each apply their own
 * as the event bubbles outward, so lane-in-lane clamps compose.
 *
 * The head wins conflicts: a detail taller than the window aligns its top
 * (plus the header allowance) so the user reads from the beginning.
 */
export function revealScrollAdjustment(input: {
  scrollTop: number
  clientHeight: number
  /** Target bounds in the scroller's content coordinate space. */
  targetTop: number
  targetBottom: number
  headerAllowance?: number
}): number | null {
  const { scrollTop, clientHeight, targetTop, targetBottom } = input
  const headerAllowance = input.headerAllowance ?? 0
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(targetTop) ||
    !Number.isFinite(targetBottom)
  ) {
    return null
  }
  const effectiveTop = Math.max(0, targetTop - headerAllowance)
  if (targetBottom - effectiveTop >= clientHeight) return effectiveTop
  if (effectiveTop < scrollTop) return effectiveTop
  if (targetBottom > scrollTop + clientHeight) return targetBottom - clientHeight
  return null
}

/**
 * Dispatch the reveal event from a card's freshly-mounted detail element.
 * Thin DOM shim kept beside the contract constant so dispatchers and the
 * listener can never drift on the event's shape (bubbles is load-bearing:
 * nested viewports rely on it).
 */
export function dispatchActivityReveal(target: Element | null | undefined): void {
  if (!target || typeof CustomEvent === 'undefined') return
  target.dispatchEvent(new CustomEvent(ACTIVITY_REVEAL_EVENT, { bubbles: true }))
}

/**
 * Whether a content-driven height change (card expand/collapse, presence
 * animation, image load — anything that grows scrollHeight without a scroll
 * or revision) should re-pin the viewport to its live edge. Only while
 * collapsed AND following: a paused viewport belongs to the user's reading
 * position, and the expanded view is free-flow with no live edge to hold.
 */
export function shouldRepinOnContentGrowth(input: {
  expanded: boolean
  following: boolean
}): boolean {
  return !input.expanded && input.following
}

/** Minimum overflow (px) before an edge fade is shown — avoids flicker at rest. */
export const EDGE_FADE_OVERFLOW_PX = 4

/**
 * Whether top/bottom edge fades should show for a collapsed live viewport.
 * Fades are overflow-aware: the top fade only appears when the user has
 * scrolled up, and the bottom fade only when content extends below the window.
 */
export function edgeFadeState(metrics: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}): { top: boolean; bottom: boolean } {
  const { scrollHeight, clientHeight, scrollTop } = metrics
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollTop)) {
    return { top: false, bottom: false }
  }
  const overflow = scrollHeight - clientHeight
  if (overflow <= EDGE_FADE_OVERFLOW_PX) {
    return { top: false, bottom: false }
  }
  const distance = distanceFromBottom(metrics)
  return {
    top: scrollTop > EDGE_FADE_OVERFLOW_PX,
    bottom: distance > EDGE_FADE_OVERFLOW_PX
  }
}
