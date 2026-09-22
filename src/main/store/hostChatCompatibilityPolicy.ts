/**
 * Policy for full-record Host compatibility checkpoints of a streaming chat.
 *
 * WHY THIS EXISTS: every save stages the whole record as a latest-wins
 * compatibility checkpoint, and the coordinator publishes a successor the
 * instant its predecessor is acknowledged when one was requested while the
 * predecessor was in flight. Paced only by the Host round trip (~0.4 s), one
 * streaming Ensemble thread produced 1998 full 23 MB `thread.record.persist`
 * transfers in 4.8 hours (~45 GB of artifact bytes, one structured clone of
 * the whole record on the Electron main thread per transfer) for roughly
 * 200 KB of new transcript every four minutes. The incremental journal is the
 * durability authority and already carries every mutation, so the successor
 * can wait: this module holds the minimum wall time between two chained
 * checkpoints for one chat.
 *
 * WHAT NEVER WAITS: explicit durability barriers (`awaitChatRecordPersisted`),
 * delete preparation, the shutdown drain, creation, the journal-failure and
 * externalization-failure fallbacks, and `history-deletion` flushes. The
 * interval only spaces the coordinator's chained successors.
 */

/** Minimum wall time between two chained full-record checkpoints for one chat. */
export const HOST_MATERIALIZE_MIN_INTERVAL_MS = 30_000

/**
 * Upper bound on the interval an environment override may set. A typo in a
 * field-triage override must not leave external readers of the compatibility
 * record (bridge, iOS, the Host's own catalogue) stale for an hour.
 */
export const HOST_MATERIALIZE_MAX_INTERVAL_MS = 10 * 60_000

/**
 * Environment override, read once when the coordinator is constructed, for
 * field triage without a rebuild. `0` disables the interval; a value that is
 * not a finite non-negative number falls back to the default.
 */
export const HOST_MATERIALIZE_MIN_INTERVAL_ENV = 'TASKWRAITH_HOST_MATERIALIZE_MIN_INTERVAL_MS'

export function resolveHostMaterializeMinIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[HOST_MATERIALIZE_MIN_INTERVAL_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') return HOST_MATERIALIZE_MIN_INTERVAL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return HOST_MATERIALIZE_MIN_INTERVAL_MS
  return Math.min(Math.floor(parsed), HOST_MATERIALIZE_MAX_INTERVAL_MS)
}
