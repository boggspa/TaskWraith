import {
  useCallback,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  computeGutterSegments,
  fractionsToTrackList,
  getMultiviewLayoutSpec,
  type MultiviewGutterSegment,
  type MultiviewLayout,
  type MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'

/**
 * MultiviewPaneGrid — arranges the central chat pane into a CSS grid of panes.
 *
 * Design: the FOCUSED pane is rendered by the host (App.tsx) exactly as today
 * via `renderFocusedCell` — same inline `.app-transcript` + composer subtree,
 * same refs, same singleton wiring (FX layers + GhostCompanion + the shared
 * `<Composer>`) — and is simply placed into its grid cell. Non-focused
 * populated cells render a `<ChatViewPane>` (`renderViewerCell`), which now
 * hosts the SAME `<Composer>` component (pane-scoped props) rather than a
 * hand-written clone; empty cells render a placeholder. In single layout we
 * return the focused content with NO wrapper at all, so the single-pane DOM is
 * byte-identical to before Multiview existed.
 *
 * Grid cells are placed by `grid-area` name, so DOM order is irrelevant — the
 * focused cell can occupy any area regardless of where it sits in the markup.
 *
 * Resizable gutters: when `columnFractions` / `rowFractions` are supplied they
 * override the spec track templates (they default to the spec, so an un-dragged
 * layout is byte-identical). Draggable dividers are rendered at the internal
 * track boundaries computed from the area matrix (only across segments that
 * separate two different areas) and call `onResizeTrack` while dragging /
 * `onResetTracks` on double-click.
 */
export interface MultiviewPaneGridProps {
  layout: MultiviewLayout
  /** Stable per-pane records (id + chatId) in cell order; length === paneCount. */
  panes: MultiviewPaneRecord[]
  focusedPaneIndex: number
  /** The existing inline main-pane content (transcript + composer). */
  renderFocusedCell: () => ReactNode
  /** A pane-scoped ChatViewPane (hosting the shared Composer) for a non-focused, populated cell. */
  renderViewerCell: (chatId: string, paneIndex: number) => ReactNode
  /** Placeholder for a non-focused empty cell. */
  renderEmptyCell?: (paneIndex: number) => ReactNode
  /** Close a pane — non-focused cells get a close affordance. */
  onClosePane?: (paneIndex: number) => void
  /**
   * Stateful column / row track fractions (the `fr` weights). Default to the
   * spec when omitted so the un-dragged grid is byte-identical to today.
   */
  columnFractions?: number[]
  rowFractions?: number[]
  /**
   * Drag a gutter: move `deltaPx` between the two tracks adjacent to the
   * boundary BEFORE `trackIndex`. `axisTotalPx` is the content px the affected
   * axis spans (grid box minus padding minus gaps). Omit to make the grid
   * non-resizable (gutters are not rendered).
   */
  onResizeTrack?: (args: {
    orientation: 'column' | 'row'
    trackIndex: number
    deltaPx: number
    axisTotalPx: number
  }) => void
  /** Double-click a gutter: reset this layout's fractions to the spec defaults. */
  onResetTracks?: () => void
}

/** A loosely-typed grid style that allows the named grid-* props. */
type GridStyle = Record<string, string>

export function MultiviewPaneGrid(props: MultiviewPaneGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  // Active drag, captured at pointerdown so pointermove can compute a delta.
  const dragRef = useRef<{
    orientation: 'column' | 'row'
    trackIndex: number
    startPos: number
    axisTotalPx: number
    pointerId: number
  } | null>(null)

  const { onResizeTrack } = props

  const segments = useMemo<MultiviewGutterSegment[]>(
    () => (onResizeTrack ? computeGutterSegments(props.layout) : []),
    [props.layout, onResizeTrack]
  )

  /**
   * Content px the given axis spans: the grid element's content box (border-box
   * minus padding) minus the total inter-track gap, so fractions map 1:1 to the
   * track px the user sees.
   */
  const measureAxis = useCallback(
    (orientation: 'column' | 'row'): number => {
      const grid = gridRef.current
      if (!grid) return 0
      const cs = getComputedStyle(grid)
      const rect = grid.getBoundingClientRect()
      if (orientation === 'column') {
        const padding = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        const tracks = (props.columnFractions ?? []).length || 1
        const gap = parseFloat(cs.columnGap || cs.gap || '0') * Math.max(0, tracks - 1)
        return Math.max(0, rect.width - padding - gap)
      }
      const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const tracks = (props.rowFractions ?? []).length || 1
      const gap = parseFloat(cs.rowGap || cs.gap || '0') * Math.max(0, tracks - 1)
      return Math.max(0, rect.height - padding - gap)
    },
    [props.columnFractions, props.rowFractions]
  )

  const handleGutterPointerDown = useCallback(
    (segment: MultiviewGutterSegment, event: ReactPointerEvent<HTMLDivElement>) => {
      if (!onResizeTrack) return
      event.preventDefault()
      event.stopPropagation()
      const axisTotalPx = measureAxis(segment.orientation)
      if (axisTotalPx <= 0) return
      dragRef.current = {
        orientation: segment.orientation,
        trackIndex: segment.trackIndex,
        startPos: segment.orientation === 'column' ? event.clientX : event.clientY,
        axisTotalPx,
        pointerId: event.pointerId
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [measureAxis, onResizeTrack]
  )

  const handleGutterPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId || !onResizeTrack) return
      const pos = drag.orientation === 'column' ? event.clientX : event.clientY
      const deltaPx = pos - drag.startPos
      if (deltaPx === 0) return
      onResizeTrack({
        orientation: drag.orientation,
        trackIndex: drag.trackIndex,
        deltaPx,
        axisTotalPx: drag.axisTotalPx
      })
      // Reset the anchor so each move reports an incremental delta — the state
      // transition conserves the adjacent pair, so successive small deltas
      // compose into the full drag without re-reading current fractions here.
      drag.startPos = pos
    },
    [onResizeTrack]
  )

  const endGutterDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  // Single layout is today's render — no grid host, no wrapper, zero diff.
  if (props.layout === 'single') {
    return <>{props.renderFocusedCell()}</>
  }

  const spec = getMultiviewLayoutSpec(props.layout)
  const gridTemplateColumns = props.columnFractions
    ? fractionsToTrackList(props.columnFractions)
    : spec.gridTemplateColumns
  const gridTemplateRows = props.rowFractions
    ? fractionsToTrackList(props.rowFractions)
    : spec.gridTemplateRows

  const renderCell = (paneIndex: number): ReactNode => {
    if (paneIndex === props.focusedPaneIndex) return props.renderFocusedCell()
    const chatId = props.panes[paneIndex]?.chatId ?? null
    if (chatId) return props.renderViewerCell(chatId, paneIndex)
    return props.renderEmptyCell ? props.renderEmptyCell(paneIndex) : null
  }

  return (
    <div
      ref={gridRef}
      className={`multiview-grid multiview-layout-${props.layout}`}
      style={{
        gridTemplateAreas: spec.gridTemplateAreas,
        gridTemplateColumns,
        gridTemplateRows
      }}
    >
      {spec.cellAreas.map((area, paneIndex) => (
        // Keyed by paneIndex (not pane id) on purpose: the refs pool and the
        // focused-cell placement are index-based, so changing the React key
        // would reshuffle DOM/refs. Stable identity for per-pane SETTINGS lives
        // in `paneSettings`; `data-pane-id` exposes it for styling/diagnostics.
        <div
          key={paneIndex}
          className={`multiview-cell${
            paneIndex === props.focusedPaneIndex ? ' multiview-cell-focused' : ''
          }`}
          style={{ gridArea: area }}
          data-pane-index={paneIndex}
          data-pane-id={props.panes[paneIndex]?.id}
        >
          {props.onClosePane && paneIndex !== props.focusedPaneIndex && (
            <button
              type="button"
              className="multiview-pane-close"
              aria-label="Close pane"
              title="Close pane"
              onClick={() => props.onClosePane?.(paneIndex)}
            >
              ×
            </button>
          )}
          {renderCell(paneIndex)}
        </div>
      ))}
      {segments.map((segment) => (
        <div
          key={segment.key}
          className={`multiview-gutter multiview-gutter-${segment.orientation}`}
          role="separator"
          aria-orientation={segment.orientation === 'column' ? 'vertical' : 'horizontal'}
          data-orientation={segment.orientation}
          data-track-index={segment.trackIndex}
          style={
            {
              gridColumn: segment.gridColumn,
              gridRow: segment.gridRow
            } as GridStyle
          }
          onPointerDown={(event) => handleGutterPointerDown(segment, event)}
          onPointerMove={handleGutterPointerMove}
          onPointerUp={endGutterDrag}
          onPointerCancel={endGutterDrag}
          onDoubleClick={() => props.onResetTracks?.()}
        >
          <span className="multiview-gutter-handle" aria-hidden />
        </div>
      ))}
    </div>
  )
}
