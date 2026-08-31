import { useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  BLACKBOARD_CHANGE_KIND,
  BLACKBOARD_CHANGE_FRESH_WINDOW_MS,
  isBlackboardChangePayload,
  type BlackboardChangePayload
} from '../../../shared/blackboardChange'
import { providerAccentVar } from '../lib/ollamaDisplayBrand'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'
import { DigitOdometer } from './DigitOdometer'

export type LegacyBlackboardChangePresentation =
  | {
      action: 'updated'
      category: Extract<BlackboardChangePayload, { action: 'updated' }>['category']
      key: string
      changedAt: string
    }
  | { action: 'cleaned'; removedCount: number; changedAt: string }
  | { action: 'pollOpened'; key: string; optionCount: number; changedAt: string }

export type BlackboardChangePresentation =
  | BlackboardChangePayload
  | LegacyBlackboardChangePresentation

const LEGACY_BLACKBOARD_UPDATED =
  /^Blackboard updated: (decision|fact|risk|do-not-repeat|note) \/ (.{1,80})\.$/
const LEGACY_BLACKBOARD_CLEANED = /^Blackboard cleaned: removed (\d{1,2}) (entry|entries)\.$/
const LEGACY_BLACKBOARD_POLL = /^Blackboard poll opened: (.{1,80}) \((\d) choices\)\.$/

const BLACKBOARD_CHANGE_CATEGORY_LABELS: Record<
  Extract<BlackboardChangePresentation, { action: 'updated' }>['category'],
  string
> = {
  decision: 'Decision',
  fact: 'Fact',
  risk: 'Risk',
  'do-not-repeat': 'Do Not Repeat',
  note: 'Note'
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

/** Strict display-only promotion for canonical rows written before structured metadata shipped. */
export function resolveBlackboardChangePresentation(
  message: ChatMessage
): BlackboardChangePresentation | null {
  const candidate = message.metadata?.blackboardChange
  if (candidate !== undefined) {
    if (message.role !== 'system' || message.metadata?.kind !== BLACKBOARD_CHANGE_KIND) return null
    return isBlackboardChangePayload(candidate) ? candidate : null
  }
  if (
    message.role !== 'system' ||
    message.metadata?.kind !== 'ensembleRoundStatus' ||
    typeof message.content !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    message.content.length > 160 ||
    message.content.includes('\n')
  ) {
    return null
  }
  const updated = message.content.match(LEGACY_BLACKBOARD_UPDATED)
  if (updated) {
    if (hasControlCharacters(updated[2])) return null
    return {
      action: 'updated',
      category: updated[1] as Extract<BlackboardChangePayload, { action: 'updated' }>['category'],
      key: updated[2],
      changedAt: message.timestamp
    }
  }
  const poll = message.content.match(LEGACY_BLACKBOARD_POLL)
  if (poll) {
    const optionCount = Number(poll[2])
    if (hasControlCharacters(poll[1]) || optionCount < 2 || optionCount > 6) return null
    return {
      action: 'pollOpened',
      key: poll[1],
      optionCount,
      changedAt: message.timestamp
    }
  }
  const cleaned = message.content.match(LEGACY_BLACKBOARD_CLEANED)
  if (!cleaned) return null
  const removedCount = Number(cleaned[1])
  const expectedNoun = removedCount === 1 ? 'entry' : 'entries'
  if (removedCount < 1 || removedCount > 60 || cleaned[2] !== expectedNoun) return null
  return { action: 'cleaned', removedCount, changedAt: message.timestamp }
}

function formatChangeTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function actionLabel(payload: BlackboardChangePresentation): string {
  if (payload.action === 'scoutBriefShared') return 'Scout brief shared'
  if (payload.action === 'pollOpened') return 'Blackboard poll opened'
  if (payload.action === 'cleaned') return 'Blackboard cleaned'
  return 'Blackboard updated'
}

function actionDetail(payload: BlackboardChangePresentation): string {
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

function BlackboardEntryDelta({
  payload
}: {
  payload: BlackboardChangePresentation
}): JSX.Element | null {
  if (payload.action === 'scoutBriefShared') return null
  const isRemoval = payload.action === 'cleaned'
  const value = isRemoval ? payload.removedCount : 1
  const sign = isRemoval ? '-' : '+'

  return (
    <span className="activity-line-stats blackboard-change-entry-delta">
      <DigitOdometer
        value={value}
        sign={sign}
        ariaLabel={`${sign}${value} Entries`}
        className={`activity-line-stat activity-line-stat-${isRemoval ? 'delete' : 'add'}`}
      />
      <span className="blackboard-change-stat-unit" aria-hidden>
        Entries
      </span>
    </span>
  )
}

function ChangeContents({
  payload,
  label,
  time
}: {
  payload: BlackboardChangePresentation
  label: string
  time: string
}): JSX.Element {
  return (
    <>
      <span className="seat-change-icon blackboard-change-icon" aria-hidden>
        <ToolFamilyIcon family="blackboard" size={16} className="blackboard-glyph" />
      </span>
      <span className="blackboard-change-label">{label}</span>
      {payload.action === 'updated' ? (
        <>
          <span className={`blackboard-change-category blackboard-cat-${payload.category}`}>
            {BLACKBOARD_CHANGE_CATEGORY_LABELS[payload.category]}
          </span>
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
      ) : payload.action === 'cleaned' ? null : (
        <ScoutBriefDetail payload={payload} />
      )}
      <BlackboardEntryDelta payload={payload} />
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
  const payload = resolveBlackboardChangePresentation(message)
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
  const structured = 'displayProviderLabel' in payload
  const accent = structured
    ? providerAccentVar(payload.displayHueClass || payload.provider)
    : undefined
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
          : structured
            ? `${label} by ${payload.displayProviderLabel}: ${detail}`
            : `${label}: ${detail}`
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
