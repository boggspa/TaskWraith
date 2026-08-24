import type { ProviderId } from '../store/types'

export const ULTRATASK_CAPABILITY_SCHEMA_VERSION = 1 as const

export const ULTRATASK_REQUIRED_STAGES = Object.freeze([
  'scout',
  'join',
  'worker',
  'worker_artifact',
  'reviewer_after_worker',
  'synthesis'
] as const)

export type UltraTaskRequiredStage = (typeof ULTRATASK_REQUIRED_STAGES)[number]

export type UltraTaskRouteKind = 'execution_graph' | 'taskwraith_delegation' | 'provider_native'

export type UltraTaskAvailability = 'available' | 'unknown' | 'unavailable'

export interface UltraTaskReasoningCapability {
  /** `configurable` has a concrete provider-valid ceiling; `fixed` means the
   * model already runs at its only reasoning setting; `none` has no reasoning
   * axis but may still support the orchestration contract. */
  mode: 'configurable' | 'fixed' | 'none'
  ceiling?: string
  supported?: readonly string[]
}

export interface UltraTaskModelCapabilityCandidate {
  provider: ProviderId
  modelId: string
  label: string
  /** Must be explicit. Missing metadata is not evidence of support. */
  ultraTaskSupported: boolean
  runtimeAvailability: UltraTaskAvailability
  runtimeUnavailableReason?: string
  reasoning: UltraTaskReasoningCapability
  /** `live` includes provider-discovered and locally installed models. */
  source: 'live' | 'static' | 'user'
}

export interface UltraTaskRouteCandidate {
  id: string
  kind: UltraTaskRouteKind
  availability: UltraTaskAvailability
  unavailableReason?: string
  /** Lower values win. Route selection never changes the selected model. */
  priority: number
  stages: readonly UltraTaskRequiredStage[]
}

export interface ResolveUltraTaskCapabilityInput {
  provider: ProviderId
  modelId?: string | null
  models: readonly UltraTaskModelCapabilityCandidate[]
  routes: readonly UltraTaskRouteCandidate[]
}

export interface UltraTaskModelOption {
  provider: ProviderId
  modelId: string
  label: string
  ultraTaskSupported: boolean
  runtimeAvailability: UltraTaskAvailability
  reasoning: UltraTaskReasoningCapability
  source: UltraTaskModelCapabilityCandidate['source']
  reason?: string
}

export interface ResolvedUltraTaskCapability {
  schemaVersion: typeof ULTRATASK_CAPABILITY_SCHEMA_VERSION
  provider: ProviderId
  modelId: string
  modelLabel: string
  modelSource: UltraTaskModelCapabilityCandidate['source']
  reasoning: UltraTaskReasoningCapability
  route: {
    id: string
    kind: UltraTaskRouteKind
    stages: readonly UltraTaskRequiredStage[]
  }
}

export type UltraTaskCapabilityErrorCode =
  | 'model_required'
  | 'model_unknown'
  | 'model_ambiguous'
  | 'model_unsupported'
  | 'model_unavailable'
  | 'model_runtime_unknown'
  | 'invalid_reasoning_capability'
  | 'route_unavailable'
  | 'route_runtime_unknown'
  | 'route_incomplete'

export type UltraTaskCapabilityResolution =
  | { ok: true; capability: ResolvedUltraTaskCapability }
  | {
      ok: false
      code: UltraTaskCapabilityErrorCode
      message: string
      models: UltraTaskModelOption[]
      route?: {
        id: string
        kind: UltraTaskRouteKind
        missingStages: UltraTaskRequiredStage[]
      }
    }

const FORBIDDEN_MODEL_SENTINELS = new Set(['cli-default', 'default', 'custom'])

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isConcreteUltraTaskModelId(value: unknown): value is string {
  const modelId = normalizedText(value)
  return Boolean(modelId) && !FORBIDDEN_MODEL_SENTINELS.has(modelId.toLowerCase())
}

function modelOption(candidate: UltraTaskModelCapabilityCandidate): UltraTaskModelOption {
  return {
    provider: candidate.provider,
    modelId: candidate.modelId,
    label: candidate.label,
    ultraTaskSupported: candidate.ultraTaskSupported,
    runtimeAvailability: candidate.runtimeAvailability,
    reasoning: { ...candidate.reasoning },
    source: candidate.source,
    ...(candidate.runtimeUnavailableReason ? { reason: candidate.runtimeUnavailableReason } : {})
  }
}

/**
 * Concrete catalog rows suitable for an agent/user model choice. Sentinels are
 * never offered, and a provider row cannot leak into another provider's list.
 */
export function listUltraTaskModelOptions(
  provider: ProviderId,
  candidates: readonly UltraTaskModelCapabilityCandidate[]
): UltraTaskModelOption[] {
  return candidates
    .filter((candidate) => candidate.provider === provider)
    .filter((candidate) => isConcreteUltraTaskModelId(candidate.modelId))
    .map(modelOption)
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.modelId.localeCompare(right.modelId)
    )
}

