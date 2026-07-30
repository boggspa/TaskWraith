import { describe, expect, it, vi } from 'vitest'
import {
  discoverAuthenticatedAntigravityCombinedModels,
  hasAuthenticatedAgyCatalogRow,
  isAuthenticatedAgyRateLimitConnection
} from './AntigravityCombinedModelCatalog'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import { antigravityAgyStaticModels } from './AntigravityAgyStaticModels'
import { antigravityGeminiApiStaticModels } from './AntigravityGeminiApiStaticModels'
import { AGY_CACHED_AUTH_EVIDENCE_TTL_MS } from './AntigravityAgyDiscoveryProvenance'

const NOW_MS = Date.parse('2026-07-30T00:00:00.000Z')

const optedIn = {
  antigravityEnabled: true,
  antigravityOptInAcceptedAt: 1,
  antigravityGeminiApiDisclosureAcceptedAt: 2
}

const store = { loadApiKey: vi.fn(() => ({ status: 'ok' as const, value: 'secret' })) }

describe('discoverAuthenticatedAntigravityCombinedModels', () => {
  it('only treats actual AGY rows as authenticated AGY quota eligibility', () => {
    expect(
      hasAuthenticatedAgyCatalogRow([
        { id: 'gemini-api:gemini-2.5-flash', label: '2.5 Flash' }
      ])
    ).toBe(false)
    expect(
      hasAuthenticatedAgyCatalogRow([
        { id: 'agy-model', label: 'AGY model' },
        { id: 'gemini-api:gemini-2.5-flash', label: '2.5 Flash' }
      ])
    ).toBe(true)
    expect(
      isAuthenticatedAgyRateLimitConnection(
        { ready: true, configuredProviders: new Set(['antigravity']) },
        [{ id: 'gemini-api:gemini-2.5-flash', label: 'API' }],
        { source: 'live', cachedAtMs: null },
        NOW_MS
      )
    ).toBe(false)
  })

  // The gate used to be shape-based, which the hardcoded floor satisfied, so it
  // was open on machines that had never authenticated. It is now evidence-based.
  describe('quota-probe gate provenance', () => {
    const READY = { ready: true, configuredProviders: new Set(['antigravity']) }
    const AGY_ROWS = [{ id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High' }]

    it('opens on a live probe', () => {
      expect(
        isAuthenticatedAgyRateLimitConnection(READY, AGY_ROWS, { source: 'live', cachedAtMs: null }, NOW_MS)
      ).toBe(true)
    })

    it('opens on a cache written inside the evidence window', () => {
      expect(
        isAuthenticatedAgyRateLimitConnection(
          READY,
          AGY_ROWS,
          { source: 'cached', cachedAtMs: NOW_MS - AGY_CACHED_AUTH_EVIDENCE_TTL_MS + 1_000 },
          NOW_MS
        )
      ).toBe(true)
    })

    it('closes on a cache older than the evidence window', () => {
      expect(
        isAuthenticatedAgyRateLimitConnection(
          READY,
          AGY_ROWS,
          { source: 'cached', cachedAtMs: NOW_MS - AGY_CACHED_AUTH_EVIDENCE_TTL_MS - 1_000 },
          NOW_MS
        )
      ).toBe(false)
    })

    it('CLOSES on floor rows — the forgery this replaced', () => {
      // Identical rows and snapshot to the live case above; only the provenance
      // differs. Under the old shape test this returned true.
      expect(
        isAuthenticatedAgyRateLimitConnection(READY, AGY_ROWS, { source: 'floor', cachedAtMs: null }, NOW_MS)
      ).toBe(false)
    })

    it('fails closed with no provenance, or a cache of unknown age', () => {
      expect(isAuthenticatedAgyRateLimitConnection(READY, AGY_ROWS, null, NOW_MS)).toBe(false)
      expect(
        isAuthenticatedAgyRateLimitConnection(READY, AGY_ROWS, { source: 'none', cachedAtMs: null }, NOW_MS)
      ).toBe(false)
      expect(
        isAuthenticatedAgyRateLimitConnection(READY, AGY_ROWS, { source: 'cached', cachedAtMs: null }, NOW_MS)
      ).toBe(false)
    })
  })
  it('merges AGY-first rows when both lanes are admitted', async () => {
    const discoverAgy = vi.fn(async () => [
      { id: 'agy-one', label: 'AGY One' },
      { id: 'duplicate', label: 'AGY Duplicate' }
    ])
    const discoverGeminiApi = vi.fn(async () => ({
      status: 'ok' as const,
      models: [
        { id: 'gemini-api:gemini-one' as `gemini-api:${string}`, modelId: 'gemini-one' },
        { id: 'gemini-api:gemini-one' as `gemini-api:${string}`, modelId: 'gemini-one' }
      ]
    }))

    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy,
        discoverGeminiApi,
        getSecretStore: () => store
      })
    ).resolves.toEqual([
      { id: 'agy-one', label: 'AGY One' },
      { id: 'duplicate', label: 'AGY Duplicate' },
      { id: 'gemini-api:gemini-one', label: 'One' }
    ])
    expect(discoverAgy).toHaveBeenCalledOnce()
    expect(discoverGeminiApi).toHaveBeenCalledOnce()
  })

  it('keeps either admitted lane when the other rejects or times out', async () => {
    // The API lane failing outright still yields the configured key's static
    // rows — an unverified catalogue must not delete the provider — and the
    // agy lane is untouched.
    const rejected = await discoverAuthenticatedAntigravityCombinedModels(optedIn, {
      discoverAgy: async () => [{ id: 'agy-only', label: 'AGY Only' }],
      discoverGeminiApi: async () => {
        throw new Error('private detail must not escape')
      },
      getSecretStore: () => store
    })
    expect(rejected[0]).toEqual({ id: 'agy-only', label: 'AGY Only' })
    expect(rejected.slice(1)).toEqual(antigravityGeminiApiStaticModels())
    expect(JSON.stringify(rejected)).not.toContain('private detail')

    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return [{ id: 'late-agy', label: 'Late AGY' }]
        },
        resolveAgyBinary: async () => ({
          binaryPath: '/Users/test/.local/bin/agy',
          source: 'path'
        }),
        discoverGeminiApi: async () => ({
          status: 'ok' as const,
          models: [
            { id: 'gemini-api:gemini-fast' as `gemini-api:${string}`, modelId: 'gemini-fast' }
          ]
        }),
        getSecretStore: () => store,
        timeoutMs: 5
      })
    ).resolves.toEqual([
      ...antigravityAgyStaticModels(),
      { id: 'gemini-api:gemini-fast', label: 'Fast' }
    ])
  })

  it('does not surface the AGY floor when the official binary is absent', async () => {
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy: () => new Promise(() => {}),
        resolveAgyBinary: async () => ({ binaryPath: null, source: 'missing' }),
        discoverGeminiApi: async () => ({
          status: 'ok' as const,
          models: [
            { id: 'gemini-api:gemini-fast' as `gemini-api:${string}`, modelId: 'gemini-fast' }
          ]
        }),
        getSecretStore: () => store,
        timeoutMs: 5
      })
    ).resolves.toEqual([{ id: 'gemini-api:gemini-fast', label: 'Fast' }])
  })

  it('offers the configured key its static rows when the live catalogue cannot be verified', async () => {
    // Every one of these used to erase AntiGravity from the picker, roster and
    // paired device with no message anywhere — a configured key must survive an
    // unverifiable probe the way every other provider survives a failed auth check.
    for (const status of [
      'unauthorized',
      'rateLimited',
      'projectLimited',
      'unavailable',
      'invalidResponse',
      'empty'
    ] as const) {
      await expect(
        discoverAuthenticatedAntigravityCombinedModels(
          {},
          {
            discoverGeminiApi: async () => ({ status, models: [] as const }),
            getSecretStore: () => store
          }
        )
      ).resolves.toEqual(antigravityGeminiApiStaticModels())
    }
  })

  it('never lets static key-lane rows imply an authenticated agy connection', async () => {
    // The agy quota probe SPAWNS the ban-risk CLI, so it keys off "is there a
    // non-`gemini-api:` row". Static fallback rows must stay invisible to it.
    const fallback = await discoverAuthenticatedAntigravityCombinedModels(
      {},
      {
        discoverGeminiApi: async () => ({ status: 'unauthorized' as const, models: [] as const }),
        getSecretStore: () => store
      }
    )
    expect(fallback.length).toBeGreaterThan(0)
    expect(hasAuthenticatedAgyCatalogRow(fallback)).toBe(false)
    expect(
      isAuthenticatedAgyRateLimitConnection(
        { ready: true, configuredProviders: new Set(['antigravity']) },
        fallback,
        { source: 'live', cachedAtMs: null },
        NOW_MS
      )
    ).toBe(false)
  })

  it('offers nothing when the lane has no key, no disclosure, or no SDK', async () => {
    for (const status of [
      'keyUnavailable',
      'disclosureRequired',
      'sdkUnavailable',
      'cancelled'
    ] as const) {
      await expect(
        discoverAuthenticatedAntigravityCombinedModels(
          {},
          {
            discoverGeminiApi: async () => ({ status, models: [] as const }),
            getSecretStore: () => store
          }
        )
      ).resolves.toEqual([])
    }
  })

  it('prefers the live catalogue over the static rows', async () => {
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(
        {},
        {
          discoverGeminiApi: async () => ({
            status: 'ok' as const,
            models: [
              { id: 'gemini-api:gemini-live' as `gemini-api:${string}`, modelId: 'gemini-live' }
            ]
          }),
          getSecretStore: () => store
        }
      )
    ).resolves.toEqual([
      { id: 'gemini-api:gemini-live', label: 'Live' }
    ])
  })

  it('does not invoke API discovery without a dedicated post-ready store', async () => {
    const discoverGeminiApi = vi.fn()
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy: async () => [],
        discoverGeminiApi,
        getSecretStore: () => null
      })
    ).resolves.toEqual([])
    expect(discoverGeminiApi).not.toHaveBeenCalled()
  })

  it('admits the Gemini API-key lane alone without AntiGravity opt-in', async () => {
    const discoverAgy = vi.fn()
    const discoverGeminiApi = vi.fn(async () => ({
      status: 'ok' as const,
      models: [{ id: 'gemini-api:gemini-solo' as `gemini-api:${string}`, modelId: 'gemini-solo' }]
    }))
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(
        {},
        {
          discoverAgy,
          discoverGeminiApi,
          getSecretStore: () => store
        }
      )
    ).resolves.toEqual([
      { id: 'gemini-api:gemini-solo', label: 'Solo' }
    ])
    expect(discoverAgy).not.toHaveBeenCalled()
    expect(discoverGeminiApi).toHaveBeenCalledOnce()
    expect(isAntigravityOptInEnabled({})).toBe(false)
  })

  it('keeps the AGY lane opt-in gated even when a Gemini API key is also configured', async () => {
    const discoverAgy = vi.fn(async () => [{ id: 'agy-gated', label: 'AGY Gated' }])
    const discoverGeminiApi = vi.fn(async () => ({
      status: 'ok' as const,
      models: [{ id: 'gemini-api:gemini-both' as `gemini-api:${string}`, modelId: 'gemini-both' }]
    }))
    // No opt-in, key configured: only the API lane is admitted.
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(
        { antigravityEnabled: false, antigravityOptInAcceptedAt: undefined },
        { discoverAgy, discoverGeminiApi, getSecretStore: () => store }
      )
    ).resolves.toEqual([
      { id: 'gemini-api:gemini-both', label: 'Both' }
    ])
    expect(discoverAgy).not.toHaveBeenCalled()
  })

  it('fails closed before either lane when neither AntiGravity opt-in nor a configured API key is present', async () => {
    const discoverAgy = vi.fn()
    const discoverGeminiApi = vi.fn()
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(
        {},
        {
          discoverAgy,
          discoverGeminiApi,
          getSecretStore: () => null
        }
      )
    ).resolves.toEqual([])
    expect(discoverAgy).not.toHaveBeenCalled()
    expect(discoverGeminiApi).not.toHaveBeenCalled()
    expect(isAntigravityOptInEnabled({})).toBe(false)
  })

  it('fails closed on null/undefined settings regardless of a configured API key', async () => {
    const discoverAgy = vi.fn()
    const discoverGeminiApi = vi.fn()
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(null, {
        discoverAgy,
        discoverGeminiApi,
        getSecretStore: () => store
      })
    ).resolves.toEqual([])
    expect(discoverAgy).not.toHaveBeenCalled()
    expect(discoverGeminiApi).not.toHaveBeenCalled()
  })
})

