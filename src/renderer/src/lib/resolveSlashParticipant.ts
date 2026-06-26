import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

const SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY = 'sideChatSelectedParticipantId'

export function resolveSlashParticipantForChat(
  chat: ChatRecord | null | undefined,
  preferred?: EnsembleParticipant | null
): EnsembleParticipant | null {
  if (chat?.chatKind !== 'ensemble') return null
  const participants = [...(chat.ensemble?.participants || [])].sort((a, b) => a.order - b.order)
  if (preferred && participants.some((participant) => participant.id === preferred.id)) {
    return preferred
  }
  const metadataParticipantId = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  if (typeof metadataParticipantId === 'string' && metadataParticipantId) {
    const metadataParticipant = participants.find(
      (participant) => participant.id === metadataParticipantId
    )
    if (metadataParticipant) return metadataParticipant
  }
  return participants.find((participant) => participant.enabled) || participants[0] || null
}
