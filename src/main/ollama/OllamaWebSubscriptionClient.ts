/**
 * Reads the account's Session (5-hour) and Weekly usage meters off
 * https://ollama.com/settings using an imported web-session cookie
 * (see OllamaWebSessionStore; the cookie is `__Secure-session`).
 *
 * This is an HTML scrape of an authenticated page — the contract is ported
 * verbatim from Limit Counter's OllamaProviderClient so both apps read the
 * same numbers. Both windows come from the one /settings page, split at the
 * "Session usage" / "Weekly usage" headings; the percent for each chunk comes
 * from a cascade rather than one regex, because the page renders the figure
 * differently across states:
 *
 *   weekly  "Limit reached" or "100% used"      -> 100
 *   session "Weekly limit reached"              -> 0 (the weekly cap is what
 *                                                  blocks you; the 5h window
 *                                                  itself is idle)
 *   aria-label="... N% ..."                     -> N
 *   width: N%                                   -> N
 *   plain "N%" / "N% used"                      -> N
 *
 * A markup change on Ollama's side breaks both apps the same way; the parser
 * fails closed to null rather than guessing.
 */

export interface OllamaWebSubscriptionResult {
  sessionUsedPercent?: number
  sessionResetDescription?: string
  weeklyUsedPercent?: number
  weeklyResetDescription?: string
}

const FETCH_TIMEOUT_MS = 15_000

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
} as const

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function extractUsedPercent(chunk: string, role: 'session' | 'weekly'): number | undefined {
  if (role === 'weekly' && (/limit reached/i.test(chunk) || /100%\s*used/i.test(chunk))) {
    return 100
  }
  if (role === 'session' && /weekly limit reached/i.test(chunk)) return 0
  const aria = chunk.match(/aria-label="[^"]*?(\d+(?:\.\d+)?)\s*%/i)
  if (aria) return clampPercent(Number(aria[1]))
  const width = chunk.match(/width:\s*(\d+(?:\.\d+)?)%/i)
  if (width) return clampPercent(Number(width[1]))
  const plain = chunk.match(/(\d+(?:\.\d+)?)\s*%(?:\s*used)?/i)
  if (plain) return clampPercent(Number(plain[1]))
  return undefined
}

function extractResetDescription(chunk: string, role: 'session' | 'weekly'): string | undefined {
  const resume = chunk.match(/sessions?\s+resume\s+in\s+(\d+)\s*(days?|hours?)/i)
  if (resume) {
    return `Resumes in ${resume[1]}${resume[2].toLowerCase().startsWith('d') ? 'd' : 'h'}`
  }
  const resets = chunk.match(/resets?\s+in\s+(\d+)\s*(hours?|days?)/i)
  if (resets) {
    return `Resets in ${resets[1]}${resets[2].toLowerCase().startsWith('h') ? 'h' : 'd'}`
  }
  if (role === 'weekly' && /limit reached/i.test(chunk)) return 'Weekly limit reached'
  return undefined
}

function sectionIndex(lowerHtml: string, primary: string, fallback: string): number {
  const primaryIdx = lowerHtml.indexOf(primary)
  return primaryIdx !== -1 ? primaryIdx : lowerHtml.indexOf(fallback)
}

/** Pure parser half, exported for fixture tests. Null = signed out or the
 *  page no longer carries either usage section. */
export function parseOllamaSettingsHtml(html: string): OllamaWebSubscriptionResult | null {
  if (
    html.includes('Sign in to Ollama') ||
    (html.includes('/login') && !html.includes('Session usage') && !html.includes('Weekly usage'))
  ) {
    return null
  }

  const lower = html.toLowerCase()
  const sessionIdx = sectionIndex(lower, 'session usage', 'session')
  const weeklyIdx = sectionIndex(lower, 'weekly usage', 'weekly')

  let sessionUsedPercent: number | undefined
  let sessionResetDescription: string | undefined
  if (sessionIdx !== -1) {
    const endIdx =
      weeklyIdx !== -1 && weeklyIdx > sessionIdx
        ? weeklyIdx
        : Math.min(html.length, sessionIdx + 1000)
    const chunk = html.slice(sessionIdx, endIdx)
    sessionUsedPercent = extractUsedPercent(chunk, 'session')
    sessionResetDescription = extractResetDescription(chunk, 'session')
  }

  let weeklyUsedPercent: number | undefined
  let weeklyResetDescription: string | undefined
  if (weeklyIdx !== -1) {
    const modelsIdx = lower.indexOf('models used', weeklyIdx)
    const endIdx = modelsIdx !== -1 ? modelsIdx : Math.min(html.length, weeklyIdx + 1000)
    const chunk = html.slice(weeklyIdx, endIdx)
    weeklyUsedPercent = extractUsedPercent(chunk, 'weekly')
    weeklyResetDescription = extractResetDescription(chunk, 'weekly')
  }

  if (sessionUsedPercent === undefined && weeklyUsedPercent === undefined) return null

  return {
    sessionUsedPercent,
    sessionResetDescription,
    weeklyUsedPercent,
    weeklyResetDescription
  }
}

export async function fetchOllamaWebSubscription(
  cookieHeader: string
): Promise<OllamaWebSubscriptionResult | null> {
  try {
    const res = await fetch('https://ollama.com/settings', {
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
    return parseOllamaSettingsHtml(await res.text())
  } catch {
    return null
  }
}
