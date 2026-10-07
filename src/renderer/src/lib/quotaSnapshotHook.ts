import {
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS,
  QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
  quotaSnapshotHookKey,
  type QuotaSnapshotHookSnapshot
} from '../../../shared/quotaSnapshotHook'
import type { ModelUsageAggregate } from './usageAggregateTypes'

const HOOK_PROVIDER_ORDER = new Map(
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS.map((provider, index) => [provider, index])
)

/** Re-derive staleness at serve time so a network reading held through an
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
 * Merge a fresh native read over the last-known snapshots, per provider.
 *
 * DeepSeek's balance call can be empty or late while offline, and the
 * renderer's one-second UI deadline can resolve to null. Without this merge a
 * transient miss would blank a last-known reading until the next poll.
 *
 * Semantics: a provider present in `fresh` always wins — measured truth, even
 * when its numbers went down or it became unconfigured. Only a provider absent
 * from the read falls back to its cached snapshot, with staleness re-derived.
 * `fresh: null` means the read never completed, so the whole cache is served.
 */
export function mergeQuotaSnapshotHookSnapshots(
  previous: ReadonlyArray<QuotaSnapshotHookSnapshot>,
  fresh: ReadonlyArray<QuotaSnapshotHookSnapshot> | null | undefined,
  now = Date.now()
): QuotaSnapshotHookSnapshot[] {
  // Keyed per provider AND account: a second Claude account is its own
  // last-known reading, never a replacement for the first one's.
  const merged = new Map<string, QuotaSnapshotHookSnapshot>()
  for (const snapshot of previous) {
    merged.set(quotaSnapshotHookKey(snapshot), withRecomputedStaleness(snapshot, now))
  }
  for (const snapshot of fresh ?? []) {
    merged.set(quotaSnapshotHookKey(snapshot), snapshot)
  }
  // Native lanes keep their canonical order; account snapshots trail them in
  // arrival order (the card re-sorts by provider for display anyway).
  const rank = (snapshot: QuotaSnapshotHookSnapshot): number =>
    HOOK_PROVIDER_ORDER.get(
      snapshot.provider as (typeof QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS)[number]
    ) ?? Number.MAX_SAFE_INTEGER
  return [...merged.values()].sort((left, right) => rank(left) - rank(right))
}

/**
 * Convert the main process's allowlisted native projection into the renderer's
 * existing quota aggregate. This function never accepts provider credentials
 * or raw responses; its input type is the credential-free shared schema.
 */
export function buildQuotaSnapshotHookAggregates(
  snapshots: ReadonlyArray<QuotaSnapshotHookSnapshot>
): ModelUsageAggregate[] {
  return snapshots.map((snapshot) => ({
    provider: snapshot.provider,
    model: 'usage limits',
    planName: snapshot.planType,
    ...(snapshot.accountId
      ? { accountId: snapshot.accountId, accountLabel: snapshot.accountLabel }
      : {}),
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
    quotaError: snapshot.error,
    quotaStale: snapshot.stale
  }))
}
