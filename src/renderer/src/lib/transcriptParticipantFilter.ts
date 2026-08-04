import type { ChatMessage, ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { normalizeEnsembleAuthority } from '../../../shared/ensembleAuthority'

export const TRANSCRIPT_SYSTEM_FILTER_KEY = 'system'

export interface TranscriptParticipantFilterItem {
  key: string
  kind: 'participant' | 'system'
  participantId?: string
  ordinal?: number
  provider?: EnsembleParticipant['provider']
  role: string
  title: string
  pooledAgent: boolean
  participant?: EnsembleParticipant
  isBossman: boolean
  isCaptain: boolean
}

export function transcriptParticipantFilterKey(participantId: string): string {
  return `participant:${participantId}`
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function transcriptParticipantIdForMessage(message: ChatMessage): string | null {
  const fromMessage = cleanString(message.metadata?.ensembleParticipantId)
  if (fromMessage) return fromMessage
  for (const activity of message.toolActivities || []) {
    const fromActivity = cleanString(activity.metadata?.ensembleParticipantId)
    if (fromActivity) return fromActivity
  }
  return null
}

export function transcriptFilterKeyForMessage(message: ChatMessage): string {
  const participantId = transcriptParticipantIdForMessage(message)
  return participantId ? transcriptParticipantFilterKey(participantId) : TRANSCRIPT_SYSTEM_FILTER_KEY
}

export function shouldShowMessageForTranscriptFilters(
  message: ChatMessage,
  activeFilterKeys: ReadonlySet<string>
): boolean {
  if (activeFilterKeys.size === 0) return true
  return activeFilterKeys.has(transcriptFilterKeyForMessage(message))
}

export function filterTranscriptMessagesByParticipantKeys(
  messages: readonly ChatMessage[],
  activeFilterKeys: ReadonlySet<string>
): ChatMessage[] {
  if (activeFilterKeys.size === 0) return messages as ChatMessage[]
  return messages.filter((message) =>
    shouldShowMessageForTranscriptFilters(message, activeFilterKeys)
  )
}

export function buildTranscriptParticipantFilterItems(
  chat: ChatRecord | null | undefined
): TranscriptParticipantFilterItem[] {
  if (!chat || chat.chatKind !== 'ensemble' || !chat.ensemble?.participants?.length) return []
  const participants = [...chat.ensemble.participants].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.role.localeCompare(b.role) || a.id.localeCompare(b.id)
  )
  const authorityState = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId: chat.ensemble.bossmanParticipantId,
    captainParticipantIds: chat.ensemble.captainParticipantIds,
    secondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId
  })
  const captainParticipantIds = new Set(authorityState.captainParticipantIds)
  const items = participants.map((participant, index): TranscriptParticipantFilterItem => {
    const isBossman = authorityState.bossmanParticipantId === participant.id
    const isCaptain = !isBossman && captainParticipantIds.has(participant.id)
    const authority = isBossman ? 'Boss - ' : isCaptain ? 'Captain - ' : ''
    return {
      key: transcriptParticipantFilterKey(participant.id),
      kind: 'participant',
      participantId: participant.id,
      ordinal: index + 1,
      provider: participant.provider,
      role: participant.role || `Participant ${index + 1}`,
      title: `${authority}${index + 1} ${participant.role || participant.provider}`,
      pooledAgent: Boolean(participant.pooledAgentId || participant.pooledAgentIdentity),
      participant,
      isBossman,
      isCaptain
    }
  })
  items.push({
    key: TRANSCRIPT_SYSTEM_FILTER_KEY,
    kind: 'system',
    role: 'System',
    title: 'System messages',
    pooledAgent: false,
    isBossman: false,
    isCaptain: false
  })
  return items
}
