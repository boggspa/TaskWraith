import type { EnsembleParticipant } from '../../../main/store/types'

export type PendingEnsembleSeatSelections = Record<string, Record<string, EnsembleParticipant>>

export interface PendingEnsembleSeatSelectionUpdate {
  selections: PendingEnsembleSeatSelections
  participant: EnsembleParticipant
}

export function ensembleParticipantSelectionsEqual(
  left: EnsembleParticipant | null | undefined,
  right: EnsembleParticipant | null | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export function queuePendingEnsembleSeatSelection(
  selections: PendingEnsembleSeatSelections,
  chatId: string,
  participant: EnsembleParticipant,
  patch: Partial<EnsembleParticipant>
): PendingEnsembleSeatSelectionUpdate {
  const current = selections[chatId]?.[participant.id] ?? participant
  const pending: EnsembleParticipant = {
    ...current,
    ...patch,
    id: participant.id,
    order: participant.order
  }
  return {
    selections: setPendingEnsembleSeatSelection(selections, chatId, pending),
    participant: pending
  }
}

export function setPendingEnsembleSeatSelection(
  selections: PendingEnsembleSeatSelections,
  chatId: string,
  participant: EnsembleParticipant
): PendingEnsembleSeatSelections {
  return {
    ...selections,
    [chatId]: {
      ...(selections[chatId] ?? {}),
      [participant.id]: participant
    }
  }
}

export function clearPendingEnsembleSeatSelection(
  selections: PendingEnsembleSeatSelections,
  chatId: string,
  participantId?: string
): PendingEnsembleSeatSelections {
  const chatSelections = selections[chatId]
  if (!chatSelections) return selections
  if (!participantId) {
    const next = { ...selections }
    delete next[chatId]
    return next
  }
  if (!chatSelections[participantId]) return selections
  const nextChatSelections = { ...chatSelections }
  delete nextChatSelections[participantId]
  const next = { ...selections }
  if (Object.keys(nextChatSelections).length > 0) {
    next[chatId] = nextChatSelections
  } else {
    delete next[chatId]
  }
  return next
}

export function overlayPendingEnsembleSeatSelections(
  participants: readonly EnsembleParticipant[],
  selections: Record<string, EnsembleParticipant> | null | undefined
): EnsembleParticipant[] {
  if (!selections) return [...participants]
  return participants.map((participant) => {
    const pending = selections[participant.id]
    return pending ? { ...pending, order: participant.order } : participant
  })
}

export function reconcilePendingEnsembleSeatSelections(
  selections: PendingEnsembleSeatSelections,
  input: {
    chatId: string
    participants: readonly EnsembleParticipant[]
    roundLive: boolean
  }
): PendingEnsembleSeatSelections {
  const chatSelections = selections[input.chatId]
  if (!chatSelections) return selections
  if (!input.roundLive) {
    return clearPendingEnsembleSeatSelection(selections, input.chatId)
  }
  const currentById = new Map(
    input.participants.map((participant) => [participant.id, participant])
  )
  let next = selections
  for (const [participantId, pending] of Object.entries(chatSelections)) {
    const current = currentById.get(participantId)
    if (!current || ensembleParticipantSelectionsEqual(current, pending)) {
      next = clearPendingEnsembleSeatSelection(next, input.chatId, participantId)
    }
  }
  return next
}
