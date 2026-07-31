import { describe, expect, it, vi } from 'vitest'
import {
  buildOllamaUnloadRequestBody,
  describeOllamaTransportFailure,
  isLikelyOllamaMemoryPressureFailure,
  ollamaUnloadUrl,
  unloadOllamaModel
} from './OllamaUnload'

describe('OllamaUnload', () => {
  it('builds a keep_alive:0 unload body for the named model', () => {
    expect(buildOllamaUnloadRequestBody('  qwen3:4b  ')).toEqual({
      model: 'qwen3:4b',
      keep_alive: 0
    })
  })

  it('joins the generate unload URL without doubling slashes', () => {
    expect(ollamaUnloadUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434/api/generate')
  })

  it('classifies transport drops as likely memory-pressure failures', () => {
    expect(isLikelyOllamaMemoryPressureFailure(new TypeError('fetch failed'))).toBe(true)
    expect(
      isLikelyOllamaMemoryPressureFailure(
        Object.assign(new Error('socket hang up'), {
          cause: { code: 'ECONNRESET' }
        })
      )
    ).toBe(true)
    expect(
      isLikelyOllamaMemoryPressureFailure(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      )
    ).toBe(false)
  })

  it('describes transport failures with an OOM recovery hint', () => {
    const message = describeOllamaTransportFailure('http://127.0.0.1:11434/', 'fetch failed', {
      unloadAttempted: true
    })
    expect(message).toContain('Ollama connection dropped')
    expect(message).toContain('memory pressure')
    expect(message).toContain('smaller local model')
    expect(message).toContain('requested an unload')
    expect(message).toContain('Original error: fetch failed')
  })

  it('POSTs keep_alive:0 and reports ok on HTTP 200', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'stream-model:latest',
        keep_alive: 0
      })
      return {
        ok: true,
        status: 200,
        text: async () => ''
      } as Response
    })

    const result = await unloadOllamaModel({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'stream-model:latest',
      fetchImpl: fetchImpl as typeof fetch
    })

    expect(result).toEqual({ ok: true, status: 200 })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/generate',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('never throws when the unload fetch fails', async () => {
    const result = await unloadOllamaModel({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'dead:latest',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('fetch failed')
  })

  it('skips unload when model is empty', async () => {
    const fetchImpl = vi.fn()
    const result = await unloadOllamaModel({
      baseUrl: 'http://127.0.0.1:11434',
      model: '   ',
      fetchImpl: fetchImpl as typeof fetch
    })
    expect(result).toEqual({ ok: false, error: 'missing model' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
