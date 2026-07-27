import type { UsageRecord } from '../../../main/store/types'

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

const usageRecordsCache = new Map<
  RendererUsageSource,
  { records: UsageRecord[]; loadedAt: number }
>()
const usageRecordsInFlight = new Map<RendererUsageSource, Promise<UsageRecord[]>>()

function loaderForUsageSource(
  source: RendererUsageSource,
  force: boolean
): (() => Promise<UsageRecord[]>) | null {
  if (typeof window === 'undefined') return null
  if (source === 'external' && typeof window.api.getExternalUsage === 'function') {
    // force propagates to the main process (bypasses its result cache and
    // re-stats the provider corpus) so a forced load keeps the manual ↻
    // refresh contract instead of silently serving main-side cache.
    return () => window.api.getExternalUsage(force ? { force: true } : undefined)
  }
  if (typeof window.api.getUsage === 'function') {
    return () => window.api.getUsage()
  }
  return null
}

export function getCachedRendererUsageRecords(source: RendererUsageSource): UsageRecord[] {
  return usageRecordsCache.get(source)?.records ?? []
}

export function setCachedRendererUsageRecords(
  source: RendererUsageSource,
  records: UsageRecord[],
  loadedAt = Date.now()
): void {
  usageRecordsCache.set(source, { records, loadedAt })
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

  const loader = loaderForUsageSource(source, options.force === true)
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
      .then((records) => {
        const normalized = Array.isArray(records) ? records : []
        // Keep a late-but-successful result for the next consumer even after
        // the current render escaped through its deadline fallback.
        setCachedRendererUsageRecords(source, normalized)
        finish(normalized)
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
