/**
 * TaskWraith-owned supplemental quota snapshots for providers that are not
 * first-class TaskWraith seat ids. The contract carries only display-ready
 * fields; credentials, raw responses, paths, and account identifiers never
 * cross the main-process boundary.
 */

export const QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS = ['deepseek', 'cerebras', 'meta'] as const

export type QuotaSnapshotHookProviderId = (typeof QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS)[number]

/** How old a provider reading may get before it must be flagged stale. The
 * main process stamps network readings, and the renderer re-derives the flag
 * while serving a last-known snapshot through a transient outage. */
export const QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS = 30 * 60 * 1000

export interface QuotaSnapshotHookWindow {
  id: string
  label: string
  usedPercent: number
  remainingPercent: number
  limitLabel: string
  valueText?: string
  resetAt?: string
  unit?: string
  windowKind?: string
  limitWindowSeconds?: number
}

export interface QuotaSnapshotHookBalance {
  id: string
  label: string
  amount: number
  unit: string
  subtitle?: string
  resetAt?: string
}

export interface QuotaSnapshotHookSnapshot {
  provider: QuotaSnapshotHookProviderId
  source: 'taskwraith-native'
  configured: boolean
  fetchedAt: string
  stale: boolean
  error?: string
  planType?: string
  windows: QuotaSnapshotHookWindow[]
  balances: QuotaSnapshotHookBalance[]
}
