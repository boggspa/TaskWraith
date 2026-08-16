import type { AppSettings } from '../store/types'
import type { AntigravityGeminiApiSecretStore } from './AntigravityGeminiApiSecretStore'

export const ANTIGRAVITY_GEMINI_API_MODEL_PREFIX = 'gemini-api:'
export const MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES = 3
export const MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS = 64

const DISCOVERY_PAGE_SIZE = 32
const GEMINI_MODEL_ID = /^gemini-[a-z0-9][a-z0-9._-]{0,127}$/
const GENERATE_CAPABLE_ACTIONS = new Set(['generateContent', 'generateContentStream'])

/**
 * Ids `models.list` still advertises as generate-capable but which 404 on the
 * first call with "no longer available to new users". Google expresses that
 * retirement NOWHERE in the listing — `supportedGenerationMethods` still names
 * generateContent — so the capability filter below cannot catch them and the
 * picker offers a model that cannot run.
 *
 * EVIDENCE-BASED, NOT A FAMILY RULE. Each id here was observed returning 404
 * against a real key (2026-07-26), so "the 2.5 family is retired" would be
 * wrong — `gemini-2.5-pro` is deliberately absent from this set.
 *
 * ONLY A 404 BELONGS HERE. A 429 is never grounds for removal, and its detail
 * says which of two very different things is happening:
 *   - `quotaValue > 0` (e.g. gemini-3.5-flash, limit 5,
 *     GenerateRequestsPerMinutePerProjectPerModel-FreeTier) — an ordinary
 *     per-minute throttle that clears in under a minute; Google even returns a
 *     `retryDelay`. Says nothing about the model.
 *   - `quotaValue == 0` (gemini-2.5-pro, the -tts and -image variants) — the
 *     model has NO free-tier allowance. It is not throttled and not retired; it
 *     works on a billing-enabled project. Pruning these would hide models a paid
 *     key can use, which is why they stay.
 * If Google revives a listed id, delete the entry.
 */
const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
])

/**
 * Variants whose OUTPUT modality this adapter cannot drive. The `-tts` and
 * `-image` families advertise generateContent, so the capability filter admits
 * them, but the turn kernel sets no `responseModalities` and no `speechConfig`
 * — it builds a text/tool turn and nothing else. Offering them puts a model in
 * the coding picker that cannot answer a coding request.
 *
 * This is a MODALITY rule, not a quota one. The note above about `quotaValue
 * == 0` still stands: a model with no free-tier allowance stays, because it
 * runs fine on a billing-enabled key. These are excluded because the adapter
 * structurally cannot consume what they return, which no key changes.
 *
 * Matched on OUTPUT only. `-vision` is an INPUT modality whose response is
 * ordinary text, so it is deliberately absent — filtering on "multimodal"
 * would drop models this lane runs perfectly well.
 */
const NON_TEXT_OUTPUT_MODEL_ID = /(?:^|-)(?:tts|image)(?:-|$)/

export interface AntigravityGeminiApiDiscoveredModel {
  /** Namespaced route token. It must never be mistaken for an official agy model ID. */
  readonly id: `${typeof ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}${string}`
  /** The dynamic Gemini API model ID returned by the authenticated official SDK. */
  readonly modelId: string
}

export type AntigravityGeminiApiDiscoveryStatus =
  | 'ok'
  | 'cancelled'
  | 'disclosureRequired'
  | 'keyUnavailable'
  | 'sdkUnavailable'
  | 'unauthorized'
  | 'rateLimited'
  | 'projectLimited'
  | 'unavailable'
  | 'invalidResponse'
  | 'empty'

export type AntigravityGeminiApiDiscoveryResult =
  | {
      readonly status: 'ok'
      readonly models: readonly AntigravityGeminiApiDiscoveredModel[]
    }
  | {
      readonly status: Exclude<AntigravityGeminiApiDiscoveryStatus, 'ok'>
      readonly models: readonly []
    }

export interface AntigravityGeminiApiListModel {
  readonly name?: unknown
  readonly supportedActions?: unknown
  /** Gemini API responses from older SDK shapes use this name. */
  readonly supportedGenerationMethods?: unknown
}

export interface AntigravityGeminiApiModelPager {
  readonly page: readonly AntigravityGeminiApiListModel[]
  hasNextPage(): boolean
  nextPage(): Promise<readonly AntigravityGeminiApiListModel[]>
}

