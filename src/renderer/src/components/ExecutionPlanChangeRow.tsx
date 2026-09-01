import { useState, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import { ensembleAuthorityRoleLabel } from '../../../shared/ensembleAuthority'
import { resolveExecutionPlanChangePayload } from '../../../shared/executionPlanChange'
import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'

function formatChangeTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Route glyph — a plan is a path through the round, waypoint to waypoint. */
function ExecutionPlanIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="3.5" cy="12.5" r="1.75" />
      <circle cx="12.5" cy="3.5" r="1.75" />
      <path d="M12.5 5.25v1a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 0-2.5 2.5v.5" />
    </svg>
  )
}

/**
 * Durable authoritative execution-plan change, rendered in the same transcript
 * lane as a seat change: fresh rows hop in with the shared animation, the
 * compact line ellipsizes the summary, and clicking discloses the full plan
 * details. The "was" line appears only for later plan updates — the payload
 * carries `previousSummary` only then. No odometer: the summary is prose, so
 * the row never fakes a rolling text transition.
 */
export function ExecutionPlanChangeRow({ message }: { message: ChatMessage }): JSX.Element | null {
  const payload = resolveExecutionPlanChangePayload(message)
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() =>
    Boolean(payload && Date.now() - Date.parse(payload.changedAt) < SEAT_CHANGE_COALESCE_WINDOW_MS)
  )

  if (!payload) return null

  const actorName = ensembleAuthorityRoleLabel(payload.actor)
  const time = formatChangeTime(message.timestamp)
  const owners = payload.ownerLabels?.length ? payload.ownerLabels : payload.ownerParticipantIds
  const toggleLabel = `${expanded ? 'Hide' : 'Show'} the plan details`
  const accessibilityLabel = [
    `${actorName} set the execution plan: ${payload.summary}`,
    payload.previousSummary ? `Replaces: ${payload.previousSummary}.` : '',
    `${toggleLabel}.`
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={`message-group seat-change-message execution-plan-change-message${
        fresh ? ' is-fresh' : ''
      }${expanded ? ' is-expanded' : ''}`}
    >
      <button
        type="button"
        className="seat-change-row execution-plan-change-row"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={accessibilityLabel}
        title={toggleLabel}
      >
        <span className="seat-change-icon execution-plan-change-icon" aria-hidden>
          <ExecutionPlanIcon />
        </span>
        <span className="execution-plan-change-label">Execution plan</span>
        <span className="execution-plan-change-summary" title={payload.summary}>
          {payload.summary}
        </span>
        <span
          className={`execution-plan-change-actor is-${payload.actor}`}
          title={[actorName, payload.actorParticipantId].filter(Boolean).join(' · ')}
        >
          {actorName}
        </span>
        {time && <span className="seat-change-time">{time}</span>}
      </button>
      {expanded && (
        <div className="execution-plan-change-details">
          <div className="execution-plan-change-full">{payload.summary}</div>
          {payload.phase && (
            <div className="execution-plan-change-detail">
              <span className="execution-plan-change-detail-label">Phase</span>
              <span>{payload.phase}</span>
            </div>
          )}
          {owners && owners.length > 0 && (
            <div className="execution-plan-change-detail">
              <span className="execution-plan-change-detail-label">Owners</span>
              <span>{owners.join(', ')}</span>
            </div>
          )}
          {payload.blockers && payload.blockers.length > 0 && (
            <div className="execution-plan-change-detail">
              <span className="execution-plan-change-detail-label">Blockers</span>
              <span>{payload.blockers.join(' · ')}</span>
            </div>
          )}
          {payload.doneCriteria && (
            <div className="execution-plan-change-detail">
              <span className="execution-plan-change-detail-label">Done when</span>
              <span>{payload.doneCriteria}</span>
            </div>
          )}
        </div>
      )}
      {expanded && payload.previousSummary && (
        <div className="seat-change-was execution-plan-change-was">
          <span className="seat-change-was-label">was</span>
          <span className="execution-plan-change-was-summary" title={payload.previousSummary}>
            {payload.previousSummary}
          </span>
        </div>
      )}
    </div>
  )
}
