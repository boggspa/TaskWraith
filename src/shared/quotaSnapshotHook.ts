/**
 * TaskWraith-owned supplemental quota snapshots for providers that are not
 * first-class TaskWraith seat ids. The contract carries only display-ready
 * fields; credentials, raw responses, paths, and account identifiers never
 * cross the main-process boundary.
 */

export const QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS = [
  'deepseek',
  'cerebras',
  'meta',
  'muse',
  'mimo',
  'qwen',
  'openrouter',
  'devin'
] as const

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

/**
 * Providers whose SECONDARY accounts (Settings → Providers → Accounts) ride
 * this lane. The primary Claude / Codex sign-in keeps its own first-class
 * fetcher; only the extra accounts are projected here, each stamped with the
 * account it belongs to so the renderer can key, label, and merge per account.
 */
export type QuotaSnapshotHookAccountProviderId = 'claude' | 'codex'

/**
 * `anthropic-admin-usage` / `openai-admin-usage` are the Console / organisation
 * API-usage report lanes (ApiUsageReportLane.ts): a `claude` or `codex`
 * snapshot stamped with a fixed account id, carrying one month-to-date spend
 * balance and no windows, so it files under Usage Credits beside the seat's
 * own subscription meters.
 */
export type QuotaSnapshotHookSource =
  | 'taskwraith-native'
  | 'claude-oauth-usage'
  | 'chatgpt-wham'
  | 'anthropic-admin-usage'
  | 'openai-admin-usage'

export interface QuotaSnapshotHookSnapshot {
  provider: QuotaSnapshotHookProviderId | QuotaSnapshotHookAccountProviderId
  source: QuotaSnapshotHookSource
  /** Set only for a secondary provider account; absent for the native lanes. */
  accountId?: string
  /** The account's user-chosen label ("Work"), shown as "Claude · Work". */
  accountLabel?: string
  configured: boolean
  fetchedAt: string
  stale: boolean
  error?: string
  planType?: string
  windows: QuotaSnapshotHookWindow[]
  balances: QuotaSnapshotHookBalance[]
}

/**
 * Identity a snapshot is merged and cached under: the provider alone for the
 * native lanes, `provider#accountId` for a secondary account, so two accounts
 * of one provider never collapse into each other.
 */
export function quotaSnapshotHookKey(
  snapshot: Pick<QuotaSnapshotHookSnapshot, 'provider' | 'accountId'>
): string {
  return snapshot.accountId ? `${snapshot.provider}#${snapshot.accountId}` : snapshot.provider
}
