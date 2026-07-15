import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import type { KimiFlavourFindings } from '../providers/KimiFlavour'
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
  probeKimiFlavour: (binaryPath: string) => Promise<KimiFlavourFindings>
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
    // Kimi Code (the kimi-cli successor) resolves like a legacy binary but
    // cannot be driven by the Wire transport, so the status carries the
    // positively-identified generation for the Settings UI to explain why
    // runs are gated (migration dossier §4).
    const flavour = await deps.probeKimiFlavour(resolved.binaryPath)
    const status: ProviderApiKeyStatus = {
      available: true,
      authState: apiKeyConfigured ? 'api-key' : 'unknown',
      apiKeyConfigured,
      encryptionAvailable,
      version,
      binaryPath: resolved.binaryPath,
      cliFlavour: flavour.flavour,
      transportSupported: flavour.flavour === 'legacy-wire'
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
