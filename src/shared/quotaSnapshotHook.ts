/**
 * Credential-free quota snapshots supplied by a local helper.
 *
 * The hook contract is intentionally smaller than either application's quota
 * model. It carries only display-ready quota and balance fields; credentials,
 * raw provider responses, paths, and account identifiers have no place in the
 * schema and are discarded by the main-process parser before IPC.
 */

export const QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS = ['antigravity', 'deepseek', 'cerebras'] as const

export type QuotaSnapshotHookProviderId = (typeof QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS)[number]

/** How old a helper reading may get before it must be flagged stale. Shared
 * because two sides apply the same horizon: the main-process parser stamps
 * `stale` when it decodes the helper cache, and the renderer's keep-last-known
 * merge re-derives it while serving cached snapshots through a read outage. */
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
  source: 'limit-counter-sanitized-cache'
  configured: true
  fetchedAt: string
  stale: boolean
  planType?: string
  windows: QuotaSnapshotHookWindow[]
  balances: QuotaSnapshotHookBalance[]
}
