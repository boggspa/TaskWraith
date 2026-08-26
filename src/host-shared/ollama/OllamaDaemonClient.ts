/**
 * Node-pure Ollama daemon HTTP client.
 *
 * Adapted from src/main/ollama/OllamaProvider.ts (fetchOllamaLocalModels at
 * 1108-1126, ollamaChatTransport at 3100-3146) and src/main/ollama/OllamaCloudApi.ts
 * (headers/base URL). Desktop reuse is a named follow-up.
 *
 * This module owns the raw daemon/HTTP seam for the pure-Node Host: model
 * listing, model show, chat completion with streaming, and unload. It carries
 * no Electron/AppStore/WebContents dependencies.
 */

export const OLLAMA_CLOUD_API_BASE_URL = 'https://ollama.com'
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

const OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS = [250, 750, 2_000] as const
const SAFE_CLOUD_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/

export interface OllamaModelInfo {
  id: string
  label: string
  description?: string
  source: 'local' | 'cloud'
  isCloud: boolean
  installed: boolean
  isDefault: boolean
  disabled?: boolean
  disabledReason?: string
  contextLength?: number
  maxOutputTokens?: number
  requiredPlan?: string
}

export interface OllamaTagsResponse {
  models?: Array<{
    name: string
    model: string
    modified_at?: string
    size?: number
    digest?: string
    details?: {
      family?: string
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

export interface OllamaModelShowResponse {
  license?: string
  modelfile?: string
  parameters?: string
  template?: string
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
  model_info?: Record<string, unknown>
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  tool_name?: string
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaChatMessage[]
  stream?: boolean
  format?: 'json' | Record<string, unknown>
  options?: {
    temperature?: number
    num_ctx?: number
    num_predict?: number
  }
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

export interface OllamaChatChunk {
  model: string
  created_at: string
  message?: {
    role: string
    content: string
    tool_calls?: Array<{
      function: {
        name: string
        arguments: Record<string, unknown>
      }
    }>
  }
  done: boolean
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface OllamaChatCompletion {
  model: string
  created_at: string
  message: {
    role: string
    content: string
    tool_calls?: Array<{
      function: {
        name: string
        arguments: Record<string, unknown>
      }
    }>
  }
  done: boolean
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

function normalizeOllamaBaseUrl(baseUrl: string | null | undefined): string {
  const raw = String(baseUrl || DEFAULT_OLLAMA_BASE_URL).trim()
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

function endpoint(baseUrl: string, path: string): string {
  return `${normalizeOllamaBaseUrl(baseUrl)}${path}`
}

function ollamaCloudApiHeaders(
  apiKey: string,
  options: { json?: boolean } = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(options.json ? { 'content-type': 'application/json' } : {})
  }
}

function humanizeOllamaModelId(modelId: string): string {
  const base = modelId.replace(/^ollama\//, '').replace(/:latest$/, '')
  return base
    .split(/[-:]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function isOllamaTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket') ||
    message.includes('abort')
  )
}

async function waitForOllamaRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error('Ollama transport launch was aborted.')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Ollama transport launch was aborted.'))
      },
      { once: true }
    )
  })
}

function assertOllamaTransportLaunchAuthorized(
  signal: AbortSignal,
  launchAuthorized?: () => boolean
): void {
  if (signal.aborted) throw new Error('Ollama transport launch was aborted.')
  if (launchAuthorized && !launchAuthorized()) {
    throw new Error('Ollama transport launch was not authorized.')
  }
}

/** List local models from the Ollama daemon. */
export async function fetchOllamaLocalModels(
  baseUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OllamaModelInfo[]> {
  const timeoutMs = options.timeoutMs ?? 3_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal || controller.signal
  try {
    const response = await fetch(endpoint(baseUrl, '/api/tags'), { signal })
    if (!response.ok) {
      throw new Error(`Ollama model list failed with HTTP ${response.status}.`)
    }
    const json = (await response.json()) as OllamaTagsResponse
    return (json.models ?? []).map((entry) => {
      const id = entry.model || entry.name
      return {
        id,
        label: humanizeOllamaModelId(id),
        source: 'local' as const,
        isCloud: false,
        installed: true,
        isDefault: false,
        ...(entry.details?.family ? { description: entry.details.family } : {})
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch model show metadata from the daemon. */
export async function fetchOllamaModelShow(
  baseUrl: string,
  model: string,
  options: { signal?: AbortSignal; apiKey?: string | null } = {}
): Promise<OllamaModelShowResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`
  }
  const response = await fetch(endpoint(baseUrl, '/api/show'), {
    method: 'POST',
    signal: options.signal,
    headers,
    body: JSON.stringify({ model })
  })
  if (!response.ok) {
    throw new Error(`Ollama model show failed with HTTP ${response.status}.`)
  }
  return (await response.json()) as OllamaModelShowResponse
}

/** Discover Ollama Cloud models when an API key is available. */
export async function discoverOllamaCloud(
  apiKey: string,
  options: { signal?: AbortSignal } = {}
): Promise<{
  supported: boolean
  enabled: boolean
  authenticated: boolean | null
  models: OllamaModelInfo[]
}> {
  if (!SAFE_CLOUD_MODEL_ID.test(apiKey)) {
    return { supported: false, enabled: true, authenticated: null, models: [] }
  }
  try {
    const response = await fetch(endpoint(OLLAMA_CLOUD_API_BASE_URL, '/api/tags'), {
      signal: options.signal,
      headers: ollamaCloudApiHeaders(apiKey)
    })
    if (!response.ok) {
      return { supported: true, enabled: true, authenticated: false, models: [] }
    }
    const json = (await response.json()) as OllamaTagsResponse
    const models = (json.models ?? []).map((entry) => {
      const id = entry.model || entry.name
      return {
        id,
        label: humanizeOllamaModelId(id),
        source: 'cloud' as const,
        isCloud: true,
        installed: false,
        isDefault: false
      }
    })
    return { supported: true, enabled: true, authenticated: true, models }
  } catch {
    return { supported: true, enabled: true, authenticated: null, models: [] }
  }
}

/** Merge local and cloud model lists into a single catalog. */
export function mergeOllamaLocalAndCloudModels(
  localModels: readonly OllamaModelInfo[],
  cloud: {
    supported: boolean
    enabled: boolean
    authenticated: boolean | null
    models: OllamaModelInfo[]
  },
  defaultModel?: string | null,
  localState: { reachable?: boolean; error?: string } = {}
): {
  models: OllamaModelInfo[]
  localModels: OllamaModelInfo[]
  cloudModels: OllamaModelInfo[]
  cloud: typeof cloud
  localReachable: boolean
  localError?: string
} {
  const byKey = new Map<string, OllamaModelInfo>()
  const cloudModels = cloud.models.map((model) => ({
    ...model,
    disabled: cloud.authenticated !== true,
    ...(cloud.authenticated === false
      ? { disabledReason: 'Sign in with `ollama signin` or add an Ollama Cloud API key.' }
      : cloud.authenticated === null
        ? { disabledReason: 'Ollama Cloud account status is unavailable.' }
        : {})
  }))
  for (const model of [...cloudModels, ...localModels]) {
    const key = model.id.toLowerCase()
    const previous = byKey.get(key)
    byKey.set(key, previous ? { ...previous, ...model } : { ...model })
  }
  const models = [...byKey.values()]
  const configuredDefault = String(defaultModel || '')
    .trim()
    .toLowerCase()
  const defaultId =
    (configuredDefault
      ? models.find((model) => model.id.toLowerCase() === configuredDefault)?.id
      : '') ||
    models.find((model) => model.source === 'local' && model.isDefault)?.id ||
    models.find((model) => !model.disabled)?.id
  for (const model of models) model.isDefault = Boolean(defaultId && model.id === defaultId)
  return {
    models,
    localModels: models.filter((model) => model.source !== 'cloud'),
    cloudModels: models.filter((model) => model.source === 'cloud'),
    cloud,
    localReachable: localState.reachable !== false,
    ...(localState.error ? { localError: localState.error } : {})
  }
}

/** Fetch the full model catalog (local + cloud). */
export async function fetchOllamaModelCatalog(
  baseUrl: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    launchAuthorized?: () => boolean
    cloudApiKey?: string | null
    defaultModel?: string | null
  } = {}
): Promise<ReturnType<typeof mergeOllamaLocalAndCloudModels>> {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl)
  let localModels: OllamaModelInfo[] = []
  let localReachable = true
  let localError = ''
  try {
    localModels = await fetchOllamaLocalModels(normalizedBaseUrl, options)
  } catch (error) {
    localReachable = false
    localError = error instanceof Error ? error.message : String(error)
    if (!options.cloudApiKey) throw error
  }
  const cloud =
    options.signal?.aborted || options.launchAuthorized?.() === false
      ? { supported: false, enabled: true, authenticated: null, models: [] }
      : options.cloudApiKey
        ? await discoverOllamaCloud(options.cloudApiKey, { signal: options.signal })
        : { supported: false, enabled: true, authenticated: null, models: [] }
  return mergeOllamaLocalAndCloudModels(localModels, cloud, options.defaultModel, {
    reachable: localReachable,
    error: localError
  })
}

/** Stream a chat completion from the Ollama daemon. */
export async function* ollamaChatTransport(input: {
  baseUrl: string
  apiKey?: string | null
  signal: AbortSignal
  request: OllamaChatRequest
  launchAuthorized?: () => boolean
  onRetry?: (input: {
    attempt: number
    maxAttempts: number
    delayMs: number
    error: string
  }) => void
}): AsyncGenerator<OllamaChatChunk, void, unknown> {
  const maxAttempts = OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      assertOllamaTransportLaunchAuthorized(input.signal, input.launchAuthorized)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (input.apiKey) {
        headers.authorization = `Bearer ${input.apiKey}`
      }
      const response = await fetch(endpoint(input.baseUrl, '/api/chat'), {
        method: 'POST',
        signal: input.signal,
        headers,
        body: JSON.stringify(input.request)
      })
      if (!response.ok) {
        throw new Error(`Ollama chat failed with HTTP ${response.status}.`)
      }
      if (!response.body) {
        throw new Error('Ollama chat response has no body.')
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (!line) continue
            try {
              const chunk = JSON.parse(line) as OllamaChatChunk
              yield chunk
            } catch {
              // Skip malformed lines.
            }
          }
        }
        if (buffer.trim()) {
          try {
            const chunk = JSON.parse(buffer.trim()) as OllamaChatChunk
            yield chunk
          } catch {
            // Skip malformed trailing data.
          }
        }
      } finally {
        reader.releaseLock()
      }
      return
    } catch (error) {
      lastError = error
      const retryDelay = OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS[attempt - 1]
      if (
        attempt >= maxAttempts ||
        retryDelay === undefined ||
        input.signal.aborted ||
        !isOllamaTransportError(error)
      ) {
        throw error
      }
      input.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: retryDelay,
        error: error instanceof Error ? error.message : String(error)
      })
      await waitForOllamaRetry(retryDelay, input.signal)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'Ollama fetch failed.'))
}

/** Non-streaming chat completion for simple use cases. */
export async function ollamaChatCompletion(input: {
  baseUrl: string
  apiKey?: string | null
  signal: AbortSignal
  request: Omit<OllamaChatRequest, 'stream'>
}): Promise<OllamaChatCompletion> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.apiKey) {
    headers.authorization = `Bearer ${input.apiKey}`
  }
  const response = await fetch(endpoint(input.baseUrl, '/api/chat'), {
    method: 'POST',
    signal: input.signal,
    headers,
    body: JSON.stringify({ ...input.request, stream: false })
  })
  if (!response.ok) {
    throw new Error(`Ollama chat failed with HTTP ${response.status}.`)
  }
  return (await response.json()) as OllamaChatCompletion
}

/** Unload a model from the Ollama daemon. */
export async function unloadOllamaModel(
  baseUrl: string,
  model: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  try {
    const response = await fetch(endpoint(baseUrl, '/api/generate'), {
      method: 'POST',
      signal: options.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 })
    })
    if (!response.ok) {
      // Best-effort unload; ignore failures.
    }
  } catch {
    // Best-effort unload; ignore failures.
  }
}
