import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  canonicalIsoTimestamp,
  createCliProviderAuthStatusHandler,
  createDiscoveryOutcomeHandler,
  createGeminiAuthHandlers,
  createProviderApiKeyHandlers,
  createProviderSecretHandlers,
  createProviderSecretStoreHandlers,
  createUsageWebSessionHandlers,
  normalizeWebSessionInput,
  projectMutation,
  projectStatus,
  webSessionStatusOf
} from './providerSecretHandlerFactory'
import type { IpcMainInvokeEvent } from 'electron'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('canonicalIsoTimestamp', () => {
  it('accepts no-millis ISO strings when allowed', () => {
    expect(canonicalIsoTimestamp('2026-08-18T12:00:00Z', { allowNoMillis: true })).toBe(
      '2026-08-18T12:00:00Z'
    )
  })

  it('rejects no-millis ISO strings by default', () => {
    expect(canonicalIsoTimestamp('2026-08-18T12:00:00Z')).toBeNull()
  })

  it('rejects non-round-trippable timestamps when required', () => {
    expect(
      canonicalIsoTimestamp('2026-02-30T12:00:00.000Z', { requireRoundTrip: true })
    ).toBeNull()
  })
})

describe('projectStatus', () => {
  it('projects configured state and canonical timestamps', () => {
    expect(
      projectStatus({
        configured: true,
        encryptionAvailable: true,
        updatedAt: '2026-08-18T12:00:00.000Z'
      })
    ).toEqual({
      configured: true,
      encryptionAvailable: true,
      updatedAt: '2026-08-18T12:00:00.000Z'
    })
  })

  it('drops noncanonical timestamps', () => {
    expect(
      projectStatus({
        configured: true,
        encryptionAvailable: true,
        updatedAt: 'not-a-timestamp'
      })
    ).toEqual({ configured: true, encryptionAvailable: true })
  })

  it('rejects non-round-trippable timestamps in strict mode', () => {
    expect(
      projectStatus(
        {
          configured: true,
          encryptionAvailable: true,
          updatedAt: '2026-02-30T12:00:00.000Z'
        },
        { allowNoMillis: false, requireRoundTrip: true }
      )
    ).toEqual({ configured: true, encryptionAvailable: true })
  })

  it('returns unavailable for non-records', () => {
    expect(projectStatus(null)).toEqual({ configured: false, encryptionAvailable: false })
    expect(projectStatus('x')).toEqual({ configured: false, encryptionAvailable: false })
  })
})

describe('projectMutation', () => {
  const recognized = new Set(['invalidApiKey', 'writeFailed'])

  it('returns default error for non-records', () => {
    expect(
      projectMutation(null, { recognizedErrors: recognized, defaultError: 'writeFailed' })
    ).toEqual({
      ok: false,
      status: { configured: false, encryptionAvailable: false },
      error: 'writeFailed'
    })
  })

  it('returns ok status for successful mutations', () => {
    expect(
      projectMutation(
        { ok: true, status: { configured: true, encryptionAvailable: true } },
        { recognizedErrors: recognized, defaultError: 'writeFailed' }
      )
    ).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true }
    })
  })

  it('passes through recognized errors', () => {
    expect(
      projectMutation(
        { ok: false, status: { configured: true }, error: 'invalidApiKey' },
        { recognizedErrors: recognized, defaultError: 'writeFailed' }
      )
    ).toEqual({
      ok: false,
      status: { configured: true, encryptionAvailable: false },
      error: 'invalidApiKey'
    })
  })

  it('uses fallbackError for unrecognized errors when provided', () => {
    expect(
      projectMutation(
        { ok: false, status: { configured: true }, error: 'unknown' },
        { recognizedErrors: recognized, defaultError: 'writeFailed', fallbackError: 'writeFailed' }
      )
    ).toEqual({
      ok: false,
      status: { configured: true, encryptionAvailable: false },
      error: 'writeFailed'
    })
  })

  it('omits error for unrecognized errors when no fallbackError', () => {
    expect(
      projectMutation(
        { ok: false, status: { configured: true }, error: 'unknown' },
        { recognizedErrors: recognized, defaultError: 'writeFailed' }
      )
    ).toEqual({
      ok: false,
      status: { configured: true, encryptionAvailable: false }
    })
  })
})

describe('normalizeWebSessionInput', () => {
  it('trims and returns non-empty strings', () => {
    expect(normalizeWebSessionInput('  abc  ')).toBe('abc')
  })

  it('rejects empty and non-string input', () => {
    expect(normalizeWebSessionInput('   ')).toBeNull()
    expect(normalizeWebSessionInput(42)).toBeNull()
  })
})

