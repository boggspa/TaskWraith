import type { UpdateStateSnapshot } from '../../../main/UpdateService'

/**
 * Produce a stable fingerprint of the user-visible updater snapshot. Periodic
 * checks stamp a new `lastCheckedAt` on every tick and briefly pass through
 * `checking`; those are transport noise. Excluding the timestamp (and
 * dropping `checking` in `shouldApplyUpdateSnapshot`) keeps an unchanged
 * heartbeat from invalidating the root React tree. An explicit user action
 * may still publish via `{ force: true }`.
 */
export function fingerprintUpdateSnapshot(snapshot: UpdateStateSnapshot | null): string {
  if (!snapshot) return ''
  return JSON.stringify({
    status: snapshot.status,
    enabled: snapshot.enabled,
    channel: snapshot.channel,
    latestVersion: snapshot.latestVersion || '',
    releaseName: snapshot.releaseName || '',
    releaseDate: snapshot.releaseDate || '',
    releaseNotes: snapshot.releaseNotes ?? null,
    releasePageUrl: snapshot.releasePageUrl || '',
    updateArchitecture: snapshot.updateArchitecture ?? null,
    downloadProgress: snapshot.downloadProgress
      ? {
          percent: snapshot.downloadProgress.percent,
          transferred: snapshot.downloadProgress.transferred,
          total: snapshot.downloadProgress.total
        }
      : null,
    errorMessage: snapshot.errorMessage || '',
    restartPending: Boolean(snapshot.restartPending),
    identityHandoff: snapshot.identityHandoff ?? null
  })
}

export function shouldApplyUpdateSnapshot(
  prev: UpdateStateSnapshot | null,
  next: UpdateStateSnapshot | null,
  options: { force?: boolean } = {}
): boolean {
  if (options.force === true) return true
  if (!next) return prev !== null
  if (next.status === 'checking') return false
  return fingerprintUpdateSnapshot(prev) !== fingerprintUpdateSnapshot(next)
}
