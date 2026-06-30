import { type BrowserWindow, type OpenDialogOptions, ipcMain } from 'electron'
import type { AppSettings } from '../store/types'

type ApnsConfig = NonNullable<AppSettings['apnsConfig']>

interface ApnsStatusResult {
  configured: boolean
  keyId?: string
  teamId?: string
  bundleId: string
  defaultBundleId: string
  configuredAt?: string
  lastTestResult?: ApnsConfig['lastTestResult']
  encryptionAvailable: boolean
  registeredDeviceCount: number
  pusherIsNoop: boolean
}

interface ApnsConfigInput {
  authKeyPath?: string
  keyId?: string
  teamId?: string
  bundleId?: string
}

interface ApnsTokenEntryLike {
  pairID: string
  deviceToken: string
  env: 'production' | 'sandbox'
}

interface ApnsTokenStoreLike {
  size(): number
  list(): ApnsTokenEntryLike[]
}

interface ApnsPushResult {
  delivered: boolean
  apnsId: string
  reason?: string
}

interface ApnsPusherLike {
  isNoop?: boolean
  pushSilentToToken?: (
    deviceTokenHex: string,
    env: 'production' | 'sandbox',
    payload?: { reason: 'resume'; generatedAt: string }
  ) => Promise<ApnsPushResult>
}

interface OpenDialogResultLike {
  canceled: boolean
  filePaths: string[]
}

export interface ApnsHandlersDeps {
  getSettings: () => AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  defaultApnsBundleId: string
  getMainWindow: () => BrowserWindow | null
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<OpenDialogResultLike>
  readFile: (path: string, encoding: 'utf-8') => Promise<string>
  getApnsTokenStore: () => ApnsTokenStoreLike | null
  getApnsPusher: () => ApnsPusherLike | null
  rebuildBridgeApnsPusherFromSettings: () => void
  getNowIso: () => string
}

export function registerApnsHandlers(deps: ApnsHandlersDeps): void {
  ipcMain.handle('get-apns-config', async (): Promise<ApnsStatusResult> => {
    const config = deps.getSettings().apnsConfig
    const encryptionAvailable = deps.isEncryptionAvailable()
    const store = deps.getApnsTokenStore()
    const pusher = deps.getApnsPusher()
    return {
      configured: Boolean(config?.encryptedAuthKey && config?.keyId && config?.teamId),
      keyId: config?.keyId,
      teamId: config?.teamId,
      bundleId: config?.bundleId || deps.defaultApnsBundleId,
      defaultBundleId: deps.defaultApnsBundleId,
      configuredAt: config?.configuredAt,
      lastTestResult: config?.lastTestResult,
      encryptionAvailable,
      registeredDeviceCount: store?.size() ?? 0,
      pusherIsNoop: Boolean(pusher === null || (pusher as { isNoop?: boolean }).isNoop)
    }
  })

  ipcMain.handle('select-apns-key-file', async () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return null
    const result = await deps.showOpenDialog(mainWindow, {
      title: 'Select Apple APNs auth key (.p8)',
      properties: ['openFile'],
      filters: [{ name: 'APNs Auth Key', extensions: ['p8', 'pem', 'key'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('set-apns-config', async (_, input: ApnsConfigInput) => {
    const keyId = (input?.keyId || '').trim()
    const teamId = (input?.teamId || '').trim()
    const bundleId = (input?.bundleId || deps.defaultApnsBundleId).trim()
    if (!keyId || !teamId) {
      return { ok: false, error: 'keyId and teamId are required.' }
    }
    if (!deps.isEncryptionAvailable()) {
      return {
        ok: false,
        error: 'macOS Keychain encryption is unavailable; cannot safely store the APNs auth key.'
      }
    }
    const existingEncrypted = deps.getSettings().apnsConfig?.encryptedAuthKey
    let encryptedAuthKey = existingEncrypted
    if (input?.authKeyPath) {
      try {
        const pem = await deps.readFile(input.authKeyPath, 'utf-8')
        if (!pem.includes('BEGIN PRIVATE KEY')) {
          return {
            ok: false,
            error: 'Selected file does not look like a PEM-encoded PKCS8 private key (.p8).'
          }
        }
        encryptedAuthKey = deps.encryptString(pem).toString('base64')
      } catch (err) {
        return {
          ok: false,
          error: `Failed to read .p8 key: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
    if (!encryptedAuthKey) {
      return { ok: false, error: 'No APNs auth key on file. Please select a .p8 to encrypt.' }
    }
    deps.updateSettings({
      apnsConfig: {
        encryptedAuthKey,
        keyId,
        teamId,
        bundleId,
        configuredAt: deps.getNowIso(),
        encryptionAvailable: true
      }
    })
    deps.rebuildBridgeApnsPusherFromSettings()
    return { ok: true }
  })

  ipcMain.handle('clear-apns-config', async () => {
    deps.updateSettings({ apnsConfig: undefined as any })
    deps.rebuildBridgeApnsPusherFromSettings()
    return { ok: true }
  })

  ipcMain.handle('test-apns-push', async () => {
    const pusher = deps.getApnsPusher()
    const store = deps.getApnsTokenStore()
    if (!pusher || !store) {
      return { ok: false, error: 'APNs pusher or token store not initialised yet.' }
    }
    const entries = store.list()
    if (entries.length === 0) {
      const result = {
        at: deps.getNowIso(),
        delivered: 0,
        failed: 0,
        error: 'No paired iOS devices have registered an APNs device token yet.'
      }
      const current = deps.getSettings().apnsConfig
      if (current) {
        deps.updateSettings({ apnsConfig: { ...current, lastTestResult: result } })
      }
      return { ok: false, ...result }
    }
    const pusherTokenAware = pusher as ApnsPusherLike
    let delivered = 0
    let failed = 0
    const errors: string[] = []
    if (typeof pusherTokenAware.pushSilentToToken !== 'function') {
      const result = {
        at: deps.getNowIso(),
        delivered: 0,
        failed: 0,
        error: 'APNs not configured (NoopApnsPusher). Save a .p8 + keyId + teamId first.'
      }
      const current = deps.getSettings().apnsConfig
      if (current) {
        deps.updateSettings({ apnsConfig: { ...current, lastTestResult: result } })
      }
      return { ok: false, ...result }
    }
    for (const entry of entries) {
      try {
        const result = await pusherTokenAware.pushSilentToToken(entry.deviceToken, entry.env, {
          reason: 'resume',
          generatedAt: deps.getNowIso()
        })
        if (result.delivered) {
          delivered++
        } else {
          failed++
          if (result.reason) errors.push(`${entry.pairID}: ${result.reason}`)
        }
      } catch (err) {
        failed++
        errors.push(`${entry.pairID}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const summary = {
      at: deps.getNowIso(),
      delivered,
      failed,
      error: errors.length ? errors.join('; ') : undefined
    }
    const current = deps.getSettings().apnsConfig
    if (current) {
      deps.updateSettings({ apnsConfig: { ...current, lastTestResult: summary } })
    }
    return { ok: failed === 0 || delivered > 0, ...summary }
  })
}
