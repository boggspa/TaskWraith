import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOllamaChatLoop, type OllamaChatLoopOptions } from './OllamaChatLoop'

afterEach(() => vi.unstubAllGlobals())

describe('Ollama thinking on the HTTP request', () => {
  it.each([false, true, 'low', 'max', undefined] as const)(
    'preserves the requested think value %s',
    async (think) => {
      let body: Record<string, unknown> = {}
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
          body = JSON.parse(String(init?.body))
          return new Response('{"message":{"content":"done"},"done":true}\n')
        })
      )
      const options: OllamaChatLoopOptions = {
        baseUrl: 'http://127.0.0.1:11434',
        signal: new AbortController().signal,
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        ...(think !== undefined ? { think } : {})
      }
      await expect(runOllamaChatLoop(options)).resolves.toMatchObject({ content: 'done' })
      if (think === undefined) expect(body).not.toHaveProperty('think')
      else expect(body.think).toBe(think)
    }
  )
})
