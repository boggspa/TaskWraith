import type { UsageRecord } from './types'

/**
 * Retention window for the hot usage.json file. Records older than this are
 * rotated to the append-only usage-archive.jsonl on write.
 *
 * usage.json is synchronously read-modify-rewritten (with fsync) on EVERY
 * turn completion — and once per participant per ensemble round — so its
 * size is a direct, ever-growing tax on the main process. Rotation bounds
 * that cost without deleting history.
 *
 * 200 days is a deliberate safety margin over the LONGEST window any live
 * reader requests: the UI usage surfaces top out at 90d, and
 * buildDailyTokenSeries clamps dayCount to 180 (DailyTokenSeries.ts) — the
 * retention floor is therefore 180d, and rotation must never shrink what a
 * live surface can display.
 */
export const USAGE_ROTATION_RETENTION_MS = 200 * 24 * 60 * 60 * 1000

export function partitionUsageRecordsForRotation(
  records: UsageRecord[],
  nowMs: number
): { keep: UsageRecord[]; rotate: UsageRecord[] } {
  const cutoff = nowMs - USAGE_ROTATION_RETENTION_MS
  const keep: UsageRecord[] = []
  const rotate: UsageRecord[] = []
  for (const record of records) {
    // Records with unparseable timestamps are kept in the hot file — never
    // rotate what we cannot prove is old.
    if (Number.isFinite(record?.timestamp) && record.timestamp < cutoff) {
      rotate.push(record)
    } else {
      keep.push(record)
    }
  }
  return { keep, rotate }
}
