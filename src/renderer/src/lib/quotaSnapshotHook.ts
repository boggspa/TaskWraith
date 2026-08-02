import type { QuotaSnapshotHookSnapshot } from '../../../shared/quotaSnapshotHook'
import type { ModelUsageAggregate } from './usageAggregateTypes'

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
