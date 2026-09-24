import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import {
  fetchKimiWebMonthlyUsage,
  type KimiWebSessionTokens
} from './KimiWebSubscriptionClient'

/**
 * Kimi's shared monthly membership-credit meter, read from the imported
 * kimi.ai web session (see KimiWebSessionStore). The kimi.com API-key lane
 * (fetchKimiUsageSnapshot) cannot see this meter, so an imported web session
 * is its only fuel.
 *
 * The fetcher serves the same NormalizedProviderUsageSnapshot contract as the
 * other providers on `get-agent-rate-limits`, with tombstone semantics
 * matching OllamaWebUsage: it ALWAYS returns a structured snapshot
 * (configured: false when no session is stored), so clearing the session
 * clears the meter via an explicit tombstone rather than a stale cache.
 *
 * The stored envelope secret is a canonical JSON serialization of the tokens;
 * rotated refresh tokens are persisted straight back into the store.
 */

const WEB_USAGE_SUCCESS_TTL_MS = 5 * 60 * 1000
const WEB_USAGE_FAILURE_RETRY_MS = 60 * 1000
/** Even a forced refresh (user-initiated) should not hammer the endpoint. */
const FORCE_REFRESH_FLOOR_MS = 5 * 1000

export const KIMI_WEB_USAGE_SOURCE = 'kimi-web-session'

export interface KimiWebUsageFetcherDeps {
  /** The web-session envelope read; anything but status 'ok' means no lane. */
  loadCookie: () => { status: string; value?: string }
  persistCookie: (value: string) => void
  fetchMonthlyUsage?: typeof fetchKimiWebMonthlyUsage
  now?: () => Date
}

export interface KimiWebUsageFetcher {
  (options?: { force?: boolean }): Promise<NormalizedProviderUsageSnapshot>
  /** Drop the TTL and caches — a fresh session was just imported. */
  invalidate(): void
}

/** Canonical at-rest form for the store envelope (also what paste accepts). */
export function serializeKimiWebSessionTokens(tokens: KimiWebSessionTokens): string {
  return JSON.stringify(
    tokens.refreshToken
      ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
      : { accessToken: tokens.accessToken }
  )
}

export function parseKimiWebSessionTokens(value: string): KimiWebSessionTokens | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const accessToken =
      typeof record.accessToken === 'string'
        ? record.accessToken.trim()
        : typeof record.access_token === 'string'
          ? record.access_token.trim()
          : ''
    if (!accessToken) return null
    const refreshToken =
      typeof record.refreshToken === 'string' && record.refreshToken.trim()
        ? record.refreshToken.trim()
        : typeof record.refresh_token === 'string' && record.refresh_token.trim()
          ? record.refresh_token.trim()
          : undefined
    return { accessToken, ...(refreshToken ? { refreshToken } : {}) }
  } catch {
    // A bare access token pasted without JSON still forms a usable lane.
    const trimmed = value.trim()
    if (/^[\w.-]{16,}$/.test(trimmed)) return { accessToken: trimmed }
    return null
  }
}

function unconfiguredSnapshot(fetchedAt: string): NormalizedProviderUsageSnapshot {
  return {
    provider: 'kimi',
    source: KIMI_WEB_USAGE_SOURCE,
    configured: false,
    fetchedAt,
    windows: []
  }
}

function buildKimiWebUsageSnapshot(
  reading: { usedPercent: number; resetAt?: string },
  now: Date
): NormalizedProviderUsageSnapshot {
  const remainingPercent = Math.round(100 - reading.usedPercent)
  return {
    provider: 'kimi',
    source: KIMI_WEB_USAGE_SOURCE,
    configured: true,
    fetchedAt: now.toISOString(),
    windows: [
      {
        id: 'kimi-web-monthly',
        label: 'Monthly',
        runs: 0,
        totalTokens: 0,
        limitLabel: `${Math.round(reading.usedPercent)}% used · shared monthly membership credit`,
        ...(reading.resetAt ? { resetAt: reading.resetAt } : {}),
        trackingOnly: false,
        usedPercent: reading.usedPercent,
        remainingPercent,
        windowKind: 'monthly'
      }
    ]
  }
}

export function createKimiWebUsageFetcher(deps: KimiWebUsageFetcherDeps): KimiWebUsageFetcher {
  const now = deps.now ?? (() => new Date())
  const fetchMonthlyUsage = deps.fetchMonthlyUsage ?? fetchKimiWebMonthlyUsage

  let lastGood: NormalizedProviderUsageSnapshot | null = null
  let lastServed: NormalizedProviderUsageSnapshot | null = null
  let lastEnvelopeValue: string | null = null
  let nextAttemptAtMs = 0
  let forceFloorAtMs = 0
  let inFlight: Promise<NormalizedProviderUsageSnapshot> | null = null

  const invalidate = (): void => {
    lastGood = null
    lastServed = null
    nextAttemptAtMs = 0
  }

  const failureFallback = (): NormalizedProviderUsageSnapshot =>
    lastGood
      ? { ...lastGood, stale: true }
      : {
          provider: 'kimi',
          source: KIMI_WEB_USAGE_SOURCE,
          configured: true,
          fetchedAt: now().toISOString(),
          windows: [],
          error:
            'Kimi could not read the imported web session. Re-import it from Settings → Providers if this persists.'
        }

  const fetcher = (async (options: { force?: boolean } = {}) => {
    const envelope = deps.loadCookie()
    if (envelope.status !== 'ok' || !envelope.value) {
      // Explicit tombstone: the session was never imported or was cleared.
      invalidate()
      lastEnvelopeValue = null
      return unconfiguredSnapshot(now().toISOString())
    }
    if (envelope.value !== lastEnvelopeValue) {
      // A different session (import or paste) must not serve the previous
      // session's cached numbers for the rest of its TTL.
      if (lastEnvelopeValue !== null) invalidate()
      lastEnvelopeValue = envelope.value
    }
    const tokens = parseKimiWebSessionTokens(envelope.value)
    if (!tokens) {
      return {
        ...failureFallback(),
        error: 'The stored Kimi web session is unreadable. Re-import it from Settings → Providers.'
      }
    }

    const nowMs = now().getTime()
    const withinTtl = nowMs < nextAttemptAtMs
    const force = options.force === true && nowMs >= forceFloorAtMs
    if (inFlight) return inFlight
    if (withinTtl && !force && lastServed) return lastServed

    inFlight = (async () => {
      try {
        const result = await fetchMonthlyUsage(tokens, (rotated) => {
          deps.persistCookie(serializeKimiWebSessionTokens(rotated))
        })
        if (result.reading) {
          const snapshot = buildKimiWebUsageSnapshot(result.reading, now())
          lastGood = snapshot
          lastServed = snapshot
          nextAttemptAtMs = now().getTime() + WEB_USAGE_SUCCESS_TTL_MS
          return snapshot
        }
        nextAttemptAtMs = now().getTime() + WEB_USAGE_FAILURE_RETRY_MS
        const fallback = failureFallback()
        lastServed = fallback
        return fallback
      } catch {
        nextAttemptAtMs = now().getTime() + WEB_USAGE_FAILURE_RETRY_MS
        const fallback = failureFallback()
        lastServed = fallback
        return fallback
      } finally {
        forceFloorAtMs = now().getTime() + FORCE_REFRESH_FLOOR_MS
        inFlight = null
      }
    })()
    return inFlight
  }) as KimiWebUsageFetcher
  fetcher.invalidate = invalidate
  return fetcher
}
