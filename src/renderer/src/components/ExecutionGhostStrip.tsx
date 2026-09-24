import { useId, type JSX } from 'react'
import {
  executionGhostSummary,
  executionGraphGhostCounts,
  type ExecutionGhostCell
} from '../../../shared/executionGraphGhost'
import { TASKWRAITH_GHOST_MONOLINE_PATHS } from './icons/TaskWraithGhostMark'

/**
 * Density strip for a durable execution graph — one mini monoline ghost per
 * work-bearing step, in topology order.
 *
 * The visual grammar is the fleet wave strip's, deliberately: outline while
 * unsettled, filled once stopped, accent for in flight, amber for an ask. A
 * reader who has learned the fleet card reads this one for free.
 *
 * The cells carry their own rules rather than reusing `.fleet-wave-card-cell`.
 * That rule is pinned by an exact-selector test which a grouped selector would
 * break, and naming an execution step a "fleet wave" cell would be a lie in the
 * DOM. `executionGhostStripCss.test.ts` asserts the two rule sets agree on the
 * stroke maths so the duplication cannot drift apart silently.
 */
export interface ExecutionGhostStripProps {
  cells: readonly ExecutionGhostCell[]
  /** Header treatment: right-aligned and size-capped, as on the fleet card. */
  header?: boolean
}

export function ExecutionGhostStrip({
  cells,
  header = false
}: ExecutionGhostStripProps): JSX.Element | null {
  // A graph with no work-bearing steps has nothing to show. Rendering an empty
  // strip would read as "no agents have started" rather than "there are none".
  const symbolId = `execution-ghost${useId().replace(/:/g, '')}`
  if (cells.length === 0) return null
  const counts = executionGraphGhostCounts(cells)

  return (
    <div
      className={`execution-ghost-strip${header ? ' is-header' : ''}`}
      role="img"
      aria-label={executionGhostSummary(counts)}
    >
      <svg
        width={0}
        height={0}
        aria-hidden="true"
        focusable="false"
        style={{ position: 'absolute' }}
      >
        <symbol id={symbolId} viewBox="0 0 128 128">
          {TASKWRAITH_GHOST_MONOLINE_PATHS}
        </symbol>
      </svg>
      {cells.map((cell) => (
        <svg
          key={cell.id}
          className={`execution-ghost-cell status-${cell.status}`}
          viewBox="0 0 128 128"
          aria-hidden="true"
          focusable="false"
        >
          <title>{cell.title || cell.id}</title>
          <use href={`#${symbolId}`} />
        </svg>
      ))}
    </div>
  )
}