describe('webSessionStatusOf', () => {
  it('returns store status', () => {
    expect(
      webSessionStatusOf({ getStatus: () => ({ configured: true, encryptionAvailable: true }) })
    ).toEqual({
      configured: true,
      encryptionAvailable: true
    })
  })

  it('returns unavailable for null or throwing stores', () => {
    expect(webSessionStatusOf(null)).toEqual({ configured: false, encryptionAvailable: false })
    expect(
      webSessionStatusOf({
        getStatus: () => {
          throw new Error('boom')
        }
      })
    ).toEqual({ configured: false, encryptionAvailable: false })
  })
})

describe('createProviderApiKeyHandlers', () => {
  function createConfig() {
    let settings = { apiKey: 'encrypted-key' as string | undefined }
    return {
      config: {
        providerName: 'test',
        settingsKey: 'apiKey',
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn((patch: { apiKey?: string }) => {
          settings = { ...settings, ...patch }
        }),
        isEncryptionAvailable: vi.fn(() => true),
        encryptApiKey: vi.fn((value: string) => `encrypted:${value}`),
        secureStorageUnavailableError:
          'Secure storage is unavailable, so the Test API key was not saved.'
      },
      getSettingsSnapshot: () => settings
    }
  }

  it('clears empty input, rejects unavailable secure storage, and encrypts keys', async () => {
    const { config, getSettingsSnapshot } = createConfig()
    const handlers = createProviderApiKeyHandlers(config)

    await expect(handlers.storeKey({}, '   ')).resolves.toEqual({
      stored: false,
      encryptionAvailable: true
    })
    expect(getSettingsSnapshot().apiKey).toBeUndefined()

    config.isEncryptionAvailable.mockReturnValue(false)
    await expect(handlers.storeKey({}, 'secret')).resolves.toEqual({
      stored: false,
      encryptionAvailable: false,
      error: 'Secure storage is unavailable, so the Test API key was not saved.'
    })

    config.isEncryptionAvailable.mockReturnValue(true)
    await expect(handlers.storeKey({}, '  secret  ')).resolves.toEqual({
      stored: true,
      encryptionAvailable: true
    })
    expect(config.encryptApiKey).toHaveBeenCalledWith('secret')
    expect(getSettingsSnapshot().apiKey).toBe('encrypted:secret')
  })

  it('clears the stored key', async () => {
    const { config, getSettingsSnapshot } = createConfig()
    const handlers = createProviderApiKeyHandlers(config)
    await expect(handlers.clearKey()).resolves.toBe(true)
    expect(getSettingsSnapshot().apiKey).toBeUndefined()
  })
})

describe('createCliProviderAuthStatusHandler', () => {
  function createConfig(binaryPath: string | null) {
    return {
      getSettings: vi.fn(() => ({ apiKey: 'encrypted-key' })),
      isEncryptionAvailable: vi.fn(() => true),
      resolveCliProviderBinary: vi.fn(
        async () =>
          ({
            provider: 'claude',
            binaryPath,
            source: binaryPath ? 'path' : 'missing'
          }) as ResolvedProviderBinary
      ),
      isMainRendererSender: vi.fn(() => true),
      readStatus: vi.fn(async () => ({
        available: true,
        authState: 'authenticated',
        apiKeyConfigured: true,
        encryptionAvailable: true,
        version: '1.0.0',
        binaryPath
      })),
      providerNameForCli: 'test'
    }
  }

  it('returns missing status when binary is unavailable', async () => {
    const config = createConfig(null)
    const handler = createCliProviderAuthStatusHandler(config)
    await expect(handler({} as IpcMainInvokeEvent)).resolves.toEqual({
      available: false,
      authState: 'missing',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      binaryPath: null
    })
  })

  it('returns readStatus result for available binary', async () => {
    const config = createConfig('/usr/local/bin/test')
    const handler = createCliProviderAuthStatusHandler(config)
    await expect(handler({} as IpcMainInvokeEvent)).resolves.toEqual({
      available: true,
      authState: 'authenticated',
      apiKeyConfigured: true,
      encryptionAvailable: true,
      version: '1.0.0',
      binaryPath: '/usr/local/bin/test'
    })
  })

  it('omits binary path for secondary senders', async () => {
    const config = createConfig('/usr/local/bin/test')
    config.isMainRendererSender.mockReturnValue(false)
    const handler = createCliProviderAuthStatusHandler(config)
    await expect(handler({ sender: { id: 42 } } as unknown as IpcMainInvokeEvent)).resolves.toEqual(
      {
        available: true,
        authState: 'authenticated',
        apiKeyConfigured: true,
        encryptionAvailable: true,
        version: '1.0.0'
      }
    )
  })
})

