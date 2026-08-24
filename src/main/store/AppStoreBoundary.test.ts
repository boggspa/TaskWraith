import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

describe('AppStore core Node boundary', () => {
  it('contains no Electron import or fallback path', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/require\(['"]electron['"]\)/)
    expect(source).not.toContain('ElectronStoreRuntimeCompatibility')
  })

  it('fails closed unless HostStoreRuntime is configured before import', async () => {
    vi.resetModules()
    const { resetHostStoreRuntimeForTests } = await import('../../host-runtime/HostStoreRuntime')
    resetHostStoreRuntimeForTests()

    await expect(import('./index')).rejects.toThrow(/requires HostStoreRuntime to be configured/i)
    vi.resetModules()
  })
})
