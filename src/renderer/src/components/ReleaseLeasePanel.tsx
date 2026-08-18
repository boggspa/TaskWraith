import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { PillButton } from './PillButton'
import './ReleaseLeasePanel.css'

/**
 * ReleaseLeasePanel — grant control for the session release lease.
 *
 * `ReleaseCommandPolicy` blocks release-class commands (git push, gh release,
 * notarytool, npm publish, ...) unless the caller presents an approval source.
 * A lease is the user saying "I am going AFK, you are authorized to publish":
 * while it is live it satisfies that gate on every agent route, and without one
 * the gate stays shut. This panel is the only place a lease is granted.
 *
 * Split into a pure view plus a container so the presentation is testable with
 * `renderToStaticMarkup` — this repo has no DOM test environment.
 */

export interface ReleaseLeaseSnapshotView {
  id: string
  commandClasses: 'all' | string[]
  workspacePath?: string
  grantedAt: string
  expiresAt: string
  note?: string
  origin: 'desktop-ui' | 'ios-bridge' | 'host'
}

export interface ReleaseLeaseApi {
  grant: (input: {
    minutes?: number
    commandClasses?: 'all' | string[]
    workspacePath?: string
    note?: string
  }) => Promise<ReleaseLeaseSnapshotView>
  status: () => Promise<ReleaseLeaseSnapshotView[]>
  revoke: (leaseId?: string) => Promise<{ revoked: number }>
}

/** Durations offered in the grant control. The main process clamps to 12h. */
export const RELEASE_LEASE_DURATION_CHOICES = [30, 60, 120, 240, 480, 720] as const

export function formatLeaseDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return Number.isInteger(hours) ? `${hours} hr` : `${hours.toFixed(1)} hr`
}

/**
 * The line a human reads to decide whether they are still exposed. Deliberately
 * states the remaining time rather than a raw timestamp, because "expires
 * 14:52Z" does not answer "is this still open?" at a glance.
 */
export function describeLeaseRemaining(expiresAt: string, nowMs: number): string {
  const remainingMs = Date.parse(expiresAt) - nowMs
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'Expired'
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes} min left`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} hr ${minutes} min left` : `${hours} hr left`
}

export function describeLeaseScope(commandClasses: 'all' | string[]): string {
  if (commandClasses === 'all' || commandClasses.length === 0) {
    return 'All release commands'
  }
  return commandClasses.join(', ')
}

export interface ReleaseLeaseViewProps {
  leases: ReleaseLeaseSnapshotView[]
  nowMs: number
  minutes: number
  scopeToWorkspace: boolean
  currentWorkspacePath?: string | null
  busy?: boolean
  error?: string | null
  onMinutesChange?: (minutes: number) => void
  onScopeToWorkspaceChange?: (scoped: boolean) => void
  onGrant?: () => void
  onRevoke?: (leaseId: string) => void
  onRevokeAll?: () => void
}

