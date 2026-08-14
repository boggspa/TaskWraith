import type { UsageRecord } from '../main/store/types'
import { externalActivityRecordTokens } from './usageAccounting'

/**
 * Time-bucket aggregation for EXTERNAL provider usage records.
 *
 * The external 90-day scan produces one UsageRecord per provider turn — over
 * 1.4M records on a busy machine (measured 2026-07-24: 1,418,685 events,
 * ~470MB of cache). That entire array used to cross every process boundary
 * verbatim: worker→main postMessage, main→renderer IPC serialize, and the
 * contextBridge deep-copy into the isolated world — the last one walks every
 * property of every record ON THE RENDERER MAIN THREAD. At current corpus
 * size that is tens of seconds of hard block per pull, re-triggered by each
 * 'external-usage-updated' upgrade ping at launch, with multi-GB renderer
 * heap churn on top: the launch beachball that never recovers.
 *
 * No consumer needs turn granularity. The welcome heatmap buckets by local
 * day, the token chart by local day, the model-usage table by rolling window
 * (finest: 1h), and the rollup chips by 24h/7d/90d. So collapse records into
 * wall-clock buckets before they leave the scan:
 *
 *   - records newer than {@link EXTERNAL_USAGE_MINUTE_BUCKET_WINDOW_MS}
 *     (48h) → LOCAL-MINUTE buckets, so the live "1h"/"24h" meters stay exact
 *     to within one minute;
 *   - older records → LOCAL-HOUR buckets; every consumer at that age
 *     aggregates by day or by ≥7d rolling window, where a ≤1h boundary drift
 *     is invisible.
 *
 * Both bucket kinds are keyed by LOCAL wall-clock fields, so a bucket never
 * straddles a local calendar day and day-bucketed surfaces (heatmap, charts,
 * month-to-date spend) are bit-identical to the unaggregated result.
 * Measured on the live corpus: 1.42M events → ~3.1k hour buckets + recent
 * minute buckets, a ~2-orders-of-magnitude payload reduction.
 *
 * Displayed run/event counts survive via `runCount`: each bucket carries how
 * many source records it absorbed, and count consumers add `runCount ?? 1`
 * instead of 1 per record (see {@link usageRecordRunCount}).
 */

export const EXTERNAL_USAGE_MINUTE_BUCKET_WINDOW_MS = 48 * 60 * 60 * 1000

/** Number of source records an aggregated record stands for. Count consumers
 * (model-usage table "runs", spend-card runs, heatmap eventCount) must use
 * this instead of counting records. */
export function usageRecordRunCount(record: Pick<UsageRecord, 'runCount'>): number {
  const value = record.runCount
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1
}

/** Start of the local-minute (recent) or local-hour (older) bucket containing
 * `timestamp`. Local-field construction keeps buckets inside one local day. */
export function externalUsageBucketStartMs(timestamp: number, nowMs: number): number {
  const date = new Date(timestamp)
  const recent = nowMs - timestamp <= EXTERNAL_USAGE_MINUTE_BUCKET_WINDOW_MS
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    recent ? date.getMinutes() : 0
  ).getTime()
}

/** FNV-1a over the bucket key — stable across scans so React keys and cache
 * comparisons don't churn when the same corpus re-aggregates. */
function bucketHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

interface BucketAccumulator {
  first: UsageRecord
  bucketStart: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  durationMs: number
  runCount: number
}

export interface ExternalUsageMonotonicMergeOptions {
  /** Inclusive retention bounds. Records outside them are deliberately
   * forgotten even when they exist only in the retained snapshot. */
  startMs?: number
  endMs?: number
}

function externalUsageBucketKey(record: UsageRecord, nowMs: number): string | null {
  if ((record.usageKind ?? 'run') !== 'run' || !Number.isFinite(record.timestamp)) return null
  const effectiveTokens = externalActivityRecordTokens(record)
  const bucketStart = externalUsageBucketStartMs(record.timestamp, nowMs)
  return [
    record.provider ?? '',
    record.model ?? '',
    record.costRateModel || record.model || '',
    record.workspaceId ?? '',
    record.chatId ?? '',
    record.runId ?? '',
    effectiveTokens > 0 ? 't' : 'z',
    bucketStart
  ].join('|')
}

/**
 * Streaming form of {@link aggregateExternalUsageRecords}. External activity
 * scans can encounter more than a million provider turns, so callers must be
 * able to fold one record at a time without retaining that raw corpus in
 * memory. `finish()` returns the same stable, newest-first representation as
 * the array helper below.
 */
export class ExternalUsageBucketAccumulator {
  private readonly passthrough: UsageRecord[] = []
  private readonly buckets = new Map<string, BucketAccumulator>()

  constructor(private readonly nowMs: number) {}

