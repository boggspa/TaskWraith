// The composer context donut, made clickable: tapping it opens a small frosted
// popover (mirroring CombinedModelPicker's portal/positioning/dismiss) with a
// context meter + model/amount labels. Solo chats show one row for the active
// model; ensemble chats stack one row per participant (each with its own model
// + window). The numbers are the HONEST current-context proxy (latest turn's
// input+output ÷ window — see lib/contextMeter.ts), so the popover labels them
// as estimated.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import type { ContextMeterModel, ContextMeterRow } from '../lib/contextMeter'
import { formatContextTokens } from '../lib/contextWindows'
import { humaniseModelIdCompact } from '../lib/modelDisplayName'
import { getProviderName } from './Sidebar'
import { ContextWheel } from './AppChromeSymbols'

interface ContextMeterPopoverProps {
  meter?: ContextMeterModel | null
  /** Donut fill (0..100) for the trigger — the solo/active percent. */
  percent: number
  /** Tooltip on the trigger (the existing "X / Y context" string). */
  label: string
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
}

interface RowView {
  id: string
  primary: string
  detail: string
  provider: ProviderId
  usedTokens: number
  windowTokens: number
  percent: number
}

function toRowView(row: ContextMeterRow, isParticipant: boolean): RowView {
  const providerName = getProviderName(row.provider)
  const model = humaniseModelIdCompact(row.provider, row.modelId)
  const primary = isParticipant ? row.role?.trim() || providerName : providerName
  const detail = isParticipant
    ? [providerName, model].filter(Boolean).join(' · ')
    : model
  return {
    id: row.id,
    primary,
    detail,
    provider: row.provider,
    usedTokens: row.usedTokens,
    windowTokens: row.windowTokens,
    percent: row.percent
  }
}

function MeterRow({ row, focused }: { row: RowView; focused?: boolean }): React.JSX.Element {
  const accent = `var(--provider-${row.provider}-color, var(--accent))`
  const pctText = `${Math.round(row.percent)}%`
  const amount = row.windowTokens > 0
    ? `${formatContextTokens(row.usedTokens)} / ${formatContextTokens(row.windowTokens)}`
    : formatContextTokens(row.usedTokens)
  return (
    <div className={`context-meter-row${focused ? ' context-meter-row--focused' : ''}`}>
      <div className="context-meter-row-head">
        <span className="context-meter-row-dot" style={{ background: accent }} aria-hidden />
        <span className="context-meter-row-primary">{row.primary}</span>
        {row.detail && <span className="context-meter-row-detail">{row.detail}</span>}
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
      <div className="context-meter-row-amount">{amount} context</div>
    </div>
  )
}

export function ContextMeterPopover({
  meter,
  percent,
  label,
  provider,
  composerStyle,
  disabled
}: ContextMeterPopoverProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Anchor above-right of the donut (mirrors CombinedModelPicker).
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const compute = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      // Matches the popover's max-width so `rect.right - width` keeps even a
      // full-width popover anchored on-screen (the donut sits near the right edge).
      const width = 320
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

  const participantRows = meter?.participants && meter.participants.length > 0
    ? meter.participants.map((row) => toRowView(row, true))
    : null
  const rows: RowView[] = participantRows ?? (meter ? [toRowView(meter.solo, false)] : [])

  const popoverContent = open && position && rows.length > 0 && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover context-meter-popover provider-${provider} shell-${composerStyle}`}
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
        {participantRows ? 'Context · per participant' : 'Context usage'}
      </div>
      <div className="context-meter-rows">
        {rows.map((row) => (
          <MeterRow key={row.id} row={row} focused={!!meter?.focusedId && row.id === meter.focusedId} />
        ))}
      </div>
      <div className="context-meter-foot">Estimated from the latest turn</div>
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-context-trigger"
        data-composer-control="context"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled || rows.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
      >
        <ContextWheel percent={percent} label={label} />
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
