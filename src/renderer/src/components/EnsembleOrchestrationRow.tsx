/*
 * EnsembleOrchestrationRow — the second row of the roster-presets
 * above-row section (rendered via EnsembleRosterPresetPicker's
 * `secondRow` slot on BOTH the welcome hero and the compact in-thread
 * variants, so every ensemble composer surface gets it).
 *
 * Consolidates the ensemble orchestration controls that previously
 * crowded the composer's bottom action row — with Continuous enabled
 * the mode picker + fan-out toggle + hop meter competed with the
 * provider/model/permission pickers for footer space. Now the row has
 * a full line of real estate and each control gets an explicit label:
 *
 *   Mode:          [Turn/Continuous/Work Session picker]
 *   Fan-Out:       [Off/Read/Write/All picker]
 *   Chars:         [slider] 24K
 *   Turns:         [n/m hop meter]           (continuous mode only)
 *
 * The shared-history slider moved OUT of the EnsembleModePicker
 * popover onto this row (the picker now holds only the three
 * orchestration choices). The Fan-Out picker keeps the existing
 * `.composer-ensemble-mode` capsule + `data-composer-control="ensemble-mode"`
 * hook so every per-shell picker/capsule override keeps applying. The
 * row itself and the mode-picker trigger deliberately carry NEITHER —
 * several shells pill-ify anything matching the bare attribute (e.g.
 * 07-composer-shells claude/gemini/kimi blocks), which drew a spurious
 * capsule around the whole row and around the Turn/Continuous trigger.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ContinuousHopsLimitChip } from './ContinuousHopsLimitChip'
import { EnsembleModePicker, type EnsembleOrchestrationMode } from './EnsembleModePicker'
import type { ComposerStyle, EnsembleFanoutPolicy } from '../../../main/store/types'

// Shared-transcript char budget bounds (mirror buildTaggedTranscript's clamp).
// Moved here from EnsembleModePicker when the slider left its popover.
const CONTEXT_MIN = 5_000
const CONTEXT_MAX = 500_000
const CONTEXT_DEFAULT = 24_000
type FanoutPickerValue = 'off' | 'read_only' | 'write' | 'all'

interface FanoutPolicyRow {
  key: FanoutPickerValue
  label: string
  description: string
  disabled?: boolean
}

function formatCharBudget(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}K` : `${chars}`
}

export interface EnsembleOllamaContextWarning {
  severity: 'ok' | 'warn' | 'critical'
  message: string
  suggestedChars?: number
}

export function EnsembleOrchestrationRow({
  orchestrationMode,
  activeOrchestrationMode,
  activeFanoutPolicy,
  isRoundRunning,
  workSessionActive,
  composerStyle,
  onSelectMode,
  onOpenWorkSession,
  fanoutPolicy,
  writerFanoutPolicy,
  onFanoutPolicyChange,
  concurrentLanesAvailable,
  concurrentWriteLanesAvailable,
  bossmanAssigned,
  contextChars,
  onContextCharsChange,
  ollamaContextWarning,
  continuationHops,
  maxContinuationHops,
  onMaxContinuationHopsChange
}: {
  orchestrationMode: EnsembleOrchestrationMode
  /** The in-flight round's mode (falls back to the chat's) — drives the
   * "Current round" tooltip and the Turn Budget cell's visibility. */
  activeOrchestrationMode: EnsembleOrchestrationMode
  activeFanoutPolicy: EnsembleFanoutPolicy
  isRoundRunning: boolean
  workSessionActive: boolean
  composerStyle: ComposerStyle
  onSelectMode: (mode: EnsembleOrchestrationMode) => void
  onOpenWorkSession: () => void
  fanoutPolicy: EnsembleFanoutPolicy
  /** Which locked-writers policy the Write button selects (boss-mediated
   * vs user-preflight) — resolved upstream from bossmanParticipantId. */
  writerFanoutPolicy: EnsembleFanoutPolicy
  onFanoutPolicyChange: (policy: EnsembleFanoutPolicy) => void
  concurrentLanesAvailable: boolean
  concurrentWriteLanesAvailable: boolean
  bossmanAssigned: boolean
  contextChars?: number
  onContextCharsChange: (chars: number) => void
  ollamaContextWarning?: EnsembleOllamaContextWarning | null
  continuationHops: number
  maxContinuationHops: number
  onMaxContinuationHopsChange: (nextMax: number) => void
}): React.JSX.Element {
  const effectiveContextChars = contextChars ?? CONTEXT_DEFAULT
  const contextSliderFill = Math.max(
    0,
    Math.min(
      100,
      ((effectiveContextChars - CONTEXT_MIN) / (CONTEXT_MAX - CONTEXT_MIN)) * 100
    )
  )
  const visibleOllamaContextWarning =
    ollamaContextWarning?.severity === 'ok' ? null : ollamaContextWarning
  const selectedFanoutValue: FanoutPickerValue =
    fanoutPolicy === 'all'
      ? 'all'
      : fanoutPolicy === 'locked_writers_with_boss' ||
          fanoutPolicy === 'locked_writers_user_preflight'
        ? 'write'
        : fanoutPolicy
  const fanoutTitle = (() => {
    if (!concurrentLanesAvailable) {
      return 'Parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0); rounds run serially.'
    }
    if (selectedFanoutValue === 'off') return 'Run participants serially.'
    if (selectedFanoutValue === 'read_only') {
      return 'Fan out scouts/read-only participants at the start and reviewers later.'
    }
    if (!concurrentWriteLanesAvailable) {
      return 'Writer fan-out is disabled (TASKWRAITH_CONCURRENT_WRITE_LANES=0).'
    }
    if (selectedFanoutValue === 'write') {
      return bossmanAssigned
        ? 'Only writer/worker fan-out is enabled; Boss-triggered lanes require explicit writeScopes.'
        : 'Only writer/worker fan-out is enabled; user-preflight claims scopes before dispatch.'
    }
    return bossmanAssigned
      ? 'Read/review fan-out plus Boss-triggered writer lanes with explicit writeScopes.'
      : 'Read/review fan-out plus user-preflight writer lanes.'
  })()
  const handleFanoutPickerChange = (value: FanoutPickerValue) => {
    if (value === 'write') {
      onFanoutPolicyChange(writerFanoutPolicy)
      return
    }
    onFanoutPolicyChange(value)
  }
  return (
    <div
      className="composer-ensemble-orchestration-row"
      role="group"
      aria-label="Ensemble orchestration"
      title={
        isRoundRunning
          ? `Current round: ${activeOrchestrationMode === 'continuous' ? 'Continuous' : 'Turn-bound'}${
              activeFanoutPolicy === 'read_only'
                ? ' + Read fan-out'
                : activeFanoutPolicy === 'off'
                  ? ''
                  : activeFanoutPolicy === 'all'
                    ? ' + All fan-out'
                    : ' + Writer fan-out'
            }`
          : 'Choose whether agents speak once per round or can hand work back and forth.'
      }
    >
      <span className="composer-orchestration-cell">
        <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
          Mode
        </span>
        <EnsembleModePicker
          mode={orchestrationMode}
          workSessionActive={workSessionActive}
          composerStyle={composerStyle}
          onSelectMode={onSelectMode}
          onOpenWorkSession={onOpenWorkSession}
        />
      </span>
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
              onSelect={handleFanoutPickerChange}
            />
          </span>
        </span>
      </span>
      <span className="composer-orchestration-cell composer-orchestration-cell-history">
        <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
          Chars
        </span>
        <input
          type="range"
          className="composer-ensemble-context-slider"
          min={CONTEXT_MIN}
          max={CONTEXT_MAX}
          step={5_000}
          value={effectiveContextChars}
          onChange={(event) => onContextCharsChange(Number(event.target.value))}
          aria-label="Shared transcript character budget"
          title={`${formatCharBudget(effectiveContextChars)} chars of recent panel history shared with each participant`}
          style={
            {
              '--ensemble-context-slider-fill': `${contextSliderFill}%`
            } as CSSProperties
          }
        />
        <span className="composer-ensemble-context-value">
          {formatCharBudget(effectiveContextChars)}
        </span>
      </span>
      {activeOrchestrationMode === 'continuous' && (
        <span className="composer-orchestration-cell">
          <span className="ensemble-roster-preset-picker-label composer-orchestration-cell-label">
            Turns
          </span>
          <ContinuousHopsLimitChip
            hops={continuationHops}
            maxHops={maxContinuationHops}
            onSave={onMaxContinuationHopsChange}
          />
        </span>
      )}
      {(visibleOllamaContextWarning || !concurrentLanesAvailable) && (
        <div className="composer-orchestration-row-hints">
          {visibleOllamaContextWarning ? (
            <div
              className={`composer-ensemble-context-hint severity-${visibleOllamaContextWarning.severity}`}
              role="note"
            >
              {visibleOllamaContextWarning.message}
              {visibleOllamaContextWarning.suggestedChars &&
              visibleOllamaContextWarning.severity !== 'ok' &&
              effectiveContextChars > visibleOllamaContextWarning.suggestedChars ? (
                <button
                  type="button"
                  className="composer-ensemble-context-suggest"
                  onClick={() =>
                    onContextCharsChange(
                      visibleOllamaContextWarning.suggestedChars ?? CONTEXT_DEFAULT
                    )
                  }
                >
                  Use {formatCharBudget(visibleOllamaContextWarning.suggestedChars)} for panel
                </button>
              ) : null}
            </div>
          ) : null}
          {!concurrentLanesAvailable ? (
            <div className="composer-ensemble-context-hint severity-warn" role="note">
              Parallel fan-out lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0). Fan-out rounds
              fall back to serial dispatch.
            </div>
          ) : null}
        </div>
      )}
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
  const writeDisabled = !concurrentWriteLanesAvailable
  return [
    { key: 'off', label: 'Off', description: 'Run participants serially.' },
    {
      key: 'read_only',
      label: 'Read',
      description: 'Fan out scouts/read-only participants at the start and reviewers later.'
    },
    {
      key: 'write',
      label: 'Write',
      description: bossmanAssigned
        ? 'Only writer/worker fan-out is enabled; Boss-triggered lanes require explicit writeScopes.'
        : 'Only writer/worker fan-out is enabled; user-preflight claims scopes before dispatch.',
      disabled: writeDisabled
    },
    {
      key: 'all',
      label: 'All',
      description: bossmanAssigned
        ? 'Read/review fan-out plus Boss-triggered writer lanes with explicit writeScopes.'
        : 'Read/review fan-out plus user-preflight writer lanes.',
      disabled: writeDisabled
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
    if (row.disabled) return
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
            aria-label="Fan-out policy"
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
                    title={row.disabled ? 'Writer fan-out is disabled.' : row.description}
                    aria-pressed={active}
                    disabled={row.disabled}
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
        aria-label="Fan-out policy"
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
