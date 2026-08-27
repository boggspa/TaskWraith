import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverOllamaCloud } from './OllamaDaemonClient'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OllamaDaemonClient model presentation', () => {
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
