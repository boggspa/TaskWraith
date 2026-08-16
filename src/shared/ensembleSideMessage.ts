import type { ChatMessage, ConcurrentLaneIntent } from '../main/store/types'

/** Persisted discriminator for a participant-authored `ensemble_send` note. */
export const ENSEMBLE_SIDE_MESSAGE_KIND = 'ensembleSideMessage' as const

/**
 * Inter-seat notes use a system carrier because they are emitted mid-turn and
 * must not become completed assistant turns in provider-history logic. They
 * are nevertheless participant-authored conversation, so transcript surfaces
 * promote this metadata kind to the same hierarchy as an assistant message.
 *
 * Accepting an assistant carrier as well keeps the presentation compatible
 * with imported/future records without ever promoting a tool row solely from
 * attacker-controlled metadata.
 */
export function isEnsembleSideMessage(message: ChatMessage | null | undefined): boolean {
  return (
    (message?.role === 'system' || message?.role === 'assistant') &&
    message.metadata?.kind === ENSEMBLE_SIDE_MESSAGE_KIND
  )
}

/** Narrow user-addressed side messages without trusting metadata on other carriers. */
export function isEnsembleSideMessageToUser(message: ChatMessage | null | undefined): boolean {
  return isEnsembleSideMessage(message) && message?.metadata?.toUser === true
}

export interface EnsembleSideMessageLaneMetadata {
  ensembleLaneId?: string
  ensembleSourceLaneId?: string
  ensembleLaneIntent?: ConcurrentLaneIntent
  ensembleFanoutWaveId?: string
  ensembleFanoutLabel?: string
  ensembleFanoutCategory?: 'user' | 'orchestrated'
}

/**
 * A lane-authored note to the User is deliberately a top-level conversation
 * row. Preserve its exact origin without leaving the live lane-grouping key on
 * the message. Ordinary inter-seat notes retain the existing lane metadata.
 */
export function sideMessageLaneMetadataForAudience(
  metadata: EnsembleSideMessageLaneMetadata,
  toUser: boolean
): EnsembleSideMessageLaneMetadata {
  if (!toUser || !metadata.ensembleLaneId) return metadata
  const { ensembleLaneId, ...rest } = metadata
  return { ...rest, ensembleSourceLaneId: ensembleLaneId }
}
