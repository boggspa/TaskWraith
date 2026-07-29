// The composer context donut, made clickable: tapping it opens a small frosted
// popover (mirroring CombinedModelPicker's portal/positioning/dismiss) with a
// context meter + model/amount labels. Solo chats show one row for the active
// model; ensemble chats stack one row per participant (each with its own model
// + window). The numbers are the HONEST current-context proxy (latest turn's
// provider total ÷ window — see lib/contextMeter.ts); while a turn is live, a
// provider snapshot takes precedence over the fallback estimate.
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, ComposerStyle, ProviderId } from '../../../main/store/types'
import {
  applyLiveContextTokenUsage,
  buildContextActivitySummary,
  type ContextActivitySummary,
  type ContextMeterModel,
  type ContextMeterRow
} from '../lib/contextMeter'
import type { ContextUsageSnapshot } from '../../../shared/contextUsage'
import { formatContextTokens } from '../lib/contextWindows'
import { useParticipantWorkingTokenSnapshot } from '../lib/participantWorkingTelemetryStore'
import { contextPressureSeverity } from '../../../shared/contextCompaction'
import { humaniseModelIdCompact } from '../lib/modelDisplayName'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderName } from './Sidebar'
import { ContextWheel, ContextCompactionIcon } from './AppChromeSymbols'
import { ContextMeterDetails } from './ContextMeterDetails'

// Extremity ramp for the per-row compaction icon. A healthy seat reads in its
// provider hue; as pressure builds the glyph warms to a bright, saturated
// orange (~60%) and finally red near the ceiling (~85%) — a glanceable "this
// one really wants compacting" cue. Deliberately distinct from the ≥80/≥95
// warn/critical severity used for the bar + %: the icon nudges earlier so the
// user acts before a seat is genuinely pressed.
function compactionIconAccent(percent: number, providerClass: string): string {
  if (percent >= 85) return 'var(--danger, #e54d4d)'
  if (percent >= 60) return '#ff7d1a'
  return `var(--provider-${providerClass}-color, var(--accent))`
}

interface ContextMeterPopoverProps {
  meter?: ContextMeterModel | null
  /** Donut fill (0..100) for the trigger — the solo/active percent. */
  percent: number
  /** Tooltip on the trigger (the existing "X / Y context" string). */
  label: string
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
  /**
   * "Compact context now" — current Claude/Codex native compaction or the
   * Kimi host-summary fallback (with Grok compaction available on eligible
   * ensemble seats). Historical Cursor summaries remain renderable, but never
   * make this action available. The button appears only while idle and under
   * warn-level context pressure.
   */
  onCompactContext?: () => void
  /**
   * Per-seat compaction for ensemble participant rows (native claude/codex
   * seats with a linked session, round idle). Rows outside
   * `compactableParticipantIds` render no button.
   */
  onCompactParticipant?: (participantId: string) => void
  /**
   * Participant rows that surface the compaction lever at all — the enabled
   * seats. The icon renders for every one of these, always (no flicker as
   * seats go idle/busy); the row itself decides whether it's actionable.
   */
  compactableParticipantIds?: readonly string[]
  /**
   * The participant whose turn is live right now. Its compaction icon is shown
   * but disabled — compacting mid-turn would derail the in-flight run (auto
   * compaction covers the active seat instead).
   */
  speakingParticipantId?: string
  /** Active run whose provider usage snapshot keeps the meter live. */
  activeRunId?: string | null
  running?: boolean
  /** Used lazily for the one expanded row, so long transcripts are not walked
   * on every streaming renderer update while the popover is closed. */
  messages?: ReadonlyArray<ChatMessage>
}

interface RowView {
  id: string
  primary: string
  detail: string
  provider: ProviderId
  providerClass: string
  usedTokens: number
  windowTokens: number
  percent: number
  usage?: ContextUsageSnapshot
  activity?: ContextActivitySummary
}

export function contextMeterRowHueClass(
  row: Pick<ContextMeterRow, 'provider' | 'modelId'>
): string {
  return resolveProviderHueClass(row.provider, row.modelId)
}

/** Accordion transition: selecting another participant closes the previous one;
 * selecting the open participant collapses it. */
export function nextExpandedContextRow(
  currentId: string | null,
  selectedId: string
): string | null {
  return currentId === selectedId ? null : selectedId
}

function toRowView(row: ContextMeterRow, isParticipant: boolean): RowView {
  const providerName = getProviderName(row.provider)
  const model = humaniseModelIdCompact(row.provider, row.modelId)
  const primary = isParticipant ? row.role?.trim() || providerName : providerName
  const detail = isParticipant ? [providerName, model].filter(Boolean).join(' · ') : model
  return {
    id: row.id,
    primary,
    detail,
    provider: row.provider,
    providerClass: contextMeterRowHueClass(row),
    usedTokens: row.usedTokens,
    windowTokens: row.windowTokens,
    percent: row.percent,
    usage: row.usage,
    activity: row.activity
  }
}

