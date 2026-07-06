/*
 * ContinuousHopsLimitChip — 1.0.6 follow-up.
 *
 * The "n/m" handoff-turns meter that appears next to the Turn/Continuous/
 * Work-Session toggle when Continuous mode is active. Pre-1.0.6 the
 * denominator was a hardcoded `6`, which was easy to miss as a setting at
 * all. Now the chip is a button: click to open a tiny popover, type a new
 * limit, Set → writes `chat.ensemble.maxContinuationHops` (and propagates to
 * any in-flight round through the same field-read path in App.tsx). New
 * limit applies from the next continuous round when one is already running;
 * when idle (no round in flight) the chip's denominator reflects the new
 * value immediately because the read falls through `round → chat → 6`.
 *
 * Reuses the existing `welcome-workspace-popover welcome-workspace-popover--portaled`
 * chrome so glass/border/shadow match the rest of the composer popovers, plus a
 * tiny `continuous-hops-popover` modifier for the input layout. Body-portaled
 * to escape the composer-area's z-index stacking context (same reason the
 * workspace popover is portaled — see App.tsx WelcomeWorkspacePicker at
 * ~line 5377 for the inherited pattern).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent
} from 'react'
import { createPortal } from 'react-dom'

const MIN_HOPS = 1
const MAX_HOPS = 500
const POPOVER_WIDTH = 260
const POPOVER_GAP = 6
const POPOVER_FALLBACK_HEIGHT = 154

interface ContinuousHopsLimitChipProps {
  /** Hops used so far in the current round (the numerator — read-only). */
  hops: number
  /** Current max (the denominator) — what the user is editing. */
  maxHops: number
  /** Current round lifecycle. Used only for the color affordance. */
  roundStatus?: ContinuousHopsRoundStatus
  /** Active goal lifecycle. Terminal completed/blocked goals mean the round ended intentionally. */
  activeGoalStatus?: ContinuousHopsGoalStatus | null
  /** Called with the validated new max when the user clicks Set. */
  onSave: (nextMax: number) => void
  /** Whether the chip is disabled (e.g. solo chat — rare; renderer already
   * gates the chip on continuous mode, but keep the prop for safety). */
  disabled?: boolean
}

export type ContinuousHopsRoundStatus = 'running' | 'completed' | 'cancelled' | 'failed'
export type ContinuousHopsGoalStatus = 'active' | 'paused' | 'blocked' | 'completed'
export type ContinuousHopsTone = 'neutral' | 'warning' | 'danger' | 'success'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function computeContinuousHopsPopoverPosition(input: {
  triggerRect: Pick<DOMRect, 'left' | 'top' | 'width'>
  popoverHeight: number
  viewportWidth: number
  margin?: number
}): { left: number; top: number } {
  const margin = input.margin ?? 8
  const popoverHeight = input.popoverHeight > 0 ? input.popoverHeight : POPOVER_FALLBACK_HEIGHT
  const idealLeft = input.triggerRect.left + input.triggerRect.width / 2 - POPOVER_WIDTH / 2
  const clampedLeft = Math.max(
    margin,
    Math.min(input.viewportWidth - POPOVER_WIDTH - margin, idealLeft)
  )
  return {
    left: clampedLeft,
    top: Math.max(margin, input.triggerRect.top - popoverHeight - POPOVER_GAP)
  }
}

export function resolveContinuousHopsTone(input: {
  hops: number
  maxHops: number
  roundStatus?: ContinuousHopsRoundStatus
  activeGoalStatus?: ContinuousHopsGoalStatus | null
}): ContinuousHopsTone {
  const isTerminalRound =
    input.roundStatus === 'completed' ||
    input.roundStatus === 'cancelled' ||
    input.roundStatus === 'failed'
  if (
    isTerminalRound &&
    (input.activeGoalStatus === 'completed' || input.activeGoalStatus === 'blocked')
  ) {
    return 'success'
  }

  const maxHops = Number.isFinite(input.maxHops) ? Math.max(1, Math.floor(input.maxHops)) : 1
  const hops = Number.isFinite(input.hops) ? Math.max(0, Math.floor(input.hops)) : 0
  const ratio = hops / maxHops

  if (isTerminalRound) {
    if (input.roundStatus === 'completed' && hops >= maxHops) return 'danger'
    return ratio >= 0.7 ? 'warning' : 'neutral'
  }

  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warning'
  return 'neutral'
}

