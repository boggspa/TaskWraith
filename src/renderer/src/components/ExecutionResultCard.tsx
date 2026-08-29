import type { JSX } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { NativeOrchestrationCard } from './NativeOrchestrationCard'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import {
  executionResultOutcome,
  executionResultSeatId,
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
  onOpenExecutionMap?: (executionId: string) => void
}

/** `provider:model` → the model half, which is what the header should name. */
function seatModelLabel(seatId: string | undefined): string | undefined {
  if (!seatId) return undefined
  const separator = seatId.indexOf(':')
  const model = separator >= 0 ? seatId.slice(separator + 1) : seatId
  return model.trim() || undefined
}

export function ExecutionResultCard({
  message,
  provider,
  onOpenExecutionMap
}: ExecutionResultCardProps): JSX.Element {
  const outcome = executionResultOutcome(message)
  const executionId =
    typeof message.metadata?.executionId === 'string' ? message.metadata.executionId : undefined
  const seatModel = seatModelLabel(executionResultSeatId(message))

  const metaParts = ['Durable execution']
  if (seatModel) metaParts.push(seatModel)
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
        <div className="execution-result-card-body" data-outcome={outcome}>
          {message.content}
        </div>
      }
    />
  )
}
