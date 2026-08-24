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
    postureId: 'read_only',
    label: 'Read only',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read' as const
  },
  {
    postureId: 'plan',
    label: 'Plan',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read' as const
  },
  {
    postureId: 'default',
    label: 'Default',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'workspace_write' as const
  },
  {
    postureId: 'workspace_write',
    label: 'Workspace write',
    available: true,
    requiresExplicitConsent: true,
    ceiling: 'workspace_write' as const
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

export function hostNodeMuseOffers(available = true): HostProviderOffersProjection {
  const models: HostProviderModelOffer[] = [
    {
      modelId: HOST_NODE_MUSE_MODEL_ID,
      label: 'Muse Spark 1.2',
      available,
      default: true,
      reasoning: HOST_NODE_MUSE_REASONING.map((reasoningId) => ({
        reasoningId,
        label: reasoningLabels[reasoningId],
        available
      }))
    }
  ]
  const offer: HostProviderOffersProjection = {
    providerId: 'muse',
    offerRevision: createHash('sha256')
      .update(
        JSON.stringify({
          model: HOST_NODE_MUSE_MODEL_ID,
          reasoning: HOST_NODE_MUSE_REASONING,
          available,
          postures
        })
      )
      .digest('hex'),
    models,
    postures: postures.map((posture) => ({ ...posture, available }))
  }
  const decoded = decodeHostProviderOffersProjection(offer)
  if (!decoded.ok) throw new Error('Muse Host catalog is invalid')
  return decoded.value
}

export function hostNodeMuseInventory(available: boolean): readonly HostProviderModelProjection[] {
  return [
    {
      providerId: 'muse',
      displayProvider: 'Muse',
      modelId: HOST_NODE_MUSE_MODEL_ID,
      modelLabel: 'Muse Spark 1.2',
      shortCode: 'MUSE',
      available
    }
  ]
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
