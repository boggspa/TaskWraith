import type { ReactNode } from 'react'
import { getMultiviewLayoutSpec, type MultiviewLayout } from '../../../shared/multiviewLayouts'

/**
 * MultiviewPaneGrid — arranges the central chat pane into a CSS grid of panes.
 *
 * Design: the FOCUSED pane is rendered by the host (App.tsx) exactly as today
 * via `renderFocusedCell` — same inline `.app-transcript` + composer subtree,
 * same refs, same singleton wiring — and is simply placed into its grid cell.
 * The other cells render read-only viewers (`renderViewerCell`) or an empty
 * placeholder. This keeps the host's risky main-pane render untouched: in
 * single layout we return the focused content with NO wrapper at all, so the
 * single-pane DOM is byte-identical to before Multiview existed.
 *
 * Grid cells are placed by `grid-area` name, so DOM order is irrelevant — the
 * focused cell can occupy any area regardless of where it sits in the markup.
 */
export interface MultiviewPaneGridProps {
  layout: MultiviewLayout
  paneChatIds: (string | null)[]
  focusedPaneIndex: number
  /** The existing inline main-pane content (transcript + composer). */
  renderFocusedCell: () => ReactNode
  /** A read-only ChatViewPane for a non-focused, populated cell. */
  renderViewerCell: (chatId: string, paneIndex: number) => ReactNode
  /** Placeholder for a non-focused empty cell. */
  renderEmptyCell?: (paneIndex: number) => ReactNode
  /** Close a pane — non-focused cells get a close affordance. */
  onClosePane?: (paneIndex: number) => void
}

export function MultiviewPaneGrid(props: MultiviewPaneGridProps) {
  // Single layout is today's render — no grid host, no wrapper, zero diff.
  if (props.layout === 'single') {
    return <>{props.renderFocusedCell()}</>
  }

  const spec = getMultiviewLayoutSpec(props.layout)

  const renderCell = (paneIndex: number): ReactNode => {
    if (paneIndex === props.focusedPaneIndex) return props.renderFocusedCell()
    const chatId = props.paneChatIds[paneIndex] ?? null
    if (chatId) return props.renderViewerCell(chatId, paneIndex)
    return props.renderEmptyCell ? props.renderEmptyCell(paneIndex) : null
  }

  return (
    <div
      className={`multiview-grid multiview-layout-${props.layout}`}
      style={{
        gridTemplateAreas: spec.gridTemplateAreas,
        gridTemplateColumns: spec.gridTemplateColumns,
        gridTemplateRows: spec.gridTemplateRows
      }}
    >
      {spec.cellAreas.map((area, paneIndex) => (
        <div
          key={paneIndex}
          className={`multiview-cell${
            paneIndex === props.focusedPaneIndex ? ' multiview-cell-focused' : ''
          }`}
          style={{ gridArea: area }}
          data-pane-index={paneIndex}
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
    </div>
  )
}
