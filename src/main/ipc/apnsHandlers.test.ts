import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { AppSettings } from '../store/types'
import { registerApnsHandlers } from './apnsHandlers'

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

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    apnsConfig: {
      encryptedAuthKey: 'encrypted',
      keyId: 'KEY123',
      teamId: 'TEAM123',
      bundleId: 'com.example.app',
      configuredAt: '2026-06-30T12:00:00.000Z',
      encryptionAvailable: true
    },
    ...overrides
  } as unknown as AppSettings
}

function createDeps() {
  let settings = createSettings()
  let mainWindow: BrowserWindow | null = { id: 1 } as unknown as BrowserWindow
  let tokenStore:
    | {
        size: () => number
        list: () => Array<{ pairID: string; deviceToken: string; env: 'production' | 'sandbox' }>
      }
    | null = {
        size: () => 2,
        list: () => [
          { pairID: 'pair-1', deviceToken: 'token-1', env: 'production' },
          { pairID: 'pair-2', deviceToken: 'token-2', env: 'sandbox' }
        ]
      }
  let pusher:
    | {
        isNoop?: boolean
        pushSilentToToken?: (
          deviceTokenHex: string,
          env: 'production' | 'sandbox',
          payload?: { reason: 'resume'; generatedAt: string }
        ) => Promise<{ delivered: boolean; apnsId: string; reason?: string }>
      }
    | null = { isNoop: true }

  const calls: string[] = []

  const deps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((patch: Partial<AppSettings>) => {
      calls.push('update')
      settings = { ...settings, ...patch } as AppSettings
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    defaultApnsBundleId: 'com.taskwraith.companion',
    getMainWindow: vi.fn(() => mainWindow),
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/tmp/AuthKey.p8'] })),
    readFile: vi.fn(async () => '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    getApnsTokenStore: vi.fn(() => tokenStore),
    getApnsPusher: vi.fn(() => pusher),
    rebuildBridgeApnsPusherFromSettings: vi.fn(() => {
      calls.push('rebuild')
    }),
    getNowIso: vi.fn(() => '2026-06-30T13:00:00.000Z')
  }

  return {
    deps,
    calls,
    setSettings(next: AppSettings) {
      settings = next
    },
    setMainWindow(next: BrowserWindow | null) {
      mainWindow = next
    },
    setTokenStore(next: typeof tokenStore) {
      tokenStore = next
    },
    setPusher(next: typeof pusher) {
      pusher = next
    }
  }
}

describe('registerApnsHandlers', () => {
  it('registers APNs IPC channels', () => {
    registerApnsHandlers(createDeps().deps)

    expect(handlerFor('get-apns-config')).toBeTypeOf('function')
    expect(handlerFor('select-apns-key-file')).toBeTypeOf('function')
    expect(handlerFor('set-apns-config')).toBeTypeOf('function')
    expect(handlerFor('clear-apns-config')).toBeTypeOf('function')
    expect(handlerFor('test-apns-push')).toBeTypeOf('function')
  })

  it('returns a redacted APNs config status from live getters', async () => {
    const { deps, setPusher, setTokenStore } = createDeps()
    registerApnsHandlers(deps)

    setPusher({ isNoop: true })
    setTokenStore({ size: () => 3, list: () => [] })

    const result = await handlerFor('get-apns-config')({})
    expect(result).toMatchObject({
      configured: true,
      keyId: 'KEY123',
      teamId: 'TEAM123',
      bundleId: 'com.example.app',
      defaultBundleId: 'com.taskwraith.companion',
      configuredAt: '2026-06-30T12:00:00.000Z',
      encryptionAvailable: true,
      registeredDeviceCount: 3,
      pusherIsNoop: true
    })
    expect(result).not.toHaveProperty('encryptedAuthKey')
  })

  it('selects an APNs key file using the current main window and exact dialog shape', async () => {
    const { deps, setMainWindow } = createDeps()
    registerApnsHandlers(deps)

    setMainWindow(null)
    await expect(handlerFor('select-apns-key-file')({})).resolves.toBeNull()

    setMainWindow({ id: 1 } as unknown as BrowserWindow)
    await expect(handlerFor('select-apns-key-file')({})).resolves.toBe('/tmp/AuthKey.p8')
    expect(deps.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Select Apple APNs auth key (.p8)',
        properties: ['openFile'],
        filters: [{ name: 'APNs Auth Key', extensions: ['p8', 'pem', 'key'] }]
      })
    )
  })

  it('preserves APNs config validation and PEM error strings', async () => {
    const { deps } = createDeps()
    registerApnsHandlers(deps)

    await expect(handlerFor('set-apns-config')({}, { keyId: '', teamId: '' })).resolves.toEqual({
      ok: false,
      error: 'keyId and teamId are required.'
    })

    deps.isEncryptionAvailable.mockReturnValue(false)
    await expect(
      handlerFor('set-apns-config')({}, { keyId: 'KEY', teamId: 'TEAM' })
    ).resolves.toEqual({
      ok: false,
      error: 'macOS Keychain encryption is unavailable; cannot safely store the APNs auth key.'
    })

    deps.isEncryptionAvailable.mockReturnValue(true)
    deps.readFile.mockResolvedValue('not a pem')
    await expect(
      handlerFor('set-apns-config')({}, {
        authKeyPath: '/tmp/AuthKey.p8',
        keyId: 'KEY',
        teamId: 'TEAM'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Selected file does not look like a PEM-encoded PKCS8 private key (.p8).'
    })
  })

  it('persists then rebuilds APNs config on success', async () => {
    const { deps, calls } = createDeps()
    registerApnsHandlers(deps)

    await expect(
      handlerFor('set-apns-config')({}, {
        authKeyPath: '/tmp/AuthKey.p8',
        keyId: ' KEY123 ',
        teamId: ' TEAM123 ',
        bundleId: ''
      })
    ).resolves.toEqual({ ok: true })

    expect(calls).toEqual(['update', 'rebuild'])
    expect(deps.updateSettings).toHaveBeenCalledWith({
      apnsConfig: expect.objectContaining({
        encryptedAuthKey: Buffer.from(
          'enc:-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
        ).toString('base64'),
        keyId: 'KEY123',
        teamId: 'TEAM123',
        bundleId: 'com.taskwraith.companion',
        configuredAt: '2026-06-30T13:00:00.000Z',
        encryptionAvailable: true
      })
    })
  })

  it('clears APNs config and rebuilds the pusher', async () => {
    const { deps, calls } = createDeps()
    registerApnsHandlers(deps)

    await expect(handlerFor('clear-apns-config')({})).resolves.toEqual({ ok: true })
    expect(deps.updateSettings).toHaveBeenCalledWith({ apnsConfig: undefined })
    expect(calls).toEqual(['update', 'rebuild'])
  })

  it('returns the initialisation and empty-token-store errors exactly', async () => {
    const { deps, setPusher, setTokenStore } = createDeps()
    registerApnsHandlers(deps)

    setPusher(null)
    setTokenStore(null)
    await expect(handlerFor('test-apns-push')({})).resolves.toEqual({
      ok: false,
      error: 'APNs pusher or token store not initialised yet.'
    })

    setPusher({ isNoop: false, pushSilentToToken: vi.fn() })
    setTokenStore({ size: () => 0, list: () => [] })
    await expect(handlerFor('test-apns-push')({})).resolves.toEqual({
      ok: false,
      at: '2026-06-30T13:00:00.000Z',
      delivered: 0,
      failed: 0,
      error: 'No paired iOS devices have registered an APNs device token yet.'
    })
  })

  it('preserves noop and mixed delivery APNs push result behavior and lastTestResult guards', async () => {
    const { deps, setPusher } = createDeps()
    registerApnsHandlers(deps)

    setPusher({ isNoop: true })
    await expect(handlerFor('test-apns-push')({})).resolves.toEqual({
      ok: false,
      at: '2026-06-30T13:00:00.000Z',
      delivered: 0,
      failed: 0,
      error: 'APNs not configured (NoopApnsPusher). Save a .p8 + keyId + teamId first.'
    })

    setPusher({
      pushSilentToToken: vi
        .fn()
        .mockResolvedValueOnce({ delivered: true, apnsId: 'apns-1' })
        .mockResolvedValueOnce({ delivered: false, apnsId: 'apns-2', reason: 'rejected' })
    })
    await expect(handlerFor('test-apns-push')({})).resolves.toEqual({
      ok: true,
      at: '2026-06-30T13:00:00.000Z',
      delivered: 1,
      failed: 1,
      error: 'pair-2: rejected'
    })
  })

  it('does not create APNs config only to persist push test results', async () => {
    const { deps, setPusher, setSettings, setTokenStore } = createDeps()
    registerApnsHandlers(deps)

    setSettings(createSettings({ apnsConfig: undefined }))
    setPusher({ pushSilentToToken: vi.fn() })
    setTokenStore({ size: () => 0, list: () => [] })
    await handlerFor('test-apns-push')({})
    expect(deps.updateSettings).not.toHaveBeenCalled()

    setPusher({ isNoop: true })
    setTokenStore({
      size: () => 1,
      list: () => [{ pairID: 'pair-1', deviceToken: 'token-1', env: 'production' }]
    })
    await handlerFor('test-apns-push')({})
    expect(deps.updateSettings).not.toHaveBeenCalled()

    setPusher({
      pushSilentToToken: vi.fn().mockResolvedValue({ delivered: true, apnsId: 'apns-1' })
    })
    await handlerFor('test-apns-push')({})
    expect(deps.updateSettings).not.toHaveBeenCalled()
  })
})
