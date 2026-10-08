/**
 * API usage report lane — the Console / organisation bill for the current
 * calendar month, projected into the credential-free quota-hook contract so
 * it files under the Model Usage card's Usage Credits stack as
 * "Claude · Console API  $12.34 spent" / "Codex · OpenAI API  $5.67 spent".
 *
 * Why a separate lane rather than more balances on the seat's own snapshot:
 * the seat meters a SUBSCRIPTION (Claude Code / ChatGPT) and this meters an
 * API KEY's organisation. They are different pools, often different billing
 * owners (work org vs personal plan), and the user explicitly wants to see
 * them side by side rather than folded together. Each report is therefore a
 * `claude` / `codex` snapshot stamped with a fixed account id, which the
 * renderer already keys, labels and merges per account — the same contract
 * secondary sign-ins ride (ProviderAccountUsage.ts).
 *
 * Cadence: Anthropic allows one poll a minute and cost data lags completion
 * by ~5 minutes; the renderer re-reads the hook in bursts. A 15-minute fresh
 * TTL per provider, single-flight, with a 5-minute backoff after a failure,
 * keeps this well inside both. A failure after a successful read serves the
 * last report flagged stale; a failure with nothing cached yields a
 * configured-but-errored snapshot so the card can say why.
 *
 * Credentials: the admin keys are loaded through injected readers at call
 * time and never stored here; snapshots carry amounts, labels and dates only.
 */
import type { QuotaSnapshotHookSnapshot } from '../../shared/quotaSnapshotHook'
import {
  fetchAnthropicCostReport,
  type AnthropicAdminUsageFailure,
  type AnthropicCostReportOutcome
} from './AnthropicAdminUsage'
import {
  fetchOpenAiCostReport,
  type OpenAiAdminUsageFailure,
  type OpenAiCostReportOutcome
} from './OpenAiAdminUsage'
import type { ApiUsageKeyProviderId } from './ApiUsageKeyStore'

export const API_USAGE_REPORT_FRESH_TTL_MS = 15 * 60_000
export const API_USAGE_REPORT_FAILURE_BACKOFF_MS = 5 * 60_000

/** Fixed account ids: never a real provider-account id (those are UUIDs). */
export const ANTHROPIC_CONSOLE_USAGE_ACCOUNT_ID = 'console-api'
export const OPENAI_API_USAGE_ACCOUNT_ID = 'openai-api'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ApiUsageReportLaneDeps {
  /** Decrypted Anthropic Admin API key, or null when none is stored. */
  loadAnthropicKey: () => string | null
  /** Decrypted OpenAI admin API key, or null when none is stored. */
  loadOpenAiKey: () => string | null
  /** Optional OpenAI project id that narrows the bill to one project. */
  getOpenAiProjectId?: () => string | null | undefined
  fetchAnthropic?: typeof fetchAnthropicCostReport
  fetchOpenAi?: typeof fetchOpenAiCostReport
  fetchImpl?: FetchLike
  now?: () => number
  freshTtlMs?: number
  failureBackoffMs?: number
}

export interface ApiUsageReportLane {
  /** Snapshots for every provider with a stored key; never throws. */
  read(): Promise<QuotaSnapshotHookSnapshot[]>
  /** Drop the cache (after a key is saved/cleared) so the next read refetches. */
  invalidate(provider?: ApiUsageKeyProviderId): void
}

interface CacheEntry {
  snapshot: QuotaSnapshotHookSnapshot | null
  fetchedAt: number
  lastFailureAt: number
  lastError: string | null
  inFlight: Promise<QuotaSnapshotHookSnapshot | null> | null
}

/** UTC calendar month containing `nowMs`: [first of month, now) plus the next reset. */
export function utcMonthToDateRange(nowMs: number): {
  startMs: number
  endMs: number
  nextResetAt: string
} {
  const now = new Date(nowMs)
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const nextResetAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  ).toISOString()
  // Truncate to the minute so repeated reads inside a minute hit the same
  // query (and any upstream cache) instead of a fresh instant every time.
  const endMs = Math.floor(nowMs / 60_000) * 60_000
  return { startMs, endMs: Math.max(endMs, startMs + 60_000), nextResetAt }
}

