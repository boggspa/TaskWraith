import { useEffect, useState, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS,
  isContinuationHopsChangePayload,
  type ContinuationHopsChangeActor
} from '../../../shared/continuationHopsChange'
import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'
import { DigitOdometer } from './DigitOdometer'

function formatChangeTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function actorLabel(actor: ContinuationHopsChangeActor): string {
  if (actor === 'boss') return 'Boss'
  if (actor === 'captain') return 'Captain'
  return 'User'
}

function ContinuationHopsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M13.5 5.5V2.75l-1.75 1.5A5.5 5.5 0 0 0 2.5 7" />
      <path d="M2.5 10.5v2.75l1.75-1.5A5.5 5.5 0 0 0 13.5 9" />
    </svg>
  )
}

/**
 * Durable max-handoff-turns change, rendered in the same transcript lane as a
 * seat change. Every mount holds the old number long enough to read, then lets
 * DigitOdometer carry the visible old -> new transition. Clicking reveals the
 * static old value underneath.
 */
export function ContinuationHopsChangeRow({
  message
}: {
  message: ChatMessage
}): JSX.Element | null {
  const candidate = message.metadata?.continuationHopsChange
  const payload = isContinuationHopsChangePayload(candidate) ? candidate : null
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() =>
    Boolean(payload && Date.now() - Date.parse(payload.changedAt) < SEAT_CHANGE_COALESCE_WINDOW_MS)
  )

  useEffect(() => {
    if (!payload || phase === 'after') return
    const timer = window.setTimeout(
      () => setPhase('after'),
      CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [payload, phase])

  if (!payload) return null

  const currentValue = phase === 'before' ? payload.before : payload.after
  const changedBy = actorLabel(payload.actor)
  const actorTitle = [changedBy, payload.actorRole, payload.actorParticipantId]
    .filter(Boolean)
    .join(' · ')
  const time = formatChangeTime(message.timestamp)

  return (
    <div
      className={`message-group seat-change-message continuation-hops-change-message${
        fresh ? ' is-fresh' : ''
      }${expanded ? ' is-expanded' : ''}`}
    >
      <button
        type="button"
        className="seat-change-row continuation-hops-change-row"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? 'Hide the previous turn limit' : 'Show the previous turn limit'}
      >
        <span className="seat-change-icon continuation-hops-change-icon" aria-hidden>
          <ContinuationHopsIcon />
        </span>
        <span className="continuation-hops-change-label">Max handoff turns</span>
        <span className="continuation-hops-change-value">
          <DigitOdometer value={currentValue} ariaLabel={`Max handoff turns ${currentValue}`} />
        </span>
        <span className={`continuation-hops-change-actor is-${payload.actor}`} title={actorTitle}>
          {changedBy}
        </span>
        {payload.reason && (
          <span className="continuation-hops-change-reason" title={payload.reason}>
            Reason: {payload.reason}
          </span>
        )}
        {time && <span className="seat-change-time">{time}</span>}
      </button>
      {expanded && (
        <div className="seat-change-was continuation-hops-change-was">
          <span className="seat-change-was-label">was</span>
          <span className="continuation-hops-change-value is-previous">
            <DigitOdometer
              value={payload.before}
              ariaLabel={`Previous max handoff turns ${payload.before}`}
            />
          </span>
        </div>
      )}
    </div>
  )
}