  add(record: UsageRecord): void {
    if (!record) return
    const key = externalUsageBucketKey(record, this.nowMs)
    if (!key) {
      this.passthrough.push(record)
      return
    }
    const effectiveTokens = externalActivityRecordTokens(record)
    const bucketStart = externalUsageBucketStartMs(record.timestamp, this.nowMs)

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = {
        first: record,
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        runCount: 0
      }
      this.buckets.set(key, bucket)
    }
    bucket.inputTokens += Math.max(0, record.inputTokens || 0)
    bucket.outputTokens += Math.max(0, record.outputTokens || 0)
    bucket.totalTokens += effectiveTokens
    bucket.cacheReadInputTokens += Math.max(0, record.cacheReadInputTokens || 0)
    bucket.cacheCreationInputTokens += Math.max(0, record.cacheCreationInputTokens || 0)
    bucket.durationMs += Math.max(0, record.durationMs || 0)
    bucket.runCount += usageRecordRunCount(record)
  }

  finish(): UsageRecord[] {
    const aggregated: UsageRecord[] = [...this.passthrough]
    for (const [key, bucket] of this.buckets) {
      aggregated.push({
        ...bucket.first,
        id: `external-agg-${bucket.first.provider ?? 'unknown'}-${bucketHash(key)}`,
        timestamp: bucket.bucketStart,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        totalTokens: bucket.totalTokens,
        ...(bucket.cacheReadInputTokens > 0
          ? { cacheReadInputTokens: bucket.cacheReadInputTokens }
          : {}),
        ...(bucket.cacheCreationInputTokens > 0
          ? { cacheCreationInputTokens: bucket.cacheCreationInputTokens }
          : {}),
        durationMs: bucket.durationMs,
        runCount: bucket.runCount
      })
    }

    return aggregated.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1))
  }
}

/**
 * Collapse external usage records into wall-clock buckets per
 * (provider, display model, effective cost-rate model, synthetic ids,
 * zero-marker flag).
 *
 * Contract notes:
 * - `totalTokens` accumulates the EFFECTIVE per-record value
 *   ({@link externalActivityRecordTokens}), not the raw field: a record with
 *   totalTokens 0 but a component breakdown counts via its parts fallback,
 *   and folding that into the bucket's totalTokens keeps every downstream
 *   "totalTokens || parts" formula equal to the per-record aggregate.
 * - Zero-signal marker rows (0 effective tokens — Cursor daily-stat rows,
 *   Codex SQLite markers) bucket SEPARATELY from token-bearing rows so the
 *   model-usage table's zero-token skip still excludes exactly the marker
 *   population while the heatmap still gets their eventCount.
 * - Records that are not plain 'run' usage (reset_hint) or carry a non-finite
 *   timestamp pass through untouched.
 * - Bucket records copy the first constituent's identity fields, so the
 *   constant synthetic external ids (workspaceId 'external', chatId/runId
 *   'external-<provider>') survive as-is.
 * - Aggregating is idempotent: re-running over already-bucketed records
 *   regroups them into the same buckets with the same sums.
 */
export function aggregateExternalUsageRecords(
  records: UsageRecord[],
  nowMs: number
): UsageRecord[] {
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  for (const record of records) accumulator.add(record)
  return accumulator.finish()
}

/**
 * Merge a completed scan over the retained external-usage snapshot without
 * adding the same bucket twice or allowing a sparse scan to shrink history.
 *
 * Both inputs are independently re-bucketed against the current clock first.
 * That matters at the 48-hour granularity boundary: yesterday's snapshot may
 * still contain minute buckets that today's scan correctly represents as one
 * hour bucket. Concatenating and aggregating would double-count them.
 *
 * For each canonical provider/model/time bucket:
 * - a missing bucket is filled from whichever side has it;
 * - a larger token total replaces a smaller one;
 * - a smaller or zero total cannot erase a populated total;
 * - run count and duration remain monotonic;
 * - repeated merges are idempotent, never additive.
 *
 * Zero-token activity markers retain their own bucket identity, matching the
 * ordinary external aggregation contract. They can colour a heatmap cell but
 * cannot collide with, or replace, a token-bearing bucket.
 */
export function mergeExternalUsageRecordsMonotonically(
  retainedRecords: UsageRecord[],
  scannedRecords: UsageRecord[],
  nowMs: number,
  options: ExternalUsageMonotonicMergeOptions = {}
): UsageRecord[] {
  const inRetentionWindow = (record: UsageRecord): boolean => {
    if (!Number.isFinite(record.timestamp)) return false
    if (options.startMs !== undefined && record.timestamp < options.startMs) return false
    if (options.endMs !== undefined && record.timestamp > options.endMs) return false
    return true
  }
  const canonicalRetained = aggregateExternalUsageRecords(retainedRecords, nowMs).filter(
    inRetentionWindow
  )
  const canonicalScanned = aggregateExternalUsageRecords(scannedRecords, nowMs).filter(
    inRetentionWindow
  )
  const merged = new Map<string, UsageRecord>()

  const keyFor = (record: UsageRecord): string =>
    externalUsageBucketKey(record, nowMs) ?? `passthrough|${record.usageKind ?? 'run'}|${record.id}`

  for (const record of canonicalRetained) merged.set(keyFor(record), record)
  for (const incoming of canonicalScanned) {
    const key = keyFor(incoming)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, incoming)
      continue
    }
    const existingTokens = externalActivityRecordTokens(existing)
    const incomingTokens = externalActivityRecordTokens(incoming)
    const stronger = incomingTokens >= existingTokens ? incoming : existing
    merged.set(key, {
      ...stronger,
      durationMs: Math.max(existing.durationMs || 0, incoming.durationMs || 0),
      runCount: Math.max(usageRecordRunCount(existing), usageRecordRunCount(incoming))
    })
  }

  return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1))
}
