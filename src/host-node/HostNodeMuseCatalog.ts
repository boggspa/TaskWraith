import { createHash } from 'node:crypto'

import {
  decodeHostProviderOffersProjection,
  decodeHostProviderStatuses,
  type HostProviderModelOffer,
  type HostProviderOffersProjection,
  type HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { HostProviderModelProjection } from '../shared/hostProtocol'

export const HOST_NODE_MUSE_MODEL_ID = 'muse-spark-1.2'
export const HOST_NODE_MUSE_CONTRIBUTOR_MODEL_ID = 'muse-spark-1.2-contributor'
export const HOST_NODE_MUSE_REASONING = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra'
] as const

const postures = [
  {
    postureId: 'plan',
    label: 'Plan',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read' as const
  },
  {
    postureId: 'read_only',
    label: 'Ask',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read' as const
  },
  {
    postureId: 'default',
    label: 'Accept Edits',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'workspace_write' as const
  },
  {
    postureId: 'workspace_write',
    label: 'Full WS Access',
    available: true,
    requiresExplicitConsent: true,
    ceiling: 'workspace_write' as const
  },
  {
    postureId: 'full_access',
    label: 'Full Access (YOLO)',
    available: false,
    requiresExplicitConsent: true,
    ceiling: 'full_access' as const,
    detail:
      'Unavailable in the standalone Host because Muse deliberately keeps its sandbox enabled.'
  }
]
const reasoningLabels: Readonly<Record<(typeof HOST_NODE_MUSE_REASONING)[number], string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  ultra: 'Ultra'
}

const museModels = [
  {
    modelId: HOST_NODE_MUSE_MODEL_ID,
    label: 'Muse Spark 1.2',
    default: true
  },
  {
    modelId: HOST_NODE_MUSE_CONTRIBUTOR_MODEL_ID,
    label: 'Muse Contributor Spark 1.2',
    detail:
      'Discounted tokens; content, including inter-session messages, may be used for product improvement.'
  }
] as const

export function hostNodeMuseOffers(available = true): HostProviderOffersProjection {
  const models: HostProviderModelOffer[] = museModels.map((model) => ({
    ...model,
    available,
    reasoning: HOST_NODE_MUSE_REASONING.map((reasoningId) => ({
      reasoningId,
      label: reasoningLabels[reasoningId],
      available
    }))
  }))
  const offer: HostProviderOffersProjection = {
    providerId: 'muse',
    offerRevision: createHash('sha256')
      .update(
        JSON.stringify({
          models,
          available,
          postures
        })
      )
      .digest('hex'),
    models,
    postures: postures.map((posture) => ({
      ...posture,
      available: posture.available && available
    }))
  }
  const decoded = decodeHostProviderOffersProjection(offer)
  if (!decoded.ok) throw new Error('Muse Host catalog is invalid')
  return decoded.value
}

export function hostNodeMuseInventory(available: boolean): readonly HostProviderModelProjection[] {
  return museModels.map((model) => ({
    providerId: 'muse',
    displayProvider: 'Muse',
    modelId: model.modelId,
    modelLabel: model.label,
    shortCode: 'MUSE',
    available
  }))
}

export function hostNodeMuseStatuses(
  available: boolean,
  configured: boolean
): readonly HostProviderStatusProjection[] {
  const statuses: HostProviderStatusProjection[] = [
    {
      providerId: 'muse',
      status: !available ? 'unavailable' : configured ? 'ready' : 'auth_required',
      label: 'MUSE'
    }
  ]
  const decoded = decodeHostProviderStatuses(statuses)
  if (!decoded.ok) throw new Error('Muse Host statuses are invalid')
  return decoded.value
}
