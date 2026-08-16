import { describe, expect, it, vi } from 'vitest'
import { discoverOllamaCloud, normalizeOllamaCloudRecommendations } from './OllamaCloudCatalog'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('normalizeOllamaCloudRecommendations', () => {
  it('keeps only explicit cloud models and preserves daemon limits', () => {
    expect(
      normalizeOllamaCloudRecommendations({
        recommendations: [
          {
            model: 'kimi-k2.5:cloud',
            description: 'Remote coding model',
            context_length: 262_144,
            max_output_tokens: 65_536,
            required_plan: 'pro'
          },
          { model: 'gpt-oss:120b-cloud', context_length: 131_072 },
          { model: 'gemma4:26b', context_length: 131_072 },
          { model: 'KIMI-K2.5:CLOUD', context_length: 1 }
        ]
      })
    ).toEqual([
      {
        model: 'kimi-k2.5:cloud',
        description: 'Remote coding model',
        contextLength: 262_144,
        maxOutputTokens: 65_536,
        requiredPlan: 'pro'
      },
      { model: 'gpt-oss:120b-cloud', contextLength: 131_072 }
    ])
  })
})

describe('discoverOllamaCloud', () => {
  it('reads account state and recommendations only through the local daemon', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/status')) {
        return jsonResponse({ cloud: { disabled: false, source: 'none' } })
      }
      if (url.endsWith('/api/me')) {
        return jsonResponse({ id: 'private', email: 'private@example.com', plan: 'pro' })
      }
      if (url.endsWith('/api/experimental/model-recommendations')) {
        return jsonResponse({
          recommendations: [
            { model: 'glm-5.2:cloud', context_length: 1_000_000, required_plan: 'pro' },
            { model: 'gemma4:26b', context_length: 131_072 }
          ]
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    await expect(discoverOllamaCloud('http://127.0.0.1:11434', { fetchImpl })).resolves.toEqual({
      supported: true,
      enabled: true,
      authenticated: true,
      plan: 'pro',
      source: 'none',
      models: [
        {
          model: 'glm-5.2:cloud',
          contextLength: 1_000_000,
          requiredPlan: 'pro'
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    for (const [url] of vi.mocked(fetchImpl).mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\//)
    }
  })

  it('unions direct API tags with daemon metadata when an API key is configured', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://ollama.com/api/tags') {
        expect(init?.headers).toEqual({ Authorization: 'Bearer cloud-key' })
        return jsonResponse({
          models: [{ model: 'minimax-m2.7' }, { model: 'glm-5.2' }]
        })
      }
      if (url.endsWith('/api/status')) {
        return jsonResponse({ cloud: { disabled: false, source: 'none' } })
      }
      if (url.endsWith('/api/me')) return jsonResponse({}, 401)
      if (url.endsWith('/api/experimental/model-recommendations')) {
        return jsonResponse({
          recommendations: [
            { model: 'glm-5.2:cloud', context_length: 1_000_000, required_plan: 'pro' }
          ]
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      discoverOllamaCloud('http://127.0.0.1:11434', {
        fetchImpl,
        apiKey: 'cloud-key'
      })
    ).resolves.toMatchObject({
      supported: true,
      enabled: true,
      authenticated: true,
      apiKeyConfigured: true,
      models: [
        { model: 'minimax-m2.7:cloud' },
        {
          model: 'glm-5.2:cloud',
          contextLength: 1_000_000,
          requiredPlan: 'pro'
        }
      ]
    })
  })

  it('keeps direct API-key Cloud available when the local daemon disables its own Cloud bridge', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://ollama.com/api/tags') {
        return jsonResponse({ models: [{ model: 'kimi-k3' }] })
      }
      if (url.endsWith('/api/status')) {
        return jsonResponse({ cloud: { disabled: true, source: 'env' } })
      }
      if (url.endsWith('/api/me')) return jsonResponse({}, 401)
      return jsonResponse({ recommendations: [] })
    }) as unknown as typeof fetch

    await expect(
      discoverOllamaCloud('http://localhost:11434', { fetchImpl, apiKey: 'cloud-key' })
    ).resolves.toMatchObject({
      enabled: true,
      authenticated: true,
      apiKeyConfigured: true,
      source: 'env',
      models: [{ model: 'kimi-k3:cloud' }]
    })
  })

  it('reports sign-in required without retaining account response details', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/me')) {
        return jsonResponse({ error: 'unauthorized', signin_url: 'https://private.example' }, 401)
      }
      if (url.endsWith('/api/status')) {
        return jsonResponse({ cloud: { disabled: false, source: 'none' } })
      }
      return jsonResponse({ recommendations: [{ model: 'minimax-m3:cloud' }] })
    }) as unknown as typeof fetch

    const snapshot = await discoverOllamaCloud('http://localhost:11434', { fetchImpl })

    expect(snapshot.authenticated).toBe(false)
    expect(snapshot).not.toHaveProperty('email')
    expect(snapshot).not.toHaveProperty('signin_url')
  })

  it('omits cloud models when the daemon explicitly disables cloud', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/status')) {
        return jsonResponse({ cloud: { disabled: true, source: 'env' } })
      }
      if (url.endsWith('/api/me')) return jsonResponse({}, 401)
      return jsonResponse({ recommendations: [{ model: 'kimi-k2.5:cloud' }] })
    }) as unknown as typeof fetch

    await expect(
      discoverOllamaCloud('http://localhost:11434', { fetchImpl })
    ).resolves.toMatchObject({
      supported: true,
      enabled: false,
      authenticated: false,
      source: 'env',
      models: []
    })
  })

  it('degrades cleanly on older daemons without cloud endpoints', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'not found' }, 404)
    ) as unknown as typeof fetch

    await expect(discoverOllamaCloud('http://localhost:11434', { fetchImpl })).resolves.toEqual({
      supported: false,
      enabled: true,
      authenticated: null,
      models: []
    })
  })
})
