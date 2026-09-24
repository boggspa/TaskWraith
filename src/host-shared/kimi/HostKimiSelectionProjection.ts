import { canonicalKimiTaskWraithModelId, KIMI_K27_MODEL_ID } from '../../shared/kimiModels'

export interface HostKimiSelectionProjection {
  readonly modelId: string | undefined
  readonly reasoningId: string | undefined
}

/**
 * Project the one shipped Kimi picker row retired by the K2.8 split.
 *
 * The old row's standard route is today's K2.8 route. Current Desktop
 * normalization maps its historical On/Off values to K2.8's Max default, and
 * the Host mirrors that established migration. Known current ids and all other
 * effort strings pass through unchanged so the provider's current offer
 * validator remains the authority for acceptance.
 */
export function projectHostKimiSelection(
  modelId: string | undefined,
  reasoningId: string | undefined
): HostKimiSelectionProjection {
  if (modelId !== KIMI_K27_MODEL_ID) return { modelId, reasoningId }
  return {
    modelId: canonicalKimiTaskWraithModelId(modelId) ?? modelId,
    reasoningId: reasoningId === 'on' || reasoningId === 'off' ? 'max' : reasoningId
  }
}

/** Exact native-session equivalence for the retired standard-route identity. */
export function hostKimiSessionModelMatches(
  requestedModel: unknown,
  selectedModel: unknown
): boolean {
  return (
    requestedModel === selectedModel ||
    (requestedModel === KIMI_K27_MODEL_ID &&
      canonicalKimiTaskWraithModelId(requestedModel) === selectedModel)
  )
}
