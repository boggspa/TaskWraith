import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX,
  MAX_ANTIGRAVITY_GEMINI_API_PROMPT_CHARS,
  MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS,
  MAX_ANTIGRAVITY_GEMINI_API_USAGE_TOKENS,
  streamAntigravityGeminiApiTurn,
  type AntigravityGeminiApiTurnClient,
  type AntigravityGeminiApiTurnClientConstructor,
  type AntigravityGeminiApiTurnSdkModule
} from './AntigravityGeminiApiTurnKernel'

const API_KEY = 'AIza-explicit-user-supplied-test-key'
const MODEL = 'gemini-api:gemini-2.5-flash'
const settings = { antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_000 }

async function* chunks(values: readonly unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value
}

function sdkFor(client: AntigravityGeminiApiTurnClient): AntigravityGeminiApiTurnSdkModule {
  const Constructor = class {
    constructor(options: { apiKey: string }) {
      expect(options).toEqual({ apiKey: API_KEY })
      return client
    }
  } as unknown as AntigravityGeminiApiTurnClientConstructor
  return { GoogleGenAI: Constructor }
}

function dependencies(
  client: AntigravityGeminiApiTurnClient,
  overrides: Partial<Parameters<typeof streamAntigravityGeminiApiTurn>[2]> = {}
) {
  return {
    secretStore: { loadApiKey: vi.fn(() => ({ status: 'ok' as const, value: API_KEY })) },
    loadSdk: vi.fn(async () => sdkFor(client)),
    onText: vi.fn(),
    ...overrides
  }
}

function clientFor(stream: AsyncIterable<unknown>) {
  const generateContentStream = vi.fn(async () => stream)
  return {
    client: { models: { generateContentStream } },
    generateContentStream
  }
}

