import { describe, expect, it, vi } from 'vitest'
import {
  captureAgyModelDiscoveryOutput,
  discoverAuthenticatedAgyModels,
  type AuthenticatedAgyModelDiscoveryDependencies
} from './AntigravityModelDiscovery'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }

describe('captureAgyModelDiscoveryOutput', () => {
  it('captures model discovery through a PTY because current agy blocks on piped stdout', async () => {
    let emitData: (data: string) => void = () => {}
    let emitExit: (event: { exitCode: number }) => void = () => {}
    const kill = vi.fn()
    const spawnPty = vi.fn(() => ({
      onData: (listener: (data: string) => void) => {
        emitData = listener
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        emitExit = listener
      },
      kill
    }))
    const clearTimer = vi.fn()
    const capture = captureAgyModelDiscoveryOutput(
      '/Users/test/.local/bin/agy',
      ['models'],
      { env: { PATH: '/Users/test/.local/bin' }, timeoutMs: 8_000 },
      {
        spawnPty,
        setTimer: vi.fn(() => 42),
        clearTimer
      }
    )

    emitData('Fetching available models...\r\n')
    emitData('gemini-3.7-flash-high\tGemini 3.7 Flash (High)\r\n')
    emitExit({ exitCode: 0 })

    await expect(capture).resolves.toEqual({
      stdout: 'Fetching available models...\r\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\r\n',
      stderr: '',
      code: 0,
      timedOut: false
    })
    expect(spawnPty).toHaveBeenCalledWith('/Users/test/.local/bin/agy', ['models'], {
      env: { PATH: '/Users/test/.local/bin' }
    })
    expect(clearTimer).toHaveBeenCalledWith(42)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})

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

  it('persists clean model ids and records live provenance for current tab-separated output', async () => {
    const writeCachedModels = vi.fn(async () => undefined)
    const recordProvenance = vi.fn()
    const output = [
      'Fetching available models...',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
      'claude-sonnet-4-5\tClaude Sonnet 4.5'
    ].join('\n')

    const models = await discoverAuthenticatedAgyModels(optedIn, {
      ...dependencies({ stdout: output }),
      readCachedModels: async () => [],
      writeCachedModels,
      recordProvenance
    })

    expect(models).toEqual([
      { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
      { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' }
    ])
    expect(writeCachedModels).toHaveBeenCalledWith(
      [
        { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
        { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }
      ],
      undefined
    )
    expect(recordProvenance).toHaveBeenCalledWith({ source: 'live', cachedAtMs: null })
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

    // THE REGRESSION THIS PINS. `agy models` costs ~2.4s; this function runs
    // inside a 900ms bounded lane. With the cache read placed after the probe,
    // the lane always timed out mid-probe, so the cache was written every pass
    // and read on none, and the hardcoded floor was not a fallback — it was the
    // only list the picker ever received. A slow probe plus a populated cache
    // must therefore resolve promptly with the CACHED rows.
    it('returns cached rows without waiting for a slow probe', async () => {
      // Initialized to a no-op so its type stays callable: the Promise executor
      // below runs synchronously, so the real resolver is installed before the
      // probe can reach the await.
      let releaseProbe: () => void = () => {}
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve
      })
      const probeStarted = vi.fn()
      const slowCapture = vi.fn(async () => {
        probeStarted()
        await probeGate
        return { stdout: 'gemini-9.9-flash-high', stderr: '', code: 0 }
      })

      const result = await discoverAuthenticatedAgyModels(optedIn, {
        ...dependencies({}),
        capture: slowCapture,
        readCachedModels: async () => CACHED,
        writeCachedModels: async () => undefined
      })

      // Resolved on the cache while the probe is still in flight.
      expect(result).toEqual(CACHED)
      expect(result).not.toEqual(antigravityAgyStaticModels())
      // And the refresh really was started — stale-while-revalidate, not
      // cache-only. This is what keeps the list self-updating.
      expect(probeStarted).toHaveBeenCalledTimes(1)
      releaseProbe()
    })

    it('fires exactly one probe per discovery pass, cached or not', async () => {
      // Request cadence against the AntiGravity backend must not grow: serving
      // the cache first changes freshness, never the number of authenticated
      // round-trips.
      const withCache = dependencies({ stdout: 'gemini-3.6-flash-high' })
      await discoverAuthenticatedAgyModels(optedIn, {
        ...withCache,
        readCachedModels: async () => CACHED,
        writeCachedModels: async () => undefined
      })
      expect(withCache.capture).toHaveBeenCalledTimes(1)

      const withoutCache = dependencies({ stdout: 'gemini-3.6-flash-high' })
      await discoverAuthenticatedAgyModels(optedIn, {
        ...withoutCache,
        readCachedModels: async () => [],
        writeCachedModels: async () => undefined
      })
      expect(withoutCache.capture).toHaveBeenCalledTimes(1)
    })

    it('treats an unreadable cache as no cache, not as a discovery failure', async () => {
      await expect(
        discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stdout: 'gemini-3.1-pro-low' }),
          readCachedModels: async () => Promise.reject(new Error('EACCES')),
          writeCachedModels: async () => undefined
        })
      ).resolves.toEqual([{ id: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' }])
    })

    // The quota gate reads this instead of guessing from row shape.
    describe('records where the rows came from', () => {
      it('records live for a successful probe', async () => {
        const recordProvenance = vi.fn()
        await discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stdout: 'gemini-3.6-flash-high' }),
          readCachedModelRecord: async () => ({ models: [], updatedAtMs: null }),
          writeCachedModels: async () => undefined,
          recordProvenance
        })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'live', cachedAtMs: null })
      })

      it('records cached WITH the cache write time when serving cache', async () => {
        const recordProvenance = vi.fn()
        const updatedAtMs = Date.parse('2026-07-29T00:00:00.000Z')
        await discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stdout: 'gemini-3.6-flash-high' }),
          readCachedModelRecord: async () => ({ models: CACHED, updatedAtMs }),
          writeCachedModels: async () => undefined,
          recordProvenance
        })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'cached', cachedAtMs: updatedAtMs })
      })

      it('records floor when falling back to the hardcoded mirror', async () => {
        // The floor is not evidence of a connection. Recording it as such is
        // what closes the quota gate on a machine that never signed in.
        const recordProvenance = vi.fn()
        await discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stderr: 'Not logged in', code: 1 }),
          readCachedModelRecord: async () => ({ models: [], updatedAtMs: null }),
          recordProvenance
        })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'floor', cachedAtMs: null })
      })

      it('records none without consent or a binary', async () => {
        const recordProvenance = vi.fn()
        await discoverAuthenticatedAgyModels({}, { ...dependencies({}), recordProvenance })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'none', cachedAtMs: null })

        recordProvenance.mockClear()
        await discoverAuthenticatedAgyModels(optedIn, {
          resolveBinary: async () => ({ binaryPath: null, source: 'missing' }),
          recordProvenance
        })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'none', cachedAtMs: null })
      })

      it('treats the legacy age-less cache seam as unknown age', async () => {
        // readCachedModels (no timestamp) must not be reported as fresh
        // evidence; the predicate fails closed on a null age.
        const recordProvenance = vi.fn()
        await discoverAuthenticatedAgyModels(optedIn, {
          ...dependencies({ stdout: 'gemini-3.6-flash-high' }),
          readCachedModels: async () => CACHED,
          writeCachedModels: async () => undefined,
          recordProvenance
        })
        expect(recordProvenance).toHaveBeenCalledWith({ source: 'cached', cachedAtMs: null })
      })
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
