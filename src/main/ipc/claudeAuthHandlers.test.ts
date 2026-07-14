import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { ipcMain } from 'electron'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import {
  registerClaudeAuthHandlers,
  type ClaudeAuthHandlersDeps
} from './claudeAuthHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createResolved(binaryPath: string | null): ResolvedProviderBinary {
  return {
    provider: 'claude',
    binaryPath,
    source: binaryPath ? 'path' : 'missing'
  }
}

function createDeps() {
  let settings = { claudeApiKey: 'encrypted-key' as string | undefined }
  let closeHandler: ((code: number | null) => void) | null = null
  let errorHandler: ((err: Error) => void) | null = null

  const deps = {
    getSettings: vi.fn<ClaudeAuthHandlersDeps['getSettings']>(() => settings),
    updateSettings: vi.fn<ClaudeAuthHandlersDeps['updateSettings']>((patch) => {
      settings = { ...settings, ...patch }
    }),
    isEncryptionAvailable: vi.fn<ClaudeAuthHandlersDeps['isEncryptionAvailable']>(() => true),
    encryptApiKey: vi.fn<ClaudeAuthHandlersDeps['encryptApiKey']>(
      (value) => `encrypted:${value}`
    ),
    resolveCliProviderBinary: vi.fn<ClaudeAuthHandlersDeps['resolveCliProviderBinary']>(
      async () => createResolved('/usr/local/bin/claude')
    ),
    readClaudeAuthState: vi.fn<ClaudeAuthHandlersDeps['readClaudeAuthState']>(
      async () => 'authenticated'
    ),
    readResolvedCliVersion: vi.fn<ClaudeAuthHandlersDeps['readResolvedCliVersion']>(
      async () => '1.2.3'
    ),
    spawn: vi.fn<ClaudeAuthHandlersDeps['spawn']>(() => {
      const child = {
        on: (event: string, handler: (...args: any[]) => void) => {
          if (event === 'close') closeHandler = (code) => handler(code)
          if (event === 'error') errorHandler = (err) => handler(err)
          return child as Pick<ChildProcess, 'on'>
        }
      }
      return child as Pick<ChildProcess, 'on'>
    }),
    createCliEnv: vi.fn<ClaudeAuthHandlersDeps['createCliEnv']>(() => ({ PATH: '/usr/bin' })),
    isMainRendererSender: vi.fn<ClaudeAuthHandlersDeps['isMainRendererSender']>(() => true)
  }

  return {
    deps,
    getSettingsSnapshot: () => settings,
    triggerClose(code: number | null) {
      if (closeHandler) closeHandler(code)
    },
    triggerError(err: Error) {
      if (errorHandler) errorHandler(err)
    }
  }
}

describe('registerClaudeAuthHandlers', () => {
  it('registers claude auth IPC channels', () => {
    registerClaudeAuthHandlers(createDeps().deps)

    expect(handlerFor('get-claude-auth-status')).toBeTypeOf('function')
    expect(handlerFor('store-claude-api-key')).toBeTypeOf('function')
    expect(handlerFor('clear-claude-api-key')).toBeTypeOf('function')
    expect(handlerFor('trigger-claude-login')).toBeTypeOf('function')
  })

  it('returns missing status when the Claude binary is unavailable', async () => {
    const { deps } = createDeps()
    deps.resolveCliProviderBinary.mockResolvedValueOnce(createResolved(null))
    registerClaudeAuthHandlers(deps)

    await expect(handlerFor('get-claude-auth-status')({})).resolves.toEqual({
      available: false,
      authState: 'missing',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      binaryPath: null
    })
  })

  it('returns available status with concurrent auth state and version reads when binary exists', async () => {
    const { deps } = createDeps()
    registerClaudeAuthHandlers(deps)

    await expect(handlerFor('get-claude-auth-status')({})).resolves.toEqual({
      available: true,
      authState: 'authenticated',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      version: '1.2.3',
      binaryPath: '/usr/local/bin/claude'
    })
    expect(deps.readClaudeAuthState).toHaveBeenCalledWith(createResolved('/usr/local/bin/claude'))
    expect(deps.readResolvedCliVersion).toHaveBeenCalledWith(createResolved('/usr/local/bin/claude'))
  })

  it('omits the resolved binary path from secondary auth status', async () => {
    const { deps } = createDeps()
    deps.isMainRendererSender.mockReturnValue(false)
    registerClaudeAuthHandlers(deps)

    await expect(handlerFor('get-claude-auth-status')({ sender: { id: 42 } })).resolves.toEqual({
      available: true,
      authState: 'authenticated',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      version: '1.2.3'
    })
  })

  it('store-claude-api-key clears on empty input, rejects unavailable secure storage, and stores encrypted keys', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerClaudeAuthHandlers(deps)

    await expect(handlerFor('store-claude-api-key')({}, '   ')).resolves.toEqual({
      stored: false,
      encryptionAvailable: true
    })
    expect(getSettingsSnapshot().claudeApiKey).toBeUndefined()

    deps.isEncryptionAvailable.mockReturnValue(false)
    deps.updateSettings.mockClear()
    await expect(handlerFor('store-claude-api-key')({}, 'abc')).resolves.toEqual({
      stored: false,
      encryptionAvailable: false,
      error: 'Secure storage is unavailable, so the Claude API key was not saved.'
    })
    expect(deps.updateSettings).not.toHaveBeenCalled()

    deps.isEncryptionAvailable.mockReturnValue(true)
    await expect(handlerFor('store-claude-api-key')({}, '  abc  ')).resolves.toEqual({
      stored: true,
      encryptionAvailable: true
    })
    expect(deps.encryptApiKey).toHaveBeenCalledWith('abc')
    expect(getSettingsSnapshot().claudeApiKey).toBe('encrypted:abc')
  })

  it('clear-claude-api-key clears the stored key and returns true', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerClaudeAuthHandlers(deps)

    await expect(handlerFor('clear-claude-api-key')({})).resolves.toBe(true)
    expect(getSettingsSnapshot().claudeApiKey).toBeUndefined()
  })

  it('trigger-claude-login preserves missing-binary error and spawn contract', async () => {
    const { deps, triggerClose, triggerError } = createDeps()
    registerClaudeAuthHandlers(deps)

    deps.resolveCliProviderBinary.mockResolvedValueOnce(createResolved(null))
    await expect(handlerFor('trigger-claude-login')({})).resolves.toEqual({
      ok: false,
      error: 'Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code'
    })

    const pending = handlerFor('trigger-claude-login')({})
    await Promise.resolve()
    expect(deps.spawn).toHaveBeenCalledWith('/usr/local/bin/claude', ['auth', 'login'], {
      shell: false,
      stdio: 'ignore',
      env: { PATH: '/usr/bin' }
    })
    expect(deps.createCliEnv).toHaveBeenCalledWith({}, '/usr/local/bin/claude')
    triggerClose(0)
    await expect(pending).resolves.toEqual({ ok: true, code: 0 })

    const rejected = handlerFor('trigger-claude-login')({})
    await Promise.resolve()
    triggerClose(1)
    await expect(rejected).resolves.toEqual({ ok: false, code: 1 })

    const failing = handlerFor('trigger-claude-login')({})
    await Promise.resolve()
    triggerError(new Error('spawn failed'))
    await expect(failing).resolves.toEqual({ ok: false, error: 'spawn failed' })
  })
})
