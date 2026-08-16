import { describe, expect, it, vi } from 'vitest'
import {
  fetchOllamaCloudApiCatalog,
  normalizeOllamaCloudApiModels,
  ollamaCloudApiHeaders
} from './OllamaCloudApi'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('OllamaCloudApi', () => {
  it('normalizes direct Cloud tags into source-classified picker ids', () => {
    expect(
      normalizeOllamaCloudApiModels({
        models: [
          { model: 'minimax-m2.7' },
          { name: 'gpt-oss:120b', details: { context_length: 131_072 } },
          { model: 'minimax-m2.7' },
          { model: 'bad model' }
        ]
      })
    ).toEqual([
      { model: 'minimax-m2.7:cloud' },
      { model: 'gpt-oss:120b:cloud', contextLength: 131_072 }
    ])
  })

  it('sends the key only as a Bearer header to the direct tags endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ model: 'glm-5.2' }] })
    ) as unknown as typeof fetch

    await expect(fetchOllamaCloudApiCatalog('ollama-secret', { fetchImpl })).resolves.toMatchObject(
      {
        reachable: true,
        ok: true,
        status: 200,
        models: [{ model: 'glm-5.2:cloud' }]
      }
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ollama.com/api/tags',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer ollama-secret' }
      })
    )
  })

  it('does not put the API key in URLs or JSON content headers', () => {
    expect(ollamaCloudApiHeaders('secret')).toEqual({ Authorization: 'Bearer secret' })
    expect(ollamaCloudApiHeaders('secret', { json: true })).toEqual({
      Authorization: 'Bearer secret',
      'content-type': 'application/json'
    })
  })
})
