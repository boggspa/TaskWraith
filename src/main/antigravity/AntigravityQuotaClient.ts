import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import {
  AGY_USAGE_FRESH_TTL_MS,
  AGY_USAGE_MANUAL_MIN_INTERVAL_MS,
  agyQuotaUnavailableSnapshot
} from './AntigravityUsage'

/** Limit Counter's deliberately uneven autonomous refresh cadence. */
export const ANTIGRAVITY_QUOTA_REFRESH_INTERVALS_MS = [4, 7, 16, 3, 21].map(
  (minutes) => minutes * 60 * 1000
)

const STALE_AFTER_MS = 30 * 60 * 1000

export interface AntigravityQuotaClientDependencies {
  /**
   * Invokes agy's own documented `/usage` surface. This boundary deliberately
   * receives no OAuth token, credential path, or raw session material.
   */
  fetchQuota: () => Promise<NormalizedProviderUsageSnapshot>
  now?: () => number
  refreshIntervalsMs?: readonly number[]
  freshTtlMs?: number
  manualMinIntervalMs?: number
  staleAfterMs?: number
}

export type AntigravityQuotaSnapshotReader = (options?: {
  force?: unknown
}) => Promise<NormalizedProviderUsageSnapshot>

interface CachedQuotaSnapshot {
  snapshot: NormalizedProviderUsageSnapshot
  observedAt: number
}

function hasQuotaWindows(snapshot: NormalizedProviderUsageSnapshot): boolean {
  return Array.isArray(snapshot.windows) && snapshot.windows.length > 0
}

function cachedSnapshot(
  cached: CachedQuotaSnapshot,
  now: number,
  staleAfterMs: number
): NormalizedProviderUsageSnapshot {
  return {
    ...cached.snapshot,
    stale: now - cached.observedAt > staleAfterMs
  }
}

function fallbackUnavailable(now: number, reason: string): NormalizedProviderUsageSnapshot {
  return agyQuotaUnavailableSnapshot(reason, () => new Date(now).toISOString())
}

/**
 * TaskWraith-owned scheduler/cache around agy's own quota UI. Automatic calls
 * follow the former Limit Counter cadence, manual refreshes stay clamped, and
 * concurrent callers join one hidden PTY session. TaskWraith never reads or
 * stores agy's OAuth material.
 */
export function createAntigravityQuotaClient(
  dependencies: AntigravityQuotaClientDependencies
): AntigravityQuotaSnapshotReader {
  const now = () => dependencies.now?.() ?? Date.now()
  const refreshIntervals = (
    dependencies.refreshIntervalsMs ?? ANTIGRAVITY_QUOTA_REFRESH_INTERVALS_MS
  ).filter((value) => Number.isFinite(value) && value >= 0)
  const freshTtlMs = Math.max(0, dependencies.freshTtlMs ?? AGY_USAGE_FRESH_TTL_MS)
  const manualMinIntervalMs = Math.max(
    0,
    dependencies.manualMinIntervalMs ?? AGY_USAGE_MANUAL_MIN_INTERVAL_MS
  )
  const staleAfterMs = Math.max(0, dependencies.staleAfterMs ?? STALE_AFTER_MS)

  let cadenceIndex = 0
  let nextAutomaticAttemptAt = 0
  let lastAttemptAt: number | null = null
  let cached: CachedQuotaSnapshot | null = null
  let lastFailure: NormalizedProviderUsageSnapshot | null = null
  let inFlight: Promise<NormalizedProviderUsageSnapshot> | null = null

  const currentInterval = (): number => {
    if (refreshIntervals.length === 0) return 0
    return refreshIntervals[cadenceIndex % refreshIntervals.length]
  }

  return (options = {}) => {
    const readAt = now()
    if (inFlight) return inFlight

    if (options.force === true) {
      if (cached && readAt - cached.observedAt < freshTtlMs) {
        return Promise.resolve(cachedSnapshot(cached, readAt, staleAfterMs))
      }
      if (lastAttemptAt !== null && readAt - lastAttemptAt < manualMinIntervalMs) {
        return Promise.resolve(
          cached
            ? cachedSnapshot(cached, readAt, staleAfterMs)
            : (lastFailure ??
                fallbackUnavailable(
                  readAt,
                  'an agy /usage refresh ran recently; TaskWraith will retry automatically.'
                ))
        )
      }
    } else if (readAt < nextAutomaticAttemptAt) {
      return Promise.resolve(
        cached
          ? cachedSnapshot(cached, readAt, staleAfterMs)
          : (lastFailure ??
              fallbackUnavailable(
                readAt,
                'the first automatic agy /usage reading is still pending.'
              ))
      )
    }

    const request = (async (): Promise<NormalizedProviderUsageSnapshot> => {
      lastAttemptAt = readAt
      let snapshot: NormalizedProviderUsageSnapshot
      try {
        snapshot = await dependencies.fetchQuota()
      } catch {
        snapshot = fallbackUnavailable(now(), 'the official agy /usage session could not be read.')
      }

      const completedAt = now()
      if (snapshot.configured === false) {
        cached = null
        lastFailure = null
        nextAutomaticAttemptAt = 0
        return snapshot
      }
      if (hasQuotaWindows(snapshot)) {
        cached = { snapshot, observedAt: completedAt }
        lastFailure = null
        nextAutomaticAttemptAt = completedAt + currentInterval()
        cadenceIndex = refreshIntervals.length ? (cadenceIndex + 1) % refreshIntervals.length : 0
        return cachedSnapshot(cached, completedAt, staleAfterMs)
      }

      lastFailure = snapshot
      nextAutomaticAttemptAt = completedAt + currentInterval()
      return cached ? cachedSnapshot(cached, completedAt, staleAfterMs) : snapshot
    })()
    inFlight = request
    void request.finally(() => {
      if (inFlight === request) inFlight = null
    })
    return request
  }
}
