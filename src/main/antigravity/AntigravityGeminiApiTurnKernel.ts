import type { AppSettings } from '../store/types'
import {
  loadOfficialGeminiApiSdk,
  type AntigravityGeminiApiSdkModule
} from './AntigravityGeminiApiModelDiscovery'
import type {
  AntigravityGeminiApiSecretLoadResult,
  AntigravityGeminiApiSecretStore
} from './AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX = 'gemini-api:'
export const MAX_ANTIGRAVITY_GEMINI_API_PROMPT_CHARS = 128 * 1024
export const MAX_ANTIGRAVITY_GEMINI_API_STREAM_TEXT_CHARS = 256 * 1024
export const MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS = 16 * 1024
export const MAX_ANTIGRAVITY_GEMINI_API_USAGE_TOKENS = 10_000_000

const GEMINI_MODEL_ROUTE = /^gemini-api:(gemini-[a-z0-9][a-z0-9._-]{0,127})$/

export type AntigravityGeminiApiTurnStatus =
  | 'ok'
  | 'cancelled'
  | 'disclosureRequired'
  | 'keyUnavailable'
  | 'invalidModel'
  | 'invalidPrompt'
  | 'sdkUnavailable'
  | 'unauthorized'
  | 'rateLimited'
  | 'projectLimited'
  | 'unavailable'
  | 'invalidResponse'
  | 'empty'

export interface AntigravityGeminiApiTurnUsage {
  readonly promptTokenCount?: number
  readonly candidatesTokenCount?: number
  readonly totalTokenCount?: number
}

export type AntigravityGeminiApiTurnResult =
  | {
      readonly status: 'ok'
      readonly model: `${typeof ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX}${string}`
      readonly chunks: number
      readonly textChars: number
      readonly usage?: AntigravityGeminiApiTurnUsage
    }
  | {
      readonly status: Exclude<AntigravityGeminiApiTurnStatus, 'ok'>
      readonly model?: `${typeof ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX}${string}`
      readonly chunks: 0
      readonly textChars: 0
    }

export interface AntigravityGeminiApiTurnRequest {
  readonly model: string
  readonly prompt: string
}

export interface AntigravityGeminiApiTurnClient {
  readonly models: {
    generateContentStream(parameters: {
      readonly model: string
      readonly contents: string
      readonly config?: { readonly abortSignal?: AbortSignal }
    }): Promise<AsyncIterable<unknown>>
  }
}

export interface AntigravityGeminiApiTurnClientConstructor {
  new (options: { readonly apiKey: string }): AntigravityGeminiApiTurnClient
}

export interface AntigravityGeminiApiTurnSdkModule {
  readonly GoogleGenAI?: AntigravityGeminiApiTurnClientConstructor
  readonly default?: {
    readonly GoogleGenAI?: AntigravityGeminiApiTurnClientConstructor
  }
}

export interface AntigravityGeminiApiTurnDependencies {
  readonly secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'>
  readonly loadSdk?: () => Promise<AntigravityGeminiApiTurnSdkModule | null>
  readonly abortSignal?: AbortSignal
  readonly onText: (text: string) => void | Promise<void>
}

/**
 * Main-process-only, one-turn text kernel for the separately billed Gemini API
 * mode. It intentionally has no provider, session, history, tools, media, or
 * usage persistence semantics. Callers must perform this admission again for
 * every turn; discovery results are not treated as authorization.
 */
