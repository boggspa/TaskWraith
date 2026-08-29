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
import { probeOllamaCloudAccount } from '../ollama/OllamaAccountProbe'
import {
  nextOllamaCliSignInRecord,
  normalizeOllamaCliSignIn,
  type OllamaCliSignInObservation,
  type OllamaCliSignInRecord
} from '../ollama/OllamaCliSignInMemory'

export interface OllamaApiKeyStatus {
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
  webSessionConfigured: boolean
  webSessionUpdatedAt?: string
  /** Remembered `ollama signin` state; absent until the daemon has answered once. */
  cliSignedIn?: boolean
  cliPlan?: string
  cliSignInUpdatedAt?: string
}

export interface OllamaAuthHandlersDeps {
  getSettings: () => {
    ollamaApiKey?: string
    ollamaBaseUrl?: string
    ollamaCliSignIn?: { signedIn: boolean; plan?: string; updatedAt: string }
  }
  updateSettings: (patch: {
    ollamaApiKey?: string
    ollamaCliSignIn?: { signedIn: boolean; plan?: string; updatedAt: string }
  }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  /** Injectable for tests; defaults to the real local-daemon account probe. */
  probeCloudAccount?: (baseUrl: string | undefined) => Promise<OllamaCliSignInObservation>
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => Date
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

/**
 * Fold a fresh daemon answer into the remembered sign-in and hand back the
 * record to project. Only a definitive yes/no writes, so a daemon that is still
 * warming up, paused, or offline can never erase a real `ollama signin` — that
 * erasure is exactly what made the sign-in look like it did not survive a quit.
 */
async function refreshOllamaCliSignIn(
  deps: OllamaAuthHandlersDeps
): Promise<OllamaCliSignInRecord | null> {
  const settings = deps.getSettings()
  const previous = normalizeOllamaCliSignIn(settings.ollamaCliSignIn)
  const probe = deps.probeCloudAccount ?? defaultProbeCloudAccount
  let observation: OllamaCliSignInObservation
  try {
    observation = await probe(settings.ollamaBaseUrl)
  } catch {
    // An unreachable daemon is not evidence of a signed-out account.
    return previous
  }
  const next = nextOllamaCliSignInRecord(
    previous,
    observation,
    (deps.now?.() ?? new Date()).toISOString()
  )
  if (next !== previous) deps.updateSettings({ ollamaCliSignIn: next ?? undefined })
  return next
}

/**
 * Deliberately probes with no API key. A stored key makes `discoverOllamaCloud`
 * report an authenticated Cloud regardless of the account, which would record a
 * CLI sign-in that never happened — and would keep reporting one after the user
 * signed out. `/api/me` alone is the CLI sign-in's truth.
 */
function defaultProbeCloudAccount(
  baseUrl: string | undefined
): Promise<OllamaCliSignInObservation> {
  return probeOllamaCloudAccount(baseUrl, { apiKey: null })
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
    const cliSignIn = await refreshOllamaCliSignIn(deps)
    return {
      apiKeyConfigured: Boolean(deps.getSettings().ollamaApiKey),
      encryptionAvailable: deps.isEncryptionAvailable(),
      webSessionConfigured: webSession.configured,
      ...(webSession.updatedAt ? { webSessionUpdatedAt: webSession.updatedAt } : {}),
      ...(cliSignIn
        ? {
            cliSignedIn: cliSignIn.signedIn,
            cliSignInUpdatedAt: cliSignIn.updatedAt,
            ...(cliSignIn.plan ? { cliPlan: cliSignIn.plan } : {})
          }
        : {})
    }
  })

  ipcMain.handle('store-ollama-api-key', apiKeyHandlers.storeKey)
  ipcMain.handle('clear-ollama-api-key', apiKeyHandlers.clearKey)
  ipcMain.handle('import-ollama-web-session', webSessionHandlers.importWebSession)
  ipcMain.handle('set-ollama-web-session', webSessionHandlers.setWebSession)
  ipcMain.handle('clear-ollama-web-session', webSessionHandlers.clearWebSession)
}
