import type { AntigravityGeminiApiDiscoveryOutcome } from '../main/antigravity/AntigravityGeminiApiDiscoveryOutcome'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus
} from '../main/antigravity/AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS = {
  status: 'antigravity-gemini-api:get-secret-status',
  set: 'antigravity-gemini-api:set-secret',
  clear: 'antigravity-gemini-api:clear-secret',
  discoveryOutcome: 'antigravity-gemini-api:get-discovery-outcome'
} as const

export interface AntigravityGeminiApiSecretIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createAntigravityGeminiApiSecretBridge(
  ipcRenderer: AntigravityGeminiApiSecretIpcRenderer
): {
  getAntigravityGeminiApiSecretStatus: () => Promise<AntigravityGeminiApiSecretStatus>
  setAntigravityGeminiApiSecret: (
    apiKey: string
  ) => Promise<AntigravityGeminiApiSecretMutationResult>
  clearAntigravityGeminiApiSecret: () => Promise<AntigravityGeminiApiSecretMutationResult>
  getAntigravityGeminiApiDiscoveryOutcome: () => Promise<AntigravityGeminiApiDiscoveryOutcome | null>
} {
  return {
    getAntigravityGeminiApiSecretStatus: () =>
      ipcRenderer.invoke(
        ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.status
      ) as Promise<AntigravityGeminiApiSecretStatus>,
    getAntigravityGeminiApiDiscoveryOutcome: () =>
      ipcRenderer.invoke(
        ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.discoveryOutcome
      ) as Promise<AntigravityGeminiApiDiscoveryOutcome | null>,
    setAntigravityGeminiApiSecret: (apiKey) =>
      ipcRenderer.invoke(
        ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.set,
        apiKey
      ) as Promise<AntigravityGeminiApiSecretMutationResult>,
    clearAntigravityGeminiApiSecret: () =>
      ipcRenderer.invoke(
        ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.clear
      ) as Promise<AntigravityGeminiApiSecretMutationResult>
  }
}
