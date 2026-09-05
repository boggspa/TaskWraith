import type { ChatRecord, ProviderId } from '../main/store/types'

export const SOLO_CONTINUITY_SEAT = '__solo__'
export const CONTINUITY_TEXT_MAX_CHARS = 1_600
export const CONTINUITY_MAX_REFS = 6
export const CONTINUITY_BLOCK_MAX_CHARS = 2_400

export interface ContinuityReference {
  messageId: string
  activityId?: string
}

export interface SeatContinuityCheckpoint {
  schemaVersion: 1
  chatId: string
  seatId: string
  revision: number
  text: string
  references: ContinuityReference[]
  updatedAt: string
  author: { provider: ProviderId; runId: string; providerSessionId?: string }
}

export interface ContinuityDelivery {
  key: string
  seatId: string
  revision: number
}

export function readSeatCheckpoint(
  chat: Pick<ChatRecord, 'appChatId' | 'continuityCheckpoints'>,
  seatId = SOLO_CONTINUITY_SEAT
): SeatContinuityCheckpoint | null {
  const value = chat.continuityCheckpoints?.[seatId]
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.chatId !== chat.appChatId ||
    value.seatId !== seatId ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.text !== 'string' ||
    value.text.length > CONTINUITY_TEXT_MAX_CHARS ||
    !Array.isArray(value.references) ||
    value.references.length > CONTINUITY_MAX_REFS ||
    !value.author?.runId ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return null
  return value
}

/** Author and seat are supplied by the active host run, never by tool arguments. */
export function updateSeatCheckpoint(
  chat: ChatRecord,
  input: {
    seatId: string
    text: string | null
    references?: ContinuityReference[]
    expectedRevision: number
    author: SeatContinuityCheckpoint['author']
    now: string
  }
): ChatRecord['continuityCheckpoints'] {
  const old = readSeatCheckpoint(chat, input.seatId)
  if ((old?.revision || 0) !== input.expectedRevision) {
    throw new Error('Checkpoint changed. Read its current revision before updating it.')
  }
  if (
    input.seatId !== SOLO_CONTINUITY_SEAT &&
    !chat.ensemble?.participants.some((p) => p.id === input.seatId)
  ) {
    throw new Error('Checkpoint seat is not a participant in this task.')
  }
  const next = { ...chat.continuityCheckpoints }
  if (input.text === null) {
    delete next[input.seatId]
    return Object.keys(next).length ? next : undefined
  }
  const text = input.text.trim()
  if (!text || text.length > CONTINUITY_TEXT_MAX_CHARS) {
    throw new Error(`Checkpoint text must contain 1–${CONTINUITY_TEXT_MAX_CHARS} characters.`)
  }
  const references = input.references || []
  if (references.length > CONTINUITY_MAX_REFS) throw new Error('Too many checkpoint references.')
  for (const ref of references) {
    if (
      typeof ref.messageId !== 'string' ||
      ref.messageId.length > 160 ||
      (ref.activityId !== undefined &&
        (typeof ref.activityId !== 'string' || ref.activityId.length > 160))
    ) {
      throw new Error('Invalid checkpoint reference.')
    }
    const message = chat.messages.find((m) => m.id === ref.messageId)
    if (
      !message ||
      (ref.activityId && !message.toolActivities?.some((a) => a.id === ref.activityId))
    ) {
      throw new Error('Checkpoint references must resolve in this task.')
    }
  }
  next[input.seatId] = {
    schemaVersion: 1,
    chatId: chat.appChatId,
    seatId: input.seatId,
    revision: (old?.revision || 0) + 1,
    text,
    references: references.map((ref) => ({
      messageId: ref.messageId,
      ...(ref.activityId ? { activityId: ref.activityId } : {})
    })),
    updatedAt: input.now,
    author: input.author
  }
  // Removed seats do not leave an ever-growing memory map on a long-lived panel.
  const seats = new Set([
    SOLO_CONTINUITY_SEAT,
    ...(chat.ensemble?.participants.map((p) => p.id) || [])
  ])
  for (const seat of Object.keys(next)) if (!seats.has(seat)) delete next[seat]
  return next
}
