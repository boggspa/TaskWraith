import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

describe('AppStore core configured Node runtime import', () => {
  it('uses a configured profile and secure-storage port before dynamically importing store/index', async () => {
    const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-configured-app-store-'))
    vi.resetModules()
    try {
      const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
        await import('../../host-runtime/HostStoreRuntime')
      configureHostStoreRuntime({
        profilePath,
        secureStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
          decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
        }
      })
      vi.doMock('electron', () => {
        throw new Error('Electron was loaded despite the configured Node runtime.')
      })

      const { AppStore } = await import('./index')
      AppStore.updateSettings({ autoUpdateEnabled: false })

      expect(AppStore.getSettings().autoUpdateEnabled).toBe(false)
      resetHostStoreRuntimeForTests()
    } finally {
      vi.doUnmock('electron')
      vi.resetModules()
      rmSync(profilePath, { recursive: true, force: true })
    }
  })
})
