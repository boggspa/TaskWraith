/*
 * EnsembleModePicker — the composer's ensemble orchestration-mode control as a
 * body-portaled picker (matching the Model/Reasoning + Permissions pickers)
 * instead of a segmented toggle. Holds the three orchestration choices:
 *   - Turn        → turn-bound rounds (each agent speaks once)
 *   - Continuous  → agents hand work back and forth within a round
 *   - Work Session→ opens the Work Session setup sheet (composes on top)
 *
 * Fan-out (parallel read-only lanes) is deliberately NOT in here — it's a
 * composable on/off toggle that layers on either mode, so it stays a separate
 * labeled control beside this picker in the orchestration row (per the
 * product decision).
 *
 * The shared-history char-budget slider used to live in a second popover
 * section; it moved onto the orchestration row itself (see
 * EnsembleOrchestrationRow.tsx) so the popover is now modes-only.
 *
 * Structurally cloned from ComposerProviderPicker: a `.composer-picker-label`
 * trigger + a portaled `.composer-combined-picker-popover.shell-${style}` so all
 * per-shell popover theming applies automatically with no per-shell branches.
 * Positioning + click-outside/Escape handling are identical.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle } from '../../../main/store/types'

export type EnsembleOrchestrationMode = 'turn_bound' | 'continuous'
type EnsembleModeRowKey = EnsembleOrchestrationMode | 'work_session'

interface EnsembleModeRow {
  key: EnsembleModeRowKey
  label: string
  description: string
}

const MODE_ROWS: EnsembleModeRow[] = [
  { key: 'turn_bound', label: 'Turn', description: 'Each agent speaks once per round.' },
  {
    key: 'continuous',
    label: 'Continuous',
    description: 'Agents can hand work back and forth within a round.'
  },
  {
    key: 'work_session',
    label: 'Work Session',
    description: 'Supervised multi-round autonomy — objective, acceptance criteria + budget.'
  }
]

export function EnsembleModePicker({
  mode,
  workSessionActive,
  composerStyle,
  onSelectMode,
  onOpenWorkSession,
  disabled
}: {
  mode: EnsembleOrchestrationMode
  workSessionActive: boolean
  composerStyle: ComposerStyle
  onSelectMode: (mode: EnsembleOrchestrationMode) => void
  onOpenWorkSession: () => void
  disabled?: boolean
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Position the popover above the trigger (cloned from ComposerProviderPicker).
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!open) {
        setPosition(null)
        return
      }
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340))
      const top = rect.top - 8
      setPosition({ left, top })
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  const triggerLabel = workSessionActive
    ? 'Work Session'
    : mode === 'continuous'
      ? 'Continuous'
      : 'Turn'

  const isRowActive = (key: EnsembleModeRowKey): boolean =>
    key === 'work_session' ? workSessionActive : mode === key

  const handleSelect = (key: EnsembleModeRowKey): void => {
    if (key === 'work_session') {
      onOpenWorkSession()
    } else {
      onSelectMode(key)
    }
    setOpen(false)
  }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover shell-${composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Ensemble orchestration mode"
          >
            <div className="composer-plus-picker-section">
              <div className="composer-combined-picker-column-header">Orchestration</div>
              {MODE_ROWS.map((row) => {
                const active = isRowActive(row.key)
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`composer-combined-picker-row composer-plus-picker-row ${active ? 'is-selected' : ''}`}
                    onClick={() => handleSelect(row.key)}
                    title={row.description}
                    aria-pressed={active}
                  >
                    <span className="composer-plus-picker-row-copy">
                      <span className="composer-combined-picker-row-label">{row.label}</span>
                      <span className="composer-combined-picker-row-sub">{row.description}</span>
                    </span>
                    {active && (
                      <span className="composer-combined-picker-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}
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
        className="composer-picker-label composer-ensemble-mode-trigger"
        title="Ensemble orchestration mode — Turn, Continuous, or Work Session"
        aria-label="Ensemble orchestration mode"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
      >
        <span className="composer-ensemble-mode-trigger-label">{triggerLabel}</span>
      </button>
      {popover}
    </>
  )
}