describe('createProviderSecretStoreHandlers', () => {
  const recognized = new Set(['invalidApiKey', 'writeFailed'])

  function createConfig() {
    const store = {
      getStatus: vi.fn(() => ({ configured: false, encryptionAvailable: true })),
      setApiKey: vi.fn((value: string) => ({
        ok: true,
        status: { configured: true, encryptionAvailable: true },
        received: value
      })),
      clear: vi.fn(() => ({
        ok: true,
        status: { configured: false, encryptionAvailable: true }
      }))
    }
    return {
      config: {
        secretStore: store,
        isMainRendererSender: vi.fn(() => true),
        recognizedErrors: recognized,
        defaultError: 'writeFailed' as const
      },
      store
    }
  }

  it('projects store status and mutations', () => {
    const { config, store } = createConfig()
    const handlers = createProviderSecretStoreHandlers(config)
    expect(handlers.getStatus({} as IpcMainInvokeEvent)).toEqual({
      configured: false,
      encryptionAvailable: true
    })
    expect(handlers.setSecret({} as IpcMainInvokeEvent, 'key')).toEqual({
      ok: true,
      status: { configured: true, encryptionAvailable: true }
    })
    expect(handlers.clearSecret({} as IpcMainInvokeEvent)).toEqual({
      ok: true,
      status: { configured: false, encryptionAvailable: true }
    })
    expect(store.setApiKey).toHaveBeenCalledWith('key')
  })

  it('returns unavailable status for unauthorized sender', () => {
    const { config } = createConfig()
    config.isMainRendererSender.mockReturnValue(false)
    const handlers = createProviderSecretStoreHandlers(config)
    expect(handlers.getStatus({ sender: { id: 2 } } as unknown as IpcMainInvokeEvent)).toEqual({
      configured: false,
      encryptionAvailable: false
    })
  })

  it('throws for unauthorized sender when assertMainRendererError is set', () => {
    const { config } = createConfig()
    config.isMainRendererSender.mockReturnValue(false)
    const handlers = createProviderSecretStoreHandlers({
      ...config,
      assertMainRendererError: 'Only the main renderer can manage this key.'
    })
    expect(() =>
      handlers.getStatus({ sender: { id: 2 } } as unknown as IpcMainInvokeEvent)
    ).toThrow('Only the main renderer can manage this key.')
  })
})

describe('createDiscoveryOutcomeHandler', () => {
  it('projects a valid outcome', () => {
    const handler = createDiscoveryOutcomeHandler({
      getDiscoveryOutcome: () => ({
        status: 'ok',
        modelCount: 12,
        checkedAt: '2026-07-24T12:00:00.000Z'
      }),
      isMainRendererSender: () => true
    })
    expect(handler({} as IpcMainInvokeEvent)).toEqual({
      status: 'ok',
      modelCount: 12,
      checkedAt: '2026-07-24T12:00:00.000Z'
    })
  })

  it('returns null for invalid or missing outcomes', () => {
    const handler = createDiscoveryOutcomeHandler({
      getDiscoveryOutcome: () => null,
      isMainRendererSender: () => true
    })
    expect(handler({} as IpcMainInvokeEvent)).toBeNull()
  })

  it('returns null when source throws', () => {
    const handler = createDiscoveryOutcomeHandler({
      getDiscoveryOutcome: () => {
        throw new Error('boom')
      },
      isMainRendererSender: () => true
    })
    expect(handler({} as IpcMainInvokeEvent)).toBeNull()
  })

  it('throws for unauthorized sender when assertMainRendererError is set', () => {
    const handler = createDiscoveryOutcomeHandler({
      getDiscoveryOutcome: () => null,
      isMainRendererSender: () => false,
      assertMainRendererError: 'Only the main renderer can manage this key.'
    })
    expect(() => handler({ sender: { id: 2 } } as unknown as IpcMainInvokeEvent)).toThrow(
      'Only the main renderer can manage this key.'
    )
  })
})

