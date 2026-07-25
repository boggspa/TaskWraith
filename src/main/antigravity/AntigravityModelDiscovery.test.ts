import { describe, expect, it, vi } from 'vitest'
import {
  discoverAuthenticatedAgyModels,
  type AuthenticatedAgyModelDiscoveryDependencies
} from './AntigravityModelDiscovery'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }

function dependencies(
  result: {
    stdout?: string
    stderr?: string
    code?: number | null
    error?: string
    timedOut?: boolean
  }
): AuthenticatedAgyModelDiscoveryDependencies {
  return {
    resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
    capture: vi.fn(async (_command, _args, options) => ({
      stdout: '',
      stderr: '',
      code: 0,
      ...result,
      ...(options.env.GEMINI_API_KEY ? { error: 'credential environment leaked' } : {})
    })),
    inheritedEnv: {
      PATH: '/Users/test/.local/bin',
      GEMINI_API_KEY: 'must-not-reach-agy',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/never-read.json'
    }
  }
}

describe('discoverAuthenticatedAgyModels', () => {
  it('does not resolve or spawn before explicit informed consent', async () => {
    const resolveBinary = vi.fn(async () => ({ binaryPath: '/agy', source: 'path' as const }))
    const capture = vi.fn()

    await expect(
      discoverAuthenticatedAgyModels({}, { resolveBinary, capture })
    ).resolves.toEqual([])

    expect(resolveBinary).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('accepts only a successful official models result and strips credential selectors', async () => {
    const deps = dependencies({ stdout: '[{"id":"gemini-3.5-pro","label":"Gemini 3.5 Pro"}]' })

    await expect(discoverAuthenticatedAgyModels(optedIn, deps)).resolves.toEqual([
      { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }
    ])
    expect(deps.capture).toHaveBeenCalledWith(
      '/Users/test/.local/bin/agy',
      ['models'],
      expect.objectContaining({
        env: expect.not.objectContaining({
          GEMINI_API_KEY: expect.anything(),
          GOOGLE_APPLICATION_CREDENTIALS: expect.anything()
        })
      })
    )
  })

  // An unusable probe result used to return [], which tripped the
  // models.length > 0 configured-provider admission and made AntiGravity vanish
  // from every surface with no diagnostic. A consented install whose binary
  // resolves now keeps its offer rows and fails loudly at dispatch instead.
  it.each([
    { stdout: '[{"id":"gemini-3.5-pro"}]', code: 1 },
    { stderr: 'Not logged in', code: 1 },
    { stdout: '', code: 0 },
    { stdout: 'authentication required', code: 0 },
    { stdout: '[{"id":"gemini-3.5-pro"}]', code: 0, timedOut: true }
  ])('falls back to the static floor for an unusable models result: %o', async (result) => {
    await expect(discoverAuthenticatedAgyModels(optedIn, dependencies(result))).resolves.toEqual(
      antigravityAgyStaticModels()
    )
  })

  it('prefers live discovery over the static floor', async () => {
    const live = await discoverAuthenticatedAgyModels(
      optedIn,
      dependencies({ stdout: 'gemini-3.6-flash-high\ngemini-3.1-pro-high' })
    )
    expect(live).toEqual([
      { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
      { id: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high' }
    ])
    expect(live).not.toEqual(antigravityAgyStaticModels())
  })

  // The two hard gates the floor must never widen: without consent, or without
  // the user's own official binary, the ban-risk lane stays invisible.
  it('offers no floor without recorded consent', async () => {
    await expect(discoverAuthenticatedAgyModels({}, dependencies({ code: 1 }))).resolves.toEqual([])
  })

  it('offers no floor when the official binary is absent', async () => {
    await expect(
      discoverAuthenticatedAgyModels(optedIn, {
        resolveBinary: async () => ({ binaryPath: null, source: 'missing', error: 'not installed' }),
        capture: vi.fn()
      })
    ).resolves.toEqual([])
  })

  it('fails closed when the official binary resolution throws', async () => {
    await expect(
      discoverAuthenticatedAgyModels(optedIn, {
        resolveBinary: async () => Promise.reject(new Error('probe failed'))
      })
    ).resolves.toEqual([])
  })

  // The hardcoded floor is a mirror of agy's output, not a curated catalogue, so
  // it should keep itself current: live > cached > hardcoded.
  describe('last-known-good cache', () => {
    const CACHED = [{ id: 'gemini-9.9-flash-high', label: 'gemini-9.9-flash-high' }]

    it('persists a successful discovery as last-known-good', async () => {
      const writeCachedModels = vi.fn(async () => undefined)
      const live = await discoverAuthenticatedAgyModels(optedIn, {
        ...dependencies({ stdout: 'gemini-3.6-flash-high' }),
        writeCachedModels,
        readCachedModels: async () => []
      })

      expect(live).toEqual([{ id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' }])
      expect(writeCachedModels).toHaveBeenCalledWith(live, undefined)
    })

    it('serves the cache when discovery fails, in preference to the floor', async () => {
      const result = await discoverAuthenticatedAgyModels(optedIn, {
        ...dependencies({ stderr: 'Not logged in', code: 1 }),
        readCachedModels: async () => CACHED
      })

      expect(result).toEqual(CACHED)
      expect(result).not.toEqual(antigravityAgyStaticModels())
    })

    it('falls back to the hardcoded floor only when the cache is empty', async () => {
      await expect(
        discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stderr: 'Not logged in', code: 1 }),
          readCachedModels: async () => []
        })
      ).resolves.toEqual(antigravityAgyStaticModels())
    })

    // A cache write failure must not turn a good discovery into a failed one.
    it('still returns live rows when persisting throws', async () => {
      await expect(
        discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stdout: 'gemini-3.1-pro-low' }),
          writeCachedModels: async () => Promise.reject(new Error('EACCES')),
          readCachedModels: async () => []
        })
      ).resolves.toEqual([{ id: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' }])
    })

    it('never consults the cache without consent or a binary', async () => {
      const readCachedModels = vi.fn(async () => CACHED)
      await expect(
        discoverAuthenticatedAgyModels({}, { ...dependencies({}), readCachedModels })
      ).resolves.toEqual([])
      await expect(
        discoverAuthenticatedAgyModels(optedIn, {
          resolveBinary: async () => ({ binaryPath: null, source: 'missing' }),
          readCachedModels
        })
      ).resolves.toEqual([])
      expect(readCachedModels).not.toHaveBeenCalled()
    })
  })

  it('resolves the binary once and reuses it for the probe', async () => {
    const resolveBinary = vi.fn(async () => ({
      binaryPath: '/Users/test/.local/bin/agy',
      source: 'path' as const
    }))
    await discoverAuthenticatedAgyModels(optedIn, {
      resolveBinary,
      capture: vi.fn(async () => ({ stdout: 'gemini-3.1-pro-high', stderr: '', code: 0 }))
    })
    expect(resolveBinary).toHaveBeenCalledTimes(1)
  })
})
