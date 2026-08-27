import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import {
  createCliProviderAuthStatusHandler,
  createProviderApiKeyHandlers
} from './providerSecretHandlerFactory'

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
  const statusHandler = createCliProviderAuthStatusHandler({
    providerNameForCli: 'kimi',
    getSettings: () => ({ apiKey: deps.getSettings().kimiApiKey }),
    isEncryptionAvailable: deps.isEncryptionAvailable,
    resolveCliProviderBinary: deps.resolveCliProviderBinary,
    isMainRendererSender: deps.isMainRendererSender,
    readStatus: async (resolved) => {
      const apiKeyConfigured = Boolean(deps.getSettings().kimiApiKey)
      const encryptionAvailable = deps.isEncryptionAvailable()
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
      return status
    }
  })

  const apiKeyHandlers = createProviderApiKeyHandlers({
    providerName: 'kimi',
    settingsKey: 'kimiApiKey',
    getSettings: () => ({ apiKey: deps.getSettings().kimiApiKey }),
    updateSettings: (patch) => deps.updateSettings({ kimiApiKey: patch.apiKey }),
    isEncryptionAvailable: deps.isEncryptionAvailable,
    encryptApiKey: deps.encryptApiKey,
    secureStorageUnavailableError: 'Secure storage is unavailable, so the Kimi API key was not saved.'
  })

  ipcMain.handle('get-kimi-auth-status', statusHandler)
  ipcMain.handle('store-kimi-api-key', apiKeyHandlers.storeKey)
  ipcMain.handle('clear-kimi-api-key', apiKeyHandlers.clearKey)
}
