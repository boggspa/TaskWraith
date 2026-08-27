import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle } from '../../../main/store/types'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { ClockSymbolIcon } from './AppChromeSymbols'

const ZERO_RUN_TIMECODE = '00:00:00:00'
const TIMECODE_POPOVER_WIDTH_FLOOR = 320

export const formatRunTimecodeDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [days, hours, minutes, seconds].map((part) => part.toString().padStart(2, '0')).join(':')
}

type ComposerTimecodeMode = 'turn' | 'total'

export interface ComposerTimecodePresentation {
  turnLabel: string
  totalLabel: string
  visibleLabel: string
  visibleMode: ComposerTimecodeMode
}

/**
 * Live "now" tick shared by the interactive timecode button and the pane-bottom
 * timecode bar. One rAF for the first paint (turn start only), then the
 * renderer-wide 1s shared tick while a run is in flight (idle threads don't
 * subscribe). `now` is sampled in the same render as the tick — no
 * effect→setState echo per second. `startedAt` restarts the first-paint rAF
 * when a new turn begins.
 */
export function useTimecodeNow(running: boolean, startedAt?: string | null): number {
  const nowTick = useSharedNowTick(running)
  const [rafNow, setRafNow] = useState(() => Date.now())
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRafNow(Date.now()))
    return () => window.cancelAnimationFrame(frame)
  }, [running, startedAt])
  const tickNow = useMemo(() => Date.now(), [nowTick, running, startedAt])
  return tickNow > rafNow ? tickNow : rafNow
}

export function getComposerTimecodePresentation({
  running,
  startedAt,
  cumulativeBaseMs,
  nowMs
}: {
  running: boolean
  startedAt?: string | null
  cumulativeBaseMs: number
  nowMs: number
}): ComposerTimecodePresentation {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const liveDelta = running && Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0
  const turnLabel = running ? formatRunTimecodeDuration(liveDelta) : ZERO_RUN_TIMECODE
  const totalLabel = formatRunTimecodeDuration(cumulativeBaseMs + liveDelta)
  const visibleMode: ComposerTimecodeMode = running ? 'turn' : 'total'

  return {
    turnLabel,
    totalLabel,
    visibleMode,
    visibleLabel: visibleMode === 'turn' ? turnLabel : totalLabel
  }
}

export interface ComposerTimecodePopoverPositionInput {
  triggerRect: Pick<DOMRect, 'left' | 'top' | 'width'>
  surfaceRect?: Pick<DOMRect, 'left' | 'width'>
  viewportWidth: number
  widthFloor?: number
}

export function computeComposerTimecodePopoverPosition({
  triggerRect,
  surfaceRect = triggerRect,
  viewportWidth,
  widthFloor = TIMECODE_POPOVER_WIDTH_FLOOR
}: ComposerTimecodePopoverPositionInput): { left: number; top: number; width: number } {
  return resolveComposerSurfacePopoverPosition({
    triggerRect,
    surfaceRect,
    viewportWidth,
    widthFloor
  })
}