describe('streamAntigravityGeminiApiTurn', () => {
  it('rejects every non-exact Gemini API route before reading the key', async () => {
    for (const model of [
      'gemini-2.5-flash',
      'agy:gemini-2.5-flash',
      'gemini-api:claude-3',
      'gemini-api:gemini 2.5 flash',
      'gemini-api:gemini-2.5-flash/',
      'gemini-api:gemini-2.5-flash?fallback=agy'
    ]) {
      const client = clientFor(chunks([{ text: 'should not run' }]))
      const deps = dependencies(client.client)
      const result = await streamAntigravityGeminiApiTurn(settings, { model, prompt: 'Hi' }, deps)
      expect(result.status).toBe('invalidModel')
      expect(deps.secretStore.loadApiKey).not.toHaveBeenCalled()
      expect(client.generateContentStream).not.toHaveBeenCalled()
    }
  })

  it('requires disclosure before the main-only secret load', async () => {
    const client = clientFor(chunks([{ text: 'no' }]))
    const deps = dependencies(client.client)
    const result = await streamAntigravityGeminiApiTurn({}, { model: MODEL, prompt: 'Hi' }, deps)
    expect(result).toEqual({ model: MODEL, status: 'disclosureRequired', chunks: 0, textChars: 0 })
    expect(deps.secretStore.loadApiKey).not.toHaveBeenCalled()
  })

  it('requires a successful dedicated secret-store load', async () => {
    const client = clientFor(chunks([{ text: 'no' }]))
    const deps = dependencies(client.client, {
      secretStore: { loadApiKey: vi.fn(() => ({ status: 'corrupt' as const })) }
    })
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )
    expect(result).toEqual({ model: MODEL, status: 'keyUnavailable', chunks: 0, textChars: 0 })
    expect(client.generateContentStream).not.toHaveBeenCalled()
  })

  it('streams text using only the local unnamespaced model and bounded text/usage', async () => {
    const controller = new AbortController()
    const first = 'Hello '
    const second = 'world'
    const client = clientFor(
      chunks([
        { text: first, usageMetadata: { promptTokenCount: 4 } },
        { text: second, usageMetadata: { candidatesTokenCount: 6, totalTokenCount: 10 } }
      ])
    )
    const deps = dependencies(client.client, { abortSignal: controller.signal })
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )

    expect(result).toEqual({
      status: 'ok',
      model: MODEL,
      chunks: 2,
      textChars: 11,
      usage: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 }
    })
    expect(deps.onText).toHaveBeenCalledWith(first)
    expect(deps.onText).toHaveBeenCalledWith(second)
    expect(client.generateContentStream).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: 'Hi',
      config: { abortSignal: controller.signal }
    })
  })

  it('re-applies disclosure and secret admission on every turn', async () => {
    const client = clientFor(chunks([{ text: 'ok' }]))
    const deps = dependencies(client.client)
    await streamAntigravityGeminiApiTurn(settings, { model: MODEL, prompt: 'one' }, deps)
    await streamAntigravityGeminiApiTurn(settings, { model: MODEL, prompt: 'two' }, deps)
    expect(deps.secretStore.loadApiKey).toHaveBeenCalledTimes(2)
    expect(client.generateContentStream).toHaveBeenCalledTimes(2)
  })

  it('fails closed before SDK work when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = clientFor(chunks([{ text: 'no' }]))
    const deps = dependencies(client.client, { abortSignal: controller.signal })
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )
    expect(result).toEqual({ model: MODEL, status: 'cancelled', chunks: 0, textChars: 0 })
    expect(deps.secretStore.loadApiKey).not.toHaveBeenCalled()
  })

  it('bounds each callback and total streamed text', async () => {
    const longText = 'x'.repeat(MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS * 2)
    const client = clientFor(chunks([{ text: longText }, { text: longText }]))
    const deps = dependencies(client.client)
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )
    expect(result).toMatchObject({
      status: 'ok',
      textChars: MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS * 2
    })
    expect(deps.onText).toHaveBeenCalledTimes(2)
    const onTextMock = deps.onText as ReturnType<typeof vi.fn>
    expect(
      onTextMock.mock.calls.every(
        ([text]) => text.length <= MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS
      )
    ).toBe(true)
  })

  it('rejects empty, oversized, and malformed stream responses', async () => {
    const emptyClient = clientFor(chunks([{ usageMetadata: { totalTokenCount: 4 } }]))
    await expect(
      streamAntigravityGeminiApiTurn(
        settings,
        { model: MODEL, prompt: 'Hi' },
        dependencies(emptyClient.client)
      )
    ).resolves.toMatchObject({ status: 'empty' })

    const malformedClient = clientFor(null as unknown as AsyncIterable<unknown>)
    await expect(
      streamAntigravityGeminiApiTurn(
        settings,
        { model: MODEL, prompt: 'Hi' },
        dependencies(malformedClient.client)
      )
    ).resolves.toMatchObject({ status: 'invalidResponse' })

    const oversizedPrompt = 'p'.repeat(MAX_ANTIGRAVITY_GEMINI_API_PROMPT_CHARS + 1)
    await expect(
      streamAntigravityGeminiApiTurn(
        settings,
        { model: MODEL, prompt: oversizedPrompt },
        dependencies(emptyClient.client)
      )
    ).resolves.toMatchObject({ status: 'invalidPrompt' })
  })

  it.each([
    [{ status: 401 }, 'unauthorized'],
    [{ status: 403 }, 'unauthorized'],
    [{ status: 429 }, 'rateLimited'],
    [{ status: 402 }, 'projectLimited'],
    [{ code: 'BILLING_NOT_ENABLED' }, 'projectLimited'],
    [new Error(`network includes ${API_KEY}`), 'unavailable']
  ] as const)('maps SDK failure to fixed metadata %#', async (error, status) => {
    const generateContentStream = vi.fn(async () => {
      throw error
    })
    const client: AntigravityGeminiApiTurnClient = { models: { generateContentStream } }
    const deps = dependencies(client)
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )
    expect(result).toMatchObject({ status, model: MODEL, chunks: 0, textChars: 0 })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(JSON.stringify(result)).not.toContain('network includes')
  })

  it('maps loader and constructor failures without exposing detail', async () => {
    const client = clientFor(chunks([{ text: 'no' }]))
    const loaderResult = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      {
        ...dependencies(client.client),
        loadSdk: async () => {
          throw new Error(`loader ${API_KEY}`)
        }
      }
    )
    expect(loaderResult).toMatchObject({ status: 'sdkUnavailable' })
    expect(JSON.stringify(loaderResult)).not.toContain(API_KEY)

    const constructor = class {
      constructor() {
        throw new Error(`constructor ${API_KEY}`)
      }
    } as unknown as AntigravityGeminiApiTurnClientConstructor
    const constructorResult = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      {
        ...dependencies(client.client),
        loadSdk: async () => ({ GoogleGenAI: constructor })
      }
    )
    expect(constructorResult).toMatchObject({ status: 'unavailable' })
    expect(JSON.stringify(constructorResult)).not.toContain(API_KEY)
  })

  it.each(['name', 'status', 'response', 'code'] as const)(
    'contains an SDK error proxy whose %s getter throws',
    async (property) => {
      const error = new Proxy(
        { name: 'Error' },
        {
          get(target, key, receiver) {
            if (key === property) throw new Error(`sentinel-${property}-${API_KEY}`)
            return Reflect.get(target, key, receiver)
          }
        }
      )
      const client: AntigravityGeminiApiTurnClient = {
        models: {
          generateContentStream: vi.fn(async () => {
            throw error
          })
        }
      }
      const result = await streamAntigravityGeminiApiTurn(
        settings,
        { model: MODEL, prompt: 'Hi' },
        dependencies(client)
      )
      expect(result).toMatchObject({ status: 'unavailable', model: MODEL, chunks: 0, textChars: 0 })
      expect(JSON.stringify(result)).not.toContain('sentinel-')
      expect(JSON.stringify(result)).not.toContain(API_KEY)
    }
  )

  it('contains throwing SDK module and async-iterator proxies with fixed metadata', async () => {
    const client = clientFor(chunks([{ text: 'no' }]))
    const sdk = new Proxy(
      {},
      {
        get() {
          throw new Error(`sentinel-module-${API_KEY}`)
        }
      }
    ) as unknown as AntigravityGeminiApiTurnSdkModule
    const moduleResult = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      { ...dependencies(client.client), loadSdk: async () => sdk }
    )
    expect(moduleResult).toMatchObject({ status: 'sdkUnavailable', model: MODEL })
    expect(JSON.stringify(moduleResult)).not.toContain('sentinel-')
    expect(JSON.stringify(moduleResult)).not.toContain(API_KEY)

    const malformedStream = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === Symbol.asyncIterator) throw new Error(`sentinel-stream-${API_KEY}`)
          return undefined
        }
      }
    ) as AsyncIterable<unknown>
    const streamClient = clientFor(malformedStream)
    const streamResult = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      dependencies(streamClient.client)
    )
    expect(streamResult).toMatchObject({ status: 'invalidResponse', model: MODEL })
    expect(JSON.stringify(streamResult)).not.toContain('sentinel-')
    expect(JSON.stringify(streamResult)).not.toContain(API_KEY)
  })

  it('returns invalidResponse for throwing stream chunk accessors', async () => {
    const chunk = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'usageMetadata' || key === 'text') {
            throw new Error(`sentinel-chunk-${API_KEY}`)
          }
          return undefined
        }
      }
    )
    const client = clientFor(chunks([chunk]))
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      dependencies(client.client)
    )
    expect(result).toMatchObject({ status: 'invalidResponse', model: MODEL })
    expect(JSON.stringify(result)).not.toContain('sentinel-')
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('maps stream abort and callback failures without propagating error text', async () => {
    const controller = new AbortController()
    const client = clientFor(
      chunks([
        { text: 'first' },
        (() => {
          controller.abort()
          return { text: `secret ${API_KEY}` }
        })()
      ])
    )
    const deps = dependencies(client.client, { abortSignal: controller.signal })
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      deps
    )
    expect(result).toMatchObject({ status: 'cancelled' })

    const callbackClient = clientFor(chunks([{ text: 'first' }]))
    const callbackResult = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      {
        ...dependencies(callbackClient.client),
        onText: () => {
          throw new Error(`callback ${API_KEY}`)
        }
      }
    )
    expect(callbackResult).toMatchObject({ status: 'unavailable' })
    expect(JSON.stringify(callbackResult)).not.toContain(API_KEY)
  })

  it('bounds usage fields and never returns arbitrary SDK properties', async () => {
    const client = clientFor(
      chunks([
        {
          text: 'ok',
          usageMetadata: {
            promptTokenCount: MAX_ANTIGRAVITY_GEMINI_API_USAGE_TOKENS + 1,
            candidatesTokenCount: 3,
            totalTokenCount: 4,
            apiKey: API_KEY,
            error: `bad ${API_KEY}`
          },
          apiKey: API_KEY
        }
      ])
    )
    const result = await streamAntigravityGeminiApiTurn(
      settings,
      { model: MODEL, prompt: 'Hi' },
      dependencies(client.client)
    )
    expect(result).toEqual({
      status: 'ok',
      model: MODEL,
      chunks: 1,
      textChars: 2,
      usage: { candidatesTokenCount: 3, totalTokenCount: 4 }
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('keeps the official SDK loader as the only production SDK path', async () => {
    const client = clientFor(chunks([{ text: 'ok' }]))
    const deps = dependencies(client.client)
    expect(deps.loadSdk).toHaveBeenCalledTimes(0)
    await streamAntigravityGeminiApiTurn(settings, { model: MODEL, prompt: 'Hi' }, deps)
    expect(deps.loadSdk).toHaveBeenCalledTimes(1)
    expect(ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX).toBe('gemini-api:')
  })
})
