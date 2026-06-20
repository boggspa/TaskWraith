/*
 * WorkflowComposeControls — the workflow configuration cluster that sits UNDER
 * the composer on the "Workflows" welcome screen (replacing the starter-prompt
 * suggestions). It is intentionally PRESENTATIONAL and fully controlled: every
 * piece of state arrives via props and every change flows out through a
 * callback. No internal persistence, no IPC, no defaults beyond what the parent
 * supplies.
 *
 * Styling deliberately reuses WorkflowCreator's classes
 * (`.workflow-creator-segmented`, `.workflow-creator-field`,
 * `.workflow-creator-inline-field` — defined in 08-theme-picker-overrides.css)
 * so the controls read identically to the modal creator. The only new class is
 * `.workflow-compose-controls`, a thin horizontal-wrapping wrapper so the
 * cluster lays out as an inline row under the composer rather than a modal
 * column.
 */

export interface WorkflowComposeControlsProps {
  cadence: 'manual' | 'interval'
  onCadenceChange: (cadence: 'manual' | 'interval') => void
  intervalMinutes: number
  onIntervalMinutesChange: (minutes: number) => void
  maxRunsPerDay: number
  onMaxRunsPerDayChange: (max: number) => void
  ensembleEnabled: boolean
  onEnsembleEnabledChange: (enabled: boolean) => void
  /** Locked once the workflow has been created/started — render the toggle disabled. */
  ensembleLocked?: boolean
  /** Hide the ensemble toggle entirely (E2 ships single-provider workflows; the
   *  ensemble toggle + its above-row animation arrive in a later slice). */
  showEnsembleToggle?: boolean
}

const ENSEMBLE_LOCKED_TITLE =
  "Ensemble mode can't be changed after the workflow starts."

export function WorkflowComposeControls({
  cadence,
  onCadenceChange,
  intervalMinutes,
  onIntervalMinutesChange,
  maxRunsPerDay,
  onMaxRunsPerDayChange,
  ensembleEnabled,
  onEnsembleEnabledChange,
  ensembleLocked = false,
  showEnsembleToggle = true
}: WorkflowComposeControlsProps): React.JSX.Element {
  const clampMin1 = (raw: number): number => Math.max(1, Math.round(raw))

  return (
    <div className="workflow-compose-controls">
      {showEnsembleToggle && (
        <div className="workflow-creator-field">
          <span id="workflow-compose-ensemble-label">Run as ensemble</span>
          <div
            className="workflow-creator-segmented"
            role="group"
            aria-labelledby="workflow-compose-ensemble-label"
            aria-disabled={ensembleLocked || undefined}
            title={ensembleLocked ? ENSEMBLE_LOCKED_TITLE : undefined}
          >
            <button
              type="button"
              className={ensembleEnabled ? 'is-active' : ''}
              onClick={() => onEnsembleEnabledChange(true)}
              disabled={ensembleLocked}
              aria-pressed={ensembleEnabled}
              title={ensembleLocked ? ENSEMBLE_LOCKED_TITLE : undefined}
            >
              On
            </button>
            <button
              type="button"
              className={ensembleEnabled ? '' : 'is-active'}
              onClick={() => onEnsembleEnabledChange(false)}
              disabled={ensembleLocked}
              aria-pressed={!ensembleEnabled}
              title={ensembleLocked ? ENSEMBLE_LOCKED_TITLE : undefined}
            >
              Off
            </button>
          </div>
        </div>
      )}

      <div className="workflow-creator-field">
        <span id="workflow-compose-cadence-label">Cadence</span>
        <div
          className="workflow-creator-segmented"
          role="group"
          aria-labelledby="workflow-compose-cadence-label"
        >
          <button
            type="button"
            className={cadence === 'manual' ? 'is-active' : ''}
            onClick={() => onCadenceChange('manual')}
            aria-pressed={cadence === 'manual'}
          >
            Manual
          </button>
          <button
            type="button"
            className={cadence === 'interval' ? 'is-active' : ''}
            onClick={() => onCadenceChange('interval')}
            aria-pressed={cadence === 'interval'}
          >
            Every
          </button>
        </div>
      </div>

      {cadence === 'interval' && (
        <label className="workflow-creator-field workflow-creator-inline-field">
          <span>Minutes</span>
          <input
            type="number"
            min={1}
            step={1}
            value={intervalMinutes}
            onChange={(event) =>
              onIntervalMinutesChange(clampMin1(Number(event.target.value)))
            }
          />
        </label>
      )}

      <label className="workflow-creator-field workflow-creator-inline-field">
        <span>Max runs per day</span>
        <input
          type="number"
          min={1}
          step={1}
          value={maxRunsPerDay}
          onChange={(event) =>
            onMaxRunsPerDayChange(clampMin1(Number(event.target.value)))
          }
        />
      </label>
    </div>
  )
}
