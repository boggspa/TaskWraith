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