export interface AntigravityGeminiApiClient {
  readonly models: {
    list(parameters: {
      readonly config: {
        readonly abortSignal?: AbortSignal
        readonly pageSize: number
        readonly queryBase: true
      }
    }): Promise<AntigravityGeminiApiModelPager>
  }
}

export interface AntigravityGeminiApiClientConstructor {
  new (options: { readonly apiKey: string }): AntigravityGeminiApiClient
}

export interface AntigravityGeminiApiSdkModule {
  readonly GoogleGenAI?: AntigravityGeminiApiClientConstructor
  readonly default?: {
    readonly GoogleGenAI?: AntigravityGeminiApiClientConstructor
  }
}

export interface AntigravityGeminiApiModelDiscoveryDependencies {
  readonly secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'>
  /** Test seam only; production uses the official SDK dynamic loader below. */
  readonly loadSdk?: () => Promise<AntigravityGeminiApiSdkModule | null>
  readonly abortSignal?: AbortSignal
}

/**
 * Main-process-only authenticated discovery for the separately billed Gemini
 * API mode. This deliberately does not call agy, inspect OAuth/keyring state,
 * reuse retired Gemini profiles, or wire a provider run. A later S4 owner may
 * consume its nonsecret output only after applying its own admission checks.
 */
export async function discoverAuthenticatedAntigravityGeminiApiModels(
  settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined,
  deps: AntigravityGeminiApiModelDiscoveryDependencies
): Promise<AntigravityGeminiApiDiscoveryResult> {
  if (deps.abortSignal?.aborted) return emptyResult('cancelled')
  if (!hasAcceptedGeminiApiDisclosure(settings)) return emptyResult('disclosureRequired')

  let loadedKey: ReturnType<AntigravityGeminiApiSecretStore['loadApiKey']>
  try {
    loadedKey = deps.secretStore.loadApiKey()
  } catch {
    return emptyResult('keyUnavailable')
  }
  if (loadedKey.status !== 'ok' || typeof loadedKey.value !== 'string' || !loadedKey.value) {
    return emptyResult('keyUnavailable')
  }

  let sdk: AntigravityGeminiApiSdkModule | null
  try {
    sdk = await (deps.loadSdk ?? loadOfficialGeminiApiSdk)()
  } catch {
    return emptyResult('sdkUnavailable')
  }
  const GoogleGenAI = sdk?.GoogleGenAI ?? sdk?.default?.GoogleGenAI
  if (typeof GoogleGenAI !== 'function') return emptyResult('sdkUnavailable')

  let client: AntigravityGeminiApiClient
  try {
    // The key is intentionally local to this main-process scope. Never place it
    // in a settings object, environment, argv, error, status, or return value.
    client = new GoogleGenAI({ apiKey: loadedKey.value })
  } catch (error) {
    return emptyResult(classifyDiscoveryFailure(error, deps.abortSignal))
  }

  try {
    const pager = await client.models.list({
      config: {
        abortSignal: deps.abortSignal,
        pageSize: DISCOVERY_PAGE_SIZE,
        queryBase: true
      }
    })
    if (!isModelPager(pager)) return emptyResult('invalidResponse')

    const discovered = new Map<string, AntigravityGeminiApiDiscoveredModel>()
    let page: readonly AntigravityGeminiApiListModel[] = pager.page
    for (
      let pageIndex = 0;
      pageIndex < MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES;
      pageIndex += 1
    ) {
      if (deps.abortSignal?.aborted) return emptyResult('cancelled')
      if (!Array.isArray(page)) return emptyResult('invalidResponse')

      for (const model of page) {
        const discoveredModel = normalizeGenerateCapableGeminiModel(model)
        if (!discoveredModel || discovered.has(discoveredModel.modelId)) continue
        discovered.set(discoveredModel.modelId, discoveredModel)
        if (discovered.size >= MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS) break
      }

      if (
        pageIndex + 1 >= MAX_ANTIGRAVITY_GEMINI_API_DISCOVERY_PAGES ||
        discovered.size >= MAX_ANTIGRAVITY_GEMINI_API_DISCOVERED_MODELS ||
        !pager.hasNextPage()
      ) {
        break
      }
      page = await pager.nextPage()
    }

    const models = [...discovered.values()]
    return models.length > 0 ? { status: 'ok', models } : emptyResult('empty')
  } catch (error) {
    return emptyResult(classifyDiscoveryFailure(error, deps.abortSignal))
  }
}