describe('Gemini API discovery outcome reporting', () => {
  it('reports each discovery classification verbatim', async () => {
    for (const status of [
      'unauthorized',
      'rateLimited',
      'projectLimited',
      'unavailable',
      'invalidResponse',
      'empty',
      'keyUnavailable',
      'disclosureRequired',
      'sdkUnavailable',
      'cancelled'
    ] as const) {
      const recordGeminiApiOutcome = vi.fn()
      await discoverAuthenticatedAntigravityCombinedModels(
        {},
        {
          discoverGeminiApi: async () => ({ status, models: [] as const }),
          getSecretStore: () => store,
          recordGeminiApiOutcome
        }
      )
      expect(recordGeminiApiOutcome).toHaveBeenCalledWith({ status, modelCount: 0 })
    }
  })

  it('reports the count of rows actually offered, not of raw list entries', async () => {
    // Curation can drop or rename discovered entries, so reporting the raw
    // `models.list` length would promise models the picker never shows.
    const recordGeminiApiOutcome = vi.fn()
    const rows = await discoverAuthenticatedAntigravityCombinedModels(
      {},
      {
        discoverGeminiApi: async () => ({
          status: 'ok' as const,
          models: [
            { id: 'gemini-api:gemini-one' as `gemini-api:${string}`, modelId: 'gemini-one' },
            { id: 'gemini-api:gemini-two' as `gemini-api:${string}`, modelId: 'gemini-two' },
            // Rejected by the id projection, so it must not be counted.
            { id: 'not-a-gemini-api-id' as `gemini-api:${string}`, modelId: 'nope' }
          ]
        }),
        getSecretStore: () => store,
        recordGeminiApiOutcome
      }
    )
    expect(recordGeminiApiOutcome).toHaveBeenCalledWith({ status: 'ok', modelCount: rows.length })
    expect(rows.length).toBe(2)
  })

  it('distinguishes a lane that never answered from one that rejected', async () => {
    // This function is the only place that can tell these apart: discovery
    // itself cannot report a timeout it never returned from. A slow network
    // must not be reported to the user as an unreachable API.
    const timedOut = vi.fn()
    await discoverAuthenticatedAntigravityCombinedModels(
      {},
      {
        discoverGeminiApi: () => new Promise(() => {}),
        getSecretStore: () => store,
        recordGeminiApiOutcome: timedOut,
        timeoutMs: 5
      }
    )
    expect(timedOut).toHaveBeenCalledWith({ status: 'timedOut', modelCount: 0 })

    const rejected = vi.fn()
    await discoverAuthenticatedAntigravityCombinedModels(
      {},
      {
        discoverGeminiApi: async () => {
          throw new Error('private detail must not escape')
        },
        getSecretStore: () => store,
        recordGeminiApiOutcome: rejected
      }
    )
    expect(rejected).toHaveBeenCalledWith({ status: 'unavailable', modelCount: 0 })
    expect(JSON.stringify(rejected.mock.calls)).not.toContain('private detail')
  })

  it('reports nothing when the lane was never admitted', async () => {
    // Without a store we never asked Google, so there is no verdict to show.
    const recordGeminiApiOutcome = vi.fn()
    await discoverAuthenticatedAntigravityCombinedModels(optedIn, {
      discoverAgy: async () => [{ id: 'agy-only', label: 'AGY Only' }],
      getSecretStore: () => null,
      recordGeminiApiOutcome
    })
    expect(recordGeminiApiOutcome).not.toHaveBeenCalled()
  })

  it('still reports when a full AGY catalogue short-circuits row assembly', async () => {
    const recordGeminiApiOutcome = vi.fn()
    await discoverAuthenticatedAntigravityCombinedModels(optedIn, {
      discoverAgy: async () =>
        Array.from({ length: 200 }, (_, index) => ({
          id: `agy-${index}`,
          label: `AGY ${index}`
        })),
      discoverGeminiApi: async () => ({ status: 'unauthorized' as const, models: [] as const }),
      getSecretStore: () => store,
      recordGeminiApiOutcome
    })
    expect(recordGeminiApiOutcome).toHaveBeenCalledWith({ status: 'unauthorized', modelCount: 0 })
  })

  it('never lets a throwing reporter suppress the rows the pass already resolved', async () => {
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(
        {},
        {
          discoverGeminiApi: async () => ({ status: 'unauthorized' as const, models: [] as const }),
          getSecretStore: () => store,
          recordGeminiApiOutcome: () => {
            throw new Error('reporter exploded')
          }
        }
      )
    ).resolves.toEqual(antigravityGeminiApiStaticModels())
  })
})
