import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from './store/types'
import {
  CONFIGURED_PROVIDER_PROBE_DEADLINE_MS,
  createConfiguredProviderDetector,
  detectConfiguredProviders,
  type DetectConfiguredProvidersDependencies
} from './ProviderConfiguration'

// Production dependencies touch Electron-owned state at module load. Every
// test injects deterministic seams, so keep those default modules inert here.
vi.mock('./providers/CliProviderRuntime', () => ({
  resolveCliProviderBinary: async () => ({ binaryPath: null })
}))
vi.mock('./ollama/OllamaProvider', () => ({
  getOllamaStatusSnapshot: async () => ({ available: false, modelCount: 0 })
}))

function dependencies(
  kimi: { available: boolean; authState?: string }
): DetectConfiguredProvidersDependencies {
  return {
    getKimiConfiguredStatus: async () => kimi,
    resolveProviderBinary: async () => ({ binaryPath: null }),
    getOllamaStatus: async () => ({ available: false, modelCount: 0 })
  }
}

describe('detectConfiguredProviders — Kimi roster configuration', () => {
  it('excludes binary/key presence when the roster status is unavailable', async () => {
    const settings = {
      kimiApiKey: 'encrypted-key',
      kimiBinaryPath: '/Users/test/.kimi-code/bin/kimi'
    } as AppSettings

    const configured = await detectConfiguredProviders(
      settings,
      dependencies({ available: false, authState: 'oauth' })
    )
    expect(configured.has('kimi')).toBe(false)
  })

  it('includes an authenticated OAuth-only runtime without a stored key', async () => {
    const configured = await detectConfiguredProviders(
      {} as AppSettings,
      dependencies({ available: true, authState: 'oauth' })
    )
    expect(configured.has('kimi')).toBe(true)
  })

  it('includes an admitted provider-key runtime but excludes unknown auth', async () => {
    const providerKey = await detectConfiguredProviders(
      {} as AppSettings,
      dependencies({ available: true, authState: 'api-key' })
    )
    const unknown = await detectConfiguredProviders(
      { kimiApiKey: 'encrypted-key' } as AppSettings,
      dependencies({ available: true, authState: 'unknown' })
    )

    expect(providerKey.has('kimi')).toBe(true)
    expect(unknown.has('kimi')).toBe(false)
  })

  it('excludes Kimi when no roster status dependency is wired', async () => {
    const configured = await detectConfiguredProviders(
      { kimiApiKey: 'encrypted-key', kimiBinaryPath: '/opt/kimi' } as AppSettings,
      {
        resolveProviderBinary: async () => ({ binaryPath: null }),
        getOllamaStatus: async () => ({ available: false, modelCount: 0 })
      }
    )
    expect(configured.has('kimi')).toBe(false)
  })
})

describe('detectConfiguredProviders — CLI binary probes', () => {
  it('seeds grok and cursor when their binaries resolve', async () => {
    const configured = await detectConfiguredProviders({} as AppSettings, {
      resolveProviderBinary: async (provider) => ({
        binaryPath:
          provider === 'grok'
            ? '/Users/test/.grok/bin/grok'
            : provider === 'cursor'
              ? '/usr/local/bin/cursor-agent'
              : null
      }),
      getOllamaStatus: async () => ({ available: false, modelCount: 0 })
    })
    expect(configured.has('grok')).toBe(true)
    expect(configured.has('cursor')).toBe(true)
  })

  it('excludes grok and cursor when the binary is unresolved or the probe throws', async () => {
    const unresolved = await detectConfiguredProviders({} as AppSettings, {
      resolveProviderBinary: async () => ({ binaryPath: null }),
      getOllamaStatus: async () => ({ available: false, modelCount: 0 })
    })
    const throwing = await detectConfiguredProviders({} as AppSettings, {
      resolveProviderBinary: async () => {
        throw new Error('probe failed')
      },
      getOllamaStatus: async () => ({ available: false, modelCount: 0 })
    })

    for (const configured of [unresolved, throwing]) {
      expect(configured.has('grok')).toBe(false)
      expect(configured.has('cursor')).toBe(false)
    }
  })

  it('runs independent probes concurrently and bounds a hung roster discovery', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<never>(() => {})
      const result = detectConfiguredProviders({} as AppSettings, {
        getKimiConfiguredStatus: () => never,
        getOllamaStatus: () => never,
        resolveProviderBinary: () => never
      })

      await vi.advanceTimersByTimeAsync(CONFIGURED_PROVIDER_PROBE_DEADLINE_MS)

      await expect(result).resolves.toEqual(new Set(['kimi', 'ollama', 'grok', 'cursor']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('never probes from chat creation and staggers one background check per provider', async () => {
    vi.useFakeTimers()
    try {
      const getKimiConfiguredStatus = vi.fn(async () => ({
        available: true,
        authState: 'oauth'
      }))
      const getOllamaStatus = vi.fn(async () => ({ available: true, modelCount: 1 }))
      const resolveProviderBinary = vi.fn(async () => ({ binaryPath: '/provider' }))
      const discovery = createConfiguredProviderDetector(
        {
          getKimiConfiguredStatus,
          getOllamaStatus,
          resolveProviderBinary,
          probeDeadlineMs: 1_000
        },
        { staggerMs: 100 }
      )
      const settings = {} as AppSettings

      await expect(discovery.snapshot(settings)).resolves.toEqual(new Set())
      expect(getKimiConfiguredStatus).not.toHaveBeenCalled()
      expect(getOllamaStatus).not.toHaveBeenCalled()
      expect(resolveProviderBinary).not.toHaveBeenCalled()

      discovery.start(settings)
      await vi.advanceTimersByTimeAsync(0)
      expect(getKimiConfiguredStatus).toHaveBeenCalledTimes(1)
      expect(getOllamaStatus).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300)
      await expect(discovery.snapshot(settings)).resolves.toEqual(
        new Set(['kimi', 'ollama', 'grok', 'cursor'])
      )
      expect(getOllamaStatus).toHaveBeenCalledTimes(1)
      expect(resolveProviderBinary).toHaveBeenCalledTimes(2)

      discovery.start(settings)
      await vi.runAllTimersAsync()
      expect(getKimiConfiguredStatus).toHaveBeenCalledTimes(1)
      expect(getOllamaStatus).toHaveBeenCalledTimes(1)
      expect(resolveProviderBinary).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
