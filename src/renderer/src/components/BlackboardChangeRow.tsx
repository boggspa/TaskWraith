import { useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  BLACKBOARD_CHANGE_FRESH_WINDOW_MS,
  isBlackboardChangePayload,
  type BlackboardChangePayload
} from '../../../shared/blackboardChange'
import { providerAccentVar } from '../lib/ollamaDisplayBrand'
import { BlackboardGlyph } from './icons/BlackboardGlyph'

function formatChangeTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function actionLabel(payload: BlackboardChangePayload): string {
  if (payload.action === 'scoutBriefShared') return 'Scout brief shared'
  if (payload.action === 'pollOpened') return 'Blackboard poll opened'
  if (payload.action === 'cleaned') return 'Blackboard cleaned'
  return 'Blackboard updated'
}

function actionDetail(payload: BlackboardChangePayload): string {
  if (payload.action === 'scoutBriefShared') {
    const caveat =
      payload.confidence === 'low'
        ? ' · needs verification'
        : payload.confidence === 'medium'
          ? ' · tentative'
          : ''
    return `${payload.role} (${payload.displayProviderLabel}) · Blackboard + next writer${caveat}`
  }
  if (payload.action === 'cleaned') {
    return `${payload.removedCount} ${payload.removedCount === 1 ? 'entry' : 'entries'} removed`
  }
  if (payload.action === 'pollOpened') return `${payload.key} · ${payload.optionCount} choices`
  return `${payload.category} / ${payload.key}`
}

function ScoutBriefDetail({ payload }: { payload: BlackboardChangePayload }): JSX.Element | null {
  if (payload.action !== 'scoutBriefShared') return null
  const caveat =
    payload.confidence === 'low'
      ? 'Needs verification'
      : payload.confidence === 'medium'
        ? 'Tentative'
        : ''
  return (
    <>
      <span className="blackboard-scout-brief-role">{payload.role}</span>
      <span className="blackboard-scout-brief-provider">({payload.displayProviderLabel})</span>
      <span className="blackboard-change-separator">·</span>
      <span className="blackboard-change-detail">Blackboard + next writer</span>
      {caveat && (
        <span
          className={`blackboard-scout-brief-caveat is-${payload.confidence}`}
          title={`Scout confidence: ${payload.confidence}`}
        >
          {caveat}
        </span>
      )}
    </>
  )
}

function ChangeContents({
  payload,
  label,
  time
}: {
  payload: BlackboardChangePayload
  label: string
  time: string
}): JSX.Element {
  return (
    <>
      <span className="seat-change-icon blackboard-change-icon" aria-hidden>
        <BlackboardGlyph />
      </span>
      <span className="blackboard-change-label">{label}</span>
      {payload.action === 'updated' ? (
        <>
          <span className="blackboard-change-category">{payload.category}</span>
          <span className="blackboard-change-separator">/</span>
          <span className="blackboard-change-key" title={payload.key}>
            {payload.key}
          </span>
        </>
      ) : payload.action === 'pollOpened' ? (
        <>
          <span className="blackboard-change-key" title={payload.key}>
            {payload.key}
          </span>
          <span className="blackboard-change-detail">
            {payload.optionCount} {payload.optionCount === 1 ? 'choice' : 'choices'}
          </span>
        </>
      ) : payload.action === 'cleaned' ? (
        <span className="blackboard-change-detail">
          {payload.removedCount} {payload.removedCount === 1 ? 'entry' : 'entries'} removed
        </span>
      ) : (
        <ScoutBriefDetail payload={payload} />
      )}
      {time && <span className="seat-change-time blackboard-change-time">{time}</span>}
    </>
  )
}

/**
 * Run-authored Blackboard mutation at the same transcript level as a seat or
 * handoff change. Provider identity is carried by the familiar tool glyph's
 * accent, not an assistant header or seat-name label.
 */
export function BlackboardChangeRow({ message }: { message: ChatMessage }): JSX.Element | null {
  const candidate = message.metadata?.blackboardChange
  const payload = isBlackboardChangePayload(candidate) ? candidate : null
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() => {
    if (!payload) return false
    const age = Date.now() - Date.parse(payload.changedAt)
    return age >= 0 && age < BLACKBOARD_CHANGE_FRESH_WINDOW_MS
  })

  if (!payload) return null

  const label = actionLabel(payload)
  const detail = actionDetail(payload)
  const time = formatChangeTime(message.timestamp)
  const accent = providerAccentVar(payload.displayHueClass || payload.provider)
  const style = accent ? ({ '--accent': accent } as CSSProperties) : undefined
  const isScoutBrief = payload.action === 'scoutBriefShared'

  return (
    <div
      className={`message-group seat-change-message blackboard-change-message${
        fresh ? ' is-fresh' : ''
      }${isScoutBrief ? ' is-scout-brief' : ''}${expanded ? ' is-expanded' : ''}`}
      style={style}
      role="group"
      aria-label={
        isScoutBrief
          ? `${label}: ${detail}`
          : `${label} by ${payload.displayProviderLabel}: ${detail}`
      }
    >
      {isScoutBrief ? (
        <button
          type="button"
          className="seat-change-row blackboard-change-row"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? 'Hide Scout brief sharing details' : 'Show Scout brief sharing details'}
        >
          <ChangeContents payload={payload} label={label} time={time} />
        </button>
      ) : (
        <div className="seat-change-row blackboard-change-row">
          <ChangeContents payload={payload} label={label} time={time} />
        </div>
      )}
      {isScoutBrief && expanded && (
        <div className="seat-change-was blackboard-scout-brief-explanation">
          <span className="seat-change-was-label">shared with</span>
          <span>Session Blackboard</span>
          <span className="blackboard-change-separator">·</span>
          <span>next serial writer</span>
          <span className="blackboard-change-separator">·</span>
          <span className="blackboard-change-detail">later briefs update this entry</span>
        </div>
      )}
    </div>
  )
}
