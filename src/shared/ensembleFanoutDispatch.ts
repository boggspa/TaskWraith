import { MAX_ENSEMBLE_PARTICIPANTS } from './ensembleLimits'

/** Structured payload carried by the durable fan-out dispatch receipt. */
export interface EnsembleFanoutDispatchParticipant {
  participantId: string
  provider: string
  role: string
  model?: string
  intent: 'read' | 'write'
}

export interface EnsembleFanoutDispatchPayload {
  label: string
  category: 'user' | 'orchestrated'
  participants: EnsembleFanoutDispatchParticipant[]
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

/** Validate persisted dispatch metadata before promoting a system carrier. */
export function isEnsembleFanoutDispatchPayload(
  value: unknown
): value is EnsembleFanoutDispatchPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<EnsembleFanoutDispatchPayload>
  if (!boundedText(payload.label, 120)) return false
  if (payload.category !== 'user' && payload.category !== 'orchestrated') return false
  if (
    !Array.isArray(payload.participants) ||
    payload.participants.length < 1 ||
    payload.participants.length > MAX_ENSEMBLE_PARTICIPANTS
  ) {
    return false
  }

  const participantIds = new Set<string>()
  for (const candidate of payload.participants) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const participant = candidate as Partial<EnsembleFanoutDispatchParticipant>
    if (
      !boundedText(participant.participantId, 160) ||
      participantIds.has(participant.participantId) ||
      !boundedText(participant.provider, 64) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(participant.provider) ||
      !boundedText(participant.role, 80) ||
      (participant.model !== undefined && !boundedText(participant.model, 160)) ||
      (participant.intent !== 'read' && participant.intent !== 'write')
    ) {
      return false
    }
    participantIds.add(participant.participantId)
  }
  return true
}

export function ensembleFanoutDispatchIntentCounts(payload: EnsembleFanoutDispatchPayload): {
  read: number
  write: number
} {
  const read = payload.participants.filter((participant) => participant.intent === 'read').length
  return { read, write: payload.participants.length - read }
}
