import { createHash } from 'node:crypto'

import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import type { OllamaModelInfo } from '../host-shared/ollama/OllamaDaemonClient'
import { resolveOllamaReasoningSupport } from '../shared/ollamaReasoning'
import type {
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderReasoningOffer
} from '../shared/hostSetupProtocol'

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: 'Off',
  on: 'On',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
}

function reasoningOffers(modelId: string): readonly HostProviderReasoningOffer[] {
  return resolveOllamaReasoningSupport({ modelId }).efforts.map((reasoningId) => ({
    reasoningId,
    label: EFFORT_LABELS[reasoningId] ?? reasoningId,
    available: true
  }))
}

function modelOffer(model: OllamaModelInfo): HostProviderModelOffer {
  return {
    modelId: model.id,
    label: model.label,
    available: true,
    ...(model.isDefault ? { default: true } : {}),
    reasoning: reasoningOffers(model.id),
    ...(model.source === 'cloud'
      ? {
          detail: model.requiredPlan ? `Ollama Cloud · ${model.requiredPlan} plan` : 'Ollama Cloud'
        }
      : {})
  }
}

function revisionOf(
  models: readonly HostProviderModelOffer[],
  postures: HostProviderOffersProjection['postures']
): string {
  return createHash('sha256').update(JSON.stringify({ models, postures })).digest('hex')
}

/**
 * Replace the static Ollama suggestions with the exact runnable catalog the
 * standalone Host proved at composition time. Disabled/unproven Cloud rows
 * never cross the Host protocol as selectable offers.
 */
export function hostNodeOllamaOffersFromCatalog(catalog: {
  readonly models: readonly OllamaModelInfo[]
}): HostProviderOffersProjection {
  const base = hostProviderOffers('ollama', true)
  if (!base) throw new Error('Standalone Ollama catalog is unavailable')
  const models = catalog.models.filter((model) => !model.disabled).map(modelOffer)
  return {
    providerId: 'ollama',
    offerRevision: revisionOf(models, base.postures),
    models,
    postures: base.postures.map((posture) => ({ ...posture }))
  }
}
