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
    startUrl: 'https://cloud.cerebras.ai/platform/',
    partition: 'websession-import:cerebras-usage',
    cookieDomainSuffixes: ['cerebras.ai']
  },
  qwen: {
    provider: 'qwen',
    windowTitle: 'Sign in to Qwen Token Plan',
    startUrl:
      'https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan#/efm/subscription/token-plan/personal',
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
  const currentIndex = lowered.indexOf('current usage')
  const weeklyIndex = lowered.indexOf('weekly limit')
  let currentUsedPercent: number | undefined
  if (currentIndex >= 0) {
    const end = weeklyIndex > currentIndex ? weeklyIndex : Math.min(text.length, currentIndex + 300)
    currentUsedPercent = subscriptionUsedPercent(text.slice(currentIndex, end))
  }
  let weeklyUsedPercent: number | undefined
  let resetAt: string | undefined
  if (weeklyIndex >= 0) {
    const payAsYouGoIndex = lowered.indexOf('pay as you go', weeklyIndex)
    const end = payAsYouGoIndex >= 0 ? payAsYouGoIndex : Math.min(text.length, weeklyIndex + 400)
    const chunk = text.slice(weeklyIndex, end)
    weeklyUsedPercent = subscriptionUsedPercent(chunk)
    resetAt = parsedDayMonthResetAt(chunk, capturedAt) ?? parsedResetAt(chunk)
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
  const text = normalizedUsagePageText(pageTextOrHtml)
  if (!text) return null
  if (provider === 'muse') return parseMuseSubscriptionReading(text, capturedAt)
  return provider === 'meta' || provider === 'cerebras'
    ? parseBillingReading(text, capturedAt)
    : parseTokenPlanReading(text, capturedAt)
}

/**
 * Refresh server-rendered Meta billing, Muse subscription, and Cerebras
 * billing pages with the encrypted session. Qwen/MiMo are client-rendered, so
 * their validated import-time reading remains authoritative until the user
 * re-imports.
 */
export async function readUsageWebSessionReading(
  provider: UsageWebSessionProviderId,
  dependencies: { fetchImpl?: FetchLike; now?: () => number } = {}
): Promise<UsageWebSessionReading | null> {
  const store = usageWebSessionStore(provider)
  const stored = store?.loadSession()
  if (!stored) return null
  if (provider === 'qwen' || provider === 'mimo') return stored.reading

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') return stored.reading
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
    if (!response.ok) return stored.reading
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
      return stored.reading
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) return stored.reading
    const capturedAt = new Date(dependencies.now?.() ?? Date.now()).toISOString()
    const reading = parseUsageWebSessionReading(provider, text, capturedAt)
    if (!reading) return stored.reading
    store?.setSession({ cookieHeader: stored.cookieHeader, reading })
    return reading
  } catch {
    return stored.reading
  } finally {
    clearTimeout(timer)
  }
}
