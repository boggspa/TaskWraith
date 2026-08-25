import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  NormalizedProviderUsageSnapshot,
  NormalizedProviderUsageWindow
} from '../ProviderQuotaSnapshots'
import { agyCliRootPath } from './AntigravityConversationReceipt'

const TOKEN_FILE_NAME = 'antigravity-oauth-token'
const TOKEN_FILE_MAX_BYTES = 1024 * 1024
const RESPONSE_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOAD_CODE_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const QUOTA_SUMMARY_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'

// Installed-app OAuth client identifiers are public protocol metadata, not a
// user secret. These are the identifiers used by the official agy CLI session.
const AGY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const AGY_OAUTH_CLIENT_SECRET = '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'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AntigravityOAuthSession {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
}

export interface AntigravityQuotaSummaryDependencies {
  tokenFilePath?: string
  env?: Readonly<Record<string, string | undefined>>
  homeDir?: string
  fetchImpl?: FetchLike
  now?: () => number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function flexibleNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function isoDate(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function antigravityOAuthTokenPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir?: string
): string {
  return join(agyCliRootPath(env, homeDir), 'antigravity-cli', TOKEN_FILE_NAME)
}

export function parseAntigravityOAuthSession(value: unknown): AntigravityOAuthSession | null {
  const envelope = record(value)
  const token = record(envelope?.token)
  const accessToken = nonEmptyString(token?.access_token)
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: nonEmptyString(token?.refresh_token),
    expiresAt: isoDate(token?.expiry)
  }
}

type BucketFamily = 'gemini' | 'claude' | 'gpt' | 'third-party'
type BucketWindow = 'five-hour' | 'weekly'

interface ParsedBucket {
  family: BucketFamily
  window: BucketWindow
  remainingFraction: number
  resetAt: string | null
}

function parseBucket(value: unknown): ParsedBucket | null {
  const bucket = record(value)
  const id = nonEmptyString(bucket?.bucketId)?.toLowerCase()
  const remaining = flexibleNumber(bucket?.remainingFraction)
  if (!id || remaining === null || remaining < -0.000_001 || remaining > 1.000_001) {
    return null
  }
  const separator = id.indexOf('-')
  if (separator <= 0) return null
  const rawFamily = id.slice(0, separator)
  const rawWindow = id.slice(separator + 1)
  const family: BucketFamily | null =
    rawFamily === 'gemini'
      ? 'gemini'
      : rawFamily === 'claude'
        ? 'claude'
        : rawFamily === 'gpt'
          ? 'gpt'
          : rawFamily === '3p'
            ? 'third-party'
            : null
  const window: BucketWindow | null =
    rawWindow === '5h' ? 'five-hour' : rawWindow === 'weekly' ? 'weekly' : null
  if (!family || !window) return null
  return {
    family,
    window,
    remainingFraction: Math.max(0, Math.min(1, remaining)),
    resetAt: isoDate(bucket?.resetTime)
  }
}

function bucketLabel(bucket: ParsedBucket): string {
  const family =
    bucket.family === 'third-party'
      ? 'Claude/GPT'
      : bucket.family === 'gpt'
        ? 'GPT'
        : bucket.family[0].toUpperCase() + bucket.family.slice(1)
  return `${family} ${bucket.window === 'five-hour' ? '5H' : 'Weekly'}`
}

function bucketOrder(bucket: ParsedBucket): number {
  const familyOrder =
    bucket.family === 'gemini'
      ? 0
      : bucket.family === 'claude'
        ? 1
        : bucket.family === 'gpt'
          ? 2
          : 3
  return familyOrder * 2 + (bucket.window === 'five-hour' ? 0 : 1)
}

function bucketWindow(bucket: ParsedBucket): NormalizedProviderUsageWindow {
  const remainingPercent = Number((bucket.remainingFraction * 100).toFixed(3))
  const usedPercent = Number((100 - remainingPercent).toFixed(3))
  const familyId = bucket.family === 'third-party' ? '3p' : bucket.family
  const windowId = bucket.window === 'five-hour' ? '5h' : 'weekly'
  return {
    id: `agy-${familyId}-${windowId}`,
    label: bucketLabel(bucket),
    runs: 0,
    totalTokens: 0,
    limitLabel: `${remainingPercent}% remaining`,
    ...(bucket.resetAt ? { resetAt: bucket.resetAt } : {}),
    trackingOnly: false,
    usedPercent,
    remainingPercent,
    windowKind: bucket.window === 'five-hour' ? 'session' : 'weekly',
    limitWindowSeconds: bucket.window === 'five-hour' ? 5 * 60 * 60 : 7 * 24 * 60 * 60
  }
}

