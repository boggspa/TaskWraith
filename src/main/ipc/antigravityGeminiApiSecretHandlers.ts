import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AntigravityGeminiApiSecretMutationError,
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus,
  AntigravityGeminiApiSecretStore
} from '../antigravity/AntigravityGeminiApiSecretStore'
import type { AntigravityGeminiApiDiscoveryOutcome } from '../antigravity/AntigravityGeminiApiDiscoveryOutcome'
import {
  createDiscoveryOutcomeHandler,
  createProviderSecretStoreHandlers
} from './providerSecretHandlerFactory'

export const ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL =
  'antigravity-gemini-api:get-secret-status'
export const ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL = 'antigravity-gemini-api:set-secret'
export const ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL = 'antigravity-gemini-api:clear-secret'
export const ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL =
  'antigravity-gemini-api:get-discovery-outcome'

export interface AntigravityGeminiApiSecretHandlerDeps {
  secretStore: Pick<AntigravityGeminiApiSecretStore, 'getStatus' | 'setApiKey' | 'clear'>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  onSecretMutationSuccess?: () => void
  /**
   * Optional so an installation without a discovery recorder simply reports
   * "not checked yet" rather than failing the channel.
   */
  getDiscoveryOutcome?: () => AntigravityGeminiApiDiscoveryOutcome | null
}

const RECOGNIZED_MUTATION_ERRORS = new Set([
  'invalidApiKey',
  'encryptionUnavailable',
  'encryptFailed',
  'existingRecordUnreadable',
  'writeFailed',
  'clearFailed'
])

export function registerAntigravityGeminiApiSecretHandlers(
  deps: AntigravityGeminiApiSecretHandlerDeps
): void {
  const secretHandlers = createProviderSecretStoreHandlers<AntigravityGeminiApiSecretMutationError>({
    secretStore: deps.secretStore,
    isMainRendererSender: deps.isMainRendererSender,
    onMutationSuccess: deps.onSecretMutationSuccess,
    recognizedErrors: RECOGNIZED_MUTATION_ERRORS,
    defaultError: 'writeFailed',
    assertMainRendererError: 'Only the main renderer can manage the Gemini API key.',
    statusProjection: { allowNoMillis: false, requireRoundTrip: true }
  })

  const discoveryOutcomeHandler = createDiscoveryOutcomeHandler({
    getDiscoveryOutcome: deps.getDiscoveryOutcome,
    isMainRendererSender: deps.isMainRendererSender,
    assertMainRendererError: 'Only the main renderer can manage the Gemini API key.'
  })

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_STATUS_CHANNEL,
    (event): AntigravityGeminiApiSecretStatus => secretHandlers.getStatus(event)
  )

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_DISCOVERY_OUTCOME_CHANNEL,
    (event): AntigravityGeminiApiDiscoveryOutcome | null => discoveryOutcomeHandler(event)
  )

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_SET_CHANNEL,
    (event, apiKey: string): AntigravityGeminiApiSecretMutationResult =>
      secretHandlers.setSecret(event, apiKey)
  )

  ipcMain.handle(
    ANTIGRAVITY_GEMINI_API_SECRET_CLEAR_CHANNEL,
    (event): AntigravityGeminiApiSecretMutationResult => secretHandlers.clearSecret(event)
  )
}
