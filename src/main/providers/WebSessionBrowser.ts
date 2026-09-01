import { BrowserWindow, session as electronSession, type Cookie } from 'electron'
import {
  fetchMistralWebSubscription,
  type MistralWebSubscriptionResult
} from '../mistral/MistralWebSubscriptionClient'
import {
  fetchKimiWebMonthlyUsage,
  type KimiWebMonthlyReading
} from '../kimi/KimiWebSubscriptionClient'
import { serializeKimiWebSessionTokens } from '../kimi/KimiWebUsage'
import {
  fetchOllamaWebSubscription,
  type OllamaWebSubscriptionResult
} from '../ollama/OllamaWebSubscriptionClient'
import type { WebSessionStatus } from './WebSessionCookieStore'
import type {
  UsageWebSessionProviderId,
  UsageWebSessionReading
} from '../../shared/usageWebSession'
import { parseUsageWebSessionReading, USAGE_WEB_SESSION_SPECS } from './UsageWebSessionClient'

/**
 * Import Web Session: open the provider's own sign-in page in an embedded
 * window, wait for a session that actually works, and hand the cookie header
 * to the caller for safeStorage persistence.
 *
 * Two properties are load-bearing:
 *
 * - The window uses a NON-persistent partition, so the sign-in never touches
 *   the app's default cookie jar or disk, and the partition's storage is
 *   wiped again the moment the capture settles. At rest the session exists
 *   only inside the store's encrypted envelope.
 * - "Captured" means VALIDATED: a candidate header is accepted only once the
 *   provider's subscription/settings page fetches and parses with it. Cookie
 *   names alone are not proof of a signed-in session — the first cut resolved
 *   on any cookie with "session" in its name, which the login page sets
 *   before any credentials are entered.
 *
 * The cookie header never crosses to the renderer; callers return only a
 * WebSessionImportOutcome projection.
 */

export interface CapturedWebSession<Summary> {
  cookieHeader: string
  summary: Summary
}

/** The only shape the renderer ever sees. */
export type WebSessionImportOutcome =
  | { ok: true; status: WebSessionStatus }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'storeFailed'; status?: WebSessionStatus }

const CAPTURE_POLL_MS = 2_000

interface WebSessionCaptureSpec<Summary> {
  windowTitle: string
  startUrl: string
  /** In-memory partition (no `persist:` prefix) dedicated to this provider's
   *  import flow. */
  partition: string
  /** Suffix match against each cookie's domain, e.g. 'mistral.ai'. */
  cookieDomainSuffixes: readonly string[]
  buildCookieHeader: (cookies: Cookie[]) => string | null
  validate: (cookieHeader: string) => Promise<Summary | null>
}

function cookieMatchesDomain(cookie: Cookie, suffixes: readonly string[]): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
  if (!domain) return false
  return suffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))
}

/** Deterministic `name=value; …` header: sorted by name, like Limit Counter,
 *  so repeated polls of the same jar dedupe by string equality. */
function joinCookies(cookies: Cookie[]): string {
  return [...cookies]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

async function captureWebSession<Summary>(
  spec: WebSessionCaptureSpec<Summary>
): Promise<CapturedWebSession<Summary> | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 980,
      height: 720,
      title: spec.windowTitle,
      autoHideMenuBar: true,
      webPreferences: {
        partition: spec.partition,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    let settled = false
    let inFlightValidation = false
    let lastAttemptedHeader: string | null = null

    const settle = (result: CapturedWebSession<Summary> | null): void => {
      if (settled) return
      settled = true
      clearInterval(interval)
      // Wipe the sign-in from the in-memory partition either way: on success
      // the cookie now lives in the encrypted store; on cancel nothing should
      // linger for the next import to silently reuse.
      void electronSession
        .fromPartition(spec.partition)
        .clearStorageData()
        .catch(() => {})
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }

    const interval = setInterval(() => {
      void (async () => {
        if (settled || inFlightValidation) return
        if (win.isDestroyed()) {
          settle(null)
          return
        }
        try {
          const cookies = await win.webContents.session.cookies.get({})
          const scoped = cookies.filter((cookie) =>
            cookieMatchesDomain(cookie, spec.cookieDomainSuffixes)
          )
          const header = spec.buildCookieHeader(scoped)
          if (!header || header === lastAttemptedHeader) return
          lastAttemptedHeader = header
          inFlightValidation = true
          const summary = await spec.validate(header)
          inFlightValidation = false
          if (summary !== null && !settled) {
            settle({ cookieHeader: header, summary })
          }
        } catch {
          inFlightValidation = false
        }
      })()
    }, CAPTURE_POLL_MS)

    win.on('closed', () => {
      settle(null)
    })

    void win.loadURL(spec.startUrl)
  })
}

