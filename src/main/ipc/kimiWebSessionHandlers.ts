import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  WebSessionCookieStore,
  WebSessionMutationResult,
  WebSessionStatus
} from '../providers/WebSessionCookieStore'
import {
  importKimiWebSession,
  type CapturedWebSession,
  type WebSessionImportOutcome
} from '../providers/WebSessionBrowser'

export interface KimiAuthStatus {
  encryptionAvailable: boolean
  webSessionConfigured: boolean
  webSessionUpdatedAt?: string
}

export interface KimiWebSessionHandlersDeps {
  isEncryptionAvailable: () => boolean
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  /** Web-session token envelope; null until configured post-app-ready. */
  webSessionStore?: () => Pick<
    WebSessionCookieStore,
    'getStatus' | 'setCookie' | 'clear' | 'loadCookie'
  > | null
  /** Injectable for tests; defaults to the real embedded sign-in window. */
  importWebSession?: () => Promise<CapturedWebSession<unknown> | null>
  /** Fired after a session is captured AND persisted — the moment a quota
   *  refresh can use it. */
  onWebSessionImported?: () => void
}

/**
 * Kimi Import Web Session: same contract as the Ollama handlers, but the
 * captured secret is a token pair (localStorage access_token/refresh_token)
 * serialized as canonical JSON rather than a cookie header. The secret stays
 * in the main process end to end; reads back out to the renderer are status
 * projections only.
 */

function webSessionStatusOf(
  store: Pick<WebSessionCookieStore, 'getStatus'> | null
): WebSessionStatus {
  if (!store) return { configured: false, encryptionAvailable: false }
  try {
    return store.getStatus()
  } catch {
    return { configured: false, encryptionAvailable: false }
  }
}

/** Accepts canonical JSON `{accessToken, refreshToken?}`, or a bare access
 *  token pasted from DevTools localStorage. */
function normalizeKimiWebSessionInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value || null
}

export function registerKimiWebSessionHandlers(deps: KimiWebSessionHandlersDeps): void {
  ipcMain.handle('get-kimi-web-session-status', async (): Promise<WebSessionStatus> => {
    const webSession = webSessionStatusOf(deps.webSessionStore?.() ?? null)
    return {
      configured: webSession.configured,
      encryptionAvailable: deps.isEncryptionAvailable(),
      ...(webSession.updatedAt ? { updatedAt: webSession.updatedAt } : {})
    }
  })

  ipcMain.handle('import-kimi-web-session', async (event): Promise<WebSessionImportOutcome> => {
    if (!deps.isMainRendererSender(event)) return { ok: false, reason: 'unavailable' }
    const store = deps.webSessionStore?.() ?? null
    if (!store) return { ok: false, reason: 'unavailable' }
    const captured = await (deps.importWebSession ?? importKimiWebSession)()
    if (!captured) return { ok: false, reason: 'cancelled' }
    const result = store.setCookie(captured.cookieHeader)
    if (!result.ok) return { ok: false, reason: 'storeFailed', status: result.status }
    try {
      deps.onWebSessionImported?.()
    } catch {
      // ignore
    }
    return { ok: true, status: result.status }
  })

  ipcMain.handle(
    'set-kimi-web-session',
    async (event, rawTokens: unknown): Promise<WebSessionMutationResult> => {
      const unavailable: WebSessionMutationResult = {
        ok: false,
        status: { configured: false, encryptionAvailable: false },
        error: 'writeFailed'
      }
      if (!deps.isMainRendererSender(event)) return unavailable
      const store = deps.webSessionStore?.() ?? null
      if (!store) return unavailable
      const serialized = normalizeKimiWebSessionInput(rawTokens)
      if (!serialized) {
        return { ok: false, status: webSessionStatusOf(store), error: 'invalidCookie' }
      }
      // Stored without a validation fetch, matching the Ollama paste path:
      // an offline moment must not block saving a good session.
      return store.setCookie(serialized)
    }
  )

  ipcMain.handle('clear-kimi-web-session', async (event): Promise<WebSessionMutationResult> => {
    if (!deps.isMainRendererSender(event)) {
      return {
        ok: false,
        status: { configured: false, encryptionAvailable: false },
        error: 'clearFailed'
      }
    }
    const store = deps.webSessionStore?.() ?? null
    if (!store) {
      return {
        ok: false,
        status: { configured: false, encryptionAvailable: false },
        error: 'clearFailed'
      }
    }
    return store.clear()
  })
}
