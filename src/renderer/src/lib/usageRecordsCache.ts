import type { UsageReadResult, UsageRecord } from '../../../main/store/types'

export type RendererUsageSource = 'taskwraith' | 'external'

const DEFAULT_MAX_AGE_MS: Record<RendererUsageSource, number> = {
  taskwraith: 30_000,
  // External history is expensive to assemble. Prefer a long renderer TTL so
  // welcome remounts / periodic UI ticks reuse the last payload while main
  // finishes progressive 14d→90d hydration.
  external: 30 * 60_000
}

// IPC should be a cache refresh, never a renderer liveness dependency. This
// is especially important for a released main process that is still draining
// an older external-history request: give the UI its cached/empty data back
// promptly and let a later push/retry replace it.
const USAGE_RECORDS_REQUEST_DEADLINE_MS = 1_000

interface CachedUsageRecords {
  records: UsageRecord[]
  loadedAt: number
  /**
   * Main's name for the history behind `records` (TaskWraith source only).
   * Sent back as `ifVersion` on the next expired load: when nothing moved,
   * main answers `unchanged` from a stat and the held array is kept as-is —
   * no 7.6MB clone across IPC, no re-parse, no new identity for consumers
   * that compare by reference. `null` means the next load is a full one.
   */
  version: string | null
}

const usageRecordsCache = new Map<RendererUsageSource, CachedUsageRecords>()
const usageRecordsInFlight = new Map<RendererUsageSource, Promise<UsageRecord[]>>()

type UsageLoad = { records: UsageRecord[]; version: string | null } | { unchanged: true }

function normalizeUsageLoad(result: UsageRecord[] | UsageReadResult | null | undefined): UsageLoad {
  if (Array.isArray(result)) return { records: result, version: null }
  if (!result || typeof result !== 'object') return { records: [], version: null }
  if ('unchanged' in result && result.unchanged === true) return { unchanged: true }
  const records = 'records' in result && Array.isArray(result.records) ? result.records : []
  const version = typeof result.version === 'string' && result.version ? result.version : null
  return { records, version }
}

function loaderForUsageSource(
  source: RendererUsageSource,
  force: boolean,
  heldVersion: string | null
): (() => Promise<UsageRecord[] | UsageReadResult>) | null {
  if (typeof window === 'undefined') return null
  if (source === 'external' && typeof window.api.getExternalUsage === 'function') {
    // force propagates to the main process (bypasses its result cache and
    // re-stats the provider corpus) so a forced load keeps the manual ↻
    // refresh contract instead of silently serving main-side cache.
    return () => window.api.getExternalUsage(force ? { force: true } : undefined)
  }
  if (typeof window.api.getUsage === 'function') {
    // A forced load never offers a version: the manual ↻ contract is a full
    // re-read, whatever main thinks it already told us.
    return () =>
      window.api.getUsage(undefined, undefined, { ifVersion: force ? null : heldVersion })
  }
  return null
}

export function getCachedRendererUsageRecords(source: RendererUsageSource): UsageRecord[] {
  return usageRecordsCache.get(source)?.records ?? []
}

/** Main's name for the cached TaskWraith history, or `null` when unknown. */
export function getCachedRendererUsageVersion(source: RendererUsageSource): string | null {
  return usageRecordsCache.get(source)?.version ?? null
}

export function setCachedRendererUsageRecords(
  source: RendererUsageSource,
  records: UsageRecord[],
  loadedAt = Date.now(),
  version: string | null = null
): void {
  usageRecordsCache.set(source, { records, loadedAt, version })
}

export function clearRendererUsageRecordsCache(): void {
  usageRecordsCache.clear()
  usageRecordsInFlight.clear()
}

/** Drop one source's cached payload so the next load re-pulls from main.
 * Used by the 'external-usage-updated' push: main's cache just upgraded
 * (14d partial → full 90d, or Cursor chunks landed), so the long external
 * TTL must not keep serving the stale short window. */
export function invalidateRendererUsageRecords(source: RendererUsageSource): void {
  usageRecordsCache.delete(source)
  usageRecordsInFlight.delete(source)
}

export function loadRendererUsageRecords(
  source: RendererUsageSource,
  options: { maxAgeMs?: number; force?: boolean } = {}
): Promise<UsageRecord[]> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS[source]
  const cached = usageRecordsCache.get(source)
  const now = Date.now()
  if (options.force !== true && cached && now - cached.loadedAt < maxAgeMs) {
    return Promise.resolve(cached.records)
  }

  const inFlight = usageRecordsInFlight.get(source)
  if (options.force !== true && inFlight) return inFlight

  const loader = loaderForUsageSource(source, options.force === true, cached?.version ?? null)
  if (!loader) return Promise.resolve(cached?.records ?? [])

  const fallback = cached?.records ?? []
  const request = Promise.resolve().then(loader)
  const visibleRequest = new Promise<UsageRecord[]>((resolve) => {
    let settled = false
    const finish = (records: UsageRecord[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(records)
    }
    const timeout = setTimeout(() => finish(fallback), USAGE_RECORDS_REQUEST_DEADLINE_MS)
    request
      .then((result) => {
        const load = normalizeUsageLoad(result)
        if ('unchanged' in load) {
          // Nothing moved since the version we offered: the held records are
          // still exact, so re-arm their TTL and keep their identity.
          const held = usageRecordsCache.get(source)
          const records = held?.records ?? fallback
          setCachedRendererUsageRecords(source, records, Date.now(), held?.version ?? null)
          finish(records)
          return
        }
        // Keep a late-but-successful result for the next consumer even after
        // the current render escaped through its deadline fallback.
        setCachedRendererUsageRecords(source, load.records, Date.now(), load.version)
        finish(load.records)
      })
      .catch(() => finish(fallback))
  })
  const trackedRequest = visibleRequest.finally(() => {
    if (usageRecordsInFlight.get(source) === trackedRequest) {
      usageRecordsInFlight.delete(source)
    }
  })
  usageRecordsInFlight.set(source, trackedRequest)
  return trackedRequest
}
