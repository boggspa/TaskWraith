import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_MODEL_PREFIX,
  MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS,
  MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES,
  discoverAuthenticatedAntigravityGeminiApiModels,
  loadOfficialGeminiApiSdk,
  type AntigravityGeminiApiClient,
  type AntigravityGeminiApiClientConstructor,
  type AntigravityGeminiApiListModel,
  type AntigravityGeminiApiModelPager,
  type AntigravityGeminiApiSdkModule
} from './AntigravityGeminiApiModelDiscovery'
import type { AntigravityGeminiApiSecretLoadResult } from './AntigravityGeminiApiSecretStore'

const API_KEY = 'AIza-explicit-user-supplied-test-key'
const acceptedSettings = { antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_000 }

describe('loadOfficialGeminiApiSdk', () => {
  it('loads the real packaged official SDK through the production loader', async () => {
    const sdk = await loadOfficialGeminiApiSdk()

    expect(sdk).not.toBeNull()
    expect(typeof (sdk?.GoogleGenAI ?? sdk?.default?.GoogleGenAI)).toBe('function')
  })
})

function generateCapable(name: string): AntigravityGeminiApiListModel {
  return { name: `models/${name}`, supportedActions: ['generateContent'] }
}

function pager(
  initialPage: readonly AntigravityGeminiApiListModel[],
  nextPages: readonly (readonly AntigravityGeminiApiListModel[])[] = []
): AntigravityGeminiApiModelPager {
  let index = 0
  return {
    page: initialPage,
    hasNextPage: vi.fn(() => index < nextPages.length),
    nextPage: vi.fn(async () => {
      const page = nextPages[index]
      index += 1
      return page
    })
  }
}

function sdkWithClient(client: AntigravityGeminiApiClient): {
  sdk: AntigravityGeminiApiSdkModule
  constructor: AntigravityGeminiApiClientConstructor
} {
  const Client = class {
    constructor(options: { apiKey: string }) {
      expect(options).toEqual({ apiKey: API_KEY })
      return client
    }
  } as unknown as AntigravityGeminiApiClientConstructor
  return { sdk: { GoogleGenAI: Client }, constructor: Client }
}

function depsFor(
  client: AntigravityGeminiApiClient,
  loadApiKey: () => AntigravityGeminiApiSecretLoadResult = () => ({
    status: 'ok',
    value: API_KEY
  })
) {
  const { sdk } = sdkWithClient(client)
  return {
    secretStore: { loadApiKey },
    loadSdk: vi.fn(async () => sdk)
  }
}

function clientWithPager(modelPager: AntigravityGeminiApiModelPager): {
  client: AntigravityGeminiApiClient
  list: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(async () => modelPager)
  return { client: { models: { list } }, list }
}

