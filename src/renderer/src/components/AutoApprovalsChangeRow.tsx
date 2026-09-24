import { useEffect, useState, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS,
  isAutoApprovalsChangePayload
} from '../../../shared/autoApprovalsChange'
import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'

function formatChangeTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function AutoApprovalsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 1.75 13 3.6v3.65c0 3.1-1.93 5.76-5 7-3.07-1.24-5-3.9-5-7V3.6L8 1.75Z" />
      <path d="m5.45 7.95 1.55 1.5 3.55-3.4" />
    </svg>
  )
}

function stateLabel(enabled: boolean): string {
  return enabled ? 'Enabled' : 'Disabled'
}

/** Visual clone of the real roster control; the outer row owns interaction. */
function AutoPill({ enabled }: { enabled: boolean }): JSX.Element {
  return (
    <span
      className="segmented-control-action segmented-control-action--compact thread-auto-approvals-pill auto-approvals-change-pill"
      data-pressed={enabled}
      aria-hidden
    >
      Auto
    </span>
  )
}

/**
 * Human-owned Auto Approvals consent change. On mount the real Auto pill holds
 * the old state for two seconds, then lights orange (or drains back to neutral)
 * for the new state. Clicking reveals the static previous state underneath.
 */
export function AutoApprovalsChangeRow({ message }: { message: ChatMessage }): JSX.Element | null {
  const candidate = message.metadata?.autoApprovalsChange
  const payload = isAutoApprovalsChangePayload(candidate) ? candidate : null
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() =>
    Boolean(payload && Date.now() - Date.parse(payload.changedAt) < SEAT_CHANGE_COALESCE_WINDOW_MS)
  )

  useEffect(() => {
    if (!payload || phase === 'after') return
    const timer = window.setTimeout(() => setPhase('after'), AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [payload, phase])

  if (!payload) return null

  const currentEnabled = phase === 'before' ? payload.before : payload.after
  const currentLabel = stateLabel(currentEnabled)
  const previousLabel = stateLabel(payload.before)
  const time = formatChangeTime(message.timestamp)

  return (
    <div
      className={`message-group seat-change-message auto-approvals-change-message${
        fresh ? ' is-fresh' : ''
      }${expanded ? ' is-expanded' : ''}`}
    >
      <button
        type="button"
        className="seat-change-row auto-approvals-change-row"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`Thread-wide Auto Approvals ${currentLabel.toLowerCase()}. ${
          expanded ? 'Hide' : 'Show'
        } previous state.`}
        title={
          expanded
            ? 'Hide the previous Auto Approvals state'
            : 'Show the previous Auto Approvals state'
        }
      >
        <span
          className={`seat-change-icon auto-approvals-change-icon${
            currentEnabled ? ' is-enabled' : ''
          }`}
          aria-hidden
        >
          <AutoApprovalsIcon />
        </span>
        <span className="auto-approvals-change-label">Thread-wide approvals</span>
        <AutoPill enabled={currentEnabled} />
        <span className={`auto-approvals-change-state${currentEnabled ? ' is-enabled' : ''}`}>
          ({currentLabel})
        </span>
        <span className="auto-approvals-change-actor">User</span>
        {time && <span className="seat-change-time">{time}</span>}
      </button>
      {expanded && (
        <div className="seat-change-was auto-approvals-change-was">
          <span className="seat-change-was-label">was</span>
          <AutoPill enabled={payload.before} />
          <span className={`auto-approvals-change-state${payload.before ? ' is-enabled' : ''}`}>
            ({previousLabel})
          </span>
        </div>
      )}
    </div>
  )
}
