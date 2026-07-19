/**
 * Provider usage fields are persisted in several historical shapes. Keep the
 * cache-subset semantics in one node/browser-safe module so old run stats are
 * interpreted consistently by main, renderer, and remote projections.
 */

function usageRecord(stats: unknown): Record<string, unknown> | null {
  return stats && typeof stats === 'object' && !Array.isArray(stats)
    ? (stats as Record<string, unknown>)
    : null
}

function positiveUsageNumber(stats: unknown, key: string): number {
  const record = usageRecord(stats)
  if (!record) return 0
  const value = record[key]
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function maxUsageAlias(stats: unknown, keys: string[]): number {
  return keys.reduce((largest, key) => Math.max(largest, positiveUsageNumber(stats, key)), 0)
}

/**
 * True when the provider-reported input count already contains cache tokens.
 *
 * `_agentbench_input_includes_cache` predates the TaskWraith rename. Codex /
 * OpenAI `cachedInputTokens` and `cached_input_tokens` are subsets of reported
 * input even on historical rows that have neither marker.
 */
export function usageInputIncludesCache(stats: unknown): boolean {
  const record = usageRecord(stats)
  if (!record) return false
  return (
    record._taskwraith_input_includes_cache === true ||
    record._agentbench_input_includes_cache === true ||
    positiveUsageNumber(record, 'cachedInputTokens') > 0 ||
    positiveUsageNumber(record, 'cached_input_tokens') > 0
  )
}

/** Cache-read aliases describe the same counter, so they are never additive. */
export function usageCacheReadInputTokens(stats: unknown): number {
  return maxUsageAlias(stats, [
    'cacheReadInputTokens',
    'cache_read_input_tokens',
    'input_cache_read',
    'cacheReadTokens',
    'cachedInputTokens',
    'cached_input_tokens'
  ])
}

/** Cache-creation/write aliases describe the same counter, so take the max. */
export function usageCacheCreationInputTokens(stats: unknown): number {
  return maxUsageAlias(stats, [
    'cacheCreationInputTokens',
    'cache_creation_input_tokens',
    'input_cache_creation',
    'cacheWriteTokens',
    'cache_write_tokens'
  ])
}

// ── External Activity window semantics ──────────────────────────────────────
// The External Activity header chips and the rollup sent to paired devices are
// computed by two separate implementations — `buildHeatmapGrid` in the renderer
// and `buildExternalUsageRollup` in main. They used different token formulas
// and different 90-day boundaries (calendar-aligned vs rolling), so a desktop
// header and a paired iOS device disagreed by construction. These are the
// single definition both now use.

export interface ExternalActivityTokenRecord {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

/**
 * Tokens attributed to one external-activity record.
 *
 * `totalTokens` is authoritative when a parser set it. The component fallback
 * exists for rows that carry a breakdown but no total; activity-only markers
 * (Cursor buckets, Codex SQLite markers) legitimately sum to zero and stay
 * zero, so they colour a cell without inventing spend.
 */
export function externalActivityRecordTokens(record: ExternalActivityTokenRecord): number {
  const total = Number(record.totalTokens)
  if (Number.isFinite(total) && total > 0) return total
  const parts =
    Number(record.inputTokens || 0) +
    Number(record.cacheReadInputTokens || 0) +
    Number(record.cacheCreationInputTokens || 0) +
    Number(record.outputTokens || 0)
  return Number.isFinite(parts) && parts > 0 ? parts : 0
}

/**
 * Bounds of the External Activity window: `dayCount` LOCAL CALENDAR days
 * ending at the last millisecond of today.
 *
 * Calendar-aligned rather than rolling, because the heatmap draws whole day
 * columns — a rolling cutoff would slice the oldest column part-way through
 * and make the header total disagree with the tiles beneath it.
 */
export function externalActivityWindowBounds(
  now: Date,
  dayCount: number
): { startMs: number; endMs: number } {
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  const startOfWindow = new Date(endOfDay)
  startOfWindow.setDate(startOfWindow.getDate() - (Math.max(1, Math.round(dayCount)) - 1))
  startOfWindow.setHours(0, 0, 0, 0)
  return { startMs: startOfWindow.getTime(), endMs: endOfDay.getTime() }
}
