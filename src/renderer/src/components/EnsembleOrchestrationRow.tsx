/*
 * EnsembleOrchestrationRow — the second row of the roster-presets
 * above-row section (rendered via EnsembleRosterPresetPicker's
 * `secondRow` slot on BOTH the welcome hero and the compact in-thread
 * variants, so every ensemble composer surface gets it).
 *
 * 2026-09-01 simplification (user decision): the Turn/Continuous mode
 * picker is retired (ensembles are Continuous-only), Fan-Out collapsed
 * from Off/Read/Write/All to an On/Off pair (On = the old All), and the
 * shared-history Chars slider is gone (per-seat ingest budgets now derive
 * from each model's context window — see shared/ensembleSeatIngest.ts,
 * with a per-model slider for the two exception classes living in the
 * Context · per participant panel). The row now holds:
 *
 *   Fan-Out:       [Off/On picker]
 *   Isolate:       [Shared/Worktrees/Any picker]
 *   Turns:         [n/m hop meter]
 *
 * The Fan-Out picker keeps the existing `.composer-ensemble-mode` capsule +
 * `data-composer-control="ensemble-mode"` hook so every per-shell
 * picker/capsule override keeps applying. The row itself deliberately
 * carries NEITHER — several shells pill-ify anything matching the bare
 * attribute (e.g. 07-composer-shells claude/gemini/kimi blocks), which drew
 * a spurious capsule around the whole row.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ContinuousHopsLimitChip,
  type ContinuousHopsGoalStatus,
  type ContinuousHopsRoundStatus
} from './ContinuousHopsLimitChip'
import type {
  ComposerStyle,
  EnsembleFanoutIsolationPolicy,
  EnsembleFanoutPolicy
} from '../../../main/store/types'

type FanoutPickerValue = 'off' | 'all'

interface FanoutPolicyRow {
  key: FanoutPickerValue
  label: string
  description: string
}

export function EnsembleOrchestrationRow({
  activeFanoutPolicy,
  isRoundRunning,
  composerStyle,
  fanoutPolicy,
  onFanoutPolicyChange,
  fanoutIsolation,
  onFanoutIsolationChange,
  concurrentLanesAvailable,
  concurrentWriteLanesAvailable,
  bossmanAssigned,
  continuationHops,
  maxContinuationHops,
  roundStatus,
  activeGoalStatus,
  onMaxContinuationHopsChange
}: {
  activeFanoutPolicy: EnsembleFanoutPolicy
  isRoundRunning: boolean
  composerStyle: ComposerStyle
  fanoutPolicy: EnsembleFanoutPolicy
  onFanoutPolicyChange: (policy: EnsembleFanoutPolicy) => void
  /** Chat-level Isolate policy for fan-out lanes. Shared ('off') and
   * Worktrees ('worktree') are user-pinned — the orchestrator clamps
   * per-call ensemble_fanout isolation overrides to match — while Any
   * delegates the per-dispatch choice to the Boss/Captain. */
  fanoutIsolation: EnsembleFanoutIsolationPolicy
  onFanoutIsolationChange: (isolation: EnsembleFanoutIsolationPolicy) => void
  concurrentLanesAvailable: boolean
  concurrentWriteLanesAvailable: boolean
  bossmanAssigned: boolean
  continuationHops: number
  maxContinuationHops: number
  roundStatus?: ContinuousHopsRoundStatus
  activeGoalStatus?: ContinuousHopsGoalStatus | null
  onMaxContinuationHopsChange: (nextMax: number) => void
}): React.JSX.Element {
  // A running round is immutable evidence of what MAIN admitted. It can differ
  // from the next-round chat setting, so the visible pill follows the round
  // until it terminates instead of implying a capability the round does not have.
  const displayedFanoutPolicy = isRoundRunning ? activeFanoutPolicy : fanoutPolicy
  // On/Off collapse: legacy graded levels (read_only / locked_writers_*) all
  // display — and persist forward — as On.
  const selectedFanoutValue: FanoutPickerValue = displayedFanoutPolicy === 'off' ? 'off' : 'all'
  const fanoutTitle = (() => {
    if (!concurrentLanesAvailable) {
      return 'Parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0); rounds run serially.'
    }
    if (selectedFanoutValue === 'off') return 'Run participants serially.'
    if (!concurrentWriteLanesAvailable) {
      return 'Read/review fan-out; writer lanes are disabled (TASKWRAITH_CONCURRENT_WRITE_LANES=0).'
    }
    return bossmanAssigned
      ? 'Read/review fan-out plus Boss-triggered writer lanes with explicit writeScopes.'
      : 'Read/review fan-out plus user-preflight writer lanes.'
  })()
  return (
    <div
      className="composer-ensemble-orchestration-row"
      role="group"
      aria-label="Ensemble orchestration"
      title={
        isRoundRunning
          ? `Current round: Continuous${displayedFanoutPolicy === 'off' ? '' : ' + fan-out'}`
          : 'Continuous rounds: agents hand work back and forth within the turn budget.'
      }
    >
      <span className="composer-orchestration-cell">
        <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
          Fan-Out
        </span>
        <span className="composer-ensemble-mode" data-composer-control="ensemble-mode">
          <span className="composer-fanout-policy">
            <FanoutPolicyPicker
              value={selectedFanoutValue}
              title={fanoutTitle}
              composerStyle={composerStyle}
              concurrentWriteLanesAvailable={concurrentWriteLanesAvailable}
              bossmanAssigned={bossmanAssigned}
              onSelect={(value) => onFanoutPolicyChange(value)}
            />
          </span>
        </span>
      </span>
      <span className="composer-orchestration-cell">
        <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
          Isolate
        </span>
        <IsolationPicker
          value={fanoutIsolation}
          composerStyle={composerStyle}
          onSelect={onFanoutIsolationChange}
        />
      </span>
      <span className="composer-orchestration-cell">
        <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
          Turns
        </span>
        <ContinuousHopsLimitChip
          hops={continuationHops}
          maxHops={maxContinuationHops}
          roundStatus={roundStatus}
          activeGoalStatus={activeGoalStatus}
          onSave={onMaxContinuationHopsChange}
        />
      </span>
    </div>
  )
}