/**
 * Dynamically loads the already-packaged official SDK only from main. The
 * literal specifier is intentional: electron-vite must see and preserve the
 * official dependency in the production main bundle. This function remains
 * the single loader shared by discovery and turn execution.
 */
export async function loadOfficialGeminiApiSdk(): Promise<AntigravityGeminiApiSdkModule | null> {
  try {
    const module = await import('@google/genai')
    return isRecord(module) ? (module as AntigravityGeminiApiSdkModule) : null
  } catch {
    return null
  }
}

function hasAcceptedGeminiApiDisclosure(
  settings: Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'> | null | undefined
): boolean {
  const acceptedAt = settings?.antigravityGeminiApiDisclosureAcceptedAt
  return typeof acceptedAt === 'number' && Number.isFinite(acceptedAt) && acceptedAt > 0
}

function normalizeGenerateCapableGeminiModel(
  value: AntigravityGeminiApiListModel
): AntigravityGeminiApiDiscoveredModel | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null
  const name = value.name.trim()
  if (name !== value.name || !name.startsWith('models/')) return null
  const modelId = name.slice('models/'.length)
  if (!GEMINI_MODEL_ID.test(modelId) || !hasGenerateCapability(value)) return null
  if (RETIRED_MODEL_IDS.has(modelId)) return null
  if (NON_TEXT_OUTPUT_MODEL_ID.test(modelId)) return null
  return {
    id: `${ANTIGRAVITY_GEMINI_API_MODEL_PREFIX}${modelId}`,
    modelId
  }
}

function hasGenerateCapability(value: AntigravityGeminiApiListModel): boolean {
  const actions = [value.supportedActions, value.supportedGenerationMethods]
    .filter(Array.isArray)
    .flat()
  return actions.some(
    (action) => typeof action === 'string' && GENERATE_CAPABLE_ACTIONS.has(action)
  )
}

function isModelPager(value: unknown): value is AntigravityGeminiApiModelPager {
  return (
    isRecord(value) &&
    Array.isArray(value.page) &&
    typeof value.hasNextPage === 'function' &&
    typeof value.nextPage === 'function'
  )
}

function classifyDiscoveryFailure(
  error: unknown,
  abortSignal: AbortSignal | undefined
): Exclude<
  AntigravityGeminiApiDiscoveryStatus,
  'ok' | 'disclosureRequired' | 'keyUnavailable' | 'sdkUnavailable' | 'invalidResponse' | 'empty'
> {
  if (abortSignal?.aborted || (isRecord(error) && error.name === 'AbortError')) return 'cancelled'

  const status =
    readNumericErrorCode(error, ['status', 'statusCode']) ??
    (isRecord(error) ? readNumericErrorCode(error.response, ['status', 'statusCode']) : null)
  if (status === 401 || status === 403) return 'unauthorized'
  // Google rejects a bad API key with 400 INVALID_ARGUMENT / API_KEY_INVALID,
  // not 401 (verified against the live endpoint). Only the classification
  // reads the message; the raw text never leaves this function.
  if (status === 400 && isApiKeyInvalidError(error)) return 'unauthorized'
  if (status === 429) return 'rateLimited'
  if (status === 402) return 'projectLimited'

  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null
  if (code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED') return 'unauthorized'
  if (code === 'RESOURCE_EXHAUSTED') return 'rateLimited'
  if (code === 'PROJECT_LIMIT_EXCEEDED' || code === 'BILLING_NOT_ENABLED') return 'projectLimited'
  return 'unavailable'
}

/** Detects Google's key-rejection shape without ever surfacing the text. */
export function isApiKeyInvalidError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const message = typeof error.message === 'string' ? error.message : ''
  return /API_KEY_INVALID|API key not valid/i.test(message)
}

function readNumericErrorCode(value: unknown, keys: readonly string[]): number | null {
  if (!isRecord(value)) return null
  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isInteger(value[key])) return value[key] as number
  }
  return null
}

function emptyResult(
  status: Exclude<AntigravityGeminiApiDiscoveryStatus, 'ok'>
): AntigravityGeminiApiDiscoveryResult {
  return { status, models: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
