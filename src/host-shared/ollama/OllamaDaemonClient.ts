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

import { taskWraithModelLabel } from '../../shared/taskWraithProviderPresentation'
import {
  isOllamaCloudModelId,
  normalizeOllamaModelKey,
  ollamaCloudBaseModelId,
  ollamaCloudModelId,
  ollamaModelIdsMatch
} from '../../shared/ollamaModelAvailability'

export const OLLAMA_CLOUD_API_BASE_URL = 'https://ollama.com'
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

const OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS = [250, 750, 2_000] as const
const SAFE_CLOUD_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/
const MAX_CLOUD_API_KEY_CHARS = 4_096
const PREFERRED_OLLAMA_CLOUD_DEFAULT = 'minimax-m3'

export interface OllamaModelInfo {
  id: string
  label: string
  description?: string
  source: 'local' | 'cloud'
  transport?: 'local-daemon' | 'cloud-daemon' | 'cloud-direct'
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
    remote_host?: string
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

interface OllamaCloudRecommendationResponse {
  recommendations?: Array<{
    model?: unknown
    description?: unknown
    context_length?: unknown
    max_output_tokens?: unknown
    required_plan?: unknown
  }>
}

export interface OllamaCloudDiscoverySnapshot {
  supported: boolean
  enabled: boolean
  authenticated: boolean | null
  plan?: string
  source?: string
  apiKeyConfigured?: boolean
  models: OllamaModelInfo[]
}

interface BoundedJsonResult {
  reachable: boolean
  ok: boolean
  status: number
  value: unknown
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.trunc(number)
}

function isConfiguredCloudApiKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CLOUD_API_KEY_CHARS &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- bearer keys must be one control-free token.
    !/[\s\u0000-\u001f\u007f]/.test(value)
  )
}

