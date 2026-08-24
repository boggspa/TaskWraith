import { afterEach, describe, expect, it } from 'vitest'

import {
  configureHostStoreRuntime,
  getConfiguredHostStoreRuntime,
  resetHostStoreRuntimeForTests,
  type HostStoreRuntime
} from './HostStoreRuntime'

const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`encrypted:${plain}`, 'utf8'),
  decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^encrypted:/, '')
}

afterEach(() => {
  resetHostStoreRuntimeForTests()
})

describe('HostStoreRuntime', () => {
  it('normalizes and installs the host-owned profile/store runtime once', () => {
    const runtime: HostStoreRuntime = {
      profilePath: '/tmp/taskwraith-host-store-runtime/../taskwraith-host-store-runtime',
      secureStorage
    }

    const installed = configureHostStoreRuntime(runtime)

    expect(installed).toMatchObject({
      profilePath: '/tmp/taskwraith-host-store-runtime',
      secureStorage
    })
    expect(configureHostStoreRuntime(runtime)).toBe(installed)
    expect(getConfiguredHostStoreRuntime()).toBe(installed)
  })

  it('rejects a later profile or secure-storage substitution', () => {
    configureHostStoreRuntime({
      profilePath: '/tmp/taskwraith-host-store-runtime-a',
      secureStorage
    })

    expect(() =>
      configureHostStoreRuntime({
        profilePath: '/tmp/taskwraith-host-store-runtime-b',
        secureStorage
      })
    ).toThrow(/incompatible authority/i)
    expect(() =>
      configureHostStoreRuntime({
        profilePath: '/tmp/taskwraith-host-store-runtime-a',
        secureStorage: { ...secureStorage }
      })
    ).toThrow(/incompatible authority/i)
  })

  it('fails closed on an invalid profile path or structural secure-storage port', () => {
    expect(() =>
      configureHostStoreRuntime({
        profilePath: 'relative/profile',
        secureStorage
      })
    ).toThrow(/absolute profile path/i)
    expect(() =>
      configureHostStoreRuntime({
        profilePath: '/tmp/taskwraith-host-store-runtime',
        secureStorage: { isEncryptionAvailable: () => true } as never
      })
    ).toThrow(/structurally invalid/i)
    expect(getConfiguredHostStoreRuntime()).toBeNull()
  })
})
