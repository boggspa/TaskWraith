import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus
} from '../main/antigravity/AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS = {
  status: 'antigravity-gemini-api:get-secret-status',
  set: 'antigravity-gemini-api:set-secret',
  clear: 'antigravity-gemini-api:clear-secret'
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
} {
  return {
    getAntigravityGeminiApiSecretStatus: () =>
      ipcRenderer.invoke(
        ANTIGRAVITY_GEMINI_API_SECRET_CHANNELS.status
      ) as Promise<AntigravityGeminiApiSecretStatus>,
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
