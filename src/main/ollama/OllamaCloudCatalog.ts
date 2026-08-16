import {
  isOllamaCloudModelId,
  normalizeOllamaModelKey,
  ollamaCloudBaseModelId
} from '../../shared/ollamaModelAvailability'
import { fetchOllamaCloudApiCatalog } from './OllamaCloudApi'

export interface OllamaCloudModelRecommendation {
  model: string
  description?: string
  contextLength?: number
  maxOutputTokens?: number
  vramBytes?: number
  requiredPlan?: string
}

export interface OllamaCloudDiscoverySnapshot {
  supported: boolean
  enabled: boolean
  authenticated: boolean | null
  plan?: string
  source?: string
  /** A write-only encrypted key is configured for direct ollama.com API requests. */
  apiKeyConfigured?: boolean
  models: OllamaCloudModelRecommendation[]
}

interface OllamaCloudDiscoveryOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
  apiKey?: string | null
}

interface JsonResult {
  reachable: boolean
  ok: boolean
  status: number
  value: unknown
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.trunc(number)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeOllamaCloudRecommendations(
  payload: unknown
): OllamaCloudModelRecommendation[] {
  const recommendations =
    payload && typeof payload === 'object' && Array.isArray((payload as any).recommendations)
      ? (payload as any).recommendations
      : []
  const seen = new Set<string>()
  const models: OllamaCloudModelRecommendation[] = []
  for (const recommendation of recommendations) {
    if (!recommendation || typeof recommendation !== 'object') continue
    const model = optionalString((recommendation as any).model)
    if (!model || !isOllamaCloudModelId(model)) continue
    const key = normalizeOllamaModelKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    const normalized: OllamaCloudModelRecommendation = { model }
    const description = optionalString((recommendation as any).description)
    const contextLength = positiveInteger((recommendation as any).context_length)
    const maxOutputTokens = positiveInteger((recommendation as any).max_output_tokens)
    const vramBytes = positiveInteger((recommendation as any).vram_bytes)
    const requiredPlan = optionalString((recommendation as any).required_plan)
    if (description) normalized.description = description
    if (contextLength) normalized.contextLength = contextLength
    if (maxOutputTokens) normalized.maxOutputTokens = maxOutputTokens
    if (vramBytes) normalized.vramBytes = vramBytes
    if (requiredPlan) normalized.requiredPlan = requiredPlan
    models.push(normalized)
  }
  return models
}

function mergeCloudRecommendations(
  ...sources: readonly OllamaCloudModelRecommendation[][]
): OllamaCloudModelRecommendation[] {
  const byKey = new Map<string, OllamaCloudModelRecommendation>()
  for (const source of sources) {
    for (const model of source) {
      const key = normalizeOllamaModelKey(ollamaCloudBaseModelId(model.model))
      if (!key) continue
      const previous = byKey.get(key)
      byKey.set(key, previous ? { ...previous, ...model } : { ...model })
    }
  }
  return [...byKey.values()]
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: Pick<OllamaCloudDiscoveryOptions, 'signal' | 'timeoutMs'>
): Promise<JsonResult> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? 1_500)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
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
      value
    }
  } catch {
    return { reachable: false, ok: false, status: 0, value: null }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/**
 * Discover the daemon-managed account plus, when the user configured a key,
 * Ollama's direct Cloud catalog. The key is used only as a Bearer header by the
 * dedicated direct-API client and is never projected into this snapshot.
 */
export async function discoverOllamaCloud(
  baseUrl: string,
  options: OllamaCloudDiscoveryOptions = {}
): Promise<OllamaCloudDiscoverySnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch
  const requestOptions = { signal: options.signal, timeoutMs: options.timeoutMs }
  const apiKey = String(options.apiKey || '').trim()
  const [statusResult, accountResult, recommendationsResult, directCatalog] = await Promise.all([
    readJson(fetchImpl, `${baseUrl}/api/status`, { method: 'GET' }, requestOptions),
    readJson(fetchImpl, `${baseUrl}/api/me`, { method: 'POST' }, requestOptions),
    readJson(
      fetchImpl,
      `${baseUrl}/api/experimental/model-recommendations`,
      { method: 'GET' },
      requestOptions
    ),
    apiKey
      ? fetchOllamaCloudApiCatalog(apiKey, {
          fetchImpl,
          signal: options.signal,
          timeoutMs: options.timeoutMs
        })
      : Promise.resolve(null)
  ])

  const statusCloud =
    statusResult.ok && statusResult.value && typeof statusResult.value === 'object'
      ? (statusResult.value as any).cloud
      : null
  const explicitlyDisabled = statusCloud?.disabled === true
  const source = optionalString(statusCloud?.source)
  const authenticated = apiKey
    ? true
    : accountResult.ok
      ? true
      : accountResult.status === 401
        ? false
        : null
  const plan =
    accountResult.ok && accountResult.value && typeof accountResult.value === 'object'
      ? optionalString((accountResult.value as any).plan)
      : undefined
  const supported = Boolean(
    directCatalog?.reachable ||
    statusResult.ok ||
    recommendationsResult.ok ||
    accountResult.ok ||
    accountResult.status === 401
  )
  const daemonModels = normalizeOllamaCloudRecommendations(recommendationsResult.value)
  const directModels: OllamaCloudModelRecommendation[] = (directCatalog?.models || []).map(
    (model) => ({ ...model })
  )
  const enabled = apiKey ? true : !explicitlyDisabled

  return {
    supported,
    enabled,
    authenticated,
    ...(plan ? { plan } : {}),
    ...(source ? { source } : {}),
    ...(apiKey ? { apiKeyConfigured: true } : {}),
    models: enabled ? mergeCloudRecommendations(directModels, daemonModels) : []
  }
}
