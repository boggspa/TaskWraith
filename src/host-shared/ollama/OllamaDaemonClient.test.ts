import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverOllamaCloud,
  discoverOllamaCloudAccount,
  fetchOllamaLocalModels,
  fetchOllamaModelCatalog
} from './OllamaDaemonClient'

const REMEMBERED = { signedIn: true, plan: 'pro', updatedAt: '2026-08-01T00:00:00.000Z' }

/** A daemon that lists a pulled Cloud tag but whose account relay never answers. */
function daemonWithSilentAccount(): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) {
      return new Response(
        JSON.stringify({
          models: [
            { model: 'qwen3.5:9b' },
            { model: 'minimax-m3:cloud', remote_host: 'ollama.com' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (url.endsWith('/api/me')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        )
      })
    }
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OllamaDaemonClient model presentation', () => {
  it('uses shared friendly labels for newly installed local tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { model: 'mistral-medium-3.5:latest' },
                { model: 'qwen3.8-flash-next:125b-mlx' },
                { model: 'granite4.2:8b' }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    )

    await expect(fetchOllamaLocalModels('http://127.0.0.1:11434')).resolves.toMatchObject([
      { id: 'mistral-medium-3.5:latest', label: 'Mistral Medium 3.5 (128B Param)' },
      { id: 'qwen3.8-flash-next:125b-mlx', label: 'Qwen 3.8 Flash Next (125B-MLX)' },
      { id: 'granite4.2:8b', label: 'Granite 4.2 (8B Param)' }
    ])
  })

  it('uses the shared curated label for Ollama Cloud models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ model: 'glm-5.3-flash' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    )

    await expect(discoverOllamaCloud('ollama-key')).resolves.toMatchObject({
      supported: true,
      enabled: true,
      authenticated: true,
      models: [
        {
          id: 'glm-5.3-flash:cloud',
          label: 'GLM 5.3 Flash',
          source: 'cloud',
          isCloud: true
        }
      ]
    })
  })

  it('offers signed-in daemon Cloud models and prefers MiniMax M3 as the cloud default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [
                { model: 'qwen3.5:9b' },
                { model: 'minimax-m3:cloud', remote_host: 'ollama.com' }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.endsWith('/api/status')) {
          return new Response(JSON.stringify({ cloud: { disabled: false, source: 'account' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/me')) {
          return new Response(JSON.stringify({ plan: 'pro', email: 'not-projected@example.com' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/experimental/model-recommendations')) {
          return new Response(
            JSON.stringify({
              recommendations: [
                { model: 'minimax-m3:cloud', context_length: 262_144 },
                { model: 'kimi-k3:cloud' }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434')

    expect(catalog.cloud).toMatchObject({
      supported: true,
      authenticated: true,
      plan: 'pro',
      source: 'account'
    })
    expect(catalog.localModels).toEqual([
      expect.objectContaining({ id: 'qwen3.5:9b', source: 'local', isDefault: false })
    ])
    expect(catalog.cloudModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-m3:cloud',
          label: 'M3',
          source: 'cloud',
          contextLength: 262_144,
          isDefault: true
        }),
        expect.objectContaining({ id: 'kimi-k3:cloud', source: 'cloud', isDefault: false })
      ])
    )
    expect(JSON.stringify(catalog)).not.toContain('not-projected@example.com')
  })

  it('keeps Cloud rows out and falls back to a local default without account proof', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [
                { model: 'qwen3.5:9b' },
                { model: 'minimax-m3:cloud', remote_host: 'ollama.com' }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.endsWith('/api/me')) {
          return new Response(JSON.stringify({ signin_url: 'https://not-projected.example' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/status')) {
          return new Response(JSON.stringify({ cloud: { disabled: false } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/experimental/model-recommendations')) {
          return new Response(
            JSON.stringify({ recommendations: [{ model: 'minimax-m3:cloud' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434')

    expect(catalog.cloud.authenticated).toBe(false)
    expect(catalog.cloudModels).toEqual([])
    expect(catalog.models).toEqual([
      expect.objectContaining({ id: 'qwen3.5:9b', source: 'local', isDefault: true })
    ])
    expect(JSON.stringify(catalog)).not.toContain('not-projected.example')
  })

  it('admits a proven direct Cloud key with the daemon offline and retains direct transport provenance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url === 'https://ollama.com/api/tags') {
          expect(init?.headers).toEqual({ authorization: 'Bearer ollama-cloud-key' })
          return new Response(
            JSON.stringify({ models: [{ model: 'minimax-m3' }, { model: 'kimi-k3' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error('daemon offline')
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', {
      cloudApiKey: 'ollama-cloud-key'
    })

    expect(catalog.localReachable).toBe(false)
    expect(catalog.cloud.authenticated).toBe(true)
    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-m3:cloud',
          source: 'cloud',
          transport: 'cloud-direct',
          isDefault: true
        }),
        expect.objectContaining({
          id: 'kimi-k3:cloud',
          source: 'cloud',
          transport: 'cloud-direct'
        })
      ])
    )
  })

  it('keeps an explicit installed-model preference ahead of the conditional Cloud default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ model: 'qwen3.5:9b' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/me')) {
          return new Response(JSON.stringify({ plan: 'pro' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/status')) {
          return new Response(JSON.stringify({ cloud: { disabled: false } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ recommendations: [{ model: 'minimax-m3:cloud' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', {
      defaultModel: 'qwen3.5:9b'
    })

    expect(catalog.models.find((model) => model.isDefault)?.id).toBe('qwen3.5:9b')
  })

  // The Host lane used to drop every Cloud row on an unknown account answer,
  // so a slow `/api/me` emptied the offers and refused the run outright.
  it('keeps the daemon Cloud rows present but disabled when the account probe hits its deadline', async () => {
    vi.stubGlobal('fetch', daemonWithSilentAccount())

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', { timeoutMs: 20 })

    expect(catalog.cloud).toMatchObject({
      supported: false,
      authenticated: null,
      accountProbe: 'timed-out'
    })
    expect(catalog.cloudModels).toEqual([
      expect.objectContaining({
        id: 'minimax-m3:cloud',
        disabled: true,
        disabledReason: 'Ollama Cloud account status is unavailable.'
      })
    ])
    expect(catalog.models.find((model) => model.isDefault)?.id).toBe('qwen3.5:9b')
  })

  it('answers the account from the remembered sign-in and re-enables the daemon Cloud rows', async () => {
    vi.stubGlobal('fetch', daemonWithSilentAccount())

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', {
      timeoutMs: 20,
      rememberedCliSignIn: REMEMBERED
    })

    expect(catalog.cloud).toMatchObject({
      supported: false,
      authenticated: true,
      plan: 'pro',
      authenticatedFromMemory: true,
      accountProbe: 'timed-out'
    })
    expect(catalog.cloudModels).toEqual([
      expect.objectContaining({ id: 'minimax-m3:cloud', disabled: false, isDefault: true })
    ])
  })

  it('answers from the remembered sign-in when the daemon listed models but refused the account relay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({ models: [{ model: 'minimax-m3:cloud', remote_host: 'ollama.com' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        throw new TypeError('fetch failed')
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', {
      rememberedCliSignIn: REMEMBERED
    })

    expect(catalog.cloud).toMatchObject({
      supported: false,
      authenticated: true,
      authenticatedFromMemory: true,
      accountProbe: 'refused'
    })
    expect(catalog.cloudModels).toEqual([
      expect.objectContaining({ id: 'minimax-m3:cloud', disabled: false })
    ])
  })

  it('still drops the daemon Cloud rows on a definitive 401 even with a remembered sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [
                { model: 'qwen3.5:9b' },
                { model: 'minimax-m3:cloud', remote_host: 'ollama.com' }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.endsWith('/api/me')) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (url.endsWith('/api/status')) {
          return new Response(JSON.stringify({ cloud: { disabled: false } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ recommendations: [{ model: 'minimax-m3:cloud' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )

    const catalog = await fetchOllamaModelCatalog('http://127.0.0.1:11434', {
      rememberedCliSignIn: REMEMBERED
    })

    expect(catalog.cloud).toMatchObject({ authenticated: false, accountProbe: 'answered' })
    expect(catalog.cloudModels).toEqual([])
  })

  it('tells its own deadline apart from a refused connection in the account probe', async () => {
    vi.stubGlobal('fetch', daemonWithSilentAccount())
    await expect(
      discoverOllamaCloudAccount('http://127.0.0.1:11434', { timeoutMs: 20 })
    ).resolves.toMatchObject({ authenticated: null, accountProbe: 'timed-out' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    await expect(
      discoverOllamaCloudAccount('http://127.0.0.1:11434', { timeoutMs: 20 })
    ).resolves.toMatchObject({ supported: false, authenticated: null, accountProbe: 'refused' })
  })
})
