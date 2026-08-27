import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { WebSessionCookieStore, WebSessionStatus } from '../providers/WebSessionCookieStore'
import {
  importKimiWebSession,
  type CapturedWebSession
} from '../providers/WebSessionBrowser'
import {
  createProviderWebSessionHandlers,
  webSessionStatusOf
} from './providerSecretHandlerFactory'

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

export function registerKimiWebSessionHandlers(deps: KimiWebSessionHandlersDeps): void {
  const webSessionHandlers = createProviderWebSessionHandlers<unknown>({
    isMainRendererSender: deps.isMainRendererSender,
    webSessionStore: deps.webSessionStore,
    importWebSession: deps.importWebSession ?? importKimiWebSession,
    onWebSessionImported: deps.onWebSessionImported
  })

  ipcMain.handle('get-kimi-web-session-status', async (): Promise<WebSessionStatus> => {
    const webSession = webSessionStatusOf(deps.webSessionStore?.() ?? null)
    return {
      configured: webSession.configured,
      encryptionAvailable: deps.isEncryptionAvailable(),
      ...(webSession.updatedAt ? { updatedAt: webSession.updatedAt } : {})
    }
  })

  ipcMain.handle('import-kimi-web-session', webSessionHandlers.importWebSession)
  ipcMain.handle('set-kimi-web-session', webSessionHandlers.setWebSession)
  ipcMain.handle('clear-kimi-web-session', webSessionHandlers.clearWebSession)
}
