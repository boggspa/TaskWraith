import type { ProviderId } from '../../../main/store/types'
import type { QuotaSnapshotHookProviderId } from '../../../shared/quotaSnapshotHook'

/**
 * Provider identities that can appear on the display-only Model Usage surface.
 * DeepSeek and Cerebras are Pi upstream billing meters, not TaskWraith runtime
 * seats, so they deliberately do not widen the governed ProviderId union.
 */
export type ModelUsageProviderId = ProviderId | QuotaSnapshotHookProviderId

// Phase L6 slice 1 — exported so `ModelUsageCard` (and the related
// per-provider block + heatmap) can type their props off the same
// shapes that App.tsx already produces in `refreshUsageSummary`.
// No data-shape changes; just visibility for sibling components.
//
// Phase L6 slice 2 — `planName` added as an optional tier-badge
// string (e.g. "Pro", "Max x5", "Moderato", "Google Account"). The
// `refreshUsageSummary` codepath leaves it `undefined` for now;
// per-provider subscription detection lands in a follow-up. The
// ModelUsageCard renders the badge pill only when this field is
// present + non-empty, so undefined values are visually inert.
export interface ModelUsageAggregate {
  provider: ModelUsageProviderId
  model: string
  planName?: string
  runs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  totalTokenLimit?: number
  resetAt?: string
  resetText?: string
  windows?: UsageWindowAggregate[]
  balances?: UsageBalanceAggregate[]
  quotaSource?: string
  quotaFetchedAt?: string
  quotaConfigured?: boolean
  quotaError?: string
  quotaStale?: boolean
}

export interface UsageWindowAggregate {
  id: string
  label: string
  runs: number
  totalTokens: number
  runLimitMax?: number
  limitLabel: string
  resetAt?: string
  trackingOnly?: boolean
  usedPercent?: number
  remainingPercent?: number
  limitWindowSeconds?: number
  valueText?: string
  unit?: string
  windowKind?: string
}

export interface UsageBalanceAggregate {
  id: string
  label: string
  amount: number
  unit: string
  subtitle?: string
  resetAt?: string
}