async function readJsonWithDeadline(
  url: string,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<BoundedJsonResult> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? 1_500)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    let value: unknown = null
    if (response.ok) {
      try {
        value = await response.json()
      } catch {
        value = null
      }
    }
    return { reachable: true, ok: response.ok, status: response.status, value }
  } catch {
    return { reachable: false, ok: false, status: 0, value: null }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
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
  const curated = taskWraithModelLabel('ollama', modelId)
  if (curated && curated !== modelId) return curated
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
      const cloud = isOllamaCloudModelId(id) || Boolean(entry.remote_host)
      return {
        id,
        label: humanizeOllamaModelId(cloud ? ollamaCloudBaseModelId(id) : id),
        source: cloud ? ('cloud' as const) : ('local' as const),
        transport: cloud ? ('cloud-daemon' as const) : ('local-daemon' as const),
        isCloud: cloud,
        installed: !cloud,
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
  if (!isConfiguredCloudApiKey(apiKey)) {
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
      const id = ollamaCloudModelId(entry.model || entry.name)
      return {
        id,
        label: humanizeOllamaModelId(ollamaCloudBaseModelId(id)),
        source: 'cloud' as const,
        transport: 'cloud-direct' as const,
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

function normalizeDaemonCloudRecommendations(payload: unknown): OllamaModelInfo[] {
  const recommendations =
    payload && typeof payload === 'object'
      ? ((payload as OllamaCloudRecommendationResponse).recommendations ?? [])
      : []
  const seen = new Set<string>()
  const models: OllamaModelInfo[] = []
  for (const recommendation of recommendations) {
    if (!recommendation || typeof recommendation !== 'object') continue
    const raw = optionalString(recommendation.model)
    if (!raw || !SAFE_CLOUD_MODEL_ID.test(raw) || !isOllamaCloudModelId(raw)) continue
    const id = ollamaCloudModelId(raw)
    const key = normalizeOllamaModelKey(id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const description = optionalString(recommendation.description)
    const contextLength = positiveInteger(recommendation.context_length)
    const maxOutputTokens = positiveInteger(recommendation.max_output_tokens)
    const requiredPlan = optionalString(recommendation.required_plan)
    models.push({
      id,
      label: humanizeOllamaModelId(ollamaCloudBaseModelId(id)),
      source: 'cloud',
      transport: 'cloud-daemon',
      isCloud: true,
      installed: false,
      isDefault: false,
      ...(description ? { description } : {}),
      ...(contextLength ? { contextLength } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(requiredPlan ? { requiredPlan } : {})
    })
  }
  return models
}

function mergeCloudModels(...sources: readonly OllamaModelInfo[][]): OllamaModelInfo[] {
  const models = new Map<string, OllamaModelInfo>()
  for (const source of sources) {
    for (const model of source) {
      const key = normalizeOllamaModelKey(ollamaCloudBaseModelId(model.id))
      const previous = models.get(key)
      models.set(key, previous ? { ...previous, ...model } : { ...model })
    }
  }
  return [...models.values()]
}

/**
 * Ask the local daemon for its account state and Cloud recommendations. A
 * recommendation or remote tag is catalog data only: rows become runnable
 * only after `/api/me` proves the daemon is signed in. A direct API key is
 * admitted independently only after ollama.com accepts that key.
 */
export async function discoverOllamaCloudAccount(
  baseUrl: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    cloudApiKey?: string | null
    daemonCloudModels?: readonly OllamaModelInfo[]
  } = {}
): Promise<OllamaCloudDiscoverySnapshot> {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl)
  const requestOptions = { signal: options.signal, timeoutMs: options.timeoutMs }
  const apiKey = String(options.cloudApiKey || '').trim()
  const [status, account, recommendations, direct] = await Promise.all([
    readJsonWithDeadline(
      endpoint(normalizedBaseUrl, '/api/status'),
      { method: 'GET' },
      requestOptions
    ),
    readJsonWithDeadline(
      endpoint(normalizedBaseUrl, '/api/me'),
      { method: 'POST' },
      requestOptions
    ),
    readJsonWithDeadline(
      endpoint(normalizedBaseUrl, '/api/experimental/model-recommendations'),
      { method: 'GET' },
      requestOptions
    ),
    apiKey
      ? discoverOllamaCloud(apiKey, { signal: options.signal })
      : Promise.resolve({
          supported: false,
          enabled: true,
          authenticated: null,
          models: [] as OllamaModelInfo[]
        })
  ])
  const statusCloud =
    status.ok && status.value && typeof status.value === 'object'
      ? (status.value as { cloud?: unknown }).cloud
      : null
  const cloudRecord =
    statusCloud && typeof statusCloud === 'object'
      ? (statusCloud as { disabled?: unknown; source?: unknown })
      : null
  const daemonAuthenticated = account.ok ? true : account.status === 401 ? false : null
  const directAuthenticated = apiKey ? direct.authenticated : null
  const authenticated =
    daemonAuthenticated === true || directAuthenticated === true
      ? true
      : daemonAuthenticated === false && (directAuthenticated === false || !apiKey)
        ? false
        : null
  const enabled = apiKey ? true : cloudRecord?.disabled !== true
  const daemonRecommendations = normalizeDaemonCloudRecommendations(recommendations.value)
  const daemonModels =
    daemonAuthenticated === true && enabled
      ? mergeCloudModels([...(options.daemonCloudModels ?? [])], daemonRecommendations)
      : []
  const directModels = directAuthenticated === true ? direct.models : []
  const accountValue =
    account.ok && account.value && typeof account.value === 'object'
      ? (account.value as { plan?: unknown })
      : null
  const plan = optionalString(accountValue?.plan)
  const source = optionalString(cloudRecord?.source)
  return {
    supported: Boolean(
      direct.supported || status.ok || recommendations.ok || account.ok || account.status === 401
    ),
    enabled,
    authenticated,
    ...(plan ? { plan } : {}),
    ...(source ? { source } : {}),
    ...(apiKey ? { apiKeyConfigured: true } : {}),
    models: enabled ? mergeCloudModels(daemonModels, directModels) : directModels
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
  const preferredCloudDefault =
    cloud.authenticated === true
      ? models.find(
          (model) =>
            model.source === 'cloud' &&
            !model.disabled &&
            normalizeOllamaModelKey(ollamaCloudBaseModelId(model.id)) ===
              PREFERRED_OLLAMA_CLOUD_DEFAULT
        )?.id
      : undefined
  const defaultId =
    (configuredDefault
      ? models.find((model) => ollamaModelIdsMatch(model.id, configuredDefault) && !model.disabled)
          ?.id
      : '') ||
    preferredCloudDefault ||
    models.find((model) => model.source === 'local' && model.isDefault)?.id ||
    models.find((model) => model.source === 'local' && !model.disabled)?.id ||
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
  const daemonCloudModels = localModels.filter((model) => model.source === 'cloud')
  localModels = localModels.filter((model) => model.source !== 'cloud')
  const cloud =
    options.signal?.aborted || options.launchAuthorized?.() === false
      ? { supported: false, enabled: true, authenticated: null, models: [] }
      : await discoverOllamaCloudAccount(normalizedBaseUrl, {
          signal: options.signal,
          timeoutMs: Math.min(options.timeoutMs ?? 3_000, 1_500),
          cloudApiKey: options.cloudApiKey,
          daemonCloudModels
        })
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