export async function importMistralWebSession(): Promise<CapturedWebSession<MistralWebSubscriptionResult> | null> {
  return captureWebSession({
    windowTitle: 'Sign in to Mistral',
    // The subscription page itself: signed-out it bounces to the login form,
    // signed-in it is exactly the page the validator scrapes.
    startUrl: 'https://admin.mistral.ai/subscription',
    partition: 'websession-import:mistral',
    cookieDomainSuffixes: ['mistral.ai'],
    buildCookieHeader: (cookies) => (cookies.length ? joinCookies(cookies) : null),
    validate: (cookieHeader) => fetchMistralWebSubscription(cookieHeader)
  })
}

/**
 * Kimi's web session is NOT a cookie: the signed-in kimi.ai page keeps
 * `access_token` / `refresh_token` in localStorage, and the membership stats
 * endpoint authenticates with a Bearer token (Limit Counter parity). The same
 * embedded-window hygiene applies — non-persistent partition, wiped when the
 * capture settles — but the poll reads tokens via executeJavaScript and
 * validates them against the live GetSubscriptionStats endpoint before the
 * window closes.
 */
const KIMI_TOKEN_CAPTURE_SCRIPT = `JSON.stringify({
  accessToken: window.localStorage.getItem('access_token'),
  refreshToken: window.localStorage.getItem('refresh_token')
})`

export async function importKimiWebSession(): Promise<CapturedWebSession<KimiWebMonthlyReading> | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 980,
      height: 720,
      title: 'Sign in to Kimi',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'websession-import:kimi',
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    const startUrl = 'https://www.kimi.ai/membership/subscription?tab=quota'
    let settled = false
    let lastAttemptedKey: string | null = null

    const settle = async (
      result: CapturedWebSession<KimiWebMonthlyReading> | null
    ): Promise<void> => {
      if (settled) return
      settled = true
      clearInterval(interval)
      // Wipe the sign-in from the in-memory partition either way; on success
      // the tokens now live in the encrypted store.
      void electronSession
        .fromPartition('websession-import:kimi')
        .clearStorageData()
        .catch(() => {})
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }

    const interval = setInterval(() => {
      void (async () => {
        if (settled) return
        if (win.isDestroyed()) {
          await settle(null)
          return
        }
        try {
          const raw = await win.webContents.executeJavaScript(KIMI_TOKEN_CAPTURE_SCRIPT, true)
          const parsed = JSON.parse(String(raw)) as {
            accessToken?: unknown
            refreshToken?: unknown
          }
          const accessToken =
            typeof parsed.accessToken === 'string' ? parsed.accessToken.trim() : ''
          if (!accessToken) return
          const refreshToken =
            typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim()
              ? parsed.refreshToken.trim()
              : undefined
          const key = `${accessToken}:${refreshToken ?? ''}`
          if (key === lastAttemptedKey) return
          lastAttemptedKey = key
          const result = await fetchKimiWebMonthlyUsage({
            accessToken,
            ...(refreshToken ? { refreshToken } : {})
          })
          // A valid session may legitimately report zero usage at the start of
          // a cycle — only a failed fetch (null reading) keeps polling.
          if (result.reading) {
            await settle({
              cookieHeader: serializeKimiWebSessionTokens({
                accessToken,
                ...(result.tokens ?? { ...(refreshToken ? { refreshToken } : {}) })
              }),
              summary: result.reading
            })
          }
        } catch {
          // Page still loading or script unavailable; keep polling until closed.
        }
      })()
    }, CAPTURE_POLL_MS)

    win.on('closed', () => {
      void settle(null)
    })

    void win.loadURL(startUrl)
  })
}

