/**
 * Best-effort Ollama model unload helpers.
 *
 * When a local chat transport drops (often after the OS kills llama-server under
 * memory pressure), TaskWraith previously left the model resident via keep_alive.
 * An explicit unload (`POST /api/generate` with `keep_alive: 0`) frees VRAM so the
 * next model switch or retry has a chance to succeed.
 */

export const OLLAMA_UNLOAD_TIMEOUT_MS = 2_500

export type OllamaUnloadRequestBody = {
  model: string
  keep_alive: 0
}

export type OllamaUnloadResult = {
  ok: boolean
  status?: number
  error?: string
}

/** Build the unload body Ollama accepts to evict a resident model. */
export function buildOllamaUnloadRequestBody(model: string): OllamaUnloadRequestBody {
  return {
    model: String(model || '').trim(),
    keep_alive: 0
  }
}

/** Join a normalized base URL with `/api/generate` (Ollama's unload route). */
export function ollamaUnloadUrl(baseUrl: string): string {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
  return `${base}/api/generate`
}

/**
 * Transport-class failures that commonly follow an OOM-killed model runner.
 * Caller can still choose to use it on cancel/unload cleanup as needed.
 */
export function isLikelyOllamaMemoryPressureFailure(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  const causeCode = cause && typeof cause.code === 'string' ? cause.code.toUpperCase() : ''
  if (causeCode === 'ABORT_ERR') return false
  return (
    message.includes('fetch failed') ||
    message.includes('terminated') ||
    message.includes('socket') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('epipe') ||
    message.includes('etimedout') ||
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(causeCode)
  )
}

/**
 * User-facing copy for a transport drop that may be memory pressure.
 * Kept separate from the provider so messaging can be unit-tested without
 * booting the full run loop.
 */
export function describeOllamaTransportFailure(
  baseUrl: string,
  originalError: string,
  options: { unloadAttempted?: boolean } = {}
): string {
  const parts = [
    `Ollama connection dropped while talking to ${String(baseUrl || '')
      .trim()
      .replace(/\/+$/, '')}.`,
    'TaskWraith retried the local chat request, but Ollama still closed or refused the connection.',
    'This often means the model runner was killed by memory pressure (OOM).',
    'Try a smaller local model, close other GPU/RAM-heavy apps, or restart the Ollama app/service.',
    options.unloadAttempted
      ? 'TaskWraith requested an unload of the failed model so the next run can reclaim memory.'
      : null,
    `Original error: ${originalError}`
  ]
  return parts.filter(Boolean).join(' ')
}

/**
 * Best-effort unload. Never throws; never uses the cancelled run signal.
 * A short private timeout keeps cleanup off the critical path if Ollama is down.
 */
export async function unloadOllamaModel(input: {
  baseUrl: string
  model: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<OllamaUnloadResult> {
  const model = String(input.model || '').trim()
  if (!model) return { ok: false, error: 'missing model' }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch unavailable' }
  }

  const timeoutMs = input.timeoutMs ?? OLLAMA_UNLOAD_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(ollamaUnloadUrl(input.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildOllamaUnloadRequestBody(model))
    })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`
      }
    }
    // Drain the body so the connection can close cleanly; ignore parse failures.
    try {
      await response.text()
    } catch {
      // ignore
    }
    return { ok: true, status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}