export function ContinuousHopsLimitChip({
  hops,
  maxHops,
  roundStatus,
  activeGoalStatus,
  onSave,
  disabled = false
}: ContinuousHopsLimitChipProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string>(String(maxHops))
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-sync the input draft to the prop whenever the popover opens — so a user
  // who set 10 last time but the chat now reads 6 (different chat) starts fresh.
  useEffect(() => {
    if (open) setDraft(String(maxHops))
  }, [open, maxHops])

  // Focus the input on open so the user can type immediately. Defer one tick so
  // the portal subtree mounts first.
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  // Outside-click + Escape close. Mirrors WelcomeWorkspacePicker's pattern.
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Position the portaled popover above the trigger; clamp horizontally to the
  // viewport. The composer sits at the bottom edge, so opening downward clips.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popoverHeight = popoverRef.current?.offsetHeight || POPOVER_FALLBACK_HEIGHT
      setPopoverPosition(
        computeContinuousHopsPopoverPosition({
          triggerRect: rect,
          popoverHeight,
          viewportWidth: window.innerWidth
        })
      )
    }
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [open])

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value)
  }, [])

  const handleSubmit = useCallback(
    (event?: FormEvent<HTMLFormElement>): void => {
      event?.preventDefault()
      const parsed = Number.parseInt(draft, 10)
      // Reject NaN / non-integers silently; keep the popover open so the user
      // can correct. Clamp to range otherwise.
      if (!Number.isInteger(parsed)) {
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      }
      const next = clamp(parsed, MIN_HOPS, MAX_HOPS)
      onSave(next)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [draft, onSave]
  )

  const parsed = Number.parseInt(draft, 10)
  const draftValid = Number.isInteger(parsed) && parsed >= MIN_HOPS && parsed <= MAX_HOPS
  const popoverStyle: CSSProperties = {
    left: popoverPosition?.left ?? 0,
    top: popoverPosition?.top ?? 0,
    width: POPOVER_WIDTH,
    visibility: popoverPosition ? 'visible' : 'hidden'
  }
  const tone = resolveContinuousHopsTone({ hops, maxHops, roundStatus, activeGoalStatus })

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-ensemble-hop-meter is-clickable is-${tone} ${
          open ? 'is-open' : ''
        }`}
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Continuous round max handoff turns"
        title="Click to set max handoff turns for continuous rounds."
      >
        {hops}/{maxHops}
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Continuous round max handoff turns"
              className="welcome-workspace-popover welcome-workspace-popover--portaled continuous-hops-popover"
              style={popoverStyle}
            >
              <form className="continuous-hops-popover-form" onSubmit={handleSubmit}>
                <label className="continuous-hops-popover-label" htmlFor="continuous-hops-input">
                  Max handoff turns
                </label>
                <input
                  ref={inputRef}
                  id="continuous-hops-input"
                  className="continuous-hops-popover-input"
                  type="number"
                  inputMode="numeric"
                  min={MIN_HOPS}
                  max={MAX_HOPS}
                  step={1}
                  value={draft}
                  onChange={handleDraftChange}
                  aria-describedby="continuous-hops-help"
                />
                <p className="continuous-hops-popover-help" id="continuous-hops-help">
                  Cap for a continuous round (between {MIN_HOPS}–{MAX_HOPS}). Updates the meter
                  immediately when you click Set.
                </p>
                <div className="continuous-hops-popover-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-sm btn-primary"
                    disabled={!draftValid}
                  >
                    Set
                  </button>
                </div>
              </form>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

// Exported for tests so the component's range constants stay in lockstep with
// validation in test fixtures.
export const CONTINUOUS_HOPS_RANGE = { min: MIN_HOPS, max: MAX_HOPS } as const
