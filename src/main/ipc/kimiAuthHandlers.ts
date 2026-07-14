import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import { rendererSafeProviderApiKeyStatus } from '../RendererProviderProjection'

interface KimiVersionReader {
  (resolved: ResolvedProviderBinary): Promise<string>
}

export interface KimiAuthHandlersDeps {
  getSettings: () => { kimiApiKey?: string }
  updateSettings: (patch: { kimiApiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  resolveCliProviderBinary: (provider: 'kimi') => Promise<ResolvedProviderBinary>
  readResolvedCliVersion: KimiVersionReader
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerKimiAuthHandlers(deps: KimiAuthHandlersDeps): void {
  ipcMain.handle('get-kimi-auth-status', async (event): Promise<ProviderApiKeyStatus> => {
    const encryptionAvailable = deps.isEncryptionAvailable()
    const apiKeyConfigured = Boolean(deps.getSettings().kimiApiKey)
    const resolved = await deps.resolveCliProviderBinary('kimi')
    if (!resolved.binaryPath) {
      const status: ProviderApiKeyStatus = {
        available: false,
        authState: 'missing',
        apiKeyConfigured,
        encryptionAvailable,
        binaryPath: null
      }
      return deps.isMainRendererSender(event) ? status : rendererSafeProviderApiKeyStatus(status)
    }
    const version = await deps.readResolvedCliVersion(resolved)
    const status: ProviderApiKeyStatus = {
      available: true,
      authState: apiKeyConfigured ? 'api-key' : 'unknown',
      apiKeyConfigured,
      encryptionAvailable,
      version,
      binaryPath: resolved.binaryPath
    }
    return deps.isMainRendererSender(event) ? status : rendererSafeProviderApiKeyStatus(status)
  })

  ipcMain.handle('store-kimi-api-key', async (_, rawKey: string) => {
    const key = String(rawKey || '').trim()
    if (!key) {
      deps.updateSettings({ kimiApiKey: undefined })
      return {
        stored: false,
        encryptionAvailable: deps.isEncryptionAvailable()
      }
    }
    if (!deps.isEncryptionAvailable()) {
      return {
        stored: false,
        encryptionAvailable: false,
        error: 'Secure storage is unavailable, so the Kimi API key was not saved.'
      }
    }
    const encrypted = deps.encryptApiKey(key)
    deps.updateSettings({ kimiApiKey: encrypted || undefined })
    return {
      stored: Boolean(encrypted),
      encryptionAvailable: deps.isEncryptionAvailable()
    }
  })

  ipcMain.handle('clear-kimi-api-key', async () => {
    deps.updateSettings({ kimiApiKey: undefined })
    return true
  })
}
