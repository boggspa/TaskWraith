import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import {
  ACTIVITY_REVEAL_EVENT,
  REVEAL_HEADER_ALLOWANCE_PX,
  distanceFromBottom,
  edgeFadeState,
  nextAutoFollow,
  revealGrownMaxHeight,
  revealScrollAdjustment,
  shouldRepinOnContentGrowth,
  shouldResetRevealGrowth,
  shouldShowViewportJump
} from '../lib/LiveActivityViewport'

interface LiveActivityViewportProps {
  children: ReactNode
  className?: string
  /**
   * Changes whenever new streaming activity/reasoning arrives. The viewport
   * re-pins to the bottom on each change while it is collapsed and following.
   * Callers typically pass a cheap signature (e.g. count + last item length).
   */
  revision: number | string
  /** True while the run is still in-flight — drives the streaming pulse rail. */
  active?: boolean
  /** Masked height (px) while collapsed. */
  collapsedMaxHeight?: number
  /** Start expanded (rare — used in tests / future per-user preference). */
  defaultExpanded?: boolean
  /** Optional controlled expansion state for callers that need height keyed externally. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Respect the user's reduced-motion preference for the jump animation. */
  reduceMotion?: boolean
  /** Accessible label for the region. */
  label?: string
  expandLabel?: string
  collapseLabel?: string
  jumpLabel?: string
  /**
   * Optional per-viewport Skip (fan-out lane cards). Rendered in the bottom-right
   * controls row next to Expand/Collapse. Callers gate when it appears.
   */
  onSkip?: () => void
  skipLabel?: string
  skipTitle?: string
  /**
   * Opt-in smart growth: when a revealed detail is taller than the collapsed
   * clamp, the clamp grows to fit it (up to this ceiling) and shrinks back
   * once content fits again. NEVER set on surfaces that reserve their
   * collapsed band from the published height (fan-out lanes) — a mid-run
   * band jump is the ratcheting the reserve exists to prevent.
   */
  revealGrowthCeiling?: number
}

/**
 * Cursor-style live activity viewport: a fixed-height, edge-masked region that
 * auto-scrolls to follow streaming thinking + tool activity. The user can scroll
 * up to pause following (a "jump to latest" pill appears) or expand it to a
 * freely-scrollable full-height view. Purely presentational — it wraps whatever
 * activity rows the caller renders as children.
 */
