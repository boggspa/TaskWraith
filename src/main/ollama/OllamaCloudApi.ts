import {
  isOllamaCloudModelId,
  normalizeOllamaModelKey,
  ollamaCloudModelId
} from '../../shared/ollamaModelAvailability'

export const OLLAMA_CLOUD_API_BASE_URL = 'https://ollama.com'

export interface OllamaCloudApiModel {
  model: string
  contextLength?: number
}

export interface OllamaCloudApiCatalogResult {
  reachable: boolean
  ok: boolean
  status: number
  models: OllamaCloudApiModel[]
}

interface OllamaCloudApiOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
  baseUrl?: string
}

const SAFE_CLOUD_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.trunc(number)
}

export function ollamaCloudApiHeaders(
  apiKey: string,
  options: { json?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`
  }
  if (options.json) headers['content-type'] = 'application/json'
  return headers
}

export function normalizeOllamaCloudApiModels(payload: unknown): OllamaCloudApiModel[] {
  const rows =
    payload && typeof payload === 'object' && Array.isArray((payload as any).models)
      ? (payload as any).models
      : []
  const seen = new Set<string>()
  const models: OllamaCloudApiModel[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = String((row as any).model || (row as any).name || '').trim()
    if (!raw || !SAFE_CLOUD_MODEL_ID.test(raw)) continue
    const model = isOllamaCloudModelId(raw) ? raw : ollamaCloudModelId(raw)
    const key = normalizeOllamaModelKey(model)
    if (!model || seen.has(key)) continue
    seen.add(key)
    const contextLength = positiveInteger(
      (row as any).details?.context_length ?? (row as any).context_length
    )
    models.push({ model, ...(contextLength ? { contextLength } : {}) })
  }
  return models
}

export async function fetchOllamaCloudApiCatalog(
  apiKey: string,
  options: OllamaCloudApiOptions = {}
): Promise<OllamaCloudApiCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? 1_500)
  try {
    const baseUrl = String(options.baseUrl || OLLAMA_CLOUD_API_BASE_URL).replace(/\/+$/, '')
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
      headers: ollamaCloudApiHeaders(apiKey)
    })
    let value: unknown = null
    if (response.ok) {
      try {
        value = await response.json()
      } catch {
        value = null
      }
    }
    return {
      reachable: true,
      ok: response.ok,
      status: response.status,
      models: response.ok ? normalizeOllamaCloudApiModels(value) : []
    }
  } catch {
    return { reachable: false, ok: false, status: 0, models: [] }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
