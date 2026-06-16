import React, { useCallback } from 'react'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'
import { useUpdateStatus } from '../hooks/useUpdateStatus'

/**
 * UpdateStatusPane — Phase G2 sub-section of Settings → System.
 *
 * Surfaces the auto-update status (idle / checking / available /
 * downloading / downloaded / error / disabled) with manual controls
 * for checking + downloading + installing. Listens for live snapshots
 * via the `update-status-changed` event the main process emits
 * whenever the underlying state changes.
 *
 * Self-contained: pulls the initial snapshot via `api.updateSnapshot()`
 * on mount, then subscribes to live changes. Doesn't depend on the
 * SettingsPanel props pipeline so it can move to any tab if we
 * reshape the Settings layout later.
 */

export function UpdateStatusPane({
  autoUpdateEnabled = true
}: {
  autoUpdateEnabled?: boolean
}): React.JSX.Element {
  const { snapshot: snap, busy, checkForUpdates, downloadUpdate, installUpdateNow } =
    useUpdateStatus()

  const handleInstall = useCallback(async () => {
    if (!confirm('Install update and restart TaskWraith now?')) return
    await installUpdateNow()
  }, [installUpdateNow])

  if (!snap) {
    return (
      <div className="update-status-pane">
        <p className="settings-hint">Loading update status…</p>
      </div>
    )
  }

  return (
    <div className="update-status-pane">
      <div className="update-status-row">
        <span className={`update-status-pill update-status-pill-${snap.status}`}>
          {labelForStatus(snap.status)}
        </span>
        {snap.latestVersion && <span className="update-status-version">v{snap.latestVersion}</span>}
        {snap.lastCheckedAt && (
          <span className="update-status-checked">
            Last checked {formatRelative(snap.lastCheckedAt)}
          </span>
        )}
      </div>

      {snap.status === 'downloading' && snap.downloadProgress && (
        <div className="update-status-progress">
          <div
            className="update-status-progress-fill"
            style={{ width: `${Math.max(0, Math.min(100, snap.downloadProgress.percent))}%` }}
          />
          <span className="update-status-progress-label">
            {snap.downloadProgress.percent.toFixed(1)}% —{' '}
            {formatBytes(snap.downloadProgress.transferred)} /{' '}
            {formatBytes(snap.downloadProgress.total)}
          </span>
        </div>
      )}

      {snap.status === 'error' && snap.errorMessage && (
        <div className="update-status-error">{snap.errorMessage}</div>
      )}

      <div className="update-status-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={
            busy || !snap.enabled || snap.status === 'checking' || snap.status === 'downloading'
          }
          onClick={() => void checkForUpdates()}
        >
          {snap.status === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
        {snap.status === 'available' && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void downloadUpdate()}
          >
            Download
          </button>
        )}
        {snap.status === 'downloaded' && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void handleInstall()}
          >
            Install and restart
          </button>
        )}
      </div>

      {!snap.enabled && (
        <p className="settings-hint update-status-disabled-hint">
          {autoUpdateEnabled
            ? 'Auto-updates are disabled by the current channel, development build, or TASKWRAITH_AUTO_UPDATE setting. They activate automatically in packaged builds when the update channel is set to '
            : 'Auto-updates are disabled because Enable Auto-Update is off. Turn it back on to resume automatic checks for '}
          <strong>Stable</strong> or
          <strong> Nightly</strong> (currently <strong>{snap.channel}</strong>).
          {autoUpdateEnabled && (
            <>
              {' '}
              Override with <code>TASKWRAITH_AUTO_UPDATE=on</code> for testing against a local
              feed.
            </>
          )}
        </p>
      )}
    </div>
  )
}

function labelForStatus(status: UpdateStateSnapshot['status']): string {
  switch (status) {
    case 'disabled':
      return 'Disabled'
    case 'idle':
      return 'Up to date check'
    case 'checking':
      return 'Checking…'
    case 'available':
      return 'Update available'
    case 'not-available':
      return 'Up to date'
    case 'downloading':
      return 'Downloading'
    case 'downloaded':
      return 'Ready to install'
    case 'error':
      return 'Error'
  }
}

function formatRelative(iso: string): string {
  try {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return iso

    const deltaS = Math.round((Date.now() - ms) / 1000)
    if (deltaS < 5) return 'just now'
    if (deltaS < 60) return `${deltaS}s ago`
    if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`
    if (deltaS < 86_400) return `${Math.round(deltaS / 3600)}h ago`
    return new Date(ms).toLocaleString()
  } catch {
    return iso
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
