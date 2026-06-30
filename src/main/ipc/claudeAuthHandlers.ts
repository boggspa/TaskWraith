import { ipcMain } from 'electron'
import type { ChildProcess, SpawnOptions } from 'child_process'
import type { ProviderApiKeyStatus } from '../store/types'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'

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
}

export function registerClaudeAuthHandlers(deps: ClaudeAuthHandlersDeps): void {
  ipcMain.handle('get-claude-auth-status', async (): Promise<ProviderApiKeyStatus> => {
    const encryptionAvailable = deps.isEncryptionAvailable()
    const apiKeyConfigured = Boolean(deps.getSettings().claudeApiKey)
    const resolved = await deps.resolveCliProviderBinary('claude')
    if (!resolved.binaryPath) {
      return {
        available: false,
        authState: 'missing',
        apiKeyConfigured,
        encryptionAvailable,
        binaryPath: null
      }
    }
    const [authState, version] = await Promise.all([
      deps.readClaudeAuthState(resolved),
      deps.readResolvedCliVersion(resolved)
    ])
    return {
      available: true,
      authState,
      apiKeyConfigured,
      encryptionAvailable,
      version,
      binaryPath: resolved.binaryPath
    }
  })

  ipcMain.handle('store-claude-api-key', async (_, rawKey: string) => {
    const key = String(rawKey || '').trim()
    if (!key) {
      deps.updateSettings({ claudeApiKey: undefined })
      return {
        stored: false,
        encryptionAvailable: deps.isEncryptionAvailable()
      }
    }
    if (!deps.isEncryptionAvailable()) {
      return {
        stored: false,
        encryptionAvailable: false,
        error: 'Secure storage is unavailable, so the Claude API key was not saved.'
      }
    }
    const encrypted = deps.encryptApiKey(key)
    deps.updateSettings({ claudeApiKey: encrypted || undefined })
    return {
      stored: Boolean(encrypted),
      encryptionAvailable: deps.isEncryptionAvailable()
    }
  })

  ipcMain.handle('clear-claude-api-key', async () => {
    deps.updateSettings({ claudeApiKey: undefined })
    return true
  })

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