export function LiveActivityViewport({
  children,
  className,
  revision,
  active = false,
  collapsedMaxHeight = 168,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  reduceMotion = false,
  label = 'Live activity',
  expandLabel = 'Expand activity',
  collapseLabel = 'Collapse activity',
  jumpLabel = 'Jump to latest',
  onSkip,
  skipLabel = 'Skip',
  skipTitle,
  revealGrowthCeiling
}: LiveActivityViewportProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded)
  const expanded = controlledExpanded ?? localExpanded
  const [following, setFollowingState] = useState(true)
  /**
   * Mirror of `following` readable from stable callbacks. The content-growth
   * ResizeObserver MUST see a reveal's pause in the same frame it was made:
   * live verification caught the stale-closure version re-pinning to the
   * bottom off the revealed detail's own growth, whose scroll event then
   * re-engaged follow — undoing the pause the instant it was made. Writers go
   * through `setFollowing` so ref and state can never drift.
   */
  const followingRef = useRef(true)
  const setFollowing = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setFollowingState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      followingRef.current = resolved
      return resolved
    })
    if (typeof next === 'boolean') {
      // Synchronous for plain writes — the reveal handler's pause must be
      // visible to observer callbacks that fire before React commits.
      followingRef.current = next
    }
  }, [])
  const [fadeTop, setFadeTop] = useState(false)
  const [fadeBottom, setFadeBottom] = useState(false)
  /**
   * Consume-once guard for the reveal scroll write below: the write fires a
   * scroll event asynchronously, and `nextAutoFollow` would re-engage follow
   * if the revealed detail happens to sit at the live edge — undoing the
   * deliberate pause the instant it was made. The flag suppresses exactly one
   * follow evaluation; edge fades still refresh on that event.
   */
  const skipFollowOnScrollRef = useRef(false)
  /** Reveal-grown clamp height (smart growth), null while at the base clamp. */
  const [grownMaxHeight, setGrownMaxHeight] = useState<number | null>(null)
  const activeCollapsedMaxHeight = grownMaxHeight ?? collapsedMaxHeight

  // Growth is a collapsed-state affordance; entering or leaving the expanded
  // free-flow view always returns the clamp to base.
  useEffect(() => {
    setGrownMaxHeight(null)
  }, [expanded])

  const setExpandedState = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(expanded) : next
      if (controlledExpanded === undefined) {
        setLocalExpanded(resolved)
      }
      onExpandedChange?.(resolved)
    },
    [controlledExpanded, expanded, onExpandedChange]
  )

  const refreshEdgeFades = useCallback(() => {
    const el = scrollRef.current
    if (!el || expanded) {
      setFadeTop(false)
      setFadeBottom(false)
      return
    }
    const next = edgeFadeState({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop
    })
    setFadeTop(next.top)
    setFadeBottom(next.bottom)
  }, [expanded])

  // Re-pin to the bottom on new content while collapsed + following. A layout
  // effect (not a passive effect) so the scroll write lands in the same frame
  // the new rows mount, avoiding a visible jump.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || expanded || !following) return
    el.scrollTop = el.scrollHeight
    refreshEdgeFades()
  }, [revision, expanded, following, refreshEdgeFades])

  useLayoutEffect(() => {
    refreshEdgeFades()
  }, [expanded, refreshEdgeFades])

  // Observe the CONTENT as well as the clamp box: once content exceeds the
  // collapsed cap the box never resizes again, so a child-driven height change
  // (card expand, presence animation, image load) would otherwise leave the
  // fades stale — advertising "nothing more below" exactly when a freshly
  // expanded detail is clipped below the fold — and let the live edge drift
  // while following. Children are observed rather than re-queried per delta:
  // React reuses the wrapper DOM nodes across renders, so the observed set
  // only goes stale on remount (which re-runs this effect).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || expanded) return
    const observer = new ResizeObserver(() => {
      if (shouldRepinOnContentGrowth({ expanded, following: followingRef.current })) {
        el.scrollTop = el.scrollHeight
      }
      // Smart growth shrinks back the moment content fits the base clamp
      // again (the revealed card was collapsed, or its rows settled away).
      setGrownMaxHeight((current) =>
        current !== null &&
        shouldResetRevealGrowth({
          contentHeight: el.scrollHeight,
          baseMaxHeight: collapsedMaxHeight
        })
          ? null
          : current
      )
      refreshEdgeFades()
    })
    observer.observe(el)
    for (const child of Array.from(el.children)) {
      observer.observe(child)
    }
    return () => observer.disconnect()
    // `following` is read via followingRef so a follow flip does not churn
    // the observer subscription (and pauses are visible pre-commit).
  }, [expanded, collapsedMaxHeight, refreshEdgeFades])

  // Disclosure→viewport reveal contract: a card the user just expanded
  // dispatches ACTIVITY_REVEAL_EVENT from its detail element. While collapsed,
  // pause auto-follow (the user is inspecting — streaming must not yank the
  // card away; the Jump pill is the way back) and scroll the detail into this
  // clamp. Each nested viewport on the bubble path adjusts only ITSELF, so
  // lane-in-lane clamps compose without double-scrolling ancestors.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || expanded) return
    const onReveal = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      setFollowing(false)
      const scrollerRect = el.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const targetTop = targetRect.top - scrollerRect.top + el.scrollTop
      // Opt-in smart growth: fit the revealed detail (bounded) before the
      // scroll adjustment. The DOM grows next frame, so the adjustment below
      // still computes against current geometry — the grown window only ever
      // shows MORE of the detail than the math guaranteed.
      if (revealGrowthCeiling !== undefined) {
        const grown = revealGrownMaxHeight({
          baseMaxHeight: collapsedMaxHeight,
          detailHeight: targetRect.height,
          headerAllowance: REVEAL_HEADER_ALLOWANCE_PX,
          ceiling: revealGrowthCeiling
        })
        setGrownMaxHeight(grown > collapsedMaxHeight ? grown : null)
      }
      const nextScrollTop = revealScrollAdjustment({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        targetTop,
        targetBottom: targetTop + targetRect.height,
        headerAllowance: REVEAL_HEADER_ALLOWANCE_PX
      })
      if (nextScrollTop !== null && nextScrollTop !== el.scrollTop) {
        skipFollowOnScrollRef.current = true
        el.scrollTop = nextScrollTop
      }
      refreshEdgeFades()
    }
    el.addEventListener(ACTIVITY_REVEAL_EVENT, onReveal)
    return () => el.removeEventListener(ACTIVITY_REVEAL_EVENT, onReveal)
  }, [expanded, collapsedMaxHeight, revealGrowthCeiling, refreshEdgeFades])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || expanded) return
    const skipFollow = skipFollowOnScrollRef.current
    skipFollowOnScrollRef.current = false
    if (!skipFollow) {
      setFollowing((current) => nextAutoFollow(distanceFromBottom(el), current))
    }
    refreshEdgeFades()
  }

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
    setFollowing(true)
  }

  const showJump = shouldShowViewportJump({ expanded, following })
  const hasSkipAction = typeof onSkip === 'function'

  return (
    <div
      className={`live-activity-viewport${expanded ? ' is-expanded' : ' is-collapsed'}${
        active ? ' is-active' : ''
      }${following ? ' is-following' : ''}${fadeTop ? ' has-fade-top' : ''}${
        fadeBottom ? ' has-fade-bottom' : ''
      }${hasSkipAction ? ' has-skip-action' : ''}${className ? ` ${className}` : ''}`}
      data-following={following ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
    >
      <span className="live-activity-viewport-rail" aria-hidden />
      <div
        ref={scrollRef}
        className="live-activity-viewport-scroll"
        /*
         * `--live-activity-collapsed-height` publishes the SAME number the
         * `max-height` cap uses, so a surface that wants to RESERVE its band
         * rather than grow into it can do so from CSS without re-declaring the
         * height. Callers own the value (fan-out lanes pass
         * COLLAPSED_FANOUT_RESULT_VIEWPORT_HEIGHT); duplicating it in a
         * stylesheet would let the two drift silently, and a stylesheet that
         * guessed low would clip the very content the cap exists to bound.
         *
         * Published unconditionally while collapsed, and consumed by nobody
         * unless a surface opts in — a custom property that nothing reads costs
         * one string on the style attribute and changes no layout.
         */
        style={
          expanded
            ? undefined
            : ({
                maxHeight: activeCollapsedMaxHeight,
                '--live-activity-collapsed-height': `${activeCollapsedMaxHeight}px`
              } as CSSProperties)
        }
        onScroll={handleScroll}
        role="log"
        aria-label={label}
        aria-live={active ? 'polite' : 'off'}
      >
        {children}
      </div>
      {showJump && (
        <button
          type="button"
          className="live-activity-viewport-jump"
          onClick={jumpToLatest}
          aria-label={jumpLabel}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="3,5 6,8 9,5" />
          </svg>
          {jumpLabel}
        </button>
      )}
      <div className="live-activity-viewport-controls">
        {hasSkipAction && (
          <button
            type="button"
            className="live-activity-viewport-skip"
            onClick={onSkip}
            title={
              skipTitle ||
              'Stop this fan-out lane and let the remaining seats continue. Round Stop still cancels the whole round.'
            }
            aria-label={skipTitle || 'Skip this fan-out lane'}
          >
            {skipLabel}
          </button>
        )}
        <button
          type="button"
          className="live-activity-viewport-toggle"
          aria-expanded={expanded}
          onClick={() => setExpandedState((current) => !current)}
        >
          {expanded ? collapseLabel : expandLabel}
          <svg
            className={`live-activity-viewport-toggle-chevron${expanded ? ' is-open' : ''}`}
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="3,4.5 6,7.5 9,4.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