function describeFailure(
  provider: ApiUsageKeyProviderId,
  failure: AnthropicAdminUsageFailure | OpenAiAdminUsageFailure,
  status?: number
): string {
  const vendor = provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
  const keyName = provider === 'anthropic' ? 'Anthropic Admin API key' : 'OpenAI admin API key'
  switch (failure) {
    case 'no-key':
      return `Store an ${keyName} to read ${vendor} API usage.`
    case 'unauthorized':
      return `${vendor} rejected the key (HTTP ${status ?? '401'}). API usage needs an organisation admin key, not a project or seat key.`
    case 'rate-limited':
      return `${vendor} rate-limited the usage report. TaskWraith will retry later.`
    case 'http':
      return `${vendor} usage report returned HTTP ${status ?? 'error'}.`
    case 'network':
      return `${vendor} usage report could not be reached.`
    case 'parse':
      return `${vendor} usage report could not be read; the figure is withheld rather than guessed.`
    default:
      return `${vendor} usage report unavailable.`
  }
}

function anthropicSnapshot(
  outcome: AnthropicCostReportOutcome,
  fetchedAtMs: number,
  nextResetAt: string
): QuotaSnapshotHookSnapshot {
  const fetchedAt = new Date(fetchedAtMs).toISOString()
  const base: QuotaSnapshotHookSnapshot = {
    provider: 'claude',
    source: 'anthropic-admin-usage',
    accountId: ANTHROPIC_CONSOLE_USAGE_ACCOUNT_ID,
    accountLabel: 'Console API',
    configured: true,
    fetchedAt,
    stale: false,
    planType: 'Console',
    windows: [],
    balances: []
  }
  if (!outcome.ok) {
    return { ...base, error: describeFailure('anthropic', outcome.failure, outcome.status) }
  }
  return {
    ...base,
    balances: [
      {
        id: 'claude-console-api-usage-mtd',
        label: 'API usage',
        amount: outcome.report.totalUsd,
        unit: 'USD',
        subtitle: 'Month to date (UTC) · Anthropic Console cost report',
        resetAt: nextResetAt
      }
    ]
  }
}

function openAiSnapshot(
  outcome: OpenAiCostReportOutcome,
  fetchedAtMs: number,
  nextResetAt: string
): QuotaSnapshotHookSnapshot {
  const fetchedAt = new Date(fetchedAtMs).toISOString()
  const base: QuotaSnapshotHookSnapshot = {
    provider: 'codex',
    source: 'openai-admin-usage',
    accountId: OPENAI_API_USAGE_ACCOUNT_ID,
    accountLabel: 'OpenAI API',
    configured: true,
    fetchedAt,
    stale: false,
    planType: 'API',
    windows: [],
    balances: []
  }
  if (!outcome.ok) {
    return { ...base, error: describeFailure('openai', outcome.failure, outcome.status) }
  }
  const scope = outcome.report.projectId
    ? `project ${outcome.report.projectId}`
    : 'whole organisation'
  return {
    ...base,
    balances: [
      {
        id: 'codex-openai-api-usage-mtd',
        label: 'API usage',
        amount: outcome.report.total,
        unit: outcome.report.currency,
        subtitle: `Month to date (UTC) · OpenAI costs, ${scope}`,
        resetAt: nextResetAt
      }
    ]
  }
}

