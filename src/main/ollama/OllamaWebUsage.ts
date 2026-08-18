import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import type { OllamaWebSubscriptionResult } from './OllamaWebSubscriptionClient'
import { fetchOllamaWebSubscription } from './OllamaWebSubscriptionClient'

/**
 * Ollama's Session (5-hour) and Weekly usage meters, read from the imported
 * ollama.com web session (see OllamaWebSessionStore). ollama.com exposes these
 * numbers nowhere else — not the local daemon, not the Cloud API key — so an
 * imported session is the lane's only fuel.
 *
 * The fetcher serves the same NormalizedProviderUsageSnapshot contract as the
 * other providers on `get-agent-rate-limits`, with the AntiGravity lane's
 * tombstone semantics: it ALWAYS returns a structured snapshot (configured:
 * false when no session is stored), so a renderer-side `null` strictly means
 * a missed deadline and last-known retention applies. Clearing the session
 * therefore clears the meters via an explicit tombstone rather than a stale
 * cache lingering forever.
 */

const WEB_USAGE_SUCCESS_TTL_MS = 5 * 60 * 1000
const WEB_USAGE_FAILURE_RETRY_MS = 60 * 1000
/** Even a forced refresh (user-initiated) should not hammer the page. */
const FORCE_REFRESH_FLOOR_MS = 5 * 1000

export const OLLAMA_WEB_USAGE_SOURCE = 'ollama-web-session'

export interface OllamaWebUsageFetcherDeps {
  /** The web-session envelope read; anything but status 'ok' means no lane. */
  loadCookie: () => { status: string; value?: string }
  fetchSubscription?: (cookieHeader: string) => Promise<OllamaWebSubscriptionResult | null>
  now?: () => Date
}

export interface OllamaWebUsageFetcher {
  (options?: { force?: boolean }): Promise<NormalizedProviderUsageSnapshot>
  /** Drop the TTL and caches — a fresh session was just imported. */
  invalidate(): void
}

function unconfiguredSnapshot(fetchedAt: string): NormalizedProviderUsageSnapshot {
  return {
    provider: 'ollama',
    source: OLLAMA_WEB_USAGE_SOURCE,
    configured: false,
    fetchedAt,
    windows: []
  }
}

/** "Resets in 3h" / "Resumes in 2d" → an ISO instant, so the card can render
 *  its usual countdown. Unparseable descriptions simply carry no date. */
export function resetDescriptionToIso(
  description: string | undefined,
  now: Date
): string | undefined {
  if (!description) return undefined
  const match = description.match(/in\s+(\d+)\s*(d|h)/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unitMs = match[2].toLowerCase() === 'd' ? 86_400_000 : 3_600_000
  return new Date(now.getTime() + amount * unitMs).toISOString()
}

/** Pure half: a settings-page read becomes the snapshot the renderer meters.
 *  Exported for tests. */
export function buildOllamaWebUsageSnapshot(
  result: OllamaWebSubscriptionResult,
  now: Date
): NormalizedProviderUsageSnapshot {
  const windows: NonNullable<NormalizedProviderUsageSnapshot['windows']> = []
  if (typeof result.sessionUsedPercent === 'number') {
    const resetAt = resetDescriptionToIso(result.sessionResetDescription, now)
    windows.push({
      id: 'ollama-session-5h',
      label: 'Session usage',
      runs: 0,
      totalTokens: 0,
      limitLabel: [
        `${Math.round(result.sessionUsedPercent)}% used`,
        result.sessionResetDescription ?? '5-hour sliding window'
      ].join(' · '),
      ...(resetAt ? { resetAt } : {}),
      trackingOnly: false,
      usedPercent: result.sessionUsedPercent,
      windowKind: 'session'
    })
  }
  if (typeof result.weeklyUsedPercent === 'number') {
    const resetAt = resetDescriptionToIso(result.weeklyResetDescription, now)
    windows.push({
      id: 'ollama-weekly',
      label: 'Weekly usage',
      runs: 0,
      totalTokens: 0,
      limitLabel: [
        `${Math.round(result.weeklyUsedPercent)}% used`,
        result.weeklyResetDescription ?? 'Weekly rolling window'
      ].join(' · '),
      ...(resetAt ? { resetAt } : {}),
      trackingOnly: false,
      usedPercent: result.weeklyUsedPercent,
      windowKind: 'weekly'
    })
  }
  return {
    provider: 'ollama',
    source: OLLAMA_WEB_USAGE_SOURCE,
    configured: true,
    fetchedAt: now.toISOString(),
    windows
  }
}

export function createOllamaWebUsageFetcher(
  deps: OllamaWebUsageFetcherDeps
): OllamaWebUsageFetcher {
  const now = deps.now ?? (() => new Date())
  const fetchSubscription = deps.fetchSubscription ?? fetchOllamaWebSubscription

  let lastGood: NormalizedProviderUsageSnapshot | null = null
  let lastServed: NormalizedProviderUsageSnapshot | null = null
  let lastCookieValue: string | null = null
  let nextAttemptAtMs = 0
  let forceFloorAtMs = 0
  let inFlight: Promise<NormalizedProviderUsageSnapshot> | null = null

  const invalidate = (): void => {
    lastGood = null
    lastServed = null
    nextAttemptAtMs = 0
  }

  const fetcher = (async (options: { force?: boolean } = {}) => {
    const cookie = deps.loadCookie()
    if (cookie.status !== 'ok' || !cookie.value) {
      // Explicit tombstone: the session was never imported or was cleared.
      // Also drop the caches so re-importing starts clean.
      invalidate()
      lastCookieValue = null
      return unconfiguredSnapshot(now().toISOString())
    }
    if (cookie.value !== lastCookieValue) {
      // A different session (import or paste) must not serve the previous
      // session's cached numbers for the rest of its TTL.
      if (lastCookieValue !== null) invalidate()
      lastCookieValue = cookie.value
    }

    const nowMs = now().getTime()
    const withinTtl = nowMs < nextAttemptAtMs
    const force = options.force === true && nowMs >= forceFloorAtMs
    if (inFlight) return inFlight
    if (withinTtl && !force && lastServed) return lastServed

    inFlight = (async () => {
      try {
        const result = await fetchSubscription(cookie.value as string)
        if (result) {
          const snapshot = buildOllamaWebUsageSnapshot(result, now())
          lastGood = snapshot
          lastServed = snapshot
          nextAttemptAtMs = now().getTime() + WEB_USAGE_SUCCESS_TTL_MS
          return snapshot
        }
        nextAttemptAtMs = now().getTime() + WEB_USAGE_FAILURE_RETRY_MS
        const fallback: NormalizedProviderUsageSnapshot = lastGood
          ? { ...lastGood, stale: true }
          : {
              provider: 'ollama',
              source: OLLAMA_WEB_USAGE_SOURCE,
              configured: true,
              fetchedAt: now().toISOString(),
              windows: [],
              error:
                'Ollama could not confirm the imported web session. Re-import it from Settings → Providers if this persists.'
            }
        lastServed = fallback
        return fallback
      } catch {
        nextAttemptAtMs = now().getTime() + WEB_USAGE_FAILURE_RETRY_MS
        const fallback = lastGood
          ? { ...lastGood, stale: true }
          : unconfiguredSnapshot(now().toISOString())
        lastServed = fallback
        return fallback
      } finally {
        forceFloorAtMs = now().getTime() + FORCE_REFRESH_FLOOR_MS
        inFlight = null
      }
    })()
    return inFlight
  }) as OllamaWebUsageFetcher
  fetcher.invalidate = invalidate
  return fetcher
}
