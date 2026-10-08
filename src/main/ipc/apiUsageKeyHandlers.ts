import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  isApiUsageKeyProviderId,
  type ApiUsageKeyMutationError,
  type ApiUsageKeyProviderId,
  type ApiUsageKeyStore
} from '../usage/ApiUsageKeyStore'
import {
  createProviderSecretStoreHandlers,
  type SecretMutationResult,
  type SecretStatus
} from './providerSecretHandlerFactory'

/**
 * IPC for the API-usage reporting keys (Anthropic Admin API key, OpenAI admin
 * key): status / set / clear, keyed by provider. The renderer only ever sees
 * the status projection (configured, encryptionAvailable, updatedAt); the key
 * bytes stay in main. Saving or clearing a key invalidates the report lane so
 * the next Model Usage read refetches instead of serving a stale bill.
 */
export const API_USAGE_KEY_STATUS_CHANNEL = 'api-usage-key:status'
export const API_USAGE_KEY_SET_CHANNEL = 'api-usage-key:set'
export const API_USAGE_KEY_CLEAR_CHANNEL = 'api-usage-key:clear'

export interface ApiUsageKeyHandlerDeps {
  /** Store for a provider; null until configured post-app-ready. */
  keyStore: (
    provider: ApiUsageKeyProviderId
  ) => Pick<ApiUsageKeyStore, 'getStatus' | 'setApiKey' | 'clear'> | null
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  /** Fired after a successful set/clear with the provider it touched. */
  onKeyMutationSuccess?: (provider: ApiUsageKeyProviderId) => void
}

const RECOGNIZED_MUTATION_ERRORS = new Set<string>([
  'invalidApiKey',
  'encryptionUnavailable',
  'encryptFailed',
  'existingRecordUnreadable',
  'writeFailed',
  'clearFailed'
])

type MutationResult = SecretMutationResult<ApiUsageKeyMutationError | 'unavailable'>

const UNAVAILABLE_STATUS: SecretStatus = { configured: false, encryptionAvailable: false }

export function registerApiUsageKeyHandlers(deps: ApiUsageKeyHandlerDeps): void {
  const handlersFor = (provider: unknown) => {
    if (!isApiUsageKeyProviderId(provider)) return null
    const store = deps.keyStore(provider)
    if (!store) return null
    return createProviderSecretStoreHandlers<ApiUsageKeyMutationError>({
      secretStore: store,
      isMainRendererSender: deps.isMainRendererSender,
      onMutationSuccess: () => deps.onKeyMutationSuccess?.(provider),
      recognizedErrors: RECOGNIZED_MUTATION_ERRORS,
      defaultError: 'writeFailed',
      fallbackError: 'writeFailed',
      mutationGuard: { setError: 'writeFailed', clearError: 'clearFailed' },
      statusProjection: { allowNoMillis: true, requireRoundTrip: false }
    })
  }

  ipcMain.handle(API_USAGE_KEY_STATUS_CHANNEL, (event, provider: unknown): SecretStatus | null => {
    if (!deps.isMainRendererSender(event)) return null
    const handlers = handlersFor(provider)
    return handlers ? handlers.getStatus(event) : null
  })

  ipcMain.handle(
    API_USAGE_KEY_SET_CHANNEL,
    (event, provider: unknown, apiKey: unknown): MutationResult => {
      if (!deps.isMainRendererSender(event)) {
        return { ok: false, status: UNAVAILABLE_STATUS, error: 'writeFailed' }
      }
      const handlers = handlersFor(provider)
      if (!handlers) return { ok: false, status: UNAVAILABLE_STATUS, error: 'unavailable' }
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return { ok: false, status: handlers.getStatus(event), error: 'invalidApiKey' }
      }
      return handlers.setSecret(event, apiKey)
    }
  )

  ipcMain.handle(API_USAGE_KEY_CLEAR_CHANNEL, (event, provider: unknown): MutationResult => {
    if (!deps.isMainRendererSender(event)) {
      return { ok: false, status: UNAVAILABLE_STATUS, error: 'clearFailed' }
    }
    const handlers = handlersFor(provider)
    if (!handlers) return { ok: false, status: UNAVAILABLE_STATUS, error: 'unavailable' }
    return handlers.clearSecret(event)
  })
}

export function unregisterApiUsageKeyHandlers(): void {
  ipcMain.removeHandler(API_USAGE_KEY_STATUS_CHANNEL)
  ipcMain.removeHandler(API_USAGE_KEY_SET_CHANNEL)
  ipcMain.removeHandler(API_USAGE_KEY_CLEAR_CHANNEL)
}
