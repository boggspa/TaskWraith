import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

/** Seat patches need roster identity, not a materialized transcript. */
export function tryCommitEnsembleSeatPatch(input: {
  chat: ChatRecord | null | undefined
  participantId: string
  patch: Partial<EnsembleParticipant>
  runtimePatch: Record<string, unknown> | null
  request: (chat: ChatRecord, participantId: string, patch: Partial<EnsembleParticipant>) => boolean
}): boolean {
  const { chat, participantId, patch, runtimePatch, request } = input
  if (!chat?.ensemble || !runtimePatch) return false
  // Leave non-runtime roster fields on their existing whole-record path.
  if (!Object.keys(patch).every((key) => Object.prototype.hasOwnProperty.call(runtimePatch, key))) {
    return false
  }
  if (!chat.ensemble.participants.some((participant) => participant.id === participantId)) {
    return false
  }
  return request(chat, participantId, patch)
}
