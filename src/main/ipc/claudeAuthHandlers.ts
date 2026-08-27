import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChildProcess, SpawnOptions } from 'child_process'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import {
  createCliProviderAuthStatusHandler,
  createProviderApiKeyHandlers
} from './providerSecretHandlerFactory'

interface ClaudeAuthStateReader {
  (resolved: ResolvedProviderBinary): Promise<string>
}

interface ClaudeVersionReader {
  (resolved: ResolvedProviderBinary): Promise<string>
}

export interface ClaudeAuthHandlersDeps {
  getSettings: () => { claudeApiKey?: string }
  updateSettings: (patch: { claudeApiKey?: string }) => void
  isEncryptionAvailable: () => boolean
  encryptApiKey: (value: string) => string | null
  resolveCliProviderBinary: (provider: 'claude') => Promise<ResolvedProviderBinary>
  readClaudeAuthState: ClaudeAuthStateReader
  readResolvedCliVersion: ClaudeVersionReader
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => Pick<ChildProcess, 'on'>
  createCliEnv: (
    extra: Record<string, string>,
    binaryPath?: string | null
  ) => Record<string, string>
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerClaudeAuthHandlers(deps: ClaudeAuthHandlersDeps): void {
  const statusHandler = createCliProviderAuthStatusHandler({
    providerNameForCli: 'claude',
    getSettings: () => ({ apiKey: deps.getSettings().claudeApiKey }),
    isEncryptionAvailable: deps.isEncryptionAvailable,
    resolveCliProviderBinary: deps.resolveCliProviderBinary,
    isMainRendererSender: deps.isMainRendererSender,
    readStatus: async (resolved) => {
      const apiKeyConfigured = Boolean(deps.getSettings().claudeApiKey)
      const encryptionAvailable = deps.isEncryptionAvailable()
      const [authState, version] = await Promise.all([
        deps.readClaudeAuthState(resolved),
        deps.readResolvedCliVersion(resolved)
      ])
      const status: ProviderApiKeyStatus = {
        available: true,
        authState,
        apiKeyConfigured,
        encryptionAvailable,
        version,
        binaryPath: resolved.binaryPath
      }
      return status
    }
  })

  const apiKeyHandlers = createProviderApiKeyHandlers({
    providerName: 'claude',
    settingsKey: 'claudeApiKey',
    getSettings: () => ({ apiKey: deps.getSettings().claudeApiKey }),
    updateSettings: (patch) => deps.updateSettings({ claudeApiKey: patch.apiKey }),
    isEncryptionAvailable: deps.isEncryptionAvailable,
    encryptApiKey: deps.encryptApiKey,
    secureStorageUnavailableError: 'Secure storage is unavailable, so the Claude API key was not saved.'
  })

  ipcMain.handle('get-claude-auth-status', statusHandler)
  ipcMain.handle('store-claude-api-key', apiKeyHandlers.storeKey)
  ipcMain.handle('clear-claude-api-key', apiKeyHandlers.clearKey)

  ipcMain.handle('trigger-claude-login', async () => {
    const resolved = await deps.resolveCliProviderBinary('claude')
    if (!resolved.binaryPath) {
      return {
        ok: false,
        error: 'Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
      }
    }
    return new Promise<{ ok: boolean; error?: string; code?: number | null }>((resolve) => {
      const child = deps.spawn(resolved.binaryPath!, ['auth', 'login'], {
        shell: false,
        stdio: 'ignore',
        env: deps.createCliEnv({}, resolved.binaryPath)
      })
      child.on('close', (code) => resolve({ ok: code === 0, code }))
      child.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
    })
  })
}