export async function streamAntigravityGeminiApiTurn(
  settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined,
  request: AntigravityGeminiApiTurnRequest,
  deps: AntigravityGeminiApiTurnDependencies
): Promise<AntigravityGeminiApiTurnResult> {
  const model = parseModelRoute(request.model)
  if (!model) return emptyResult('invalidModel')
  if (!isValidPrompt(request.prompt)) return emptyResult('invalidPrompt', request.model)
  if (deps.abortSignal?.aborted) return emptyResult('cancelled', request.model)
  if (!hasAcceptedDisclosure(settings)) return emptyResult('disclosureRequired', request.model)

  let loadedKey: AntigravityGeminiApiSecretLoadResult
  try {
    loadedKey = deps.secretStore.loadApiKey()
  } catch {
    return emptyResult('keyUnavailable', request.model)
  }
  if (loadedKey.status !== 'ok' || typeof loadedKey.value !== 'string' || !loadedKey.value) {
    return emptyResult('keyUnavailable', request.model)
  }
  if (deps.abortSignal?.aborted) return emptyResult('cancelled', request.model)

  let sdk: AntigravityGeminiApiTurnSdkModule | null
  try {
    sdk = await (deps.loadSdk ?? loadOfficialTurnSdk)()
  } catch {
    return emptyResult('sdkUnavailable', request.model)
  }
  const GoogleGenAI = readSdkConstructor(sdk)
  if (typeof GoogleGenAI !== 'function') return emptyResult('sdkUnavailable', request.model)

  let client: AntigravityGeminiApiTurnClient
  try {
    // Keep the key local to main-process construction. It never enters a
    // settings object, environment, argv, callback, status, or error result.
    client = new GoogleGenAI({ apiKey: loadedKey.value })
  } catch (error) {
    return emptyResult(classifyTurnFailure(error, deps.abortSignal), request.model)
  }

  if (deps.abortSignal?.aborted) return emptyResult('cancelled', request.model)

  let stream: AsyncIterable<unknown>
  try {
    stream = await client.models.generateContentStream({
      model,
      contents: request.prompt,
      config: { abortSignal: deps.abortSignal }
    })
  } catch (error) {
    return emptyResult(classifyTurnFailure(error, deps.abortSignal), request.model)
  }
  if (!isAsyncIterable(stream)) return emptyResult('invalidResponse', request.model)

  let chunks = 0
  let textChars = 0
  let usage: AntigravityGeminiApiTurnUsage | undefined
  try {
    for await (const chunk of stream) {
      if (deps.abortSignal?.aborted) return emptyResult('cancelled', request.model)
      chunks = Math.min(chunks + 1, Number.MAX_SAFE_INTEGER)
      const projectedUsage = projectUsage(chunk)
      if (projectedUsage.status === 'invalid') {
        return emptyResult('invalidResponse', request.model)
      }
      usage = mergeUsage(usage, projectedUsage.usage)
      const chunkText = readChunkText(chunk)
      if (chunkText.status === 'invalid') {
        return emptyResult('invalidResponse', request.model)
      }
      const text = chunkText.text
      if (!text) continue
      const remaining = MAX_ANTIGRAVITY_GEMINI_API_STREAM_TEXT_CHARS - textChars
      if (remaining <= 0) continue
      const bounded = text.slice(
        0,
        Math.min(remaining, MAX_ANTIGRAVITY_GEMINI_API_STREAM_CHUNK_CHARS)
      )
      if (!bounded) continue
      await deps.onText(bounded)
      textChars += bounded.length
    }
  } catch (error) {
    return emptyResult(classifyTurnFailure(error, deps.abortSignal), request.model)
  }

  if (deps.abortSignal?.aborted) return emptyResult('cancelled', request.model)
  if (textChars === 0) return emptyResult('empty', request.model)
  return {
    status: 'ok',
    model: request.model as `${typeof ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX}${string}`,
    chunks,
    textChars,
    ...(usage ? { usage } : {})
  }
}

async function loadOfficialTurnSdk(): Promise<AntigravityGeminiApiTurnSdkModule | null> {
  const sdk: AntigravityGeminiApiSdkModule | null = await loadOfficialGeminiApiSdk()
  return sdk as AntigravityGeminiApiTurnSdkModule | null
}

function parseModelRoute(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = GEMINI_MODEL_ROUTE.exec(value)
  return match?.[1] ?? null
}

function isValidPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ANTIGRAVITY_GEMINI_API_PROMPT_CHARS
  )
}

function hasAcceptedDisclosure(
  settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined
): boolean {
  const acceptedAt = settings?.antigravityGeminiApiDisclosureAcceptedAt
  return typeof acceptedAt === 'number' && Number.isFinite(acceptedAt) && acceptedAt > 0
}

function readChunkText(
  value: unknown
): { status: 'ok'; text: string | null } | { status: 'invalid' } {
  if (!isRecord(value)) return { status: 'invalid' }
  const text = readProperty(value, 'text')
  return text.ok
    ? { status: 'ok', text: typeof text.value === 'string' ? text.value : null }
    : { status: 'invalid' }
}

function projectUsage(
  value: unknown
): { status: 'ok'; usage?: AntigravityGeminiApiTurnUsage } | { status: 'invalid' } {
  if (!isRecord(value)) return { status: 'invalid' }
  const usageMetadata = readProperty(value, 'usageMetadata')
  if (!usageMetadata.ok) return { status: 'invalid' }
  if (!isRecord(usageMetadata.value)) return { status: 'ok' }
  const usage = usageMetadata.value
  const promptTokenCount = readProperty(usage, 'promptTokenCount')
  const candidatesTokenCount = readProperty(usage, 'candidatesTokenCount')
  const totalTokenCount = readProperty(usage, 'totalTokenCount')
  if (!promptTokenCount.ok || !candidatesTokenCount.ok || !totalTokenCount.ok) {
    return { status: 'invalid' }
  }
  const projected: AntigravityGeminiApiTurnUsage = {
    ...(boundedTokenCount(promptTokenCount.value) !== undefined
      ? { promptTokenCount: boundedTokenCount(promptTokenCount.value) }
      : {}),
    ...(boundedTokenCount(candidatesTokenCount.value) !== undefined
      ? { candidatesTokenCount: boundedTokenCount(candidatesTokenCount.value) }
      : {}),
    ...(boundedTokenCount(totalTokenCount.value) !== undefined
      ? { totalTokenCount: boundedTokenCount(totalTokenCount.value) }
      : {})
  }
  return {
    status: 'ok',
    ...(Object.keys(projected).length > 0 ? { usage: projected } : {})
  }
}

function boundedTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ANTIGRAVITY_GEMINI_API_USAGE_TOKENS
    ? value
    : undefined
}

function mergeUsage(
  current: AntigravityGeminiApiTurnUsage | undefined,
  next: AntigravityGeminiApiTurnUsage | undefined
): AntigravityGeminiApiTurnUsage | undefined {
  if (!current) return next
  if (!next) return current
  return {
    ...(next.promptTokenCount !== undefined || current.promptTokenCount !== undefined
      ? { promptTokenCount: next.promptTokenCount ?? current.promptTokenCount }
      : {}),
    ...(next.candidatesTokenCount !== undefined || current.candidatesTokenCount !== undefined
      ? { candidatesTokenCount: next.candidatesTokenCount ?? current.candidatesTokenCount }
      : {}),
    ...(next.totalTokenCount !== undefined || current.totalTokenCount !== undefined
      ? { totalTokenCount: next.totalTokenCount ?? current.totalTokenCount }
      : {})
  }
}

function classifyTurnFailure(
  error: unknown,
  abortSignal: AbortSignal | undefined
): Exclude<
  AntigravityGeminiApiTurnStatus,
  | 'ok'
  | 'disclosureRequired'
  | 'keyUnavailable'
  | 'invalidModel'
  | 'invalidPrompt'
  | 'sdkUnavailable'
  | 'invalidResponse'
  | 'empty'
> {
  if (abortSignal?.aborted) return 'cancelled'
  const name = readProperty(error, 'name')
  if (!name.ok) return 'unavailable'
  if (name.value === 'AbortError') return 'cancelled'

  const status = readNumericCode(error, ['status', 'statusCode'])
  if (status !== null) return classifyStatusCode(status)
  if (isRecord(error)) {
    const response = readProperty(error, 'response')
    if (!response.ok) return 'unavailable'
    const responseStatus = readNumericCode(response.value, ['status', 'statusCode'])
    if (responseStatus !== null) return classifyStatusCode(responseStatus)
  }

  const code = readProperty(error, 'code')
  if (!code.ok) return 'unavailable'
  if (code.value === 'UNAUTHENTICATED' || code.value === 'PERMISSION_DENIED') return 'unauthorized'
  if (code.value === 'RESOURCE_EXHAUSTED') return 'rateLimited'
  if (code.value === 'PROJECT_LIMIT_EXCEEDED' || code.value === 'BILLING_NOT_ENABLED') {
    return 'projectLimited'
  }
  return 'unavailable'
}

function classifyStatusCode(
  status: number
): Exclude<
  AntigravityGeminiApiTurnStatus,
  | 'ok'
  | 'cancelled'
  | 'disclosureRequired'
  | 'keyUnavailable'
  | 'invalidModel'
  | 'invalidPrompt'
  | 'sdkUnavailable'
  | 'invalidResponse'
  | 'empty'
> {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rateLimited'
  if (status === 402) return 'projectLimited'
  return 'unavailable'
}

function readNumericCode(value: unknown, keys: readonly string[]): number | null {
  if (!isRecord(value)) return null
  for (const key of keys) {
    const property = readProperty(value, key)
    if (!property.ok) return null
    if (typeof property.value === 'number' && Number.isInteger(property.value)) {
      return property.value
    }
  }
  return null
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!isRecord(value)) return false
  const iterator = readProperty(value, Symbol.asyncIterator)
  return iterator.ok && typeof iterator.value === 'function'
}

function readSdkConstructor(
  value: AntigravityGeminiApiTurnSdkModule | null
): AntigravityGeminiApiTurnClientConstructor | undefined {
  if (!isRecord(value)) return undefined
  const named = readProperty(value, 'GoogleGenAI')
  if (!named.ok) return undefined
  if (typeof named.value === 'function') {
    return named.value as AntigravityGeminiApiTurnClientConstructor
  }
  const defaultModule = readProperty(value, 'default')
  if (!defaultModule.ok || !isRecord(defaultModule.value)) return undefined
  const defaultConstructor = readProperty(defaultModule.value, 'GoogleGenAI')
  return defaultConstructor.ok && typeof defaultConstructor.value === 'function'
    ? (defaultConstructor.value as AntigravityGeminiApiTurnClientConstructor)
    : undefined
}

function readProperty(
  value: unknown,
  key: PropertyKey
): { ok: true; value: unknown } | { ok: false } {
  if (!isRecord(value)) return { ok: false }
  try {
    return { ok: true, value: Reflect.get(value, key) }
  } catch {
    return { ok: false }
  }
}

function emptyResult(
  status: Exclude<AntigravityGeminiApiTurnStatus, 'ok'>,
  model?: string
): AntigravityGeminiApiTurnResult {
  return {
    status,
    ...(typeof model === 'string' && model.startsWith(ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX)
      ? { model: model as `${typeof ANTIGRAVITY_GEMINI_API_TURN_MODEL_PREFIX}${string}` }
      : {}),
    chunks: 0,
    textChars: 0
  }
}

function isRecord(value: unknown): value is Record<string | symbol, any> {
  return value !== null && typeof value === 'object'
}
