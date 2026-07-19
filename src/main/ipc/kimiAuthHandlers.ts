import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import { rendererSafeProviderApiKeyStatus } from '../RendererProviderProjection'

export interface KimiAuthHandlersDeps {
  getSettings: () => { kimiApiKey?: string }
  updateSettings: (patch: { kimiApiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  resolveCliProviderBinary: (provider: 'kimi') => Promise<ResolvedProviderBinary>
  inspectRuntime: (resolved: ResolvedProviderBinary) => Promise<
    | { admitted: true; version: string; mode: 'reviewed' | 'unattested-development' }
    | { admitted: false; message: string }
  >
  /** Managed ACP credential state from the current ~/.kimi-code home only. */
  getManagedAuthState: () => Promise<'oauth' | 'api-key' | 'unknown'>
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
    // Runtime admission owns the only executable inventory probes. Status must
    // not run an independent --version/--help process around that gate.
    const runtime = await deps.inspectRuntime(resolved)
    // The encrypted Settings key is used by the usage endpoint and is not
    // projected into ACP. Only inspect current-home credentials after runtime
    // admission succeeds; an unqualified binary is never reported ready.
    const managedAuthState = runtime.admitted ? await deps.getManagedAuthState() : 'unknown'
    const status: ProviderApiKeyStatus = {
      available: runtime.admitted,
      authState: managedAuthState,
      apiKeyConfigured,
      encryptionAvailable,
      version: runtime.admitted ? runtime.version : runtime.message,
      binaryPath: resolved.binaryPath,
      cliFlavour: runtime.admitted ? 'kimi-code' : 'unsupported',
      transportSupported: runtime.admitted
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
