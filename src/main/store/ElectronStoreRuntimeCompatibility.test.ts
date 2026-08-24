import { afterEach, describe, expect, it, vi } from 'vitest'

describe('ElectronStoreRuntimeCompatibility', () => {
  afterEach(() => {
    vi.doUnmock('electron')
    vi.resetModules()
  })

  it('installs Electron profile, safe-storage, and version ports before store/index evaluates', async () => {
    const profilePath = '/tmp/taskwraith-electron-store-runtime'
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
