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
  distanceFromBottom,
  edgeFadeState,
  nextAutoFollow,
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
  jumpLabel = 'Jump to latest'
}: LiveActivityViewportProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded)
  const expanded = controlledExpanded ?? localExpanded
  const [following, setFollowing] = useState(true)
  const [fadeTop, setFadeTop] = useState(false)
  const [fadeBottom, setFadeBottom] = useState(false)

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

  useEffect(() => {
    const el = scrollRef.current
    if (!el || expanded) return
    const observer = new ResizeObserver(() => refreshEdgeFades())
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, refreshEdgeFades])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || expanded) return
    setFollowing((current) => nextAutoFollow(distanceFromBottom(el), current))
    refreshEdgeFades()
  }

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' })
    setFollowing(true)
  }

  const showJump = shouldShowViewportJump({ expanded, following })

  return (
    <div
      className={`live-activity-viewport${expanded ? ' is-expanded' : ' is-collapsed'}${
        active ? ' is-active' : ''
      }${following ? ' is-following' : ''}${fadeTop ? ' has-fade-top' : ''}${
        fadeBottom ? ' has-fade-bottom' : ''
      }${className ? ` ${className}` : ''}`}
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
                maxHeight: collapsedMaxHeight,
                '--live-activity-collapsed-height': `${collapsedMaxHeight}px`
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
