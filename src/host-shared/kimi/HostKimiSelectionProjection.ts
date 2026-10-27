import {
  canonicalKimiTaskWraithModelId,
  KIMI_K27_MODEL_ID,
  kimiRetiredModelSuccessor
} from '../../shared/kimiModels'

export interface HostKimiSelectionProjection {
  readonly modelId: string | undefined
  readonly reasoningId: string | undefined
}

/**
 * Project the shipped Kimi picker rows that have been retired.
 *
 * The old row's standard route is today's K2.8 route. Current Desktop
 * normalization maps its historical On/Off values to K2.8's Max default, and
 * the Host mirrors that established migration. Known current ids and all other
 * effort strings pass through unchanged so the provider's current offer
 * validator remains the authority for acceptance.
 *
 * Both K3 rows (`kimi-k3`, `kimi-k3-256k`) moved to K3.1 Pro on 2026-10-27.
 * They share its Low/High/Max axis, so only the model moves.
 */
export function projectHostKimiSelection(
  modelId: string | undefined,
  reasoningId: string | undefined
): HostKimiSelectionProjection {
  const successor = kimiRetiredModelSuccessor(modelId)
  if (successor) return { modelId: successor, reasoningId }
  if (modelId !== KIMI_K27_MODEL_ID) return { modelId, reasoningId }
  return {
    modelId: canonicalKimiTaskWraithModelId(modelId) ?? modelId,
    reasoningId: reasoningId === 'on' || reasoningId === 'off' ? 'max' : reasoningId
  }
}

/** Exact native-session equivalence for the retired row identities. */
export function hostKimiSessionModelMatches(
  requestedModel: unknown,
  selectedModel: unknown
): boolean {
  if (typeof requestedModel === 'string' && kimiRetiredModelSuccessor(requestedModel)) {
    return kimiRetiredModelSuccessor(requestedModel) === selectedModel
  }
  return (
    requestedModel === selectedModel ||
    (requestedModel === KIMI_K27_MODEL_ID &&
      canonicalKimiTaskWraithModelId(requestedModel) === selectedModel)
  )
}
