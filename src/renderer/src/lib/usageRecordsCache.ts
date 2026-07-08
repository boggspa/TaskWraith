import type { UsageRecord } from '../../../main/store/types'

export type RendererUsageSource = 'taskwraith' | 'external'

const DEFAULT_MAX_AGE_MS: Record<RendererUsageSource, number> = {
  taskwraith: 30_000,
  external: 5 * 60_000
}

const usageRecordsCache = new Map<
  RendererUsageSource,
  { records: UsageRecord[]; loadedAt: number }
>()
const usageRecordsInFlight = new Map<RendererUsageSource, Promise<UsageRecord[]>>()

function loaderForUsageSource(source: RendererUsageSource): (() => Promise<UsageRecord[]>) | null {
  if (typeof window === 'undefined') return null
  if (source === 'external' && typeof window.api.getExternalUsage === 'function') {
    return () => window.api.getExternalUsage()
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

  const loader = loaderForUsageSource(source)
  if (!loader) return Promise.resolve(cached?.records ?? [])

  const request = loader()
    .then((records) => {
      const normalized = Array.isArray(records) ? records : []
      setCachedRendererUsageRecords(source, normalized)
      return normalized
    })
    .finally(() => {
      if (usageRecordsInFlight.get(source) === request) {
        usageRecordsInFlight.delete(source)
      }
    })
  usageRecordsInFlight.set(source, request)
  return request
}
