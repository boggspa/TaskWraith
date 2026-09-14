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

describe('Ollama inline reasoning extraction', () => {
  function stubChatStream(lines: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`${lines.join('\n')}\n`))
    )
  }

  function loopOptions(overrides: Partial<OllamaChatLoopOptions> = {}): OllamaChatLoopOptions {
    return {
      baseUrl: 'http://127.0.0.1:11434',
      signal: new AbortController().signal,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      ...overrides
    }
  }

  function contentLine(content: string): string {
    return JSON.stringify({ message: { content } })
  }

  it('extracts inline <think> block contents into thinking, not the tag name', async () => {
    stubChatStream([contentLine('Hello <think>secret plan</think> world'), '{"done":true}'])
    const deltas: Array<[string, string]> = []
    const result = await runOllamaChatLoop(
      loopOptions({ onThinkingDelta: (delta, full) => deltas.push([delta, full]) })
    )
    expect(result.thinking).toBe('secret plan')
    expect(deltas).toEqual([['secret plan', 'secret plan']])
  })

  it('reassembles a reasoning block split across chunks without visible-text pollution', async () => {
    stubChatStream([
      contentLine('Start <think>split'),
      contentLine(' plan</think> end'),
      '{"done":true}'
    ])
    const result = await runOllamaChatLoop(loopOptions())
    expect(result.thinking).toBe('split plan')
  })

  it('detects an open tag split across a chunk boundary', async () => {
    stubChatStream([contentLine('a <thi'), contentLine('nk>tagged</think> b'), '{"done":true}'])
    const result = await runOllamaChatLoop(loopOptions())
    expect(result.thinking).toBe('tagged')
  })

  it('flushes a block left unclosed at the end of the stream', async () => {
    stubChatStream([
      contentLine('A <think>long trailing'),
      contentLine(' thought'),
      '{"done":true}'
    ])
    const result = await runOllamaChatLoop(loopOptions())
    expect(result.thinking).toBe('long trailing thought')
  })

  it('streams the daemon thinking field through onThinkingDelta', async () => {
    stubChatStream([
      JSON.stringify({ message: { content: 'hi', thinking: 'daemon thought' } }),
      '{"done":true}'
    ])
    const deltas: string[] = []
    const result = await runOllamaChatLoop(
      loopOptions({ onThinkingDelta: (delta) => deltas.push(delta) })
    )
    expect(result.thinking).toBe('daemon thought')
    expect(deltas).toEqual(['daemon thought'])
  })
})
