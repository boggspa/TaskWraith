import { useEffect, useState, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS,
  resolveContinuationHopsChangePayload,
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

function ContinuationHopsValue({
  value,
  maxHops,
  previous = false
}: {
  value: number
  maxHops?: number
  previous?: boolean
}): JSX.Element {
  const className = `continuation-hops-change-value${previous ? ' is-previous' : ''}`
  if (maxHops === undefined) {
    return (
      <span className={className}>
        <DigitOdometer
          value={value}
          ariaLabel={`${previous ? 'Previous max' : 'Max'} handoff turns ${value}`}
        />
      </span>
    )
  }

  return (
    <span
      className={className}
      role="img"
      aria-label={
        previous
          ? `Previous handoff turns ${value} of ${maxHops}`
          : `Handoff turns ${value} of ${maxHops}`
      }
    >
      <span aria-hidden>
        <DigitOdometer value={value} />
        <span>/</span>
        <DigitOdometer value={maxHops} />
      </span>
    </span>
  )
}

/**
 * Durable max-handoff-turns change or consumed handoff, rendered in the same
 * transcript lane as a seat change. Every mount holds the old number long
 * enough to read, then lets DigitOdometer carry the visible old -> new
 * transition. Clicking reveals the static old value underneath.
 */
export function ContinuationHopsChangeRow({
  message
}: {
  message: ChatMessage
}): JSX.Element | null {
  const payload = resolveContinuationHopsChangePayload(message)
  const hasPayload = payload !== null
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() =>
    Boolean(payload && Date.now() - Date.parse(payload.changedAt) < SEAT_CHANGE_COALESCE_WINDOW_MS)
  )

  useEffect(() => {
    if (!hasPayload || phase === 'after') return
    const timer = window.setTimeout(
      () => setPhase('after'),
      CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [hasPayload, message.id, phase])

  if (!payload) return null

  const isAdvance = payload.event === 'advance'
  const currentValue = phase === 'before' ? payload.before : payload.after
  const changedBy = isAdvance ? null : actorLabel(payload.actor)
  const primaryLabel = isAdvance ? payload.targetLabel || payload.sourceLabel : changedBy
  const secondaryLabel = isAdvance && payload.targetLabel ? payload.sourceLabel : undefined
  const actorTitle = isAdvance
    ? [payload.sourceLabel, payload.targetLabel].filter(Boolean).join(' → ')
    : [changedBy, payload.actorRole, payload.actorParticipantId].filter(Boolean).join(' · ')
  const time = formatChangeTime(message.timestamp)
  const rowLabel = isAdvance ? 'Handoff turns' : 'Max handoff turns'
  const previousTitle = isAdvance ? 'handoff count' : 'turn limit'
  const toggleLabel = `${expanded ? 'Hide' : 'Show'} the previous ${previousTitle}`
  const accessibilityLabel = isAdvance
    ? [
        `Handoff turns advanced from ${payload.before} to ${payload.after} of ${payload.maxHops}.`,
        payload.targetLabel ? `Target ${payload.targetLabel}.` : '',
        payload.sourceLabel ? `Source ${payload.sourceLabel}.` : '',
        `${toggleLabel}.`
      ]
        .filter(Boolean)
        .join(' ')
    : [
        `Max handoff turns changed from ${payload.before} to ${payload.after}.`,
        changedBy ? `Changed by ${changedBy}.` : '',
        payload.reason ? `Reason: ${payload.reason}.` : '',
        `${toggleLabel}.`
      ]
        .filter(Boolean)
        .join(' ')

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
        aria-label={accessibilityLabel}
        title={toggleLabel}
      >
        <span className="seat-change-icon continuation-hops-change-icon" aria-hidden>
          <ContinuationHopsIcon />
        </span>
        <span className="continuation-hops-change-label">{rowLabel}</span>
        <ContinuationHopsValue
          value={currentValue}
          maxHops={isAdvance ? payload.maxHops : undefined}
        />
        {primaryLabel && (
          <span
            className={`continuation-hops-change-actor${
              isAdvance ? ' is-advance' : ` is-${payload.actor}`
            }`}
            title={actorTitle}
          >
            {primaryLabel}
          </span>
        )}
        {secondaryLabel && (
          <span className="continuation-hops-change-reason" title={secondaryLabel}>
            {secondaryLabel}
          </span>
        )}
        {!isAdvance && payload.reason && (
          <span className="continuation-hops-change-reason" title={payload.reason}>
            Reason: {payload.reason}
          </span>
        )}
        {time && <span className="seat-change-time">{time}</span>}
      </button>
      {expanded && (
        <div className="seat-change-was continuation-hops-change-was">
          <span className="seat-change-was-label">was</span>
          <ContinuationHopsValue
            value={payload.before}
            maxHops={isAdvance ? payload.maxHops : undefined}
            previous
          />
        </div>
      )}
    </div>
  )
}
