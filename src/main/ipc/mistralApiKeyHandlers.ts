import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  MistralApiKeyMutationError,
  MistralApiKeyMutationResult,
  MistralApiKeyStatus,
  MistralApiKeyStore
} from '../mistral/MistralApiKeyStore'
import type { WebSessionCookieStore } from '../providers/WebSessionCookieStore'
import { importMistralWebSession, type CapturedWebSession } from '../providers/WebSessionBrowser'
import type { MistralWebSubscriptionResult } from '../mistral/MistralWebSubscriptionClient'
import {
  createProviderSecretStoreHandlers,
  createProviderWebSessionHandlers
} from './providerSecretHandlerFactory'

export const MISTRAL_API_KEY_STATUS_CHANNEL = 'mistral-api-key:get-status'
export const MISTRAL_API_KEY_SET_CHANNEL = 'mistral-api-key:set'
export const MISTRAL_API_KEY_CLEAR_CHANNEL = 'mistral-api-key:clear'
export const MISTRAL_WEB_SESSION_IMPORT_CHANNEL = 'mistral-web-session:import'
export const MISTRAL_WEB_SESSION_STATUS_CHANNEL = 'mistral-web-session:get-status'
export const MISTRAL_WEB_SESSION_CLEAR_CHANNEL = 'mistral-web-session:clear'

export interface MistralApiKeyHandlerDeps {
  keyStore: Pick<MistralApiKeyStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onKeyMutationSuccess?: () => void
  /** Web-session cookie envelope; null until configured post-app-ready. */
  webSessionStore?: () => Pick<WebSessionCookieStore, 'getStatus' | 'setCookie' | 'clear'> | null
  /** Injectable for tests; defaults to the real embedded sign-in window. */
  importWebSession?: () => Promise<CapturedWebSession<MistralWebSubscriptionResult> | null>
  /** Fired after a session is captured AND persisted — the moment a quota
   *  refresh can use it. Receives the already-validated subscription read. */
  onWebSessionImported?: (summary: MistralWebSubscriptionResult) => void
}

const RECOGNIZED_MUTATION_ERRORS = new Set([
  'invalidApiKey',
  'invalidCookie',
  'encryptionUnavailable',
  'encryptFailed',
  'existingRecordUnreadable',
  'writeFailed',
  'clearFailed'
])

export function registerMistralApiKeyHandlers(deps: MistralApiKeyHandlerDeps): void {
  const secretHandlers = createProviderSecretStoreHandlers<MistralApiKeyMutationError>({
    secretStore: deps.keyStore,
    isMainRendererSender: deps.isMainRendererSender,
    onMutationSuccess: deps.onKeyMutationSuccess,
    recognizedErrors: RECOGNIZED_MUTATION_ERRORS,
    defaultError: 'writeFailed',
    fallbackError: 'writeFailed',
    mutationGuard: { setError: 'writeFailed', clearError: 'clearFailed' },
    statusProjection: { allowNoMillis: true, requireRoundTrip: false }
  })

  const webSessionHandlers = createProviderWebSessionHandlers<MistralWebSubscriptionResult>({
    isMainRendererSender: deps.isMainRendererSender,
    webSessionStore: deps.webSessionStore,
    importWebSession: deps.importWebSession ?? importMistralWebSession,
    onWebSessionImported: deps.onWebSessionImported,
    syncClear: true
  })

  ipcMain.handle(
    MISTRAL_API_KEY_STATUS_CHANNEL,
    (event): MistralApiKeyStatus => secretHandlers.getStatus(event)
  )

  ipcMain.handle(
    MISTRAL_API_KEY_SET_CHANNEL,
    (_event, apiKey: unknown): MistralApiKeyMutationResult => {
      if (!deps.isMainRendererSender(_event)) {
        return {
          ok: false,
          status: { configured: false, encryptionAvailable: false },
          error: 'writeFailed'
        }
      }
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return {
          ok: false,
          status: secretHandlers.getStatus(_event),
          error: 'invalidApiKey'
        }
      }
      return secretHandlers.setSecret(_event, apiKey)
    }
  )

  ipcMain.handle(
    MISTRAL_API_KEY_CLEAR_CHANNEL,
    (event): MistralApiKeyMutationResult => secretHandlers.clearSecret(event)
  )

  ipcMain.handle(MISTRAL_WEB_SESSION_IMPORT_CHANNEL, webSessionHandlers.importWebSession)
  ipcMain.handle(MISTRAL_WEB_SESSION_STATUS_CHANNEL, webSessionHandlers.getWebSessionStatus)
  ipcMain.handle(MISTRAL_WEB_SESSION_CLEAR_CHANNEL, webSessionHandlers.clearWebSession)
}

export function unregisterMistralApiKeyHandlers(): void {
  ipcMain.removeHandler(MISTRAL_API_KEY_STATUS_CHANNEL)
  ipcMain.removeHandler(MISTRAL_API_KEY_SET_CHANNEL)
  ipcMain.removeHandler(MISTRAL_API_KEY_CLEAR_CHANNEL)
  ipcMain.removeHandler(MISTRAL_WEB_SESSION_IMPORT_CHANNEL)
  ipcMain.removeHandler(MISTRAL_WEB_SESSION_STATUS_CHANNEL)
  ipcMain.removeHandler(MISTRAL_WEB_SESSION_CLEAR_CHANNEL)
}
