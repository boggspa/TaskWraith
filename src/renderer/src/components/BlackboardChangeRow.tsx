import { useState, type CSSProperties, type JSX } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  BLACKBOARD_CHANGE_FRESH_WINDOW_MS,
  type BlackboardChangePayload
} from '../../../shared/blackboardChange'
import { providerAccentVar } from '../lib/ollamaDisplayBrand'
import {
  resolveBlackboardChangePresentation,
  type BlackboardChangePresentation
} from '../lib/blackboardChangePresentation'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'
import { DigitOdometer } from './DigitOdometer'

export { resolveBlackboardChangePresentation } from '../lib/blackboardChangePresentation'
export type {
  BlackboardChangePresentation,
  LegacyBlackboardChangePresentation
} from '../lib/blackboardChangePresentation'

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
  payload,
  addedCount
}: {
  payload: BlackboardChangePresentation
  addedCount?: number
}): JSX.Element | null {
  if (payload.action === 'scoutBriefShared') return null
  const isRemoval = payload.action === 'cleaned'
  const value = isRemoval ? payload.removedCount : (addedCount ?? 1)
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
  time,
  addedCount
}: {
  payload: BlackboardChangePresentation
  label: string
  time: string
  addedCount?: number
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
      <BlackboardEntryDelta payload={payload} addedCount={addedCount} />
      {time && <span className="seat-change-time blackboard-change-time">{time}</span>}
    </>
  )
}

function changeAccentStyle(payload: BlackboardChangePresentation): CSSProperties | undefined {
  if (!('displayProviderLabel' in payload)) return undefined
  const accent = providerAccentVar(payload.displayHueClass || payload.provider)
  return { '--blackboard-change-accent': accent } as CSSProperties
}

function BlackboardUpdateStackItem({ message }: { message: ChatMessage }): JSX.Element | null {
  const payload = resolveBlackboardChangePresentation(message)
  if (!payload || payload.action !== 'updated') return null
  const label = actionLabel(payload)
  const detail = actionDetail(payload)
  const structured = 'displayProviderLabel' in payload
  return (
    <li
      className="blackboard-change-stack-item"
      style={changeAccentStyle(payload)}
      aria-label={
        structured
          ? `${label} by ${payload.displayProviderLabel}: ${detail}`
          : `${label}: ${detail}`
      }
    >
      <div className="seat-change-row blackboard-change-row">
        <ChangeContents
          payload={payload}
          label={label}
          time={formatChangeTime(message.timestamp)}
        />
      </div>
    </li>
  )
}

/**
 * Run-authored Blackboard mutation at the same transcript level as a seat or
 * handoff change. Provider identity is carried by the familiar tool glyph's
 * accent, not an assistant header or seat-name label.
 */
export function BlackboardChangeRow({
  message,
  stackMessages,
  expanded: controlledExpanded,
  onExpandedChange
}: {
  message: ChatMessage
  stackMessages?: readonly ChatMessage[]
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}): JSX.Element | null {
  const payload = resolveBlackboardChangePresentation(message)
  const [localExpanded, setLocalExpanded] = useState(false)
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
  const style = changeAccentStyle(payload)
  const isScoutBrief = payload.action === 'scoutBriefShared'
  const isUpdateStack =
    payload.action === 'updated' && Boolean(stackMessages && stackMessages.length > 1)
  const expanded = controlledExpanded ?? localExpanded
  const toggleExpanded = (): void => {
    const next = !expanded
    if (onExpandedChange) onExpandedChange(next)
    else setLocalExpanded(next)
  }
  const expandable = isScoutBrief || isUpdateStack

  return (
    <div
      className={`message-group seat-change-message blackboard-change-message${
        fresh ? ' is-fresh' : ''
      }${isScoutBrief ? ' is-scout-brief' : ''}${
        isUpdateStack ? ' is-update-stack' : ''
      }${expanded ? ' is-expanded' : ''}`}
      style={style}
      role="group"
      aria-label={
        isUpdateStack
          ? `${stackMessages!.length} Blackboard updates. Latest: ${detail}`
          : isScoutBrief
            ? `${label}: ${detail}`
            : structured
              ? `${label} by ${payload.displayProviderLabel}: ${detail}`
              : `${label}: ${detail}`
      }
    >
      {expandable ? (
        <button
          type="button"
          className="seat-change-row blackboard-change-row"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          title={
            isUpdateStack
              ? expanded
                ? 'Hide individual Blackboard updates'
                : `Show all ${stackMessages!.length} Blackboard updates`
              : expanded
                ? 'Hide Scout brief sharing details'
                : 'Show Scout brief sharing details'
          }
        >
          <ChangeContents
            payload={payload}
            label={label}
            time={time}
            addedCount={isUpdateStack ? stackMessages!.length : undefined}
          />
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
      {isUpdateStack && expanded && (
        <ol
          className="blackboard-change-stack"
          aria-label={`${stackMessages!.length} individual Blackboard updates, oldest first`}
        >
          {stackMessages!.map((stackMessage, index) => (
            <BlackboardUpdateStackItem key={`${stackMessage.id}:${index}`} message={stackMessage} />
          ))}
        </ol>
      )}
    </div>
  )
}
