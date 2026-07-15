import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import type { KimiFlavourFindings } from '../providers/KimiFlavour'
import { registerKimiAuthHandlers } from './kimiAuthHandlers'

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
    provider: 'kimi',
    binaryPath,
    source: binaryPath ? 'path' : 'missing'
  }
}

function createDeps() {
  let settings = { kimiApiKey: 'encrypted-key' as string | undefined }
  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((patch: { kimiApiKey?: string }) => {
      settings = { ...settings, ...patch }
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptApiKey: vi.fn((value: string) => `encrypted:${value}`),
    resolveCliProviderBinary: vi.fn(async () => createResolved('/usr/local/bin/kimi')),
    readResolvedCliVersion: vi.fn(async () => '2.7.0'),
    probeKimiFlavour: vi.fn(
      async (): Promise<KimiFlavourFindings> => ({
        flavour: 'legacy-wire',
        evidence: '--wire advertised in --help'
      })
    ),
    hasOAuthCredential: vi.fn(async () => false),
    isMainRendererSender: vi.fn(() => true)
  }

  return {
    deps,
    getSettingsSnapshot: () => settings
  }
}

describe('registerKimiAuthHandlers', () => {
  it('registers kimi auth IPC channels', () => {
    registerKimiAuthHandlers(createDeps().deps)

    expect(handlerFor('get-kimi-auth-status')).toBeTypeOf('function')
    expect(handlerFor('store-kimi-api-key')).toBeTypeOf('function')
    expect(handlerFor('clear-kimi-api-key')).toBeTypeOf('function')
  })

  it('returns missing status when the Kimi binary is unavailable', async () => {
    const { deps } = createDeps()
    deps.resolveCliProviderBinary.mockResolvedValueOnce(createResolved(null))
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toEqual({
      available: false,
      authState: 'missing',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      binaryPath: null
    })
  })

  it('returns api-key vs unknown authState depending on whether a key is configured', async () => {
    const { deps } = createDeps()
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toEqual({
      available: true,
      authState: 'api-key',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      version: '2.7.0',
      binaryPath: '/usr/local/bin/kimi',
      cliFlavour: 'legacy-wire',
      transportSupported: true
    })

    deps.getSettings.mockReturnValueOnce({ kimiApiKey: undefined })
    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toEqual({
      available: true,
      authState: 'unknown',
      apiKeyConfigured: false,
      encryptionAvailable: true,
      version: '2.7.0',
      binaryPath: '/usr/local/bin/kimi',
      cliFlavour: 'legacy-wire',
      transportSupported: true
    })
  })

  it('reports oauth authState for a signed-in user with no API key', async () => {
    const { deps } = createDeps()
    deps.getSettings.mockReturnValue({ kimiApiKey: undefined })
    deps.hasOAuthCredential.mockResolvedValue(true)
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toMatchObject({
      available: true,
      authState: 'oauth',
      apiKeyConfigured: false
    })
  })

  it('stays unknown when neither an API key nor an OAuth credential is present', async () => {
    const { deps } = createDeps()
    deps.getSettings.mockReturnValue({ kimiApiKey: undefined })
    deps.hasOAuthCredential.mockResolvedValue(false)
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toMatchObject({
      authState: 'unknown'
    })
  })

  it('marks a Kimi Code binary as available but transport-unsupported', async () => {
    const { deps } = createDeps()
    deps.probeKimiFlavour.mockResolvedValue({
      flavour: 'kimi-code' as const,
      evidence: "no --wire option; 'acp' subcommand advertised in --help"
    })
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({})).resolves.toMatchObject({
      available: true,
      cliFlavour: 'kimi-code',
      transportSupported: false
    })
    expect(deps.probeKimiFlavour).toHaveBeenCalledWith('/usr/local/bin/kimi')
  })

  it('omits the resolved binary path from secondary auth status', async () => {
    const { deps } = createDeps()
    deps.isMainRendererSender.mockReturnValue(false)
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('get-kimi-auth-status')({ sender: { id: 42 } })).resolves.toEqual({
      available: true,
      authState: 'api-key',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      version: '2.7.0'
    })
  })

  it('store-kimi-api-key clears on empty input, rejects unavailable secure storage, and stores encrypted keys', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('store-kimi-api-key')({}, '   ')).resolves.toEqual({
      stored: false,
      encryptionAvailable: true
    })
    expect(getSettingsSnapshot().kimiApiKey).toBeUndefined()

    deps.isEncryptionAvailable.mockReturnValue(false)
    deps.updateSettings.mockClear()
    await expect(handlerFor('store-kimi-api-key')({}, 'abc')).resolves.toEqual({
      stored: false,
      encryptionAvailable: false,
      error: 'Secure storage is unavailable, so the Kimi API key was not saved.'
    })
    expect(deps.updateSettings).not.toHaveBeenCalled()

    deps.isEncryptionAvailable.mockReturnValue(true)
    await expect(handlerFor('store-kimi-api-key')({}, '  abc  ')).resolves.toEqual({
      stored: true,
      encryptionAvailable: true
    })
    expect(deps.encryptApiKey).toHaveBeenCalledWith('abc')
    expect(getSettingsSnapshot().kimiApiKey).toBe('encrypted:abc')
  })

  it('clear-kimi-api-key clears the stored key and returns true', async () => {
    const { deps, getSettingsSnapshot } = createDeps()
    registerKimiAuthHandlers(deps)

    await expect(handlerFor('clear-kimi-api-key')({})).resolves.toBe(true)
    expect(getSettingsSnapshot().kimiApiKey).toBeUndefined()
  })
})
