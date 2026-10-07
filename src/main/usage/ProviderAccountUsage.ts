/**
 * Usage meters for SECONDARY provider accounts (Settings → Providers →
 * Accounts). The primary Claude / Codex sign-in keeps its first-class fetcher;
 * every extra account is read here with the same endpoints, its own TTL and
 * failure backoff, and is projected into the credential-free quota-hook
 * contract stamped with the account it belongs to.
 *
 * Pure over injected readers so it tests without Electron, the network, or
 * the Keychain. Credentials never leave this module: the projection carries
 * windows, balances, labels, and timestamps only.
 */
import type { ProviderCliAccount } from '../store/types'
import type { CodexUsageCredential, ClaudeOAuthCredential } from '../providers/ProviderAuthUsage'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import type { QuotaSnapshotHookSnapshot } from '../../shared/quotaSnapshotHook'

export const PROVIDER_ACCOUNT_USAGE_FRESH_TTL_MS = 10 * 60_000
export const PROVIDER_ACCOUNT_USAGE_FAILURE_BACKOFF_MS = 90_000

export interface ProviderAccountUsageDeps {
  listAccounts: () => readonly ProviderCliAccount[]
  readClaudeCredential: (account: ProviderCliAccount) => Promise<ClaudeOAuthCredential | null>
  fetchClaudeUsage: (credential: ClaudeOAuthCredential) => Promise<NormalizedProviderUsageSnapshot>
  readCodexCredential: (account: ProviderCliAccount) => Promise<CodexUsageCredential | null>
  fetchCodexUsage: (credential: CodexUsageCredential) => Promise<NormalizedProviderUsageSnapshot>
  now?: () => number
  freshTtlMs?: number
  failureBackoffMs?: number
}

interface AccountUsageCacheEntry {
  snapshot: NormalizedProviderUsageSnapshot | null
  fetchedAt: number
  lastFailureAt: number
  lastError: string | null
  inFlight: Promise<NormalizedProviderUsageSnapshot | null> | null
}

function signInHint(account: ProviderCliAccount): string {
  return account.provider === 'codex'
    ? `Sign in to the "${account.label}" Codex account from Settings → Providers → Codex → Accounts.`
    : `Sign in to the "${account.label}" Claude account from Settings → Providers → Claude → Accounts.`
}

/** Project a normalised provider snapshot into the hook contract for one account. */
export function projectProviderAccountSnapshot(
  account: ProviderCliAccount,
  snapshot: NormalizedProviderUsageSnapshot | null,
  options: { now: number; stale?: boolean; error?: string; configured?: boolean }
): QuotaSnapshotHookSnapshot {
  const fetchedAt =
    snapshot?.fetchedAt && !Number.isNaN(Date.parse(snapshot.fetchedAt))
      ? snapshot.fetchedAt
      : new Date(options.now).toISOString()
  const error = options.error ?? snapshot?.error
  return {
    provider: account.provider,
    source: account.provider === 'codex' ? 'chatgpt-wham' : 'claude-oauth-usage',
    accountId: account.id,
    accountLabel: account.label,
    configured: options.configured ?? snapshot?.configured ?? false,
    fetchedAt,
    stale: Boolean(options.stale ?? snapshot?.stale),
    ...(error ? { error } : {}),
    ...(snapshot?.planType || snapshot?.subscriptionType
      ? { planType: snapshot.planType ?? snapshot.subscriptionType }
      : {}),
    windows: (snapshot?.windows ?? []).map((window) => ({
      id: `${account.id}:${window.id}`,
      label: window.label,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent ?? Math.max(0, 100 - window.usedPercent),
      limitLabel: window.limitLabel,
      ...(window.resetAt ? { resetAt: window.resetAt } : {}),
      ...(window.windowKind ? { windowKind: window.windowKind } : {}),
      ...(window.limitWindowSeconds ? { limitWindowSeconds: window.limitWindowSeconds } : {})
    })),
    balances: (snapshot?.balances ?? []).map((balance, index) => ({
      id: `${account.id}:balance-${index}`,
      label: balance.label,
      amount: balance.amount,
      unit: balance.unit,
      ...(balance.subtitle ? { subtitle: balance.subtitle } : {}),
      ...(balance.resetAt ? { resetAt: balance.resetAt } : {})
    }))
  }
}

export function createProviderAccountUsageReader(
  deps: ProviderAccountUsageDeps
): () => Promise<QuotaSnapshotHookSnapshot[]> {
  const now = deps.now ?? (() => Date.now())
  const freshTtlMs = deps.freshTtlMs ?? PROVIDER_ACCOUNT_USAGE_FRESH_TTL_MS
  const failureBackoffMs = deps.failureBackoffMs ?? PROVIDER_ACCOUNT_USAGE_FAILURE_BACKOFF_MS
  const cache = new Map<string, AccountUsageCacheEntry>()

  const entryFor = (account: ProviderCliAccount): AccountUsageCacheEntry => {
    let entry = cache.get(account.id)
    if (!entry) {
      entry = { snapshot: null, fetchedAt: 0, lastFailureAt: 0, lastError: null, inFlight: null }
      cache.set(account.id, entry)
    }
    return entry
  }

  const loadLive = async (
    account: ProviderCliAccount,
    entry: AccountUsageCacheEntry
  ): Promise<NormalizedProviderUsageSnapshot | null> => {
    const credential =
      account.provider === 'codex'
        ? await deps.readCodexCredential(account)
        : await deps.readClaudeCredential(account)
    if (!credential) return null
    const snapshot =
      account.provider === 'codex'
        ? await deps.fetchCodexUsage(credential as CodexUsageCredential)
        : await deps.fetchClaudeUsage(credential as ClaudeOAuthCredential)
    entry.snapshot = snapshot
    entry.fetchedAt = now()
    entry.lastFailureAt = 0
    entry.lastError = null
    return snapshot
  }

  const readAccount = async (account: ProviderCliAccount): Promise<QuotaSnapshotHookSnapshot> => {
    const entry = entryFor(account)
    const readAt = now()
    if (entry.snapshot && readAt - entry.fetchedAt < freshTtlMs) {
      return projectProviderAccountSnapshot(account, entry.snapshot, { now: readAt })
    }
    if (entry.lastFailureAt && readAt - entry.lastFailureAt < failureBackoffMs) {
      return projectProviderAccountSnapshot(account, entry.snapshot, {
        now: readAt,
        stale: true,
        configured: true,
        error: entry.lastError ?? 'Usage fetch is backing off after a recent failure.'
      })
    }
    if (!entry.inFlight) {
      entry.inFlight = loadLive(account, entry).finally(() => {
        entry.inFlight = null
      })
    }
    try {
      const snapshot = await entry.inFlight
      if (!snapshot) {
        // No credential in the folder: the account is registered but not
        // signed in. A configured:false tombstone says so without a meter.
        return projectProviderAccountSnapshot(account, null, {
          now: readAt,
          configured: false,
          error: signInHint(account)
        })
      }
      return projectProviderAccountSnapshot(account, snapshot, { now: now() })
    } catch (error) {
      entry.lastFailureAt = now()
      entry.lastError =
        error instanceof Error && error.message ? error.message : 'Usage fetch failed.'
      return projectProviderAccountSnapshot(account, entry.snapshot, {
        now: readAt,
        stale: true,
        configured: true,
        error: entry.lastError
      })
    }
  }

  return async () => {
    const accounts = deps.listAccounts()
    const live = new Set(accounts.map((account) => account.id))
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id)
    return Promise.all(accounts.map((account) => readAccount(account)))
  }
}
