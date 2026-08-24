import type { ProviderId } from '../store/types'
import {
  ULTRATASK_REQUIRED_STAGES,
  type UltraTaskAvailability,
  type UltraTaskRouteCandidate
} from './UltraTaskCapabilityResolver'
import {
  buildUltraTaskModelCapabilityCatalog,
  materializeDiscoveredUltraTaskSupport,
  mergeUltraTaskCatalogCapabilityMetadata,
  type UltraTaskCatalogModelLike,
  type UltraTaskModelRuntimeEvidence
} from './UltraTaskModelCatalog'
import {
  auditionUltraTaskModels,
  type UltraTaskAuditionRate,
  type UltraTaskModelAuditionResult,
  type UltraTaskQuotaPoolSnapshot
} from './UltraTaskModelAudition'
import { resolveUltraTaskQuotaBinding } from './UltraTaskQuotaBindings'

export const ULTRA_TASK_OPTIONS_SCHEMA_VERSION = 1 as const
export const ULTRA_TASK_OPTIONS_MAX_PROVIDERS = 16
export const ULTRA_TASK_OPTIONS_MAX_MODELS_PER_PROVIDER = 256

export interface UltraTaskOptionsRate extends UltraTaskAuditionRate {
  provider: ProviderId
  modelId: string
}

export interface UltraTaskOptionsProviderInput {
  provider: ProviderId
  configured: boolean
  models: readonly UltraTaskCatalogModelLike[]
  fallbackModels?: readonly UltraTaskCatalogModelLike[]
  source: 'live' | 'static' | 'user'
  runtimeEvidence?: Readonly<Record<string, UltraTaskModelRuntimeEvidence>>
  routes: readonly UltraTaskRouteCandidate[]
}

export interface BuildUltraTaskOptionsInput {
  providers: readonly UltraTaskOptionsProviderInput[]
  quotaPools?: readonly UltraTaskQuotaPoolSnapshot[]
  rates?: readonly UltraTaskOptionsRate[]
  expectedInputTokens?: number
  expectedOutputTokens?: number
}

export interface UltraTaskOptionsResult extends UltraTaskModelAuditionResult {
  schemaVersion: typeof ULTRA_TASK_OPTIONS_SCHEMA_VERSION
  truncated: boolean
}

function completeRouteAvailability(
  routes: readonly UltraTaskRouteCandidate[]
): UltraTaskAvailability {
  const required = new Set(ULTRATASK_REQUIRED_STAGES)
  const complete = routes.filter((route) => {
    const stages = new Set(route.stages)
    return [...required].every((stage) => stages.has(stage))
  })
  if (complete.some((route) => route.availability === 'available')) return 'available'
  if (complete.some((route) => route.availability === 'unknown')) return 'unknown'
  return 'unavailable'
}

/**
 * Compose the read-only model/options view consumed by prospective callers.
 * Every join key is exact provider+model or exact quota-pool id. This service
 * performs no discovery, fetching, persistence, provider launch, or fallback
 * selection; callers supply evidence and receive a deterministic projection.
 */
export function buildUltraTaskOptions(input: BuildUltraTaskOptionsInput): UltraTaskOptionsResult {
  const providers = input.providers.slice(0, ULTRA_TASK_OPTIONS_MAX_PROVIDERS)
  const ratesByModel = new Map(
    (input.rates ?? []).map((rate) => [`${rate.provider}\0${rate.modelId}`, rate] as const)
  )
  let truncated = input.providers.length > providers.length
  const candidates = providers.flatMap((providerInput) => {
    const boundedModels = providerInput.models.slice(0, ULTRA_TASK_OPTIONS_MAX_MODELS_PER_PROVIDER)
    if (providerInput.models.length > boundedModels.length) truncated = true
    const merged = mergeUltraTaskCatalogCapabilityMetadata(
      boundedModels,
      providerInput.fallbackModels
    )
    const materialized =
      providerInput.source === 'live'
        ? materializeDiscoveredUltraTaskSupport(providerInput.provider, merged)
        : merged
    const catalog = buildUltraTaskModelCapabilityCatalog({
      provider: providerInput.provider,
      models: materialized,
      source: providerInput.source,
      ...(providerInput.runtimeEvidence ? { runtimeEvidence: providerInput.runtimeEvidence } : {})
    })
    const routeAvailability = completeRouteAvailability(providerInput.routes)
    return catalog.map((model) => {
      const rate = ratesByModel.get(`${model.provider}\0${model.modelId}`)
      return {
        provider: model.provider,
        modelId: model.modelId,
        label: model.label,
        configured: providerInput.configured,
        ultraTaskSupported: model.ultraTaskSupported,
        runtimeAvailability: model.runtimeAvailability,
        routeAvailability,
        quotaBinding: resolveUltraTaskQuotaBinding(model.provider, model.modelId),
        ...(rate
          ? {
              rate: {
                billingBasis: rate.billingBasis,
                inputUsdPerMillion: rate.inputUsdPerMillion,
                outputUsdPerMillion: rate.outputUsdPerMillion
              }
            }
          : {})
      }
    })
  })
  const audition = auditionUltraTaskModels({
    candidates,
    ...(input.quotaPools ? { quotaPools: input.quotaPools } : {}),
    ...(input.expectedInputTokens !== undefined
      ? { expectedInputTokens: input.expectedInputTokens }
      : {}),
    ...(input.expectedOutputTokens !== undefined
      ? { expectedOutputTokens: input.expectedOutputTokens }
      : {})
  })
  const summarizedProviders = new Set(audition.providers.map((provider) => provider.provider))
  const emptyProviders = providers
    .filter((provider) => !summarizedProviders.has(provider.provider))
    .map((provider) => ({
      provider: provider.provider,
      state: provider.configured ? ('unknown' as const) : ('unconfigured' as const),
      candidateCount: 0,
      eligibleCount: 0
    }))
  return {
    schemaVersion: ULTRA_TASK_OPTIONS_SCHEMA_VERSION,
    truncated,
    ...audition,
    providers: [...audition.providers, ...emptyProviders].sort((left, right) =>
      left.provider.localeCompare(right.provider)
    )
  }
}
