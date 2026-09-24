import * as electron from 'electron'
import { isAbsolute, parse, resolve } from 'node:path'

import {
  configureHostStoreRuntime,
  getConfiguredHostStoreRuntime,
  type HostStoreRuntime,
  type HostStoreSecureStorage
} from '../../host-runtime/HostStoreRuntime'

/**
 * Electron-only compatibility adapter. Importing this module is the desktop
 * entry boundary: it installs a host store runtime before store/index can be
 * evaluated. A standalone Node Host must import store/index directly after
 * configuring HostStoreRuntime, so it never reaches this file or Electron.
 */
export function installElectronStoreRuntime(): Readonly<HostStoreRuntime> {
  const existing = getConfiguredHostStoreRuntime()
  if (existing) return existing

  const profilePath = electronUserDataPath()
  return configureHostStoreRuntime({
    profilePath,
    secureStorage: electronSafeStorageOrUnavailable(),
    appVersion: electronAppVersion()
  })
}

function electronUserDataPath(): string {
  const value = electron.app?.getPath?.('userData')
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error('Electron app.getPath("userData") did not return an absolute path.')
  }
  const profilePath = resolve(value)
  if (profilePath === parse(profilePath).root) {
    throw new Error('Electron app.getPath("userData") resolved to a filesystem root.')
  }
  return profilePath
}

function electronAppVersion(): string | undefined {
  const value = electron.app?.getVersion?.()
  return typeof value === 'string' && value.trim() ? value : undefined
}

function electronSafeStorageOrUnavailable(): HostStoreSecureStorage {
  try {
    const storage = (electron as unknown as { safeStorage?: unknown }).safeStorage
    if (
      storage &&
      typeof (storage as { isEncryptionAvailable?: unknown }).isEncryptionAvailable ===
        'function' &&
      typeof (storage as { encryptString?: unknown }).encryptString === 'function' &&
      typeof (storage as { decryptString?: unknown }).decryptString === 'function'
    ) {
      return storage as HostStoreSecureStorage
    }
  } catch {
    // Older Electron mocks do not define safeStorage.
  }

  // Preserve the old behaviour for Electron test mocks that only supplied
  // `app.getPath`: the store loads, while secret reads/writes fail closed.
  return Object.freeze({
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('Electron safeStorage is unavailable.')
    },
    decryptString: () => {
      throw new Error('Electron safeStorage is unavailable.')
    }
  })
}

// ESM evaluates this side-effect module before the following store/index
// re-export in src/main/store.ts. The focused wrapper test proves that ordering.
installElectronStoreRuntime()
