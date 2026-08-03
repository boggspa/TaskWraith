/**
 * AppDriveDockPanel — first-class right-dock App Drive surface.
 *
 * Prop-driven: consumes a safe status projection (observation + control +
 * explicit lifecycle). Does not call IPC, mint leases, or actuate targets.
 * Pause / Takeover / Stop are callback hooks for a main-owned session layer.
 *
 * Mode chip is always Foreground Drive for the shipped native path. The
 * virtual cursor is display-only (pointer-events: none).
 */
import type { ReactNode } from 'react'
import { AppDriveVirtualCursor } from './AppDriveVirtualCursor'
import {
  formatExpiry,
  formatStepsRemaining,
  formatVerbList,
  lifecycleActionAvailability,
  lifecycleStatusLabel,
  modeChipLabel,
  permissionDisclosureLabel,
  targetPrimaryLabel,
  targetSecondaryLabel,
  type AppDriveDockStatus
} from '../lib/appDriveDockState'
import './AppDriveDockPanel.css'

export interface AppDriveDockPanelProps {
  readonly status: AppDriveDockStatus
  /** Wall clock for expiry formatting in tests. */
  readonly nowMs?: number
  readonly onPause?: () => void
  readonly onResume?: () => void
  readonly onTakeOver?: () => void
  readonly onStop?: () => void
}

export function AppDriveDockPanel({
  status,
  nowMs,
  onPause,
  onResume,
  onTakeOver,
  onStop
}: AppDriveDockPanelProps): ReactNode {
  const actions = lifecycleActionAvailability(status.lifecycle)
  const hasAttachment = Boolean(status.observation || status.control)
  const modeLabel = modeChipLabel(status.mode)
  const permissionLabel = permissionDisclosureLabel(status)
  const primary = targetPrimaryLabel(status.observation)
  const secondary = targetSecondaryLabel(status.observation)

  return (
    <div className="appdrive-dock-panel" aria-label="App Drive panel">
      <header className="appdrive-dock-header">
        <div className="appdrive-dock-title-row">
          <span className="appdrive-dock-title">App Drive</span>
          <span
            className="appdrive-dock-mode-chip"
            data-testid="appdrive-mode-chip"
            title="Native Tier 4 requires the selected app to be frontmost. Non-disruptive and VM-isolated modes are not shipped."
          >
            {modeLabel}
          </span>
        </div>
        <div className="appdrive-dock-status-row" data-testid="appdrive-lifecycle">
          <span className={`appdrive-dock-lifecycle is-${status.lifecycle}`}>
            {lifecycleStatusLabel(status.lifecycle)}
          </span>
          <span className="appdrive-dock-permission" data-testid="appdrive-permission">
            {permissionLabel}
          </span>
        </div>
      </header>

      {!hasAttachment ? (
        <div className="appdrive-dock-empty" data-testid="appdrive-empty">
          No App Drive target attached. Use Screen Watch, then approve View &amp; Control for the
          current launch when you want the agent to drive.
        </div>
      ) : (
        <>
          <section className="appdrive-dock-section" aria-label="Target">
            <div className="appdrive-dock-subtitle">Target</div>
            <div className="appdrive-dock-target" data-testid="appdrive-target">
              <div className="appdrive-dock-target-primary">{primary}</div>
              {secondary ? <div className="appdrive-dock-target-secondary">{secondary}</div> : null}
              {status.observation?.bundleID ? (
                <div
                  className="appdrive-dock-target-meta"
                  title="Display only — not an approval key"
                >
                  {status.observation.bundleID}
                </div>
              ) : null}
            </div>
          </section>

          <section className="appdrive-dock-preview" aria-label="Preview">
            <div className="appdrive-dock-preview-frame">
              {status.previewFrameUrl ? (
                <img
                  className="appdrive-dock-preview-image"
                  src={status.previewFrameUrl}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="appdrive-dock-preview-placeholder">
                  Preview appears when Screen Watch is streaming.
                </div>
              )}
              <AppDriveVirtualCursor
                point={status.virtualCursor}
                visible={Boolean(status.control) && status.lifecycle !== 'stopped'}
              />
            </div>
            <div className="appdrive-dock-preview-note">
              Agent cursor is display-only. It does not move the Mac pointer.
            </div>
          </section>

          <section className="appdrive-dock-section" aria-label="Lease status">
            <div className="appdrive-dock-subtitle">Lease</div>
            <dl className="appdrive-dock-metrics">
              <div>
                <dt>Steps</dt>
                <dd data-testid="appdrive-steps">{formatStepsRemaining(status.control)}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd data-testid="appdrive-expiry">
                  {formatExpiry(status.control?.expiresAt, nowMs)}
                </dd>
              </div>
              <div className="appdrive-dock-metrics-wide">
                <dt>Verbs</dt>
                <dd data-testid="appdrive-verbs">{formatVerbList(status.control?.allowedVerbs)}</dd>
              </div>
              {status.control ? (
                <div className="appdrive-dock-metrics-wide">
                  <dt>Provider</dt>
                  <dd data-testid="appdrive-provider">{status.control.provider}</dd>
                </div>
              ) : null}
            </dl>
            {actions.agentActionsRefused && status.control ? (
              <div className="appdrive-dock-note" data-testid="appdrive-refuse-note">
                Agent actuation is refused while this session is{' '}
                {lifecycleStatusLabel(status.lifecycle).toLowerCase()}. Explicit Pause / Takeover is
                session chrome — native HID arbitration remains machine-wide.
              </div>
            ) : null}
          </section>
        </>
      )}

      {status.warning ? (
        <div className="appdrive-dock-warning" role="status" data-testid="appdrive-warning">
          {status.warning}
        </div>
      ) : null}

      <footer className="appdrive-dock-controls" aria-label="App Drive controls">
        {actions.canPause ? (
          <button
            type="button"
            className="appdrive-dock-button"
            data-testid="appdrive-pause"
            onClick={onPause}
            disabled={!onPause}
          >
            Pause
          </button>
        ) : null}
        {actions.canResume ? (
          <button
            type="button"
            className="appdrive-dock-button"
            data-testid="appdrive-resume"
            onClick={onResume}
            disabled={!onResume}
          >
            Resume
          </button>
        ) : null}
        {actions.canTakeOver ? (
          <button
            type="button"
            className="appdrive-dock-button"
            data-testid="appdrive-takeover"
            onClick={onTakeOver}
            disabled={!onTakeOver}
          >
            Take Over
          </button>
        ) : null}
        {actions.canStop ? (
          <button
            type="button"
            className="appdrive-dock-button is-danger"
            data-testid="appdrive-stop"
            onClick={onStop}
            disabled={!onStop}
          >
            Stop
          </button>
        ) : null}
        {!actions.canPause && !actions.canResume && !actions.canTakeOver && !actions.canStop ? (
          <span className="appdrive-dock-controls-idle">No active control session</span>
        ) : null}
      </footer>
    </div>
  )
}
