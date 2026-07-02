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
 *   Fan-Out:       [Off | Read | Write]
 *   Chars:         [slider] 24K
 *   Turns:         [n/m hop meter]           (continuous mode only)
 *
 * The shared-history slider moved OUT of the EnsembleModePicker
 * popover onto this row (the picker now holds only the three
 * orchestration choices). The Fan-Out segment group keeps the existing
 * `.composer-ensemble-mode` capsule + `data-composer-control="ensemble-mode"`
 * hook so every per-shell button/capsule override keeps applying. The
 * row itself and the mode-picker trigger deliberately carry NEITHER —
 * several shells pill-ify anything matching the bare attribute (e.g.
 * 07-composer-shells claude/gemini/kimi blocks), which drew a spurious
 * capsule around the whole row and around the Turn/Continuous trigger.
 */

import { ContinuousHopsLimitChip } from './ContinuousHopsLimitChip'
import { EnsembleModePicker, type EnsembleOrchestrationMode } from './EnsembleModePicker'
import type { ComposerStyle, EnsembleFanoutPolicy } from '../../../main/store/types'

// Shared-transcript char budget bounds (mirror buildTaggedTranscript's clamp).
// Moved here from EnsembleModePicker when the slider left its popover.
const CONTEXT_MIN = 5_000
const CONTEXT_MAX = 500_000
const CONTEXT_DEFAULT = 24_000

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
  writerFanoutSelected,
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
  writerFanoutSelected: boolean
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
  const visibleOllamaContextWarning =
    ollamaContextWarning?.severity === 'ok' ? null : ollamaContextWarning
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
          <span className="composer-fanout-policy" aria-label="Fan-out policy">
            <button
              type="button"
              className={`composer-ensemble-mode-button ${fanoutPolicy === 'off' ? 'is-active' : ''}`}
              onClick={() => onFanoutPolicyChange('off')}
              title="Run participants serially."
            >
              Off
            </button>
            <button
              type="button"
              className={`composer-ensemble-mode-button ${fanoutPolicy === 'read_only' ? 'is-active' : ''}`}
              onClick={() => onFanoutPolicyChange('read_only')}
              title={
                concurrentLanesAvailable
                  ? 'Fan out read-only participants in parallel before writer-capable participants run serially.'
                  : 'Parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0); rounds run serially.'
              }
            >
              Read
            </button>
            <button
              type="button"
              className={`composer-ensemble-mode-button ${writerFanoutSelected ? 'is-active' : ''} ${
                !concurrentWriteLanesAvailable ? 'is-locked' : ''
              }`}
              disabled={!concurrentWriteLanesAvailable}
              onClick={() => onFanoutPolicyChange(writerFanoutPolicy)}
              title={
                concurrentWriteLanesAvailable
                  ? bossmanAssigned
                    ? 'Writer fan-out is available when the assigned Boss calls ensemble_fanout with explicit writeScopes.'
                    : 'Writer fan-out is mediated by user-enabled write-scope preflight: claim scopes, host conflict matrix, then ack.'
                  : 'Writer fan-out is disabled (TASKWRAITH_CONCURRENT_WRITE_LANES=0).'
              }
            >
              Write
            </button>
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