export function ComposerTimecode({
  running,
  startedAt,
  cumulativeBaseMs,
  composerStyle = 'default',
  interactive = true
}: {
  running: boolean
  startedAt?: string | null
  cumulativeBaseMs: number
  composerStyle?: ComposerStyle
  interactive?: boolean
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const now = useTimecodeNow(running, startedAt)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null
  )

  useEffect(() => {
    if (!open || !interactive) {
      setPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const triggerRect = trigger.getBoundingClientRect()
      const surface = trigger.closest('.composer-surface') as HTMLElement | null
      const surfaceRect = surface?.getBoundingClientRect() ?? triggerRect
      setPosition(
        computeComposerTimecodePopoverPosition({
          triggerRect,
          surfaceRect,
          viewportWidth: window.innerWidth
        })
      )
    }
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) computePosition()
    })
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [interactive, open])

  useEffect(() => {
    if (!open || !interactive) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [interactive, open])

  const presentation = getComposerTimecodePresentation({
    running,
    startedAt,
    cumulativeBaseMs,
    nowMs: now
  })
  const title =
    presentation.visibleMode === 'turn'
      ? 'Current turn / round elapsed time'
      : 'Total thread wall time'
  const className = `composer-run-timecode composer-timecode-control${open ? ' is-open' : ''}`
  const sharedProps = {
    className,
    'data-running': running ? 'true' : 'false',
    'data-mode': presentation.visibleMode,
    title,
    'aria-label': `${title} ${presentation.visibleLabel}`
  }
  const content = (
    <>
      <ClockSymbolIcon />
      <span className="composer-timecode-value">{presentation.visibleLabel}</span>
    </>
  )

  const popover =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover composer-timecode-popover shell-${composerStyle}`}
            style={
              {
                position: 'fixed',
                left: `${position.left}px`,
                top: `${position.top}px`,
                width: `${position.width}px`,
                minWidth: 0,
                maxWidth: 'calc(100vw - 16px)',
                transform: 'translateY(-100%)',
              } as CSSProperties
            }
            role="dialog"
            aria-label="Thread timecodes"
          >
            <div className="composer-combined-picker-column composer-timecode-popover-column">
              <div className="composer-combined-picker-column-header">Timecodes</div>
              <div
                className={`composer-combined-picker-row composer-timecode-popover-row ${
                  presentation.visibleMode === 'turn' ? 'is-selected' : ''
                }`}
              >
                <span className="composer-timecode-popover-label">Turn / Round</span>
                <span className="composer-timecode-popover-value">{presentation.turnLabel}</span>
              </div>
              <div
                className={`composer-combined-picker-row composer-timecode-popover-row ${
                  presentation.visibleMode === 'total' ? 'is-selected' : ''
                }`}
              >
                <span className="composer-timecode-popover-label">Total Thread</span>
                <span className="composer-timecode-popover-value">{presentation.totalLabel}</span>
              </div>
            </div>
          </div>,
          document.body
        )
      : null

  if (!interactive) {
    return <span {...sharedProps}>{content}</span>
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        {...sharedProps}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {content}
      </button>
      {popover}
    </>
  )
}

/**
 * Pane-bottom timecode bar. Unpacks what used to be the composer telemetry-row
 * timecode picker into a standalone, pane-aligned row that sits glued under the
 * composer: the current turn / round elapsed time on the left, the total thread
 * wall time on the right. Static (no popover / no interactivity) — it reuses the
 * pure presentation helper + the shared live tick so both values update in step.
 */
export function ComposerThreadTimecodeBar({
  running,
  startedAt,
  cumulativeBaseMs,
  center
}: {
  running: boolean
  startedAt?: string | null
  cumulativeBaseMs: number
  /** Optional centred slot between the two timecodes (PR/CI and workspace-edit
   * satellites). Rendered even when empty so the bar's 1fr/auto/1fr grid
   * keeps the turn/total columns stable. */
  center?: ReactNode
}) {
  const now = useTimecodeNow(running, startedAt)
  const { turnLabel, totalLabel } = getComposerTimecodePresentation({
    running,
    startedAt,
    cumulativeBaseMs,
    nowMs: now
  })

  return (
    <div className="composer-thread-timecodes" data-running={running ? 'true' : 'false'}>
      <span
        className="composer-thread-timecode composer-thread-timecode--turn"
        title="Current turn / round elapsed time"
        aria-label={`Current turn elapsed time ${turnLabel}`}
      >
        <ClockSymbolIcon />
        <span className="composer-thread-timecode-label">Turn</span>
        <span className="composer-thread-timecode-value">{turnLabel}</span>
      </span>
      <div className="composer-thread-timecodes-center">{center}</div>
      <span
        className="composer-thread-timecode composer-thread-timecode--total"
        title="Total thread wall time"
        aria-label={`Total thread wall time ${totalLabel}`}
      >
        <span className="composer-thread-timecode-label">Total thread</span>
        <span className="composer-thread-timecode-value">{totalLabel}</span>
        <ClockSymbolIcon />
      </span>
    </div>
  )
}
