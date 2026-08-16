import { ipcMain } from 'electron'

export interface OllamaApiKeyStatus {
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
}

export interface OllamaAuthHandlersDeps {
  getSettings: () => { ollamaApiKey?: string }
  updateSettings: (patch: { ollamaApiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
}

export function registerOllamaAuthHandlers(deps: OllamaAuthHandlersDeps): void {
  ipcMain.handle(
    'get-ollama-auth-status',
    async (): Promise<OllamaApiKeyStatus> => ({
      apiKeyConfigured: Boolean(deps.getSettings().ollamaApiKey),
      encryptionAvailable: deps.isEncryptionAvailable()
    })
  )

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
}