/** Parse the official retrieveUserQuotaSummary response. */
export function parseAntigravityQuotaSummary(
  value: unknown,
  options: { planName?: string | null; fetchedAt?: string } = {}
): NormalizedProviderUsageSnapshot | null {
  const response = record(value)
  const groups = Array.isArray(response?.groups) ? response.groups : []
  const candidates = groups
    .flatMap((group) => {
      const buckets = record(group)?.buckets
      return Array.isArray(buckets) ? buckets : []
    })
    .map(parseBucket)
    .filter((bucket): bucket is ParsedBucket => Boolean(bucket))

  const hasDedicatedThirdParty = candidates.some(
    (bucket) => bucket.family === 'claude' || bucket.family === 'gpt'
  )
  const active = candidates.filter(
    (bucket) => bucket.family !== 'third-party' || !hasDedicatedThirdParty
  )
  if (!active.some((bucket) => bucket.family === 'gemini')) return null

  const windows = active
    .sort((left, right) => bucketOrder(left) - bucketOrder(right))
    .map(bucketWindow)
  if (windows.length === 0) return null
  return {
    provider: 'antigravity',
    source: 'agy-quota-summary',
    configured: true,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    windows,
    ...(nonEmptyString(options.planName) ? { planType: options.planName!.trim() } : {})
  }
}

async function boundedJsonResponse(response: Response): Promise<unknown | null> {
  if (!response.ok) return null
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) return null
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit
): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal })
    return await boundedJsonResponse(response)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function usableAccessToken(
  session: AntigravityOAuthSession,
  fetchImpl: FetchLike,
  now: number
): Promise<string | null> {
  const expiry = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN
  if (!Number.isFinite(expiry) || expiry > now + TOKEN_REFRESH_LEEWAY_MS) {
    return session.accessToken
  }
  if (!session.refreshToken) return null
  const form = new URLSearchParams({
    client_id: AGY_OAUTH_CLIENT_ID,
    client_secret: AGY_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken
  })
  const refreshed = record(
    await requestJson(fetchImpl, OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    })
  )
  return nonEmptyString(refreshed?.access_token)
}

function agyHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/cli/1.1.9 (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`
  }
}

/**
 * Read the official CLI session locally and request its quota summary. No
 * token, raw response, or credential path is returned to the renderer.
 */
export async function fetchAntigravityCliQuotaSummary(
  dependencies: AntigravityQuotaSummaryDependencies = {}
): Promise<NormalizedProviderUsageSnapshot | null> {
  const tokenFilePath =
    dependencies.tokenFilePath ??
    antigravityOAuthTokenPath(dependencies.env ?? process.env, dependencies.homeDir)
  try {
    const info = await stat(tokenFilePath)
    if (!info.isFile() || info.size <= 0 || info.size > TOKEN_FILE_MAX_BYTES) return null
  } catch {
    return null
  }

  let tokenEnvelope: unknown
  try {
    tokenEnvelope = JSON.parse(await readFile(tokenFilePath, 'utf8')) as unknown
  } catch {
    return null
  }
  const session = parseAntigravityOAuthSession(tokenEnvelope)
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  if (!session || typeof fetchImpl !== 'function') return null
  const now = dependencies.now?.() ?? Date.now()
  const accessToken = await usableAccessToken(session, fetchImpl, now)
  if (!accessToken) return null

  const metadata = record(
    await requestJson(fetchImpl, LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: agyHeaders(accessToken),
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
    })
  )
  const project = nonEmptyString(metadata?.cloudaicompanionProject)
  if (!project) return null
  const paidTier = record(metadata?.paidTier)
  const currentTier = record(metadata?.currentTier)
  const planName = nonEmptyString(paidTier?.name) ?? nonEmptyString(currentTier?.name)

  const summary = await requestJson(fetchImpl, QUOTA_SUMMARY_URL, {
    method: 'POST',
    headers: agyHeaders(accessToken),
    body: JSON.stringify({ project })
  })
  return parseAntigravityQuotaSummary(summary, {
    planName,
    fetchedAt: new Date(now).toISOString()
  })
}