export function ReleaseLeaseView({
  leases,
  nowMs,
  minutes,
  scopeToWorkspace,
  currentWorkspacePath,
  busy = false,
  error = null,
  onMinutesChange,
  onScopeToWorkspaceChange,
  onGrant,
  onRevoke,
  onRevokeAll
}: ReleaseLeaseViewProps): React.JSX.Element {
  const live = leases.filter((lease) => Date.parse(lease.expiresAt) > nowMs)

  return (
    <section className="release-lease-panel">
      <header className="release-lease-header">
        <h3 className="release-lease-title">Release authorization</h3>
        <span className="release-lease-count">
          {live.length === 0
            ? 'No active lease'
            : `${live.length} active lease${live.length === 1 ? '' : 's'}`}
        </span>
      </header>

      <p className="release-lease-explainer">
        Agents cannot run release commands — git push, gh release, notarytool, npm publish — unless
        you grant a lease. Grant one when you want a release to continue while you are away. It
        expires on its own, and you can revoke it at any time.
      </p>

      {live.length === 0 ? (
        <p className="release-lease-empty">
          No lease is active. Release commands are blocked for every agent.
        </p>
      ) : (
        <ul className="release-lease-list">
          {live.map((lease) => (
            <li className="release-lease-row" key={lease.id}>
              <div className="release-lease-row-main">
                <span className="release-lease-row-title">
                  {describeLeaseScope(lease.commandClasses)}
                </span>
                <span className="release-lease-row-meta">
                  {describeLeaseRemaining(lease.expiresAt, nowMs)}
                  {lease.workspacePath ? ` · ${lease.workspacePath}` : ' · any workspace'}
                </span>
                {lease.note ? <span className="release-lease-row-note">{lease.note}</span> : null}
              </div>
              <PillButton
                variant="danger"
                size="compact"
                className="release-lease-revoke"
                disabled={busy}
                onClick={() => onRevoke?.(lease.id)}
              >
                Revoke
              </PillButton>
            </li>
          ))}
        </ul>
      )}

      <div className="release-lease-controls">
        <label className="release-lease-control-group">
          <span className="release-lease-control-label">Duration</span>
          <select
            className="release-lease-duration"
            value={minutes}
            disabled={busy}
            onChange={(event) => onMinutesChange?.(Number(event.target.value))}
          >
            {RELEASE_LEASE_DURATION_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {formatLeaseDuration(choice)}
              </option>
            ))}
          </select>
        </label>

        {currentWorkspacePath ? (
          <label className="release-lease-control-group release-lease-scope">
            <input
              type="checkbox"
              checked={scopeToWorkspace}
              disabled={busy}
              onChange={(event) => onScopeToWorkspaceChange?.(event.target.checked)}
            />
            <span className="release-lease-control-label">Limit to this workspace</span>
          </label>
        ) : null}

        <div className="release-lease-actions">
          <PillButton variant="primary" disabled={busy} onClick={() => onGrant?.()}>
            Grant lease
          </PillButton>
          {live.length > 0 ? (
            <PillButton variant="secondary" disabled={busy} onClick={() => onRevokeAll?.()}>
              Revoke all
            </PillButton>
          ) : null}
        </div>
      </div>

      {error ? <p className="release-lease-error">{error}</p> : null}
    </section>
  )
}

export interface ReleaseLeasePanelProps {
  currentWorkspacePath?: string | null
  /** Injectable for tests; defaults to the preload bindings. */
  api?: ReleaseLeaseApi
}

function defaultReleaseLeaseApi(): ReleaseLeaseApi | null {
  const bridge = (window as unknown as { api?: Record<string, unknown> }).api
  if (!bridge || typeof bridge.releaseLeaseGrant !== 'function') return null
  return {
    grant: bridge.releaseLeaseGrant as ReleaseLeaseApi['grant'],
    status: bridge.releaseLeaseStatus as ReleaseLeaseApi['status'],
    revoke: bridge.releaseLeaseRevoke as ReleaseLeaseApi['revoke']
  }
}

export function ReleaseLeasePanel({
  currentWorkspacePath,
  api
}: ReleaseLeasePanelProps): React.JSX.Element {
  const resolvedApi = useMemo(() => api ?? defaultReleaseLeaseApi(), [api])
  const [leases, setLeases] = useState<ReleaseLeaseSnapshotView[]>([])
  const [minutes, setMinutes] = useState<number>(120)
  const [scopeToWorkspace, setScopeToWorkspace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Ticks so the "time left" line stays honest without a manual refresh.
  const [nowMs, setNowMs] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    if (!resolvedApi) return
    try {
      setLeases(await resolvedApi.status())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [resolvedApi])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setNowMs(Date.now())
      }
    },
    [refresh]
  )

  return (
    <ReleaseLeaseView
      leases={leases}
      nowMs={nowMs}
      minutes={minutes}
      scopeToWorkspace={scopeToWorkspace}
      currentWorkspacePath={currentWorkspacePath}
      busy={busy || !resolvedApi}
      error={resolvedApi ? error : 'Release-lease controls are unavailable in this window.'}
      onMinutesChange={setMinutes}
      onScopeToWorkspaceChange={setScopeToWorkspace}
      onGrant={() =>
        void runAction(() =>
          resolvedApi!.grant({
            minutes,
            ...(scopeToWorkspace && currentWorkspacePath
              ? { workspacePath: currentWorkspacePath }
              : {})
          })
        )
      }
      onRevoke={(leaseId) => void runAction(() => resolvedApi!.revoke(leaseId))}
      onRevokeAll={() => void runAction(() => resolvedApi!.revoke())}
    />
  )
}