describe('discoverAuthenticatedAntigravityGeminiApiModels', () => {
  it('requires the separate acknowledgement before reading the main-only key', async () => {
    const { client } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
    const loadApiKey = vi.fn()

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels({}, depsFor(client, loadApiKey))
    ).resolves.toEqual({ status: 'disclosureRequired', models: [] })

    expect(loadApiKey).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for invalid acknowledgement timestamp %s',
    async (acceptedAt) => {
      const { client } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
      await expect(
        discoverAuthenticatedAntigravityGeminiApiModels(
          { antigravityGeminiApiDisclosureAcceptedAt: acceptedAt },
          depsFor(client)
        )
      ).resolves.toEqual({ status: 'disclosureRequired', models: [] })
    }
  )

  it('fails closed without a successful encrypted-key load', async () => {
    const { client, list } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
    const loadApiKey = vi.fn(() => ({ status: 'corrupt' }) as const)

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, depsFor(client, loadApiKey))
    ).resolves.toEqual({ status: 'keyUnavailable', models: [] })

    expect(list).not.toHaveBeenCalled()
  })

  it('contains unexpected secret-store failures without exposing their detail', async () => {
    const { client, list } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
    const loadApiKey = vi.fn(() => {
      throw new Error(`secret store failed for ${API_KEY}`)
    })

    const result = await discoverAuthenticatedAntigravityGeminiApiModels(
      acceptedSettings,
      depsFor(client, loadApiKey)
    )

    expect(result).toEqual({ status: 'keyUnavailable', models: [] })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(list).not.toHaveBeenCalled()
  })

  it('drops ids Google still advertises but no longer serves to new keys', async () => {
    // gemini-2.5-flash / -flash-lite return 404 "no longer available to new
    // users" on the FIRST call while models.list still reports them as
    // generateContent-capable, so the capability filter cannot catch them and
    // the picker offered a model that could not run (observed 2026-07-26).
    const { client } = clientWithPager(
      pager([
        generateCapable('gemini-2.5-flash'),
        generateCapable('gemini-2.5-flash-lite'),
        generateCapable('gemini-2.5-pro'),
        generateCapable('gemini-3.5-flash')
      ])
    )

    const result = await discoverAuthenticatedAntigravityGeminiApiModels(
      acceptedSettings,
      depsFor(client)
    )
    expect(result.status).toBe('ok')
    expect(result.models.map((model) => model.modelId)).toEqual([
      // 2.5-pro survives deliberately: it answered 429 (quota exhausted), which
      // says nothing about the model. Only a proven 404 justifies removal, so
      // "the 2.5 family is retired" must NOT be inferred here.
      'gemini-2.5-pro',
      'gemini-3.5-flash'
    ])
  })

  it('discovers only authenticated, generate-capable Gemini models under the API namespace', async () => {
    const { client, list } = clientWithPager(
      pager(
        [
          // Duplicated on purpose — this case pins dedup. Uses a LIVE id:
          // gemini-2.5-flash is now filtered as retired, which would have made
          // this assertion about the retirement list rather than about dedup.
          generateCapable('gemini-3.5-flash'),
          generateCapable('gemini-3.5-flash'),
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedActions: ['countTokens'] },
          generateCapable('gemma-4-31b-it'),
          { name: 'tunedModels/private-model', supportedActions: ['generateContent'] },
          { name: 'models/gemini invalid', supportedActions: ['generateContent'] }
        ],
        [[generateCapable('gemini-3-flash-preview')]]
      )
    )

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, depsFor(client))
    ).resolves.toEqual({
      status: 'ok',
      models: [
        {
          id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}gemini-3.5-flash`,
          modelId: 'gemini-3.5-flash'
        },
        // 2.5-pro stays: it answered 429 (quota), not 404 — it is alive.
        { id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}gemini-2.5-pro`, modelId: 'gemini-2.5-pro' },
        {
          id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}gemini-3-flash-preview`,
          modelId: 'gemini-3-flash-preview'
        }
      ]
    })

    expect(list).toHaveBeenCalledWith({
      config: expect.objectContaining({ pageSize: 32, queryBase: true })
    })
  })

  it('bounds pagination and discovered results', async () => {
    const page = Array.from(
      { length: MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS + 5 },
      (_, index) => generateCapable(`gemini-2.5-flash-${index}`)
    )
    const modelPager = pager(
      page,
      Array.from({ length: MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES }, () => [])
    )
    const { client } = clientWithPager(modelPager)

    const result = await discoverAuthenticatedAntigravityGeminiApiModels(
      acceptedSettings,
      depsFor(client)
    )

    expect(result).toMatchObject({ status: 'ok' })
    expect(result.models).toHaveLength(MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS)
    expect(modelPager.nextPage).not.toHaveBeenCalled()
  })

  it('bounds empty pagination rather than following an unbounded SDK pager', async () => {
    const modelPager = pager(
      [],
      Array.from({ length: 20 }, () => [])
    )
    const { client } = clientWithPager(modelPager)

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, depsFor(client))
    ).resolves.toEqual({ status: 'empty', models: [] })

    expect(modelPager.nextPage).toHaveBeenCalledTimes(
      MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES - 1
    )
  })

  it('returns empty rather than exposing an empty or invalid catalog', async () => {
    const { client } = clientWithPager(
      pager([{ name: 'models/gemini-2.5-flash', supportedActions: ['countTokens'] }])
    )

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, depsFor(client))
    ).resolves.toEqual({
      status: 'empty',
      models: []
    })
  })

  it('fails closed for a malformed pager response', async () => {
    const { client } = clientWithPager({
      page: [] as never[],
      hasNextPage: () => false,
      nextPage: async () => []
    })
    client.models.list = vi.fn(async () => ({
      page: null
    })) as unknown as AntigravityGeminiApiClient['models']['list']

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, depsFor(client))
    ).resolves.toEqual({
      status: 'invalidResponse',
      models: []
    })
  })

  it.each([
    [{ status: 401 }, 'unauthorized'],
    [{ status: 403 }, 'unauthorized'],
    // Live-verified: a rejected key surfaces as 400 + API_KEY_INVALID (never
    // 401), so the settings card must be able to say "rejected", not
    // "unreachable". A plain 400 without the marker stays 'unavailable'.
    [
      {
        name: 'ApiError',
        status: 400,
        message:
          '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'
      },
      'unauthorized'
    ],
    [{ name: 'ApiError', status: 400, message: 'bad page token' }, 'unavailable'],
    [{ status: 429 }, 'rateLimited'],
    [{ status: 402 }, 'projectLimited'],
    [{ code: 'BILLING_NOT_ENABLED' }, 'projectLimited'],
    [new Error('network unavailable'), 'unavailable']
  ] as const)('returns fixed nonsecret metadata for SDK failure %#', async (error, status) => {
    const list = vi.fn(async () => {
      throw error
    })
    const client: AntigravityGeminiApiClient = { models: { list } }
    const result = await discoverAuthenticatedAntigravityGeminiApiModels(
      acceptedSettings,
      depsFor(client)
    )

    expect(result).toEqual({ status, models: [] })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(JSON.stringify(result)).not.toContain('network unavailable')
  })

  it('passes abort support to the official SDK and fails closed when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, list } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, {
        ...depsFor(client),
        abortSignal: controller.signal
      })
    ).resolves.toEqual({ status: 'cancelled', models: [] })
    expect(list).not.toHaveBeenCalled()
  })

  it('maps an SDK abort without returning a model or error detail', async () => {
    const controller = new AbortController()
    const list = vi.fn(async () => {
      controller.abort()
      const error = new Error('request included ' + API_KEY)
      error.name = 'AbortError'
      throw error
    })
    const client: AntigravityGeminiApiClient = { models: { list } }

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, {
        ...depsFor(client),
        abortSignal: controller.signal
      })
    ).resolves.toEqual({ status: 'cancelled', models: [] })
  })

  it('does not construct a client when the official SDK loader is unavailable', async () => {
    const { client } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
    const deps = depsFor(client)

    await expect(
      discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, {
        ...deps,
        loadSdk: async () => null
      })
    ).resolves.toEqual({ status: 'sdkUnavailable', models: [] })
  })

  it('contains SDK loader failures without propagating their text', async () => {
    const { client } = clientWithPager(pager([generateCapable('gemini-2.5-flash')]))
    const result = await discoverAuthenticatedAntigravityGeminiApiModels(acceptedSettings, {
      ...depsFor(client),
      loadSdk: async () => {
        throw new Error(`failed loading SDK with ${API_KEY}`)
      }
    })

    expect(result).toEqual({ status: 'sdkUnavailable', models: [] })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })
})
