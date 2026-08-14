import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  GROK_USAGE_BINARY_OVERRIDE_ENV,
  resolveGrokUsageProbeBinary
} from './GrokUsageBinaryOverride'

describe('resolveGrokUsageProbeBinary', () => {
  it('uses an explicit disposable binary without consulting host discovery', async () => {
    const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

    await expect(
      resolveGrokUsageProbeBinary({
        env: {
          [GROK_USAGE_BINARY_OVERRIDE_ENV]: '/acceptance/home/.grok/bin/grok'
        },
        resolveDefault
      })
    ).resolves.toEqual({
      binaryPath: '/acceptance/home/.grok/bin/grok',
      source: 'override'
    })
    expect(resolveDefault).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'relative/.grok/bin/grok'])(
    'fails closed for a present but invalid override %j',
    async (overridePath) => {
      const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

      await expect(
        resolveGrokUsageProbeBinary({
          env: { [GROK_USAGE_BINARY_OVERRIDE_ENV]: overridePath },
          resolveDefault
        })
      ).resolves.toEqual({
        binaryPath: null,
        source: 'invalid_override'
      })
      expect(resolveDefault).not.toHaveBeenCalled()
    }
  )

  it('uses ordinary provider discovery when no override is present', async () => {
    const resolveDefault = vi.fn(async () => ({ binaryPath: '/owner/home/.grok/bin/grok' }))

    await expect(resolveGrokUsageProbeBinary({ env: {}, resolveDefault })).resolves.toEqual({
      binaryPath: '/owner/home/.grok/bin/grok',
      source: 'discovered'
    })
    expect(resolveDefault).toHaveBeenCalledOnce()
  })

  it('is wired into the production Grok usage handler', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const handlerStart = source.indexOf("ipcMain.handle('grok-usage:probe'")
    const handlerEnd = source.indexOf('const watchPrPoller', handlerStart)
    const handler = source.slice(handlerStart, handlerEnd)

    expect(handlerStart).toBeGreaterThan(-1)
    expect(handlerEnd).toBeGreaterThan(handlerStart)
    expect(handler).toContain('resolveGrokUsageProbeBinary({')
    expect(handler).toContain('env: process.env')
    expect(handler).toContain("resolveDefault: () => resolveCliProviderBinary('grok')")
  })
})
