import type { ChatMessage } from '../main/store/types'
import { isEnsembleSideMessage } from './ensembleSideMessage'

export const ENSEMBLE_PARTICIPANT_STATUS_KIND = 'ensembleParticipantStatus' as const

/**
 * A yielded participant status carries the seat's own handoff reason. It stays
 * on a system carrier so lifecycle accounting does not mistake it for another
 * completed assistant turn, but transcript surfaces present it at assistant
 * hierarchy. Other status codas remain application-authored system notices.
 */
export function isEnsembleYieldMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const candidate = message as {
    role?: unknown
    metadata?: { kind?: unknown; ensembleStatus?: unknown } | null
  }
  return (
    (candidate.role === 'system' || candidate.role === 'assistant') &&
    candidate.metadata?.kind === ENSEMBLE_PARTICIPANT_STATUS_KIND &&
    candidate.metadata.ensembleStatus === 'yielded'
  )
}

/** Participant-authored conversation that intentionally uses a system carrier. */
export function isEnsembleParticipantAuthoredMessage(message: unknown): boolean {
  return isEnsembleSideMessage(message as ChatMessage) || isEnsembleYieldMessage(message)
}
