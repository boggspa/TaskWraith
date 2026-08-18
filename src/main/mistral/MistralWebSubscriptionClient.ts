/**
 * Reads the two usage bars off admin.mistral.ai/subscription using an imported
 * web-session cookie header (see MistralWebSessionStore).
 *
 * This is an HTML scrape of an authenticated page — the same contract Limit
 * Counter ships (its `parseSubscriptionHTML`), ported verbatim so the two apps
 * read identical numbers: slice the page at the "API usage" and "Vibe Code
 * usage" headings, take the first two currency amounts in each slice as
 * spent/allowance, and the "Resets in N days/hours" phrase as the period end.
 * A markup change on Mistral's side breaks both apps the same way; the parser
 * fails closed to null rather than guessing.
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

function extractCurrencyAmounts(chunk: string): number[] {
  const regex = /(?:€|\$|£|EUR|USD|GBP)\s*([0-9]+(?:\.[0-9]+)?)/gi
  const matches = [...chunk.matchAll(regex)]
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
  if (
    html.includes('Sign in to your account') ||
    (html.includes('/login') && !html.includes('API usage'))
  ) {
    return null
  }

  let currency = 'EUR'
  if (html.includes('€')) currency = 'EUR'
  else if (html.includes('$')) currency = 'USD'
  else if (html.includes('£')) currency = 'GBP'

  let planName: string | undefined = undefined
  const planMatch = html.match(/CURRENT PLAN[\s\S]*?(Pro|Team|Enterprise|Free)/i)
  if (planMatch) {
    planName = planMatch[1]
  } else if (/Pro/i.test(html)) {
    planName = 'Pro'
  }

  let apiSpent: number | undefined = undefined
  let apiAllowance: number | undefined = undefined
  let apiResetDate: Date | undefined = undefined

  const apiIdx = html.toLowerCase().indexOf('api usage')
  if (apiIdx !== -1) {
    const start = apiIdx
    const vibeIdx = html.toLowerCase().indexOf('vibe code usage', start)
    const endLimit = vibeIdx !== -1 ? vibeIdx : Math.min(html.length, start + 1200)
    const chunk = html.slice(start, endLimit)
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

  const vibeIdx = html.toLowerCase().indexOf('vibe code usage')
  if (vibeIdx !== -1) {
    const start = vibeIdx
    const paygoIdx = html.toLowerCase().indexOf('pay-as-you-go', start)
    const estIdx = html.toLowerCase().indexOf('estimated price', start)
    let endLimit = html.length
    if (paygoIdx !== -1) endLimit = Math.min(endLimit, paygoIdx)
    if (estIdx !== -1) endLimit = Math.min(endLimit, estIdx)
    if (endLimit === html.length) endLimit = Math.min(html.length, start + 1200)

    const chunk = html.slice(start, endLimit)
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
