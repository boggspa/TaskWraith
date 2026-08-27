import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { WebSessionCookieStore } from '../providers/WebSessionCookieStore'
import {
  importOllamaWebSession,
  type CapturedWebSession
} from '../providers/WebSessionBrowser'
import type { OllamaWebSubscriptionResult } from '../ollama/OllamaWebSubscriptionClient'
import {
  createProviderApiKeyHandlers,
  createProviderWebSessionHandlers,
  webSessionStatusOf
} from './providerSecretHandlerFactory'

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

export function registerOllamaAuthHandlers(deps: OllamaAuthHandlersDeps): void {
  const apiKeyHandlers = createProviderApiKeyHandlers({
    providerName: 'ollama',
    settingsKey: 'ollamaApiKey',
    getSettings: () => ({ apiKey: deps.getSettings().ollamaApiKey }),
    updateSettings: (patch) => deps.updateSettings({ ollamaApiKey: patch.apiKey }),
    isEncryptionAvailable: deps.isEncryptionAvailable,
    encryptApiKey: deps.encryptApiKey,
    secureStorageUnavailableError:
      'Secure storage is unavailable, so the Ollama API key was not saved.'
  })

  const webSessionHandlers = createProviderWebSessionHandlers<OllamaWebSubscriptionResult>({
    isMainRendererSender: deps.isMainRendererSender,
    webSessionStore: deps.webSessionStore,
    importWebSession: deps.importWebSession ?? importOllamaWebSession,
    onWebSessionImported: deps.onWebSessionImported,
    normalizeInput: normalizeOllamaWebSessionInput
  })

  ipcMain.handle('get-ollama-auth-status', async (): Promise<OllamaApiKeyStatus> => {
    const webSession = webSessionStatusOf(deps.webSessionStore?.() ?? null)
    return {
      apiKeyConfigured: Boolean(deps.getSettings().ollamaApiKey),
      encryptionAvailable: deps.isEncryptionAvailable(),
      webSessionConfigured: webSession.configured,
      ...(webSession.updatedAt ? { webSessionUpdatedAt: webSession.updatedAt } : {})
    }
  })

  ipcMain.handle('store-ollama-api-key', apiKeyHandlers.storeKey)
  ipcMain.handle('clear-ollama-api-key', apiKeyHandlers.clearKey)
  ipcMain.handle('import-ollama-web-session', webSessionHandlers.importWebSession)
  ipcMain.handle('set-ollama-web-session', webSessionHandlers.setWebSession)
  ipcMain.handle('clear-ollama-web-session', webSessionHandlers.clearWebSession)
}