function fanoutRows({
  concurrentWriteLanesAvailable,
  bossmanAssigned
}: {
  concurrentWriteLanesAvailable: boolean
  bossmanAssigned: boolean
}): FanoutPolicyRow[] {
  return [
    { key: 'off', label: 'Off', description: 'Run participants serially.' },
    {
      key: 'all',
      label: 'On',
      description: !concurrentWriteLanesAvailable
        ? 'Read/review fan-out (writer lanes are disabled by TASKWRAITH_CONCURRENT_WRITE_LANES=0).'
        : bossmanAssigned
          ? 'Read/review fan-out plus Boss-triggered writer lanes with explicit writeScopes.'
          : 'Read/review fan-out plus user-preflight writer lanes.'
    }
  ]
}

function FanoutPolicyPicker({
  value,
  title,
  composerStyle,
  concurrentWriteLanesAvailable,
  bossmanAssigned,
  onSelect
}: {
  value: FanoutPickerValue
  title: string
  composerStyle: ComposerStyle
  concurrentWriteLanesAvailable: boolean
  bossmanAssigned: boolean
  onSelect: (value: FanoutPickerValue) => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const rows = fanoutRows({ concurrentWriteLanesAvailable, bossmanAssigned })
  const triggerLabel = rows.find((row) => row.key === value)?.label || 'Off'

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

  const handleSelect = (row: FanoutPolicyRow): void => {
    onSelect(row.key)
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
            aria-label="Fan-out"
          >
            <div className="composer-plus-picker-section">
              <div className="composer-combined-picker-column-header">Fan-Out</div>
              {rows.map((row) => {
                const active = row.key === value
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`composer-combined-picker-row composer-plus-picker-row ${active ? 'is-selected' : ''}`}
                    onClick={() => handleSelect(row)}
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
        className="composer-picker-label composer-ensemble-mode-trigger composer-fanout-policy-trigger"
        title={title}
        aria-label="Fan-out"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="composer-fanout-policy-trigger-label">{triggerLabel}</span>
      </button>
      {popover}
    </>
  )
}

interface IsolationRow {
  key: EnsembleFanoutIsolationPolicy
  label: string
  description: string
}

const ISOLATION_ROWS: IsolationRow[] = [
  {
    key: 'off',
    label: 'Shared',
    description:
      'User-pinned: every lane works in the live checkout on its current branch. Agents may not create branches or worktrees; TaskWraith write locks serialize concurrent writers.'
  },
  {
    key: 'worktree',
    label: 'Worktrees',
    description:
      'User-pinned: write-intent fan-out lanes always run in per-lane git worktrees (forked from the last commit) whose results become candidates to compare & promote.'
  },
  {
    key: 'any',
    label: 'Any',
    description:
      'Agents decide: Boss/Captain choose per dispatch via the fan-out isolation parameter; lanes without an explicit choice keep the shared checkout.'
  }
]

/**
 * Isolate picker — trigger + portaled popover, structurally cloned from
 * FanoutPolicyPicker above so it reuses the exact combined-picker popover
 * chrome every other composer popover carries (opaque themed panel + rim
 * highlight). The trigger keeps the `.composer-fanout-isolation-toggle`
 * class (its resting/active text treatment is pinned by
 * EnsembleOrchestrationRow.test.ts); `data-active` still marks the
 * pinned-Worktrees state only.
 */
function IsolationPicker({
  value,
  composerStyle,
  onSelect
}: {
  value: EnsembleFanoutIsolationPolicy
  composerStyle: ComposerStyle
  onSelect: (value: EnsembleFanoutIsolationPolicy) => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const selectedRow = ISOLATION_ROWS.find((row) => row.key === value) || ISOLATION_ROWS[0]

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
            aria-label="Fan-out isolation"
          >
            <div className="composer-plus-picker-section">
              <div className="composer-combined-picker-column-header">Isolate</div>
              {ISOLATION_ROWS.map((row) => {
                const active = row.key === value
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={`composer-combined-picker-row composer-plus-picker-row ${active ? 'is-selected' : ''}`}
                    onClick={() => {
                      onSelect(row.key)
                      setOpen(false)
                    }}
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
        className="composer-fanout-isolation-toggle"
        data-active={value === 'worktree'}
        title={selectedRow.description}
        aria-label="Fan-out isolation"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedRow.label}
      </button>
      {popover}
    </>
  )
}
