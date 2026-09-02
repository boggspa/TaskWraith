import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

describe('ElectronStoreRuntimeCompatibility', () => {
  afterEach(() => {
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('installs Electron profile, safe-storage, and version ports before store/index evaluates', async () => {
    // Platform-built so the runtime's own path.resolve over the profile path
    // is the identity on every OS; a POSIX `/tmp/...` literal resolves onto a
    // Windows drive and no longer equals the fixture value.
    const profilePath = path.resolve(os.tmpdir(), 'taskwraith-electron-store-runtime')
    const secureStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`electron:${plain}`, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^electron:/, '')
    }
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: () => profilePath,
        getVersion: () => '1.9.9'
      },
      safeStorage: secureStorage
    }))

    const { AppStore } = await import('../store')
    const { getConfiguredHostStoreRuntime } = await import('../../host-runtime/HostStoreRuntime')

    expect(getConfiguredHostStoreRuntime()).toMatchObject({
      profilePath,
      secureStorage,
      appVersion: '1.9.9'
    })
    expect(AppStore.getSettings()).toBeTruthy()
  })
})
