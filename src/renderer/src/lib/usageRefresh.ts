// Helpers for the sidebar "MODEL USAGE" background refresh loop. Pulled out
// of App.tsx so the cheap "did the usage payload change?" check is unit
// testable without a full React render. The companion refresh effect calls
// these helpers, but the loop itself lives in App.tsx because it needs to
// invoke the existing `refreshUsageSummary` closure.

import type { ModelUsageProviderId } from './usageAggregateTypes'

export interface UsageSummaryLike {
  provider: ModelUsageProviderId
  model: string
  planName?: string
  runs?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  durationMs?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  totalTokenLimit?: number
  resetAt?: string
  resetText?: string
  windows?: Array<{
    id: string
    label: string
    limitLabel: string
    runs?: number
    totalTokens?: number
    runLimitMax?: number
    resetAt?: string
    trackingOnly?: boolean
    usedPercent?: number
    remainingPercent?: number
    limitWindowSeconds?: number
    valueText?: string
    unit?: string
    windowKind?: string
  }>
  balances?: Array<{
    id: string
    label: string
    amount: number
    unit: string
    subtitle?: string
    resetAt?: string
  }>
  quotaSource?: string
  quotaFetchedAt?: string
  quotaConfigured?: boolean
  quotaError?: string
  quotaStale?: boolean
}

/**
 * Produce a stable fingerprint of the semantic usage-summary payload. The
 * provider snapshots stamp every successful response with a new
 * `quotaFetchedAt`; that transport metadata is intentionally excluded so an
 * unchanged heartbeat cannot invalidate the root React tree. A manual refresh
 * may still publish the fresh timestamp explicitly.
 */
export function fingerprintUsageSummary(summary: ReadonlyArray<UsageSummaryLike>): string {
  const ordered = summary.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    planName: entry.planName || '',
    runs: entry.runs ?? 0,
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    totalTokens: entry.totalTokens ?? 0,
    durationMs: entry.durationMs ?? 0,
    inputTokenLimit: entry.inputTokenLimit ?? null,
    outputTokenLimit: entry.outputTokenLimit ?? null,
    totalTokenLimit: entry.totalTokenLimit ?? null,
    resetAt: entry.resetAt || '',
    resetText: entry.resetText || '',
    windows: (entry.windows || []).map((windowEntry) => ({
      id: windowEntry.id,
      label: windowEntry.label,
      limitLabel: windowEntry.limitLabel,
      runs: windowEntry.runs ?? 0,
      totalTokens: windowEntry.totalTokens ?? 0,
      runLimitMax: windowEntry.runLimitMax ?? null,
      resetAt: windowEntry.resetAt || '',
      trackingOnly: windowEntry.trackingOnly ?? null,
      usedPercent: windowEntry.usedPercent ?? null,
      remainingPercent: windowEntry.remainingPercent ?? null,
      limitWindowSeconds: windowEntry.limitWindowSeconds ?? null,
      valueText: windowEntry.valueText || '',
      unit: windowEntry.unit || '',
      windowKind: windowEntry.windowKind || ''
    })),
    balances: (entry.balances || []).map((balance) => ({
      id: balance.id,
      label: balance.label,
      amount: balance.amount,
      unit: balance.unit,
      subtitle: balance.subtitle || '',
      resetAt: balance.resetAt || ''
    })),
    quotaSource: entry.quotaSource || '',
    quotaConfigured: entry.quotaConfigured ?? null,
    quotaError: entry.quotaError || '',
    quotaStale: entry.quotaStale ?? false
  }))
  return JSON.stringify(ordered)
}

/**
 * Returns true when the new payload differs from the previous one in a way
 * the sidebar would actually render. Used by the autonomous refresh loop to
 * avoid re-rendering when the provider snapshots came back identical.
 */
export function hasUsageSummaryChanged(
  prev: ReadonlyArray<UsageSummaryLike>,
  next: ReadonlyArray<UsageSummaryLike>
): boolean {
  return fingerprintUsageSummary(prev) !== fingerprintUsageSummary(next)
}

/**
 * A UI deadline miss is not a provider tombstone. Keep the complete last
 * structured snapshot so transient timeout fallbacks cannot erase metadata
 * while the underlying provider read continues in the background.
 */
export function retainQuotaSnapshotOnDeadlineMiss<T extends object>(
  previous: T | null | undefined,
  candidate: T | null | undefined
): T | null {
  if (candidate !== null && candidate !== undefined && typeof candidate === 'object') {
    return candidate
  }
  return previous ?? null
}

export interface UsageRecordsRefreshInput {
  /** The caller only needs live provider quota/balance telemetry. */
  quotaOnly: boolean
  /** At least one full usage-record load has completed in this renderer. */
  recordsInitialized: boolean
}

/**
 * The quota heartbeat reuses the last run aggregates after initial hydration.
 * Full/manual/post-run refreshes still load records, and a quota-only request
 * safely falls back to a full load when it happens before initialization.
 */
export function shouldLoadUsageRecords(input: UsageRecordsRefreshInput): boolean {
  return !input.quotaOnly || !input.recordsInitialized
}

export interface UsageRefreshDecisionInput {
  /** Wall-clock ms since the last refresh kicked off; null/undefined when no prior run. */
  msSinceLastRefresh: number | null | undefined
  /** Refresh cadence in ms (e.g. 90_000). */
  intervalMs: number
  /** A previous refresh is still in flight. */
  inFlight: boolean
  /** The Electron window is currently focused. */
  windowFocused: boolean
  /** `navigator.onLine` value. */
  online: boolean
}

/**
 * Decide whether the autonomous refresh loop should fire right now. Pure
 * function so the policy can be unit-tested without setting up timers.
 *
 * The loop skips when:
 *   - a previous request is still in flight (avoid hammering IPC);
 *   - the window is blurred (no one is watching);
 *   - the user is offline (the data would be stale anyway);
 *   - too little wall-clock time has elapsed since the last attempt
 *     (cheap guard against jittery `setInterval` + focus-resume races).
 */
export function shouldRunUsageRefresh(input: UsageRefreshDecisionInput): boolean {
  if (input.inFlight) return false
  if (!input.windowFocused) return false
  if (!input.online) return false
  if (input.msSinceLastRefresh !== null && input.msSinceLastRefresh !== undefined) {
    // Guard against the focus-resume path racing the heartbeat fire — only
    // skip if we *just* refreshed. We still want hand-rolled focus refreshes
    // to win when they precede the interval tick.
    if (input.msSinceLastRefresh < Math.min(intervalFloor(input.intervalMs), 5_000)) {
      return false
    }
  }
  return true
}

function intervalFloor(intervalMs: number): number {
  // Allow at most one in-flight refresh per ~third of the cadence so a
  // focus-resume immediately after a heartbeat doesn't double-fire.
  return Math.max(1_000, Math.floor(intervalMs / 3))
}