export async function importOllamaWebSession(): Promise<CapturedWebSession<OllamaWebSubscriptionResult> | null> {
  return captureWebSession({
    windowTitle: 'Sign in to Ollama',
    startUrl: 'https://ollama.com/login',
    partition: 'websession-import:ollama',
    cookieDomainSuffixes: ['ollama.com', 'ollama.ai'],
    buildCookieHeader: (cookies) => {
      if (!cookies.length) return null
      // Prefer the one cookie that actually carries the session, like Limit
      // Counter: exact `__Secure-session`, then anything session-named, then
      // the whole jar as a last resort.
      const exact = cookies.find((cookie) => cookie.name === '__Secure-session')
      if (exact) return `${exact.name}=${exact.value}`
      const sessionNamed = cookies.filter((cookie) => /session/i.test(cookie.name))
      if (sessionNamed.length) return joinCookies(sessionNamed)
      return joinCookies(cookies)
    },
    validate: (cookieHeader) => fetchOllamaWebSubscription(cookieHeader)
  })
}

const RENDERED_BODY_CAPTURE_SCRIPT = `document.body ? document.body.innerText : ''`

/**
 * Meta, Muse, Cerebras, Qwen, and MiMo expose their useful reading only after
 * the signed-in console has rendered. Poll the visible body and accept the
 * import only when the provider-specific parser finds a real billing/quota
 * value. The validated reading travels only to the main-process encrypted
 * store; the cookie never crosses IPC.
 */
export async function importUsageWebSession(
  provider: UsageWebSessionProviderId
): Promise<CapturedWebSession<UsageWebSessionReading> | null> {
  const spec = USAGE_WEB_SESSION_SPECS[provider]
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 980,
      height: 720,
      title: spec.windowTitle,
      autoHideMenuBar: true,
      webPreferences: {
        partition: spec.partition,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    let settled = false
    let polling = false
    let lastAttemptedSignature: string | null = null

    const settle = (result: CapturedWebSession<UsageWebSessionReading> | null): void => {
      if (settled) return
      settled = true
      clearInterval(interval)
      void electronSession
        .fromPartition(spec.partition)
        .clearStorageData()
        .catch(() => {})
      if (!win.isDestroyed()) win.close()
      resolve(result)
    }

    const interval = setInterval(() => {
      void (async () => {
        if (settled || polling) return
        if (win.isDestroyed()) {
          settle(null)
          return
        }
        polling = true
        try {
          const [cookies, rawText] = await Promise.all([
            win.webContents.session.cookies.get({}),
            win.webContents.executeJavaScript(RENDERED_BODY_CAPTURE_SCRIPT, true)
          ])
          const scoped = cookies.filter((cookie) =>
            cookieMatchesDomain(cookie, spec.cookieDomainSuffixes)
          )
          if (!scoped.length || typeof rawText !== 'string') return
          const cookieHeader = joinCookies(scoped)
          const signature = `${cookieHeader}\n${rawText}`
          if (signature === lastAttemptedSignature) return
          lastAttemptedSignature = signature
          const reading = parseUsageWebSessionReading(provider, rawText)
          // "Captured" means a real meter, not just a parsed page: quota plans
          // need their percent, and the Muse subscription needs at least one of
          // its Current/Weekly meters before the cookie is worth keeping.
          const hasRequiredReading =
            reading &&
            (provider === 'qwen' || provider === 'mimo'
              ? reading.quotaUsedPercent !== undefined
              : provider === 'muse'
                ? reading.currentUsedPercent !== undefined ||
                  reading.weeklyUsedPercent !== undefined
                : true)
          if (hasRequiredReading) settle({ cookieHeader, summary: reading })
        } catch {
          // The page is still loading or has not completed sign-in; keep polling.
        } finally {
          polling = false
        }
      })()
    }, CAPTURE_POLL_MS)

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })
    win.on('closed', () => settle(null))
    void win.loadURL(spec.startUrl)
  })
}
