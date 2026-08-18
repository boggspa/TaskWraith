/**
 * Reads the two usage bars off admin.mistral.ai/subscription using an imported
 * web-session cookie header (see MistralWebSessionStore).
 *
 * This is an HTML scrape of an authenticated page, same contract as Limit
 * Counter's `parseSubscriptionHTML` — but hardened past it, because LC's
 * raw-markup scan was observed HALF-PARSING the live page (2026-08-18): API
 * extracted, Vibe deterministically nil. The console is a Next.js app, so the
 * server HTML is not the rendered DOM — landmarks are duplicated into the RSC
 * flight payload inside <script> tags, React emits `<!-- -->` separators
 * inside interpolated text (splitting `€` from its digits), and tooltip copy
 * ("Pay-as-you-go for Vibe Code…") renders inline where LC used it as a chunk
 * boundary, clipping the Vibe amounts out of their own section.
 *
 * So this parser (1) reduces the page to its VISIBLE TEXT first — scripts,
 * styles, comments, and tags stripped — which removes the RSC duplicates and
 * rejoins split amounts; (2) slices at the "API usage" / "Vibe Code usage"
 * headings with boundaries scoped after the section start; and (3) prefers
 * the exact `<spent> of <allowance>` currency pair the bar renders, which
 * tooltip prose and the pay-as-you-go block's own figures never match. It
 * still fails closed to null rather than guessing.
 */

export interface MistralWebSubscriptionResult {
  planName?: string
  apiSpent?: number
  apiAllowance?: number
  vibeSpent?: number
  vibeAllowance?: number
  currency: string
  periodEnd?: Date
}

const FETCH_TIMEOUT_MS = 15_000

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
} as const

/**
 * Server HTML → the visible text a browser would render, near enough for
 * landmark and amount scanning. Comments are removed WITHOUT padding (React's
 * `<!-- -->` separators sit inside amounts); tags become single spaces.
 */
function htmlToVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
}

const CURRENCY_AMOUNT = /(?:€|\$|£|EUR|USD|GBP)\s*([0-9]+(?:\.[0-9]+)?)/gi
/** The bar's own text: "€21.30 of €255.00". Tooltip prose and the
 *  pay-as-you-go block's standalone figures never form this pair. */
const CURRENCY_PAIR =
  /(?:€|\$|£|EUR|USD|GBP)\s*([0-9]+(?:\.[0-9]+)?)\s+of\s+(?:€|\$|£|EUR|USD|GBP)\s*([0-9]+(?:\.[0-9]+)?)/i

function extractCurrencyAmounts(chunk: string): number[] {
  const pair = chunk.match(CURRENCY_PAIR)
  if (pair) {
    const spent = Number(pair[1])
    const allowance = Number(pair[2])
    if (Number.isFinite(spent) && Number.isFinite(allowance)) return [spent, allowance]
  }
  const matches = [...chunk.matchAll(CURRENCY_AMOUNT)]
  return matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
}

function extractResetDate(chunk: string, now: Date): Date | undefined {
  let m = chunk.match(/(?:Resets?\s+in\s+([0-9]+)\s*(?:days?|d))/i)
  if (m) {
    const d = Number(m[1])
    return new Date(now.getTime() + d * 86400 * 1000)
  }
  m = chunk.match(/(?:Resets?\s+in\s+([0-9]+)\s*(?:hours?|hrs?|h))/i)
  if (m) {
    const h = Number(m[1])
    return new Date(now.getTime() + h * 3600 * 1000)
  }
  return undefined
}

/** Pure parser half, exported for fixture tests. Null = signed out or the
 *  page no longer carries either usage section. */
export function parseMistralSubscriptionHtml(
  html: string,
  now = new Date()
): MistralWebSubscriptionResult | null {
  // The login-wall heuristics run on the RAW markup: '/login' lives in href
  // attributes, which the visible-text reduction strips.
  if (
    html.includes('Sign in to your account') ||
    (html.includes('/login') && !html.includes('API usage'))
  ) {
    return null
  }

  const text = htmlToVisibleText(html)
  const lowerText = text.toLowerCase()

  let currency = 'EUR'
  if (text.includes('€')) currency = 'EUR'
  else if (text.includes('$')) currency = 'USD'
  else if (text.includes('£')) currency = 'GBP'

  let planName: string | undefined = undefined
  const planMatch = text.match(/CURRENT PLAN[\s\S]*?(Pro|Team|Enterprise|Free)/i)
  if (planMatch) {
    planName = planMatch[1]
  } else if (/Pro/i.test(text)) {
    planName = 'Pro'
  }

  let apiSpent: number | undefined = undefined
  let apiAllowance: number | undefined = undefined
  let apiResetDate: Date | undefined = undefined

  const apiIdx = lowerText.indexOf('api usage')
  if (apiIdx !== -1) {
    const start = apiIdx
    const vibeIdx = lowerText.indexOf('vibe code usage', start)
    const endLimit = vibeIdx !== -1 ? vibeIdx : Math.min(text.length, start + 1200)
    const chunk = text.slice(start, endLimit)
    const amounts = extractCurrencyAmounts(chunk)
    if (amounts.length >= 2) {
      apiSpent = amounts[0]
      apiAllowance = amounts[1]
    } else if (amounts.length === 1) {
      apiSpent = amounts[0]
    }
    apiResetDate = extractResetDate(chunk, now)
  }

  let vibeSpent: number | undefined = undefined
  let vibeAllowance: number | undefined = undefined
  let vibeResetDate: Date | undefined = undefined

  const vibeIdx = lowerText.indexOf('vibe code usage')
  if (vibeIdx !== -1) {
    const start = vibeIdx
    // Boundary: the estimated-price block only. LC also cut at
    // 'pay-as-you-go', and the tooltip mentioning it mid-section is exactly
    // what clipped the Vibe amounts on the live page; the pair-first
    // extraction keeps the pay-as-you-go block's own figures out instead.
    const estIdx = lowerText.indexOf('estimated price', start)
    const endLimit = estIdx !== -1 ? estIdx : Math.min(text.length, start + 1200)

    const chunk = text.slice(start, endLimit)
    const amounts = extractCurrencyAmounts(chunk)
    if (amounts.length >= 2) {
      vibeSpent = amounts[0]
      vibeAllowance = amounts[1]
    } else if (amounts.length === 1) {
      vibeSpent = amounts[0]
    }
    vibeResetDate = extractResetDate(chunk, now)
  }

  if (apiSpent === undefined && vibeSpent === undefined) return null

  return {
    planName,
    apiSpent,
    apiAllowance,
    vibeSpent,
    vibeAllowance,
    currency,
    periodEnd: vibeResetDate ?? apiResetDate
  }
}

export async function fetchMistralWebSubscription(
  cookieHeader: string,
  now = new Date()
): Promise<MistralWebSubscriptionResult | null> {
  try {
    const res = await fetch('https://admin.mistral.ai/subscription', {
      headers: { Cookie: cookieHeader, ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    // A signed-out session bounces to the login page; treat the redirect
    // itself as "not signed in" rather than parsing the login markup.
    try {
      if (new URL(res.url).pathname.includes('/login')) return null
    } catch {
      // An unparseable final URL is not by itself a failure; the body check
      // below still guards the signed-out case.
    }
    return parseMistralSubscriptionHtml(await res.text(), now)
  } catch {
    return null
  }
}
