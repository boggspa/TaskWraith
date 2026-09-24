import { createHash } from 'node:crypto'

import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import type { OllamaModelInfo } from '../host-shared/ollama/OllamaDaemonClient'
import { resolveOllamaReasoningSupport } from '../shared/ollamaReasoning'
import {
  HOST_SETUP_MAX_MODELS,
  type HostProviderModelOffer,
  type HostProviderOffersProjection,
  type HostProviderReasoningOffer
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
  const cloudDetail =
    model.source === 'cloud'
      ? model.requiredPlan
        ? `Ollama Cloud · ${model.requiredPlan} plan`
        : 'Ollama Cloud'
      : undefined
  const detail = model.disabled ? (model.disabledReason ?? cloudDetail) : cloudDetail
  return {
    modelId: model.id,
    label: model.label,
    available: !model.disabled,
    ...(model.isDefault ? { default: true } : {}),
    reasoning: reasoningOffers(model.id),
    ...(detail ? { detail } : {})
  }
}

function revisionOf(
  models: readonly HostProviderModelOffer[],
  postures: HostProviderOffersProjection['postures']
): string {
  return createHash('sha256').update(JSON.stringify({ models, postures })).digest('hex')
}

/**
 * Replace the static Ollama suggestions with the exact catalog the standalone
 * Host proved at composition time. A disabled Cloud row (account state unknown
 * or signed out) crosses the protocol as `available: false` with its reason —
 * present but unselectable — so a slow account probe reads as "not confirmed"
 * rather than as a catalogue that lost its Cloud models.
 */
export function hostNodeOllamaOffersFromCatalog(catalog: {
  readonly models: readonly OllamaModelInfo[]
}): HostProviderOffersProjection {
  const base = hostProviderOffers('ollama', true)
  if (!base) throw new Error('Standalone Ollama catalog is unavailable')
  // The Host setup protocol bounds one provider response at 128 rows. Runnable
  // rows come first so a large disabled Cloud list can never crowd the
  // installed local models out of the response; within each group the
  // daemon's deterministic order is kept, and the response never exceeds
  // what the client decoder accepts.
  const runnable = catalog.models.filter((model) => !model.disabled)
  const unavailable = catalog.models.filter((model) => model.disabled)
  const models = [...runnable, ...unavailable].slice(0, HOST_SETUP_MAX_MODELS).map(modelOffer)
  return {
    providerId: 'ollama',
    offerRevision: revisionOf(models, base.postures),
    models,
    postures: base.postures.map((posture) => ({ ...posture }))
  }
}
