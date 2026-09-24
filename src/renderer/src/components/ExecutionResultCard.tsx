import type { JSX } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { NativeOrchestrationCard } from './NativeOrchestrationCard'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { SeatChangeInlineStrip } from './SeatChangeRow'
import { ExecutionGhostStrip } from './ExecutionGhostStrip'
import {
  executionGhostSummary,
  type ExecutionGhostCardView
} from '../../../shared/executionGraphGhost'
import {
  executionResultExecutionId,
  executionResultOutcome,
  executionResultSeatLink,
  executionResultStatusLabel,
  executionResultStatusSlug,
  executionResultTitle
} from './ExecutionResultCardModel'

/**
 * The delivered result of a durable execution graph.
 *
 * Presentation is deliberately derivative of the fleet card — it rides the same
 * `NativeOrchestrationCard` chassis that FleetWaveCard, WorkflowCard and
 * ReviewCard use, so a graph result reads as a sibling of the other
 * orchestration outcomes rather than as a new species of row.
 *
 * The DATA underneath is graph-native. Nothing here reads `subThreadReturn`,
 * `parallelResultWaveId`, or any sub-thread field; reusing those to get this
 * presentation for free would have made close-out harvesting and seat
 * attribution silently misdescribe the execution.
 */

export interface ExecutionResultCardProps {
  message: ChatMessage
  /** Seat that owned the execution, for accent + glyph. */
  provider: ProviderId
  /** Live projection of the same execution, when the thread still holds one —
   * supplies the ghost strip's cells. Absent, the card simply omits the strip
   * rather than inventing a shape for it. */
  view?: ExecutionGhostCardView
  onOpenExecutionMap?: (executionId: string) => void
}

export function ExecutionResultCard({
  message,
  provider,
  view,
  onOpenExecutionMap
}: ExecutionResultCardProps): JSX.Element {
  const outcome = executionResultOutcome(message)
  const executionId = executionResultExecutionId(message)
  const seatLink = executionResultSeatLink(message)

  const metaParts = ['Durable execution']
  // The seat is named by the shared seat element below, not by a slug here —
  // repeating the model in the meta row would say the same thing twice, worse.
  if (view) metaParts.push(executionGhostSummary(view.counts))
  if (outcome === 'requires_action') {
    // Say what the reader must do, not merely what state the graph is in.
    metaParts.push('paused — needs a decision')
  }

  return (
    <NativeOrchestrationCard
      cardClassName="execution-result-card"
      provider={provider}
      status={executionResultStatusSlug(outcome)}
      statusLabel={executionResultStatusLabel(outcome)}
      // A delivered result is settled by construction: this row only exists
      // once the graph has stopped, so it never animates as live.
      isRunning={false}
      glyph={<ProviderBrandLogoIcon provider={provider} />}
      name={executionResultTitle(message)}
      metaParts={metaParts}
      useProviderAccent
      headerTrailing={
        executionId && onOpenExecutionMap ? (
          <button
            type="button"
            className="execution-result-card-open-map"
            onClick={() => onOpenExecutionMap(executionId)}
          >
            Open map
          </button>
        ) : undefined
      }
      // The result goes in `extras` (always visible), never `detail` (collapsed
      // behind the chevron). This card exists so a graph's answer reaches the
      // thread that asked for it; putting the answer behind a disclosure would
      // reproduce the silence it was built to remove — the reader would see
      // "Complete" and no result. Long output scrolls in place instead.
      extras={
        <>
          {seatLink || view ? (
            <div className="execution-result-card-attribution">
              {seatLink ? <SeatChangeInlineStrip link={seatLink} /> : null}
              {view ? <ExecutionGhostStrip cells={view.cells} /> : null}
            </div>
          ) : null}
          <div className="execution-result-card-body" data-outcome={outcome}>
            {message.content}
          </div>
        </>
      }
    />
  )
}
