import type { JSX } from 'react'
import type { ProviderId } from '../../../main/store/types'
import {
  executionGhostSummary,
  type ExecutionGhostCardView
} from '../../../shared/executionGraphGhost'
import { NativeOrchestrationCard } from './NativeOrchestrationCard'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { SeatChangeInlineStrip } from './SeatChangeRow'
import { ExecutionGhostStrip } from './ExecutionGhostStrip'
import { executionSeatLink } from './ExecutionResultCardModel'

/**
 * A durable execution graph while it is still running.
 *
 * DERIVED AT RENDER TIME from the live projection — deliberately not an
 * authored message. Authoring is a one-shot reaction, so an authored live card
 * would have to be found and mutated on every activation and deleted on
 * settle; miss one and the transcript keeps a card claiming work that stopped
 * hours ago. Deriving it means the card cannot outlive the state it describes.
 *
 * This is the surface that answers "how many agents are in, proposed, or
 * finished" — those three states only coexist while a graph is in flight, so
 * the settled result card can never show them.
 */
export interface ExecutionLiveCardProps {
  view: ExecutionGhostCardView
  /** Seat that owns the execution, for accent + glyph. */
  provider: ProviderId
  onOpenExecutionMap?: (executionId: string) => void
  onCancelExecution?: (executionId: string) => void
  /** Offered only while the graph is paused — there is nothing to resume
   * otherwise, and a control that refuses on click teaches nothing. */
  onResumeExecution?: (executionId: string) => void
}

function liveStatusSlug(state: string): string {
  return state === 'requires_action' ? 'attention' : 'running'
}

function liveStatusLabel(view: ExecutionGhostCardView): string {
  if (view.state === 'requires_action') return 'Needs attention'
  if (view.counts.running > 0) return 'Running'
  if (view.counts.queued > 0) return 'Queued'
  return 'Preparing'
}

export function ExecutionLiveCard({
  view,
  provider,
  onOpenExecutionMap,
  onCancelExecution,
  onResumeExecution
}: ExecutionLiveCardProps): JSX.Element {
  const seatLink = executionSeatLink(view.seatId, view.executionId)
  const paused = view.state === 'requires_action'
  const providerRunning = !paused && view.counts.running > 0
  const pending = !paused && !providerRunning
  const progressFraction = view.counts.total ? view.counts.settled / view.counts.total : 0

  const metaParts = ['Durable execution', executionGhostSummary(view.counts)]
  if (paused) metaParts.push('paused — needs a decision')

  return (
    <NativeOrchestrationCard
      cardClassName="execution-live-card"
      provider={provider}
      status={liveStatusSlug(view.state)}
      statusLabel={liveStatusLabel(view)}
      // A paused graph is stopped: animating it would say work is happening
      // when the whole point of the state is that none is.
      isRunning={providerRunning}
      isPending={pending}
      progressFraction={progressFraction}
      glyph={<ProviderBrandLogoIcon provider={provider} />}
      name={view.title || 'Durable execution'}
      metaParts={metaParts}
      useProviderAccent
      headerTrailing={
        <span className="execution-live-card-actions">
          {onOpenExecutionMap ? (
            <button
              type="button"
              className="execution-result-card-open-map"
              onClick={() => onOpenExecutionMap(view.executionId)}
            >
              Open map
            </button>
          ) : null}
          {paused && onResumeExecution ? (
            <button
              type="button"
              className="execution-live-card-resume"
              onClick={() => onResumeExecution(view.executionId)}
            >
              Resume
            </button>
          ) : null}
          {onCancelExecution ? (
            <button
              type="button"
              className="execution-live-card-cancel"
              onClick={() => onCancelExecution(view.executionId)}
            >
              Cancel
            </button>
          ) : null}
        </span>
      }
      // `extras`, never `detail`: a progress read behind a disclosure chevron
      // is not a progress read.
      extras={
        <div className="execution-live-card-body">
          {seatLink ? (
            <div className="execution-live-card-seat">
              <SeatChangeInlineStrip link={seatLink} />
            </div>
          ) : null}
          <ExecutionGhostStrip cells={view.cells} />
        </div>
      }
    />
  )
}
