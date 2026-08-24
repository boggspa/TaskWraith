import type { ProviderId } from '../store/types'
import { resolveSubThreadDelegationRunSettings } from '../SubThreadDelegationRunSettings'
import { isKimiK3Model } from '../providers/StaticProviderModels'
import {
  isConcreteUltraTaskModelId,
  type UltraTaskAvailability,
  type UltraTaskModelCapabilityCandidate,
  type UltraTaskReasoningCapability
} from './UltraTaskCapabilityResolver'

export interface UltraTaskCatalogModelLike {
  id?: unknown
  label?: unknown
  disabled?: unknown
  disabledReason?: unknown
  ultraTaskSupported?: unknown
  supportedReasoningEfforts?: unknown
}

export interface UltraTaskModelRuntimeEvidence {
  state: UltraTaskAvailability
  reason?: string
}

export interface BuildUltraTaskModelCatalogInput {
  provider: ProviderId
  models: readonly UltraTaskCatalogModelLike[]
  /** Exact-id TaskWraith metadata fallback for live catalogs that omit local
   * capability fields. Identity, label, disabled state, and runtime evidence
   * always remain owned by `models`. */
  fallbackModels?: readonly UltraTaskCatalogModelLike[]
  source: UltraTaskModelCapabilityCandidate['source']
  /** Runtime/auth/model discovery evidence is supplied by the host. Absence is
   * unknown, never silently upgraded merely because a static row exists. */
  runtimeEvidence?: Readonly<Record<string, UltraTaskModelRuntimeEvidence>>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function enabledReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const efforts: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const effort = text(entry).toLowerCase()
      if (effort) efforts.push(effort)
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (record.disabled === true) continue
    const effort = text(record.reasoningEffort).toLowerCase()
    if (effort) efforts.push(effort)
  }
  return [...new Set(efforts)]
}

function reasoningMode(
  provider: ProviderId,
  modelId: string,
  ceiling: string | undefined
): UltraTaskReasoningCapability['mode'] {
  if (!ceiling) return 'none'
  if (provider === 'antigravity') return 'fixed'
  if (provider === 'kimi' && !isKimiK3Model(modelId)) return 'fixed'
  return 'configurable'
}

function reasoningCapability(
  provider: ProviderId,
  modelId: string,
  model: UltraTaskCatalogModelLike
): { reasoning: UltraTaskReasoningCapability; error?: string } {
  const resolved = resolveSubThreadDelegationRunSettings({
    provider,
    model: modelId,
    reasoningEffort: 'ultratask'
  })
  if (!resolved.ok) {
    return {
      reasoning: { mode: 'none' },
      error: resolved.message.replace(/^delegate_to_subthread:\s*/, '')
    }
  }
  const ceiling = resolved.reasoningEffort
  const mode = reasoningMode(provider, modelId, ceiling)
  if (!ceiling) return { reasoning: { mode } }
  const advertised = enabledReasoningEfforts(model.supportedReasoningEfforts)
  const supported = [...new Set([...advertised, ceiling])]
  return {
    reasoning: {
      mode,
      ceiling,
      supported
    }
  }
}

function runtimeEvidence(
  input: BuildUltraTaskModelCatalogInput,
  modelId: string,
  model: UltraTaskCatalogModelLike,
  capabilityError: string | undefined
): UltraTaskModelRuntimeEvidence {
  if (model.disabled === true) {
    return {
      state: 'unavailable',
      reason: text(model.disabledReason) || 'The model is disabled in the current catalog.'
    }
  }
  if (capabilityError) {
    return { state: 'unavailable', reason: capabilityError }
  }
  return (
    input.runtimeEvidence?.[modelId] || {
      state: 'unknown',
      reason: 'Runtime availability has not been proved for this model.'
    }
  )
}

/**
 * Convert a caller-supplied live/static model list into the exact candidates
 * consumed by `resolveUltraTaskCapability`. Missing support metadata is a
 * negative, and missing runtime evidence remains unknown. No default model is
 * selected here; callers receive every concrete row and make an explicit choice.
 */
export function buildUltraTaskModelCapabilityCatalog(
  input: BuildUltraTaskModelCatalogInput
): UltraTaskModelCapabilityCandidate[] {
  const candidates: UltraTaskModelCapabilityCandidate[] = []
  for (const model of input.models) {
    const modelId = text(model.id)
    if (!isConcreteUltraTaskModelId(modelId)) continue
    const fallback = input.fallbackModels?.find(
      (candidate) => text(candidate.id).toLowerCase() === modelId.toLowerCase()
    )
    const label = text(model.label) || modelId
    const ultraTaskSupported =
      model.ultraTaskSupported === undefined
        ? fallback?.ultraTaskSupported === true
        : model.ultraTaskSupported === true
    const capabilityModel: UltraTaskCatalogModelLike = {
      ...model,
      ...(model.supportedReasoningEfforts === undefined && fallback?.supportedReasoningEfforts
        ? { supportedReasoningEfforts: fallback.supportedReasoningEfforts }
        : {})
    }
    const resolved = ultraTaskSupported
      ? reasoningCapability(input.provider, modelId, capabilityModel)
      : { reasoning: { mode: 'none' as const } }
    const runtime = runtimeEvidence(input, modelId, model, resolved.error)
    candidates.push({
      provider: input.provider,
      modelId,
      label,
      ultraTaskSupported,
      runtimeAvailability: runtime.state,
      ...(runtime.reason ? { runtimeUnavailableReason: runtime.reason } : {}),
      reasoning: resolved.reasoning,
      source: input.source
    })
  }
  return candidates.sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.modelId.localeCompare(right.modelId)
  )
}