function failure(
  code: UltraTaskCapabilityErrorCode,
  message: string,
  models: UltraTaskModelOption[]
): UltraTaskCapabilityResolution {
  return { ok: false, code, message, models }
}

function missingStages(route: UltraTaskRouteCandidate): UltraTaskRequiredStage[] {
  const supported = new Set(route.stages)
  return ULTRATASK_REQUIRED_STAGES.filter((stage) => !supported.has(stage))
}

function routeOrder(left: UltraTaskRouteCandidate, right: UltraTaskRouteCandidate): number {
  return left.priority - right.priority || left.id.localeCompare(right.id)
}

function validReasoningCapability(reasoning: UltraTaskReasoningCapability): boolean {
  const ceiling = normalizedText(reasoning.ceiling)
  if (reasoning.mode === 'configurable' || reasoning.mode === 'fixed') {
    if (!ceiling || FORBIDDEN_MODEL_SENTINELS.has(ceiling.toLowerCase())) return false
    if (reasoning.supported) {
      const supported = reasoning.supported.map((entry) => normalizedText(entry)).filter(Boolean)
      if (supported.length === 0 || !supported.includes(ceiling)) return false
    }
    return true
  }
  return !ceiling && reasoning.supported === undefined
}

/**
 * Resolve one exact model and one complete execution route. This function does
 * not fetch catalogs, rank models, inspect quota, or silently fall back. Those
 * are separate producer/audition concerns; execution receives their explicit
 * candidates and either returns a bound capability or an actionable failure.
 */
export function resolveUltraTaskCapability(
  input: ResolveUltraTaskCapabilityInput
): UltraTaskCapabilityResolution {
  const models = listUltraTaskModelOptions(input.provider, input.models)
  const requestedModel = normalizedText(input.modelId)
  if (!isConcreteUltraTaskModelId(requestedModel)) {
    return failure(
      'model_required',
      `UltraTask requires an exact concrete ${input.provider} model; choose one of the returned models.`,
      models
    )
  }

  const matching = input.models.filter(
    (candidate) =>
      candidate.provider === input.provider &&
      isConcreteUltraTaskModelId(candidate.modelId) &&
      candidate.modelId === requestedModel
  )
  if (matching.length === 0) {
    return failure(
      'model_unknown',
      `UltraTask model "${requestedModel}" is not present in the current ${input.provider} catalog.`,
      models
    )
  }
  if (matching.length > 1) {
    return failure(
      'model_ambiguous',
      `UltraTask model "${requestedModel}" appears more than once in the current ${input.provider} catalog.`,
      models
    )
  }

  const model = matching[0]!
  if (!model.ultraTaskSupported) {
    return failure(
      'model_unsupported',
      `${input.provider} model "${requestedModel}" does not support UltraTask.`,
      models
    )
  }
  if (model.runtimeAvailability === 'unavailable') {
    return failure(
      'model_unavailable',
      model.runtimeUnavailableReason ||
        `${input.provider} model "${requestedModel}" is currently unavailable.`,
      models
    )
  }
  if (model.runtimeAvailability === 'unknown') {
    return failure(
      'model_runtime_unknown',
      model.runtimeUnavailableReason ||
        `${input.provider} model "${requestedModel}" has not proved runtime availability.`,
      models
    )
  }
  if (!validReasoningCapability(model.reasoning)) {
    return failure(
      'invalid_reasoning_capability',
      `${input.provider} model "${requestedModel}" has an invalid UltraTask reasoning capability.`,
      models
    )
  }

  const routes = input.routes.filter((route) => normalizedText(route.id)).sort(routeOrder)
  const fullRoute = routes.find(
    (route) => route.availability === 'available' && missingStages(route).length === 0
  )
  if (!fullRoute) {
    const availablePartial = routes.find((route) => route.availability === 'available')
    if (availablePartial) {
      const missing = missingStages(availablePartial)
      return {
        ok: false,
        code: 'route_incomplete',
        message:
          `UltraTask route "${availablePartial.id}" is incomplete; missing stages: ` +
          `${missing.join(', ')}.`,
        models,
        route: {
          id: availablePartial.id,
          kind: availablePartial.kind,
          missingStages: missing
        }
      }
    }
    const unknownRoute = routes.find((route) => route.availability === 'unknown')
    if (unknownRoute) {
      return failure(
        'route_runtime_unknown',
        unknownRoute.unavailableReason ||
          `UltraTask route "${unknownRoute.id}" has not proved runtime availability.`,
        models
      )
    }
    return failure(
      'route_unavailable',
      routes.map((route) => route.unavailableReason).find(Boolean) ||
        `No complete UltraTask orchestration route is available for ${input.provider}.`,
      models
    )
  }

  return {
    ok: true,
    capability: {
      schemaVersion: ULTRATASK_CAPABILITY_SCHEMA_VERSION,
      provider: input.provider,
      modelId: model.modelId,
      modelLabel: model.label,
      modelSource: model.source,
      reasoning: { ...model.reasoning },
      route: {
        id: fullRoute.id,
        kind: fullRoute.kind,
        stages: [...ULTRATASK_REQUIRED_STAGES]
      }
    }
  }
}
