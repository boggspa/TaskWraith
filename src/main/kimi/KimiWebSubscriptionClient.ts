/**
 * Reads Kimi's shared monthly membership-credit meter from
 * https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats
 * using web-session tokens captured by Import Web Session (see
 * KimiWebSessionStore). The kimi.com API-key lane (fetchKimiUsageSnapshot)
 * cannot see this meter — it is a property of the signed-in web account.
 *
 * The contract is ported verbatim from Limit Counter's KimiWebMembershipClient
 * (App/Providers/ProviderClient.swift) so both apps read the same numbers:
 *
 * - Bearer POST of `{}` with Connect-Protocol-Version/web platform headers.
 * - A 401 triggers one refresh via auth.kimi.ai RefreshToken; rotated tokens
 *   are returned so the caller can persist them for next time.
 * - `subscription_balance.amount_used_ratio` is a 0..1 ratio (the web client
 *   also tolerates an already-percent value); `expire_time` carries the cycle
 *   reset as ISO, epoch seconds/millis, or {seconds}.
 * - An omitted ratio reads as zero at the start of a fresh cycle, matching
 *   Kimi's own web client.
 */

export interface KimiWebSessionTokens {
  accessToken: string
  refreshToken?: string
}

export interface KimiWebMonthlyReading {
  usedPercent: number
  resetAt?: string
}

export interface KimiWebMonthlyFetchResult {
  reading: KimiWebMonthlyReading | null
  /** Present only when a refresh succeeded; persist these. */
  tokens?: KimiWebSessionTokens
}

const FETCH_TIMEOUT_MS = 15_000

const STATS_URL =
  'https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'
const REFRESH_URL = 'https://auth.kimi.ai/api/account.gateway.v1.AuthService/RefreshToken'

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** ISO string, epoch seconds/millis, or a protobuf {seconds} timestamp. */
function parseKimiDate(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime()
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
  }
  const seconds = numeric(value)
  if (seconds !== undefined) {
    const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000
    return new Date(ms).toISOString()
  }
  const nested = record(value)
  if (nested) {
    const innerSeconds = numeric(nested.seconds)
    if (innerSeconds !== undefined) return new Date(innerSeconds * 1000).toISOString()
  }
  return undefined
}

/** Pure parser half, exported for fixture tests. Null = no balance object. */
export function parseKimiWebMonthlyUsage(payload: unknown): KimiWebMonthlyReading | null {
  const root = record(payload)
  if (!root) return null
  const balance =
    record(root.subscription_balance) ?? record(root.subscriptionBalance) ?? record(root.balance)
  if (!balance) return null

  // Kimi's own web client treats an omitted proto default as zero at the
  // start of a fresh subscription cycle.
  let rawRatio = numeric(balance.amount_used_ratio ?? balance.amountUsedRatio) ?? 0
  if (rawRatio > 1) rawRatio = rawRatio / 100
  const usedPercent = clampPercent(rawRatio * 100)
  const resetAt = parseKimiDate(balance.expire_time ?? balance.expireTime)
  return { usedPercent, ...(resetAt ? { resetAt } : {}) }
}

export function parseRefreshedTokens(
  payload: unknown,
  previousRefreshToken?: string
): KimiWebSessionTokens | null {
  const root = record(payload)
  if (!root) return null
  const accessToken =
    stringField(root.access_token) ?? stringField(root.accessToken) ?? stringField(root.token)
  if (!accessToken) return null
  const refreshToken =
    stringField(root.refresh_token) ?? stringField(root.refreshToken) ?? previousRefreshToken
  return { accessToken, ...(refreshToken ? { refreshToken } : {}) }
}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; payload: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Connect-Protocol-Version': '1',
        'x-msh-platform': 'web',
        'X-Language': 'en-US',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36',
        ...headers
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    let payload: unknown = null
    try {
      payload = await res.json()
    } catch {
      // Non-JSON error bodies still carry a usable status code.
    }
    return { status: res.status, payload }
  } catch {
    return null
  }
}

/**
 * Fetch the monthly reading, refreshing once on 401 and handing back the
 * rotated tokens so the caller can persist them (Limit Counter parity).
 */
export async function fetchKimiWebMonthlyUsage(
  tokens: KimiWebSessionTokens,
  persistTokens?: (tokens: KimiWebSessionTokens) => void
): Promise<KimiWebMonthlyFetchResult> {
  const attempt = async (
    accessToken: string
  ): Promise<{ status: number; payload: unknown } | null> =>
    postJson(STATS_URL, '{}', { Authorization: `Bearer ${accessToken}` })

  let current = tokens
  let response = await attempt(current.accessToken)

  if (response && response.status === 401 && current.refreshToken) {
    const refreshed = await postJson(REFRESH_URL, JSON.stringify({ refresh_token: current.refreshToken }), {})
    const nextTokens = refreshed?.payload
      ? parseRefreshedTokens(refreshed.payload, current.refreshToken)
      : null
    if (refreshed && refreshed.status === 200 && nextTokens) {
      current = nextTokens
      try {
        persistTokens?.(current)
      } catch {
        // Persistence failure must not lose the in-memory reading.
      }
      response = await attempt(current.accessToken)
    }
  }

  if (!response || response.status !== 200) return { reading: null }
  return {
    reading: parseKimiWebMonthlyUsage(response.payload),
    ...(current !== tokens ? { tokens: current } : {})
  }
}
