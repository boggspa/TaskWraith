import type {
  UsageWebSessionProviderId,
  UsageWebSessionReading
} from '../../shared/usageWebSession'
import { usageWebSessionStore } from './UsageWebSessionStore'

const RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface UsageWebSessionSpec {
  provider: UsageWebSessionProviderId
  windowTitle: string
  startUrl: string
  partition: string
  cookieDomainSuffixes: readonly string[]
}

export const USAGE_WEB_SESSION_SPECS: Record<UsageWebSessionProviderId, UsageWebSessionSpec> = {
  meta: {
    provider: 'meta',
    windowTitle: 'Sign in to Meta API billing',
    startUrl: 'https://dev.meta.ai/billing/',
    partition: 'websession-import:meta-usage',
    cookieDomainSuffixes: ['meta.ai', 'meta.com']
  },
  muse: {
    provider: 'muse',
    windowTitle: 'Sign in to Meta Muse Code usage',
    startUrl: 'https://dev.meta.ai/usage/',
    partition: 'websession-import:muse-subscription',
    cookieDomainSuffixes: ['meta.ai', 'meta.com']
  },
  cerebras: {
    provider: 'cerebras',
    windowTitle: 'Sign in to Cerebras billing',
    startUrl: 'https://cloud.cerebras.ai/platform/billing',
    partition: 'websession-import:cerebras-usage',
    cookieDomainSuffixes: ['cerebras.ai']
  },
  qwen: {
    provider: 'qwen',
    windowTitle: 'Sign in to Qwen Token Plan',
    startUrl:
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan&productCode=p_efm#/efm/subscription/token-plan/personal',
    partition: 'websession-import:qwen-token-plan',
    cookieDomainSuffixes: ['alibabacloud.com']
  },
  mimo: {
    provider: 'mimo',
    windowTitle: 'Sign in to Xiaomi MiMo Token Plan',
    startUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
    partition: 'websession-import:mimo-token-plan',
    cookieDomainSuffixes: ['xiaomimimo.com']
  }
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lowered = entity.toLowerCase()
    if (lowered.startsWith('#')) {
      const hex = lowered.startsWith('#x')
      const parsed = Number.parseInt(lowered.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match
    }
    return entities[lowered] ?? match
  })
}