describe('createUsageWebSessionHandlers', () => {
  function createConfig() {
    const store = {
      getStatus: vi.fn(() => ({ configured: false, encryptionAvailable: true })),
      setSession: vi.fn(() => ({
        ok: true,
        status: { configured: true, encryptionAvailable: true, updatedAt: '2026-08-25T20:00:00Z' }
      })),
      clear: vi.fn(() => ({ ok: true, status: { configured: false, encryptionAvailable: true } }))
    }
    return {
      config: {
        isMainRendererSender: vi.fn(() => true),
        store: vi.fn(() => store),
        importSession: vi.fn(async () => ({
          cookieHeader: 'session=secret',
          summary: { balance: 15, currency: 'GBP', capturedAt: '2026-08-25T20:00:00Z' }
        })),
        onSessionChanged: vi.fn()
      },
      store
    }
  }

  it('stores a validated import without returning the cookie', async () => {
    const { config, store } = createConfig()
    const handlers = createUsageWebSessionHandlers(config)
    const result = await handlers.importSession({} as IpcMainInvokeEvent, 'meta')
    expect(store.setSession).toHaveBeenCalledWith({
      cookieHeader: 'session=secret',
      reading: { balance: 15, currency: 'GBP', capturedAt: '2026-08-25T20:00:00Z' }
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result).toMatchObject({ ok: true, status: { configured: true } })
  })

  it('rejects invalid provider and unauthorized sender', async () => {
    const { config, store } = createConfig()
    const handlers = createUsageWebSessionHandlers(config)
    await expect(handlers.getStatus({} as IpcMainInvokeEvent, 'invalid')).resolves.toEqual({
      configured: false,
      encryptionAvailable: false
    })
    config.isMainRendererSender.mockReturnValue(false)
    await expect(handlers.importSession({} as IpcMainInvokeEvent, 'meta')).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(store.setSession).not.toHaveBeenCalled()
  })
})

describe('createGeminiAuthHandlers', () => {
  it('delegates to deps and applies renderer-safe projections', async () => {
    const profile = { id: 'profile-1', provider: 'gemini' } as never
    const summary = { id: 'profile-1', isDefault: true } as never
    const status = { authState: 'authenticated' } as never
    const oauthStatus = { status: 'running' } as never
    const config = {
      getGeminiAuthStatusSnapshot: vi.fn(async () => status),
      getDefaultGeminiAuthProfileId: vi.fn(() => 'profile-1'),
      getGeminiAuthProfiles: vi.fn(() => [profile]),
      summarizeGeminiAuthProfile: vi.fn(() => summary),
      saveGeminiAuthProfile: vi.fn(() => summary),
      deleteGeminiAuthProfile: vi.fn(async () => true),
      setDefaultGeminiAuthProfile: vi.fn(() => summary),
      startGeminiOAuthLogin: vi.fn(async () => oauthStatus),
      getGeminiOAuthLoginStatus: vi.fn(() => oauthStatus),
      cancelGeminiOAuthLogin: vi.fn(() => oauthStatus),
      isMainRendererSender: vi.fn(() => true)
    }
    const handlers = createGeminiAuthHandlers(config)

    await expect(handlers.getStatus({} as IpcMainInvokeEvent)).resolves.toBe(status)
    await expect(handlers.listProfiles({} as IpcMainInvokeEvent)).resolves.toEqual([summary])
    await expect(handlers.saveProfile({}, { id: 'p2' })).resolves.toBe(summary)
    await expect(handlers.deleteProfile({}, 'p2')).resolves.toBe(true)
    await expect(handlers.setDefaultProfile({}, 'p2')).resolves.toBe(summary)
    await expect(handlers.startOAuthLogin({}, { profileId: 'p2' })).resolves.toBe(oauthStatus)
    await expect(handlers.getOAuthLoginStatus({}, 'p2')).resolves.toBe(oauthStatus)
    await expect(handlers.cancelOAuthLogin({}, 'p2')).resolves.toBe(oauthStatus)
  })
})

describe('createProviderSecretHandlers', () => {
  it('dispatches to the correct factory', () => {
    const apiKey = createProviderSecretHandlers({
      kind: 'apiKey',
      config: {
        providerName: 'test',
        settingsKey: 'apiKey',
        getSettings: () => ({}),
        updateSettings: () => {},
        isEncryptionAvailable: () => true,
        encryptApiKey: (v) => v,
        secureStorageUnavailableError: 'unavailable'
      }
    })
    expect(apiKey).toHaveProperty('storeKey')
    expect(apiKey).toHaveProperty('clearKey')

    const cli = createProviderSecretHandlers({
      kind: 'cliAuth',
      config: {
        getSettings: () => ({}),
        isEncryptionAvailable: () => true,
        resolveCliProviderBinary: async () => ({
          provider: 'claude',
          binaryPath: null,
          source: 'missing'
        }),
        isMainRendererSender: () => true,
        readStatus: async () => ({
          available: false,
          authState: 'missing',
          apiKeyConfigured: false,
          encryptionAvailable: true
        }),
        providerNameForCli: 'test'
      }
    })
    expect(cli).toHaveProperty('getStatus')

    expect(() => createProviderSecretHandlers({ kind: 'unknown' } as never)).toThrow(
      'Unknown provider secret handler kind'
    )
  })
})