export function createApiUsageReportLane(deps: ApiUsageReportLaneDeps): ApiUsageReportLane {
  const now = deps.now ?? (() => Date.now())
  const freshTtlMs = deps.freshTtlMs ?? API_USAGE_REPORT_FRESH_TTL_MS
  const failureBackoffMs = deps.failureBackoffMs ?? API_USAGE_REPORT_FAILURE_BACKOFF_MS
  const fetchAnthropic = deps.fetchAnthropic ?? fetchAnthropicCostReport
  const fetchOpenAi = deps.fetchOpenAi ?? fetchOpenAiCostReport

  const emptyEntry = (): CacheEntry => ({
    snapshot: null,
    fetchedAt: Number.NEGATIVE_INFINITY,
    lastFailureAt: Number.NEGATIVE_INFINITY,
    lastError: null,
    inFlight: null
  })
  const cache: Record<ApiUsageKeyProviderId, CacheEntry> = {
    anthropic: emptyEntry(),
    openai: emptyEntry()
  }

  const serveCached = (
    provider: ApiUsageKeyProviderId,
    at: number
  ): QuotaSnapshotHookSnapshot | null => {
    const entry = cache[provider]
    if (!entry.snapshot) return null
    const stale = at - entry.fetchedAt >= freshTtlMs
    return stale ? { ...entry.snapshot, stale: true } : entry.snapshot
  }

  const run = async (
    provider: ApiUsageKeyProviderId,
    apiKey: string
  ): Promise<QuotaSnapshotHookSnapshot | null> => {
    const entry = cache[provider]
    const at = now()
    const cached = serveCached(provider, at)
    if (cached && at - entry.fetchedAt < freshTtlMs) return cached
    if (at - entry.lastFailureAt < failureBackoffMs) {
      return (
        cached ??
        errorSnapshot(provider, entry.lastError ?? describeFailure(provider, 'network'), at)
      )
    }
    if (entry.inFlight) return entry.inFlight
    entry.inFlight = (async () => {
      const readAt = now()
      const range = utcMonthToDateRange(readAt)
      try {
        const snapshot =
          provider === 'anthropic'
            ? anthropicSnapshot(
                await fetchAnthropic({
                  apiKey,
                  startingAt: new Date(range.startMs).toISOString(),
                  endingAt: new Date(range.endMs).toISOString(),
                  fetchImpl: deps.fetchImpl
                }),
                readAt,
                range.nextResetAt
              )
            : openAiSnapshot(
                await fetchOpenAi({
                  apiKey,
                  startTimeMs: range.startMs,
                  endTimeMs: range.endMs,
                  projectId: deps.getOpenAiProjectId?.() ?? null,
                  fetchImpl: deps.fetchImpl
                }),
                readAt,
                range.nextResetAt
              )
        if (snapshot.error) {
          entry.lastFailureAt = now()
          entry.lastError = snapshot.error
          return serveCached(provider, now()) ?? snapshot
        }
        entry.snapshot = snapshot
        entry.fetchedAt = readAt
        entry.lastError = null
        return snapshot
      } catch {
        entry.lastFailureAt = now()
        entry.lastError = describeFailure(provider, 'network')
        return serveCached(provider, now()) ?? errorSnapshot(provider, entry.lastError, now())
      } finally {
        entry.inFlight = null
      }
    })()
    return entry.inFlight
  }

  const errorSnapshot = (
    provider: ApiUsageKeyProviderId,
    error: string,
    at: number
  ): QuotaSnapshotHookSnapshot =>
    provider === 'anthropic'
      ? { ...anthropicSnapshot({ ok: false, failure: 'network' }, at, ''), error }
      : { ...openAiSnapshot({ ok: false, failure: 'network' }, at, ''), error }

  return {
    invalidate: (provider) => {
      for (const id of provider ? [provider] : (['anthropic', 'openai'] as const)) {
        cache[id] = emptyEntry()
      }
    },
    read: async () => {
      const keys: Array<[ApiUsageKeyProviderId, string | null]> = [
        ['anthropic', safeLoad(deps.loadAnthropicKey)],
        ['openai', safeLoad(deps.loadOpenAiKey)]
      ]
      const snapshots = await Promise.all(
        keys.map(async ([provider, apiKey]) => {
          if (!apiKey) {
            // A cleared key empties the lane rather than serving a ghost bill.
            cache[provider] = emptyEntry()
            return null
          }
          try {
            return await run(provider, apiKey)
          } catch {
            return null
          }
        })
      )
      return snapshots.filter((snapshot): snapshot is QuotaSnapshotHookSnapshot => !!snapshot)
    }
  }
}

function safeLoad(load: () => string | null): string | null {
  try {
    const value = load()
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}
