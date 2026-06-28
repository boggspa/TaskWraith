import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import { ClockSymbolIcon } from '../components/AppChromeSymbols'
import { formatScheduledRunTime, toDateTimeLocalValue } from '../lib/dateTimeFormat'
import { formatScheduleCountdown } from '../lib/scheduledCountdown'

interface ComposerScheduleButtonProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  value: string
  onChange: (value: string) => void
  onSchedule: () => void | Promise<void>
  disabled?: boolean
  disabledReason?: string
  hasPrompt: boolean
}

const QUICK_OFFSETS_MINUTES = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: 'Tonight', minutes: null },
  { label: 'Tomorrow', minutes: null }
] as const

function tonightValue(now: Date): string {
  const next = new Date(now)
  next.setHours(20, 0, 0, 0)
  if (next.getTime() <= now.getTime() + 60_000) next.setDate(next.getDate() + 1)
  return toDateTimeLocalValue(next)
}

function tomorrowValue(now: Date): string {
  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(9, 0, 0, 0)
  return toDateTimeLocalValue(next)
}

export function ComposerScheduleButton({
  provider,
  composerStyle,
  value,
  onChange,
  onSchedule,
  disabled,
  disabledReason,
  hasPrompt
}: ComposerScheduleButtonProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open && !value) return
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [open, value])

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
      top: rect.top - 8
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
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

  const minValue = useMemo(() => toDateTimeLocalValue(new Date(nowMs + 60_000)), [nowMs])
  const targetMs = value ? new Date(value).getTime() : Number.NaN
  const hasValidFutureTime = Boolean(value) && Number.isFinite(targetMs) && targetMs > nowMs
  const selectedSummary = value
    ? `${formatScheduledRunTime(value)} · ${formatScheduleCountdown(value, nowMs)}`
    : 'No time selected'
  const canSchedule = !disabled && hasPrompt && hasValidFutureTime && !busy
  const triggerLabel = value
    ? `Schedule message: ${selectedSummary}`
    : disabledReason || 'Schedule message'

  const setQuickValue = (label: string): void => {
    const now = new Date()
    if (label === 'Tonight') {
      onChange(tonightValue(now))
      return
    }
    if (label === 'Tomorrow') {
      onChange(tomorrowValue(now))
      return
    }
    const preset = QUICK_OFFSETS_MINUTES.find((item) => item.label === label)
    if (preset?.minutes) {
      onChange(toDateTimeLocalValue(new Date(now.getTime() + preset.minutes * 60_000)))
    }
  }

  const handleSchedule = async (): Promise<void> => {
    if (!canSchedule) return
    setBusy(true)
    try {
      await onSchedule()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover composer-schedule-popover provider-${provider} shell-${composerStyle}`}
            role="dialog"
            aria-label="Schedule message"
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)'
            }}
          >
            <div className="composer-schedule-popover-header">
              <span>Schedule message</span>
              <span>{Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'}</span>
            </div>
            <label className="composer-schedule-field">
              <span>Date & time</span>
              <input
                type="datetime-local"
                value={value}
                min={minValue}
                onChange={(event) => onChange(event.target.value)}
                disabled={disabled || busy}
                autoFocus
              />
            </label>
            <div className="composer-schedule-presets" aria-label="Schedule presets">
              {QUICK_OFFSETS_MINUTES.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setQuickValue(preset.label)}
                  disabled={disabled || busy}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="composer-schedule-summary">
              <span>{selectedSummary}</span>
              {!hasPrompt && <span>Prompt required</span>}
              {disabledReason && <span>{disabledReason}</span>}
              {value && !hasValidFutureTime && <span>Choose a future time</span>}
            </div>
            <div className="composer-schedule-actions">
              <button type="button" onClick={() => onChange('')} disabled={!value || busy}>
                Clear
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void handleSchedule()}
                disabled={!canSchedule}
              >
                {busy ? 'Scheduling' : 'Schedule'}
              </button>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-schedule-trigger composer-hint-pill ${value ? 'is-active' : ''}`}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabled ? disabledReason : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        data-composer-control="schedule"
        data-hint-label={value ? formatScheduleCountdown(value, nowMs) : 'Schedule'}
      >
        <span className="composer-control-icon" aria-hidden="true">
          <ClockSymbolIcon />
        </span>
      </button>
      {popover}
    </>
  )
}
