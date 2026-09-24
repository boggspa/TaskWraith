import type { EnsembleFanoutDispatchPayload } from '../../shared/ensembleFanoutDispatch'
import type { EnsembleParticipant } from '../store/types'

export interface EnsembleFanoutDispatchTranscriptLane {
  participant: Pick<EnsembleParticipant, 'id' | 'provider' | 'role' | 'model'>
  laneIntent: 'read' | 'write'
}

/** Freeze the exact planned seats before the orchestrator seeds their runs. */
export function buildEnsembleFanoutDispatchPayload(input: {
  label: string
  category: 'user' | 'orchestrated'
  lanes: readonly EnsembleFanoutDispatchTranscriptLane[]
}): EnsembleFanoutDispatchPayload {
  return {
    label: input.label.trim(),
    category: input.category,
    participants: input.lanes.map(({ participant, laneIntent }) => ({
      participantId: participant.id,
      provider: participant.provider,
      role: participant.role.trim() || 'Participant',
      ...(participant.model?.trim() ? { model: participant.model.trim() } : {}),
      intent: laneIntent
    }))
  }
}
