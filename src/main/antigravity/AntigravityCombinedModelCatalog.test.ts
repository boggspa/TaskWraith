import { describe, expect, it, vi } from 'vitest'
import {
  discoverAuthenticatedAntigravityCombinedModels,
  hasAuthenticatedAgyCatalogRow,
  isAuthenticatedAgyRateLimitConnection
} from './AntigravityCombinedModelCatalog'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'

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
        { id: 'gemini-api:gemini-2.5-flash', label: 'Gemini API · flash · separate billing' }
      ])
    ).toBe(false)
    expect(
      hasAuthenticatedAgyCatalogRow([
        { id: 'agy-model', label: 'AGY model' },
        { id: 'gemini-api:gemini-2.5-flash', label: 'Gemini API · flash · separate billing' }
      ])
    ).toBe(true)
    expect(
      isAuthenticatedAgyRateLimitConnection(
        { ready: true, configuredProviders: new Set(['antigravity']) },
        [{ id: 'gemini-api:gemini-2.5-flash', label: 'API' }]
      )
    ).toBe(false)
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
      { id: 'gemini-api:gemini-one', label: 'Gemini API · gemini-one · separate billing' }
    ])
    expect(discoverAgy).toHaveBeenCalledOnce()
    expect(discoverGeminiApi).toHaveBeenCalledOnce()
  })

  it('keeps either admitted lane when the other rejects or times out', async () => {
    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy: async () => [{ id: 'agy-only', label: 'AGY Only' }],
        discoverGeminiApi: async () => {
          throw new Error('private detail must not escape')
        },
        getSecretStore: () => store
      })
    ).resolves.toEqual([{ id: 'agy-only', label: 'AGY Only' }])

    await expect(
      discoverAuthenticatedAntigravityCombinedModels(optedIn, {
        discoverAgy: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return [{ id: 'late-agy', label: 'Late AGY' }]
        },
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
      { id: 'gemini-api:gemini-fast', label: 'Gemini API · gemini-fast · separate billing' }
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
      { id: 'gemini-api:gemini-solo', label: 'Gemini API · gemini-solo · separate billing' }
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
      { id: 'gemini-api:gemini-both', label: 'Gemini API · gemini-both · separate billing' }
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