export function MeterRow({
  row,
  focused,
  expanded,
  compactable,
  speaking,
  confirming,
  onRequestCompact,
  onConfirmCompact,
  onCancelCompact,
  onToggleExpanded
}: {
  row: RowView
  focused?: boolean
  expanded?: boolean
  /** Show the compaction icon on this row (an enabled participant seat). */
  compactable?: boolean
  /** This seat is the live speaker — icon disabled to avoid racing its turn. */
  speaking?: boolean
  /** This row's inline "Compact X?" confirmation is open. */
  confirming?: boolean
  onRequestCompact?: () => void
  onConfirmCompact?: () => void
  onCancelCompact?: () => void
  onToggleExpanded: () => void
}): React.JSX.Element {
  const disclosureId = useId()
  const toggleId = `${disclosureId}-toggle`
  const accent = `var(--provider-${row.providerClass}-color, var(--accent))`
  const pctText = `${Math.round(row.percent)}%`
  const amount =
    row.windowTokens > 0
      ? `${formatContextTokens(row.usedTokens)} / ${formatContextTokens(row.windowTokens)}`
      : formatContextTokens(row.usedTokens)
  const amountPrefix = row.usage?.precision === 'exact' ? '' : '≈'
  const severity = contextPressureSeverity(row.percent)
  // Nothing to compact until a seat has actually accrued context; the live
  // speaker is locked out so a manual compaction can't collide with its turn.
  const nothingToCompact = row.percent < 1
  const compactDisabled = nothingToCompact || Boolean(speaking)
  const compactAccent = compactionIconAccent(row.percent, row.providerClass)
  const compactTitle = speaking
    ? `${row.primary} is speaking — auto-compaction handles the active seat`
    : nothingToCompact
      ? `No context to compact yet for ${row.primary}`
      : `Compact ${row.primary}`
  return (
    <div
      className={`context-meter-row provider-${row.providerClass}${
        focused ? ' context-meter-row--focused' : ''
      }${expanded ? ' context-meter-row--expanded' : ''}${
        severity !== 'ok' ? ` context-meter-row--${severity}` : ''
      }`}
      data-provider-hue={row.providerClass}
      style={
        {
          '--context-meter-row-accent': accent
        } as React.CSSProperties
      }
    >
      <div className="context-meter-row-head">
        <button
          id={toggleId}
          type="button"
          className="context-meter-row-toggle"
          aria-expanded={Boolean(expanded)}
          aria-controls={disclosureId}
          onClick={onToggleExpanded}
        >
          <span
            className={`context-meter-row-chevron${expanded ? ' is-expanded' : ''}`}
            aria-hidden
          >
            ›
          </span>
          <span className="context-meter-row-dot" style={{ background: accent }} aria-hidden />
          <span className="context-meter-row-primary">{row.primary}</span>
          {row.detail && <span className="context-meter-row-detail">{row.detail}</span>}
        </button>
        {compactable && (
          <button
            type="button"
            className={`context-meter-row-compact-icon${confirming ? ' is-confirming' : ''}`}
            style={compactDisabled ? undefined : { color: compactAccent }}
            title={compactTitle}
            aria-label={compactTitle}
            disabled={compactDisabled}
            onClick={onRequestCompact}
          >
            <ContextCompactionIcon />
          </button>
        )}
        <span className="context-meter-row-pct">{pctText}</span>
      </div>
      <div
        className="context-meter-row-bar"
        role="meter"
        aria-valuenow={Math.round(row.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.primary} context ${pctText}`}
      >
        <span
          className="context-meter-row-fill"
          style={{ width: `${Math.max(0, Math.min(100, row.percent))}%`, background: accent }}
        />
      </div>
      {confirming ? (
        <div
          className="context-meter-row-confirm"
          role="group"
          aria-label={`Compact ${row.primary}?`}
        >
          <span className="context-meter-row-confirm-label">Compact {row.primary}?</span>
          <span className="context-meter-row-confirm-actions">
            <button
              type="button"
              className="context-meter-row-confirm-btn context-meter-row-confirm-btn--yes"
              onClick={onConfirmCompact}
            >
              Yes
            </button>
            <button
              type="button"
              className="context-meter-row-confirm-btn context-meter-row-confirm-btn--no"
              onClick={onCancelCompact}
            >
              No
            </button>
          </span>
        </div>
      ) : (
        <div
          className="context-meter-row-amount"
          title={
            row.usage?.precision === 'exact'
              ? 'Provider-reported latest window snapshot'
              : 'Best available context estimate'
          }
        >
          {amountPrefix}
          {amount} context
        </div>
      )}
      {expanded && !confirming && (
        <div id={disclosureId} role="region" aria-labelledby={toggleId}>
          <ContextMeterDetails
            primary={row.primary}
            usedTokens={row.usedTokens}
            windowTokens={row.windowTokens}
            percent={row.percent}
            usage={row.usage}
            activity={row.activity}
          />
        </div>
      )}
    </div>
  )
}

export function ContextMeterPopover({
  meter,
  percent,
  label,
  provider,
  composerStyle,
  disabled,
  onCompactContext,
  onCompactParticipant,
  compactableParticipantIds,
  speakingParticipantId,
  activeRunId,
  running = false,
  messages
}: ContextMeterPopoverProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  // Which participant row's inline "Compact X?" confirm is open (one at a time).
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // Rich participant accordion — exactly one row may be expanded at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const liveUsage = useParticipantWorkingTokenSnapshot(running ? activeRunId : null)
  const trackedMeter = applyLiveContextTokenUsage(meter, liveUsage, speakingParticipantId)

  // Anchor above-right of the donut (mirrors CombinedModelPicker).
  useEffect(() => {
    if (!open) {
      setPosition(null)
      setConfirmingId(null)
      setExpandedId(null)
      return
    }
    const compute = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      // Matches the popover's max-width so `rect.right - width` keeps even a
      // full-width popover anchored on-screen (the donut sits near the right edge).
      const width = 480
      setPosition({ left: Math.max(8, rect.right - width), top: rect.top - 8 })
    }
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) compute()
    })
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const participantRows =
    trackedMeter?.participants && trackedMeter.participants.length > 0
      ? trackedMeter.participants.map((row) => toRowView(row, true))
      : null
  const rows: RowView[] =
    participantRows ?? (trackedMeter ? [toRowView(trackedMeter.solo, false)] : [])
  const focusedRow = trackedMeter?.focusedId
    ? trackedMeter.participants?.find((row) => row.id === trackedMeter.focusedId)
    : trackedMeter?.solo
  const trackedPercent = focusedRow?.percent ?? percent
  const trackedLabel = focusedRow
    ? `${formatContextTokens(focusedRow.usedTokens)} / ${formatContextTokens(focusedRow.windowTokens)} context`
    : label
  const roundedPercent = Math.round(trackedPercent)
  // The ChatGPT shell borrows Cursor's bottom-row controls, incl. the context
  // donut + inline percent, so it shares Cursor's context-trigger treatment.
  const isCursorShell = composerStyle === 'cursor' || composerStyle === 'chatgpt'
  const triggerSeverity = contextPressureSeverity(trackedPercent)
  const showCompactAction = Boolean(onCompactContext) && triggerSeverity !== 'ok'
  const popoverProviderClass =
    participantRows || rows.length !== 1 ? provider : rows[0]?.providerClass || provider

  const popoverContent = open && position && rows.length > 0 && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover context-meter-popover provider-${popoverProviderClass} shell-${composerStyle}`}
      data-provider-hue={popoverProviderClass}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label="Context usage"
    >
      <div className="context-meter-header">
        <span>{participantRows ? 'Context · per participant' : 'Context usage'}</span>
        <span className="context-meter-header-hint">Select a row for details</span>
      </div>
      <div className="context-meter-rows">
        {rows.map((row) => {
          const expanded = expandedId === row.id
          const detailActivity =
            expanded && messages
              ? buildContextActivitySummary(messages, participantRows ? row.id : undefined)
              : row.activity
          const compactable = Boolean(
            participantRows && onCompactParticipant && compactableParticipantIds?.includes(row.id)
          )
          return (
            <MeterRow
              key={row.id}
              row={detailActivity === row.activity ? row : { ...row, activity: detailActivity }}
              focused={!!trackedMeter?.focusedId && row.id === trackedMeter.focusedId}
              expanded={expanded}
              compactable={compactable}
              speaking={!!speakingParticipantId && row.id === speakingParticipantId}
              confirming={compactable && confirmingId === row.id}
              onRequestCompact={compactable ? () => setConfirmingId(row.id) : undefined}
              onConfirmCompact={() => {
                setOpen(false)
                onCompactParticipant?.(row.id)
              }}
              onCancelCompact={() => setConfirmingId(null)}
              onToggleExpanded={() => {
                setConfirmingId(null)
                setExpandedId((current) => nextExpandedContextRow(current, row.id))
              }}
            />
          )
        })}
      </div>
      <div className="context-meter-foot">
        <span>
          {liveUsage
            ? liveUsage.contextUsage?.precision === 'exact'
              ? 'Live provider window snapshot'
              : liveUsage.estimated
                ? 'Live TaskWraith estimate'
                : 'Live provider usage'
            : 'Latest available window accounting'}
        </span>
        {showCompactAction && (
          <button
            type="button"
            className="context-meter-compact-button"
            onClick={() => {
              setOpen(false)
              onCompactContext?.()
            }}
          >
            Compact context now
          </button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-context-trigger${isCursorShell ? ' composer-context-trigger--cursor' : ''}`}
        data-composer-control="context"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled || rows.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={trackedLabel}
        aria-label={`Context ${roundedPercent}% used (${trackedLabel})`}
      >
        <ContextWheel
          percent={trackedPercent}
          label={trackedLabel}
          codexShell={composerStyle === 'codex'}
          claudeShell={composerStyle === 'claude'}
          cursorShell={isCursorShell}
          severity={triggerSeverity}
        />
        {isCursorShell && (
          <span className="composer-context-trigger-pct" aria-hidden="true">
            {roundedPercent}%
          </span>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
