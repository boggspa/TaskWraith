import {
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS,
  QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
  type QuotaSnapshotHookSnapshot
} from '../../../shared/quotaSnapshotHook'
import type { ModelUsageAggregate } from './usageAggregateTypes'

const HOOK_PROVIDER_ORDER = new Map(
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS.map((provider, index) => [provider, index])
)

/** A cached reading keeps the `stale` flag the parser stamped when it was
 * decoded; re-derive it at serve time so a reading held through a long read
 * outage cannot keep presenting itself as current. */
function withRecomputedStaleness(
  snapshot: QuotaSnapshotHookSnapshot,
  now: number
): QuotaSnapshotHookSnapshot {
  const fetchedAtMs = Date.parse(snapshot.fetchedAt)
  const stale =
    snapshot.stale ||
    !Number.isFinite(fetchedAtMs) ||
    now - fetchedAtMs > QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS
  return stale === snapshot.stale ? snapshot : { ...snapshot, stale }
}

/**
 * Merge a fresh hook read over the last-known snapshots, per provider.
 *
 * The Limit Counter lane is the only quota source without a keep-last-known
 * cache behind it: the helper cache is re-read (via plutil) on every refresh,
 * and any one read can come back empty or late — a torn plist write while the
 * helper refetches a provider, a plutil hiccup, or the renderer's 1s UI
 * deadline resolving to null. Without this merge each of those blanked the
 * AntiGravity/DeepSeek/Cerebras/Meta meters until the next successful poll.
 *
 * Semantics: a provider present in `fresh` always wins — measured truth, even
 * when its numbers went down (cycle resets do that). Only a provider absent
 * from the read falls back to its cached snapshot, with staleness re-derived.
 * `fresh: null` means the read never completed, so the whole cache is served.
 */
export function mergeQuotaSnapshotHookSnapshots(
  previous: ReadonlyArray<QuotaSnapshotHookSnapshot>,
  fresh: ReadonlyArray<QuotaSnapshotHookSnapshot> | null | undefined,
  now = Date.now()
): QuotaSnapshotHookSnapshot[] {
  const merged = new Map<QuotaSnapshotHookSnapshot['provider'], QuotaSnapshotHookSnapshot>()
  for (const snapshot of previous) {
    merged.set(snapshot.provider, withRecomputedStaleness(snapshot, now))
  }
  for (const snapshot of fresh ?? []) {
    merged.set(snapshot.provider, snapshot)
  }
  return [...merged.values()].sort(
    (left, right) =>
      (HOOK_PROVIDER_ORDER.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
      (HOOK_PROVIDER_ORDER.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
  )
}

/**
 * Convert the main process's allowlisted helper projection into the renderer's
 * existing quota aggregate. This function never accepts provider credentials
 * or raw responses; its input type is the credential-free shared hook schema.
 */
export function buildQuotaSnapshotHookAggregates(
  snapshots: ReadonlyArray<QuotaSnapshotHookSnapshot>
): ModelUsageAggregate[] {
  return snapshots.map((snapshot) => ({
    provider: snapshot.provider,
    model: 'usage limits',
    planName: snapshot.planType,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    windows: snapshot.windows.map((windowEntry) => ({
      id: windowEntry.id,
      label: windowEntry.label,
      runs: 0,
      totalTokens: 0,
      limitLabel: windowEntry.limitLabel,
      resetAt: windowEntry.resetAt,
      trackingOnly: false,
      usedPercent: windowEntry.usedPercent,
      remainingPercent: windowEntry.remainingPercent,
      limitWindowSeconds: windowEntry.limitWindowSeconds,
      valueText: windowEntry.valueText,
      unit: windowEntry.unit,
      windowKind: windowEntry.windowKind
    })),
    balances: snapshot.balances.map((balance) => ({
      id: balance.id,
      label: balance.label,
      amount: balance.amount,
      unit: balance.unit,
      subtitle: balance.subtitle,
      resetAt: balance.resetAt
    })),
    quotaSource: snapshot.source,
    quotaFetchedAt: snapshot.fetchedAt,
    quotaConfigured: snapshot.configured,
    quotaStale: snapshot.stale
  }))
}
