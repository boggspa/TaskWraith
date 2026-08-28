import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverOllamaCloud, fetchOllamaLocalModels } from './OllamaDaemonClient'

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
          id: 'glm-5.3-flash',
          label: 'GLM 5.3 Flash',
          source: 'cloud',
          isCloud: true
        }
      ]
    })
  })
})