export function normalizedUsagePageText(value: string): string {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, ' $1 ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/\s*(?:div|p|li|tr|section|article|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Rendered text the way a browser shows it: scripts/styles dropped, tags
 * collapsed to spaces, entities decoded, whitespace collapsed. Ports
 * Limit Counter's `normalizedRenderedText` (SpendProviderClients.swift): React
 * SSR inserts `<!-- -->` between text segments and amounts can be split
 * across inline elements, so comments are stripped before tags collapse.
 */
export function normalizedRenderedPageText(value: string): string {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/\s*(?:div|p|li|tr|section|article|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodedJavaScriptEscapes(value: string): string {
  return String(value || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
      const parsed = Number.parseInt(hex, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => {
      const parsed = Number.parseInt(hex, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _
    })
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/')
}

/**
 * Script bodies (Next.js RSC flight payload and similar) decoded into
 * searchable text, for pages that do not server-render the meters. Ports
 * Limit Counter's `normalizedScriptPayloadText`: the payload carries the same
 * meter strings as escaped JS literals, so escapes are decoded before tags
 * are stripped. Returns '' when the input carries no script bodies.
 */
export function normalizedScriptPayloadText(value: string): string {
  const bodies: string[] = []
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  for (const match of String(value || '').matchAll(pattern)) {
    if (match[1]) bodies.push(match[1])
  }
  if (!bodies.length) return ''
  const text = decodedJavaScriptEscapes(bodies.join(' '))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
}

interface CurrencyAmount {
  amount: number
  currency: string
}

function currencyAmounts(value: string): CurrencyAmount[] {
  const amounts: CurrencyAmount[] = []
  const pattern =
    /([$£€])\s*([0-9][0-9,]*(?:\.[0-9]+)?)|\b(USD|GBP|EUR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*\b(USD|GBP|EUR)\b/gi
  for (const match of value.matchAll(pattern)) {
    const symbol = match[1]
    const raw = match[2] ?? match[4] ?? match[5]
    const code = (match[3] ?? match[6])?.toUpperCase()
    const amount = Number(String(raw).replace(/,/g, ''))
    if (!Number.isFinite(amount) || amount < 0) continue
    const currency = code ?? (symbol === '£' ? 'GBP' : symbol === '€' ? 'EUR' : 'USD')
    amounts.push({ amount, currency })
  }
  return amounts
}

function labeledAmount(text: string, labels: readonly string[]): CurrencyAmount | null {
  const lowered = text.toLowerCase()
  for (const label of labels) {
    let offset = 0
    while (offset < lowered.length) {
      const index = lowered.indexOf(label, offset)
      if (index < 0) break
      const block = text.slice(index + label.length, index + label.length + 400)
      const amount = currencyAmounts(block)[0]
      if (amount) return amount
      offset = index + label.length
    }
  }
  // Some DOM orders render the value element before its label
  // ("$15.00" above "Current balance"); scan a short window backwards as a
  // fallback, taking the amount closest to the label. Ports Limit Counter's
  // backwards scan (SpendProviderClients.swift labeledUsedPercent fallback).
  for (const label of labels) {
    let offset = 0
    while (offset < lowered.length) {
      const index = lowered.indexOf(label, offset)
      if (index < 0) break
      const backWindow = text.slice(Math.max(0, index - 150), index)
      const amounts = currencyAmounts(backWindow)
      if (amounts.length) return amounts[amounts.length - 1]
      offset = index + label.length
    }
  }
  return null
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern)
  return match?.[1]?.trim() || null
}

function parsedResetAt(text: string): string | undefined {
  const raw = firstMatch(
    text,
    /(?:end\s*time|valid\s*until|next\s*reset|resets?(?:\s+on)?)\s*:?[ \t]*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)?(?:\s*\(?UTC\)?)?)/i
  )
  if (!raw) return undefined
  const normalized = raw.replace(/\s*\(?UTC\)?$/i, 'Z').replace(' ', 'T')
  const parsed = new Date(normalized.length === 10 ? `${normalized}T00:00:00Z` : normalized)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function normalizePlanName(value: string): string {
  let normalized = value.replace(/\s+/g, ' ').trim()
  while (/\bPlan\s+Plan$/i.test(normalized)) normalized = normalized.replace(/\s+Plan$/i, '')
  return normalized
}

function tokenPlanName(text: string): string | undefined {
  const named = firstMatch(
    text,
    /\b((?:Lite|Free|Pro|Team|Enterprise|Personal|Basic|Standard|Premium)(?:\s+[A-Za-z0-9+._-]+){0,3}\s+Plan)\b/i
  )
  if (named) return normalizePlanName(named)
  return undefined
}

function parseBillingReading(text: string, capturedAt: string): UsageWebSessionReading | null {
  const balance = labeledAmount(text, [
    'current balance',
    'available balance',
    'available credit',
    'credit balance',
    'remaining balance',
    'balance'
  ])
  const spend = labeledAmount(text, [
    'spend this billing period',
    'spend to date',
    'billing period spend',
    'total spend',
    'used this period',
    'spend'
  ])
  if (!balance && !spend) return null
  return {
    ...(balance ? { balance: balance.amount } : {}),
    ...(spend ? { spend: spend.amount } : {}),
    currency: balance?.currency ?? spend?.currency ?? 'USD',
    ...(parsedResetAt(text) ? { resetAt: parsedResetAt(text) } : {}),
    capturedAt
  }
}

function parseTokenPlanReading(text: string, capturedAt: string): UsageWebSessionReading | null {
  const rawUsed =
    firstMatch(text, /(\d+(?:\.\d+)?)\s*%\s*Used/i) ??
    firstMatch(text, /Used[^0-9%]{0,40}(\d+(?:\.\d+)?)\s*%/i)
  const quotaUsedPercent = rawUsed === null ? undefined : Number(rawUsed)
  const rawDays = firstMatch(text, /Remaining\s*Days?\s*:?\s*(\d+)/i)
  const remainingDays = rawDays === null ? undefined : Number(rawDays)
  const planName = tokenPlanName(text)
  const resetAt = parsedResetAt(text)
  if (
    (quotaUsedPercent === undefined ||
      !Number.isFinite(quotaUsedPercent) ||
      quotaUsedPercent < 0 ||
      quotaUsedPercent > 100) &&
    !planName &&
    !resetAt
  ) {
    return null
  }
  return {
    ...(quotaUsedPercent !== undefined && quotaUsedPercent >= 0 && quotaUsedPercent <= 100
      ? { quotaUsedPercent }
      : {}),
    ...(planName ? { planName } : {}),
    ...(remainingDays !== undefined && Number.isInteger(remainingDays) && remainingDays >= 0
      ? { remainingDays }
      : {}),
    ...(resetAt ? { resetAt } : {}),
    capturedAt
  }
}

const SUBSCRIPTION_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
}

/**
 * "Resets 7 Sep at 01:00" carries no year, so resolve it against the capture
 * time: same local year, rolled one forward when the candidate would land more
 * than a grace window in the past (a weekly reset is never more than 7 days
 * out, so only a genuine Dec→Jan crossover rolls). Local time on purpose — the
 * console renders the viewer's clock, and the refresh runs on the same machine.
 */
function parsedDayMonthResetAt(chunk: string, capturedAt: string): string | undefined {
  const dayFirst = chunk.match(
    /resets?\s+(?:on\s+)?([0-9]{1,2})\s+([A-Za-z]{3,9})\.?(?:\s+at\s+([0-9]{1,2}):([0-9]{2})\s*(am|pm)?)?/i
  )
  const monthFirst = dayFirst
    ? null
    : chunk.match(
        /resets?\s+(?:on\s+)?([A-Za-z]{3,9})\.?\s+([0-9]{1,2})(?:\s+at\s+([0-9]{1,2}):([0-9]{2})\s*(am|pm)?)?/i
      )
  const match = dayFirst ?? monthFirst
  if (!match) return undefined
  const day = Number(dayFirst ? match[1] : match[2])
  const monthName = String(dayFirst ? match[2] : match[1])
    .slice(0, 3)
    .toLowerCase()
  const month = SUBSCRIPTION_MONTHS[monthName]
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return undefined
  let hours = match[3] === undefined ? 0 : Number(match[3])
  const minutes = match[4] === undefined ? 0 : Number(match[4])
  const meridiem = match[5]?.toLowerCase()
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (!Number.isInteger(hours) || hours > 23 || !Number.isInteger(minutes) || minutes > 59) {
    return undefined
  }
  const capturedAtMs = Date.parse(capturedAt)
  const base = Number.isFinite(capturedAtMs) ? new Date(capturedAtMs) : new Date()
  const graceMs = 36 * 60 * 60 * 1000
  let candidate = new Date(base.getFullYear(), month, day, hours, minutes)
  if (candidate.getTime() < base.getTime() - graceMs) {
    candidate = new Date(base.getFullYear() + 1, month, day, hours, minutes)
  }
  return Number.isNaN(candidate.getTime()) ? undefined : candidate.toISOString()
}

function subscriptionUsedPercent(chunk: string): number | undefined {
  if (/limit reached/i.test(chunk)) return 100
  const match = chunk.match(/(\d+(?:\.\d+)?)\s*%\s*used/i) ?? chunk.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : undefined
}

/**
 * Backwards fallback for value-before-label DOM order ("37% used" rendered
 * above "Current usage"). Requires the `used` suffix so an unrelated bare
 * percent nearby cannot match, and takes the closest match to the label.
 * Ports Limit Counter's backwards scan (SpendProviderClients.swift
 * labeledUsedPercent, 80-char window).
 */
function subscriptionUsedPercentBefore(backWindow: string): number | undefined {
  if (/limit reached/i.test(backWindow)) return 100
  const pattern = /(\d+(?:\.\d+)?)\s*%\s*used/gi
  let last: string | undefined
  for (const match of backWindow.matchAll(pattern)) {
    last = match[1]
  }
  if (last === undefined) return undefined
  const parsed = Number(last)
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : undefined
}

function museMeterPercent(
  text: string,
  label: string,
  stops: readonly string[],
  maxLength: number
): number | undefined {
  const lowered = text.toLowerCase()
  const labelLower = label.toLowerCase()
  let offset = 0
  while (offset < lowered.length) {
    const index = lowered.indexOf(labelLower, offset)
    if (index < 0) break
    let end = Math.min(text.length, index + label.length + maxLength)
    for (const stop of stops) {
      const stopIndex = lowered.indexOf(stop.toLowerCase(), index + label.length)
      if (stopIndex >= 0 && stopIndex < end) end = stopIndex
    }
    const percent = subscriptionUsedPercent(text.slice(index, end))
    if (percent !== undefined) return percent
    offset = index + label.length
  }
  offset = 0
  while (offset < lowered.length) {
    const index = lowered.indexOf(labelLower, offset)
    if (index < 0) break
    const percent = subscriptionUsedPercentBefore(text.slice(Math.max(0, index - 80), index))
    if (percent !== undefined) return percent
    offset = index + label.length
  }
  return undefined
}

/**
 * dev.meta.ai/usage — the Muse Code subscription section: a "Current usage"
 * meter, a "Weekly limit" meter with its reset, and the plan name from the
 * "<plan> subscription" heading. The pay-as-you-go spend below it belongs to
 * the existing `meta` billing lane and is deliberately not read here.
 */
function parseMuseSubscriptionReading(
  text: string,
  capturedAt: string
): UsageWebSessionReading | null {
  const lowered = text.toLowerCase()
  const weeklyIndex = lowered.indexOf('weekly limit')
  const currentUsedPercent = museMeterPercent(text, 'current usage', ['weekly limit', 'pay as you go'], 300)
  let weeklyUsedPercent: number | undefined
  let resetAt: string | undefined
  if (weeklyIndex >= 0) {
    const payAsYouGoIndex = lowered.indexOf('pay as you go', weeklyIndex)
    const end = payAsYouGoIndex >= 0 ? payAsYouGoIndex : Math.min(text.length, weeklyIndex + 400)
    const chunk = text.slice(weeklyIndex, end)
    weeklyUsedPercent =
      subscriptionUsedPercent(chunk) ??
      museMeterPercent(text, 'weekly limit', ['current usage', 'pay as you go'], 400)
    resetAt = parsedDayMonthResetAt(chunk, capturedAt) ?? parsedResetAt(chunk)
  } else {
    weeklyUsedPercent = museMeterPercent(text, 'weekly limit', ['current usage', 'pay as you go'], 400)
  }
  if (currentUsedPercent === undefined && weeklyUsedPercent === undefined) return null
  const planName = firstMatch(text, /\b(Muse[\w .+-]{0,50}?)\s+subscription\b/i)
  return {
    ...(currentUsedPercent !== undefined ? { currentUsedPercent } : {}),
    ...(weeklyUsedPercent !== undefined ? { weeklyUsedPercent } : {}),
    ...(planName ? { planName: planName.replace(/\s+/g, ' ').trim() } : {}),
    ...(resetAt ? { resetAt } : {}),
    capturedAt
  }
}

export function parseUsageWebSessionReading(
  provider: UsageWebSessionProviderId,
  pageTextOrHtml: string,
  capturedAt: string = new Date().toISOString()
): UsageWebSessionReading | null {
  // Dual parse, ports Limit Counter's rendered-text + RSC-payload entry
  // (SpendProviderClients.swift parse(renderedText:payloadText:)): the meters
  // may be server-rendered markup or embedded escaped in a Next.js flight
  // payload. Rendered wins; the payload is the fallback. Already-rendered
  // `innerText` (the import sheet) yields no payload, so the second attempt
  // is a no-op there.
  const rendered = normalizedRenderedPageText(pageTextOrHtml)
  const payload = normalizedScriptPayloadText(pageTextOrHtml)
  for (const text of [rendered, payload]) {
    if (!text) continue
    const reading =
      provider === 'muse'
        ? parseMuseSubscriptionReading(text, capturedAt)
        : provider === 'meta' || provider === 'cerebras'
          ? parseBillingReading(text, capturedAt)
          : parseTokenPlanReading(text, capturedAt)
    if (reading) return reading
  }
  return null
}

/** Cadence guards for the server refresh below. The quota poll that drives it
 * can fire every ~30 seconds, and Meta hosts two lanes (billing + Muse
 * subscription) on one dev.meta.ai origin — being rate-limited or blocked
 * there would take both meters out at once, so the readings refresh at a
 * console-friendly pace instead of the poll's. */
const REFRESH_SUCCESS_TTL_MS = 15 * 60 * 1000
const REFRESH_FAILURE_RETRY_MS = 5 * 60 * 1000
const REFRESH_BLOCKED_RETRY_MS = 60 * 60 * 1000

interface UsageWebSessionRefreshGate {
  cookieHeader: string
  nextAttemptAtMs: number
}

const refreshGates = new Map<UsageWebSessionProviderId, UsageWebSessionRefreshGate>()
const refreshInFlight = new Map<UsageWebSessionProviderId, Promise<UsageWebSessionReading | null>>()

function cookieDomainMatches(host: string, allowedDomain: string): boolean {
  const normalizedHost = host.trim().replace(/^\.+/, '').toLowerCase()
  const normalizedDomain = allowedDomain.trim().replace(/^\.+/, '').toLowerCase()
  if (!normalizedHost || !normalizedDomain) return false
  return (
    normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
  )
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  const normalized = !cookiePath ? '/' : cookiePath
  if (normalized === '/') return true
  if (!requestPath.startsWith(normalized)) return false
  return (
    requestPath.length === normalized.length ||
    normalized.endsWith('/') ||
    requestPath[normalized.length] === '/'
  )
}

function readSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as unknown as { getSetCookie?: () => string[] }
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    try {
      const values = withGetSetCookie.getSetCookie() ?? []
      if (Array.isArray(values)) return values.filter((value) => typeof value === 'string' && value.trim())
    } catch {
      return []
    }
    return []
  }
  // Undici exposes multi-cookie responses via getSetCookie() above; a lone
  // `set-cookie` header is the legacy fallback. Comma-joined values are split
  // best-effort (an Expires date carries a comma, so only split where the next
  // segment opens a new name=value pair).
  const single = headers.get('set-cookie')
  if (!single) return []
  return single
    .split(/,(?=[^;,]*=)/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Merge response `Set-Cookie` values into the stored cookie header, ports
 * Limit Counter's `ImportedCookieHeaderMerger` (SpendProviderClients.swift):
 * the console rotates session cookies on reads, and without the merge every
 * refresh after the first replays a stale session. Domain/path scope and
 * expiry deletion follow the reference; anything outside `allowedDomains`
 * never enters the stored header.
 *
 * Returns the merged header when at least one cookie applied and the result
 * differs, else null (nothing worth persisting). Pure function — persistence
 * stays with the caller so the encrypted store shape is untouched.
 */
export function mergeUsageWebSessionCookieHeader(
  existingHeader: string,
  setCookieValues: readonly string[],
  requestUrl: string,
  allowedDomains: readonly string[],
  nowMs: number = Date.now()
): string | null {
  if (!setCookieValues.length) return null
  let requestHost = ''
  let requestPath = '/'
  try {
    const parsed = new URL(requestUrl)
    requestHost = (parsed.hostname || '').toLowerCase()
    requestPath = parsed.pathname || '/'
  } catch {
    return null
  }
  const order: string[] = []
  const values = new Map<string, string>()
  for (const component of String(existingHeader || '').split(';')) {
    const separator = component.indexOf('=')
    if (separator < 0) continue
    const name = component.slice(0, separator).trim()
    if (!name || values.has(name)) continue
    order.push(name)
    values.set(name, component.slice(separator + 1).trim())
  }
  let didApplyCookie = false
  for (const setCookie of setCookieValues) {
    const segments = String(setCookie || '').split(';')
    const pair = segments.shift() ?? ''
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!name) continue
    let cookieDomain = requestHost
    let cookiePath = '/'
    let expiresMs: number | undefined
    let maxAge: number | undefined
    for (const segment of segments) {
      const trimmed = segment.trim()
      const equals = trimmed.indexOf('=')
      const attrName = (equals < 0 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase()
      const attrValue = equals < 0 ? '' : trimmed.slice(equals + 1).trim()
      if (attrName === 'domain' && attrValue) {
        cookieDomain = attrValue.replace(/^\.+/, '').toLowerCase()
      } else if (attrName === 'path' && attrValue) {
        cookiePath = attrValue
      } else if (attrName === 'expires' && attrValue) {
        const parsed = Date.parse(attrValue)
        if (Number.isFinite(parsed)) expiresMs = parsed
      } else if (attrName === 'max-age' && attrValue) {
        const parsed = Number(attrValue)
        if (Number.isFinite(parsed)) maxAge = parsed
      }
    }
    if (!cookieDomainMatches(requestHost, cookieDomain)) continue
    const allowed =
      !allowedDomains.length ||
      allowedDomains.some(
        (allowedDomain) =>
          cookieDomainMatches(cookieDomain, allowedDomain) ||
          cookieDomainMatches(requestHost, allowedDomain)
      )
    if (!allowed || !cookiePathMatches(requestPath, cookiePath)) continue
    didApplyCookie = true
    if ((maxAge !== undefined && maxAge <= 0) || (expiresMs !== undefined && expiresMs <= nowMs)) {
      values.delete(name)
      const at = order.indexOf(name)
      if (at >= 0) order.splice(at, 1)
      continue
    }
    if (!values.has(name)) order.push(name)
    values.set(name, value)
  }
  if (!didApplyCookie) return null
  const merged = order
    .filter((name) => values.has(name))
    .map((name) => `${name}=${values.get(name)}`)
    .join('; ')
  return merged === String(existingHeader || '').trim() ? null : merged
}

async function refreshStoredUsageWebSessionReading(
  provider: UsageWebSessionProviderId,
  stored: { cookieHeader: string; reading: UsageWebSessionReading },
  gate: UsageWebSessionRefreshGate,
  dependencies: { fetchImpl?: FetchLike; now?: () => number }
): Promise<UsageWebSessionReading | null> {
  const now = () => dependencies.now?.() ?? Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      gate.nextAttemptAtMs = now() + REFRESH_FAILURE_RETRY_MS
      return stored.reading
    }
    const response = await fetchImpl(USAGE_WEB_SESSION_SPECS[provider].startUrl, {
      method: 'GET',
      headers: {
        Cookie: stored.cookieHeader,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36'
      },
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      // An explicit rate limit or refusal earns the long back-off; anything
      // else retries on the shorter window. Either way the stored reading
      // keeps serving, and staleness surfaces through its own capture age.
      gate.nextAttemptAtMs =
        now() +
        (response.status === 429 || response.status === 403
          ? REFRESH_BLOCKED_RETRY_MS
          : REFRESH_FAILURE_RETRY_MS)
      return stored.reading
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
      gate.nextAttemptAtMs = now() + REFRESH_FAILURE_RETRY_MS
      return stored.reading
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) {
      gate.nextAttemptAtMs = now() + REFRESH_FAILURE_RETRY_MS
      return stored.reading
    }
    const capturedAt = new Date(now()).toISOString()
    const reading = parseUsageWebSessionReading(provider, text, capturedAt)
    const rotatedHeader = mergeUsageWebSessionCookieHeader(
      stored.cookieHeader,
      readSetCookieValues(response.headers),
      USAGE_WEB_SESSION_SPECS[provider].startUrl,
      USAGE_WEB_SESSION_SPECS[provider].cookieDomainSuffixes,
      now()
    )
    if (!reading) {
      if (rotatedHeader) {
        // The rotation is server-issued freshness while the parse failure is
        // ours — keep the fresh session rather than replaying stale cookies.
        usageWebSessionStore(provider)?.setSession({
          cookieHeader: rotatedHeader,
          reading: stored.reading
        })
        gate.cookieHeader = rotatedHeader
      }
      gate.nextAttemptAtMs = now() + REFRESH_FAILURE_RETRY_MS
      return stored.reading
    }
    if (rotatedHeader) gate.cookieHeader = rotatedHeader
    usageWebSessionStore(provider)?.setSession({
      cookieHeader: rotatedHeader ?? stored.cookieHeader,
      reading
    })
    gate.nextAttemptAtMs = now() + REFRESH_SUCCESS_TTL_MS
    return reading
  } catch {
    gate.nextAttemptAtMs = now() + REFRESH_FAILURE_RETRY_MS
    return stored.reading
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Refresh server-rendered Meta billing, Muse subscription, and Cerebras
 * billing pages with the encrypted session. Qwen/MiMo are client-rendered, so
 * their validated import-time reading remains authoritative until the user
 * re-imports.
 *
 * Network refreshes are throttled per provider: a success holds for
 * `REFRESH_SUCCESS_TTL_MS` (anchored to the reading's own capture time, so a
 * fresh import starts quiet and an app restart does not re-fetch early), a
 * failure retries no sooner than `REFRESH_FAILURE_RETRY_MS`, and an explicit
 * 429/403 backs off for `REFRESH_BLOCKED_RETRY_MS`. Concurrent callers share
 * one in-flight request. Inside a gate window the stored reading serves as-is.
 *
 * Rendered-page fallback, assessed and deliberately not ported: Limit Counter
 * keeps a hidden WKWebView load for client-side-only rollouts of the Meta
 * console (macOS only). Fetch-only suffices here because (a) the import sheet
 * (`WebSessionBrowser`) already captures `document.body.innerText` — the true
 * rendered path — at import time, (b) the server refresh covers only
 * meta/muse/cerebras, which server-render or embed the same meters in the RSC
 * flight payload that the dual parse reads, and (c) the genuinely
 * client-rendered lanes (qwen/mimo) are import-authoritative by design. A
 * hidden window in headless main would add a GPU/renderer failure surface for
 * no new data.
 */
export async function readUsageWebSessionReading(
  provider: UsageWebSessionProviderId,
  dependencies: { fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<UsageWebSessionReading | null> {
  const store = usageWebSessionStore(provider)
  const stored = store?.loadSession()
  if (!stored) {
    refreshGates.delete(provider)
    return null
  }
  if (provider === 'qwen' || provider === 'mimo') return stored.reading

  const readAt = dependencies.now?.() ?? Date.now()
  let gate = refreshGates.get(provider)
  if (!gate || gate.cookieHeader !== stored.cookieHeader) {
    const capturedAtMs = Date.parse(stored.reading.capturedAt)
    gate = {
      cookieHeader: stored.cookieHeader,
      nextAttemptAtMs: Number.isFinite(capturedAtMs)
        ? capturedAtMs + REFRESH_SUCCESS_TTL_MS
        : readAt
    }
    refreshGates.set(provider, gate)
  }
  if (readAt < gate.nextAttemptAtMs) return stored.reading

  const inFlight = refreshInFlight.get(provider)
  if (inFlight) return inFlight
  const request = refreshStoredUsageWebSessionReading(provider, stored, gate, dependencies)
  refreshInFlight.set(provider, request)
  void request.finally(() => {
    if (refreshInFlight.get(provider) === request) refreshInFlight.delete(provider)
  })
  return request
}
