/**
 * Pure policy helpers for provider quota snapshot serving.
 *
 * Cold launch used to await live provider quota RPCs (and, for Cursor, a
 * fallback full-copy of the editor's multi-GB state.vscdb when sqlite was
 * locked). That hung main until every network/sqlite path finished.
 *
 * These helpers decide when to:
 *   - return a still-fresh in-memory snapshot,
 *   - serve a stale in-memory / disk snapshot immediately and revalidate in
 *     the background, or
 *   - block on a live fetch (no cache, or explicit force).
 *
 * They also gate the Cursor sqlite temp-copy fallback so a multi-GB editor
 * DB can never be copied on the launch path.
 */

export type UsageServeDecision =
  | { action: 'return-fresh' }
  | { action: 'return-stale-and-revalidate' }
  | { action: 'fetch-live' }

export interface UsageServeInput {
  force?: boolean
  nowMs: number
  memoryFetchedAtMs: number | null
  freshTtlMs: number
  staleTtlMs: number
  /** True when in-memory cache holds usable windows/balances. */
  hasMemoryContent: boolean
  /** True when the durable provider-usage-snapshots.json entry has content. */
  hasPersistedContent: boolean
}

/**
 * Decide how a quota IPC should respond for this call.
 *
 * - force → always live (manual ↻).
 * - memory within fresh TTL → return memory, no revalidate.
 * - memory or disk has content within the stale window → return stale now,
 *   revalidate in background so launch never waits on network/sqlite.
 * - otherwise → live fetch (true cold / no cache).
 */
export function decideUsageSnapshotServe(input: UsageServeInput): UsageServeDecision {
  if (input.force) return { action: 'fetch-live' }

  const fetchedAt = input.memoryFetchedAtMs
  const hasMemoryAge = typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)
  const ageMs = hasMemoryAge ? input.nowMs - (fetchedAt as number) : null

  if (input.hasMemoryContent && ageMs !== null && ageMs >= 0 && ageMs < input.freshTtlMs) {
    return { action: 'return-fresh' }
  }

  if (input.hasMemoryContent && ageMs !== null && ageMs >= 0 && ageMs < input.staleTtlMs) {
    return { action: 'return-stale-and-revalidate' }
  }

  if (input.hasPersistedContent) {
    return { action: 'return-stale-and-revalidate' }
  }

  return { action: 'fetch-live' }
}

/** Never full-copy the Cursor editor state DB above this size. */
export const CURSOR_SQLITE_MAX_COPY_BYTES = 64 * 1024 * 1024

/**
 * The launch-time Cursor usage fallback used to `fs.copyFile` the entire
 * state.vscdb when sqlite returned locked. Real installs commonly hold multi-GB
 * DBs there; a copy freezes main for the duration. Only tiny DBs may still use
 * the temp-copy recovery path.
 */
export function shouldCopyCursorStateDbForUsage(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= CURSOR_SQLITE_MAX_COPY_BYTES
  )
}
