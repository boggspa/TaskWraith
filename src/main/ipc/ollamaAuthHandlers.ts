import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  WebSessionCookieStore,
  WebSessionMutationResult,
  WebSessionStatus
} from '../providers/WebSessionCookieStore'
import {
  importOllamaWebSession,
  type CapturedWebSession,
  type WebSessionImportOutcome
} from '../providers/WebSessionBrowser'
import type { OllamaWebSubscriptionResult } from '../ollama/OllamaWebSubscriptionClient'

export interface OllamaApiKeyStatus {
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
  webSessionConfigured: boolean
  webSessionUpdatedAt?: string
}

export interface OllamaAuthHandlersDeps {
  getSettings: () => { ollamaApiKey?: string }
  updateSettings: (patch: { ollamaApiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  /** Web-session cookie envelope; null until configured post-app-ready. */
  webSessionStore?: () => Pick<WebSessionCookieStore, 'getStatus' | 'setCookie' | 'clear'> | null
  /** Injectable for tests; defaults to the real embedded sign-in window. */
  importWebSession?: () => Promise<CapturedWebSession<OllamaWebSubscriptionResult> | null>
  /** Fired after a session is captured AND persisted — the moment a quota
   *  refresh can use it. Receives the already-validated settings read. */
  onWebSessionImported?: (summary: OllamaWebSubscriptionResult) => void
}

/**
 * Accept what people actually paste from DevTools: a bare `__Secure-session`
 * value, a `name=value` pair, a full header, or any of those with a leading
 * `Cookie:` label. A bare value is wrapped as `__Secure-session=<value>` —
 * the one cookie ollama.com's settings page authenticates on.
 */
export function normalizeOllamaWebSessionInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw
    .trim()
    .replace(/^cookie:\s*/i, '')
    .trim()
  if (!value) return null
  return value.includes('=') ? value : `__Secure-session=${value}`
}

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

export function registerOllamaAuthHandlers(deps: OllamaAuthHandlersDeps): void {
  ipcMain.handle('get-ollama-auth-status', async (): Promise<OllamaApiKeyStatus> => {
    const webSession = webSessionStatusOf(deps.webSessionStore?.() ?? null)
    return {
      apiKeyConfigured: Boolean(deps.getSettings().ollamaApiKey),
      encryptionAvailable: deps.isEncryptionAvailable(),
      webSessionConfigured: webSession.configured,
      ...(webSession.updatedAt ? { webSessionUpdatedAt: webSession.updatedAt } : {})
    }
  })

  ipcMain.handle('store-ollama-api-key', async (_, rawKey: string) => {
    const key = String(rawKey || '').trim()
    if (!key) {
      deps.updateSettings({ ollamaApiKey: undefined })
      return {
        stored: false,
        encryptionAvailable: deps.isEncryptionAvailable()
      }
    }
    if (!deps.isEncryptionAvailable()) {
      return {
        stored: false,
        encryptionAvailable: false,
        error: 'Secure storage is unavailable, so the Ollama API key was not saved.'
      }
    }
    const encrypted = deps.encryptApiKey(key)
    deps.updateSettings({ ollamaApiKey: encrypted || undefined })
    return {
      stored: Boolean(encrypted),
      encryptionAvailable: deps.isEncryptionAvailable()
    }
  })

  ipcMain.handle('clear-ollama-api-key', async () => {
    deps.updateSettings({ ollamaApiKey: undefined })
    return true
  })

  // ── Import Web Session ─────────────────────────────────────────────────────
  // The cookie stays in the main process end to end: captured by the embedded
  // window (or pasted, one renderer→main hop), validated against the live
  // settings page, persisted into the safeStorage envelope. Reads back out to
  // the renderer are status projections only, never the cookie.

  ipcMain.handle('import-ollama-web-session', async (event): Promise<WebSessionImportOutcome> => {
    if (!deps.isMainRendererSender(event)) return { ok: false, reason: 'unavailable' }
    const store = deps.webSessionStore?.() ?? null
    if (!store) return { ok: false, reason: 'unavailable' }
    const captured = await (deps.importWebSession ?? importOllamaWebSession)()
    if (!captured) return { ok: false, reason: 'cancelled' }
    const result = store.setCookie(captured.cookieHeader)
    if (!result.ok) return { ok: false, reason: 'storeFailed', status: result.status }
    try {
      deps.onWebSessionImported?.(captured.summary)
    } catch {
      // ignore
    }
    return { ok: true, status: result.status }
  })

  ipcMain.handle(
    'set-ollama-web-session',
    async (event, rawCookie: unknown): Promise<WebSessionMutationResult> => {
      const unavailable: WebSessionMutationResult = {
        ok: false,
        status: { configured: false, encryptionAvailable: false },
        error: 'writeFailed'
      }
      if (!deps.isMainRendererSender(event)) return unavailable
      const store = deps.webSessionStore?.() ?? null
      if (!store) return unavailable
      const cookie = normalizeOllamaWebSessionInput(rawCookie)
      if (!cookie) {
        return { ok: false, status: webSessionStatusOf(store), error: 'invalidCookie' }
      }
      // Stored without a validation fetch, matching Limit Counter's paste
      // path: an offline moment must not block saving a good cookie. The
      // quota lane surfaces an expired session on its next read instead.
      return store.setCookie(cookie)
    }
  )

  ipcMain.handle('clear-ollama-web-session', async (event): Promise<WebSessionMutationResult> => {
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
