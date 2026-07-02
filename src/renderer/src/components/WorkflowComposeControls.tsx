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

import type { UnattendedElevationLevel } from '../../../main/UnattendedPostureGate'

export interface WorkflowComposeControlsProps {
  cadence: 'manual' | 'interval'
  onCadenceChange: (cadence: 'manual' | 'interval') => void
  intervalMinutes: number
  onIntervalMinutesChange: (minutes: number) => void
  maxRunsPerDay: number
  onMaxRunsPerDayChange: (max: number) => void
  /**
   * P2b: the chosen UNATTENDED permission level. Default 'safe' (read-only). This
   * is captured as INTENT only — the verified ack is minted post-save by the
   * set-workflow-unattended-elevation IPC (the save/update sanitizers strip a
   * renderer-supplied ack), so this control never writes onto the workflow object.
   */
  unattendedLevel: UnattendedElevationLevel
  onUnattendedLevelChange: (level: UnattendedElevationLevel) => void
}

const UNATTENDED_LEVEL_OPTIONS: ReadonlyArray<{
  level: UnattendedElevationLevel
  label: string
}> = [
  { level: 'safe', label: 'Safe (read-only)' },
  { level: 'default', label: 'Default permissions' },
  { level: 'full_access', label: 'Full Workspace Access' }
]

export function WorkflowComposeControls({
  cadence,
  onCadenceChange,
  intervalMinutes,
  onIntervalMinutesChange,
  maxRunsPerDay,
  onMaxRunsPerDayChange,
  unattendedLevel,
  onUnattendedLevelChange
}: WorkflowComposeControlsProps): React.JSX.Element {
  const clampMin1 = (raw: number): number => Math.max(1, Math.round(raw))

  return (
    <div className="workflow-compose-controls">
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

      <div className="workflow-creator-field">
        <span id="workflow-compose-unattended-label">Unattended permissions</span>
        <div
          className="workflow-creator-segmented"
          role="group"
          aria-labelledby="workflow-compose-unattended-label"
        >
          {UNATTENDED_LEVEL_OPTIONS.map((option) => (
            <button
              key={option.level}
              type="button"
              className={unattendedLevel === option.level ? 'is-active' : ''}
              onClick={() => onUnattendedLevelChange(option.level)}
              aria-pressed={unattendedLevel === option.level}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
