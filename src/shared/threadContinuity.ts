import type { ChatRecord, ChatRun, ProviderId } from '../main/store/types'

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
  /** A text-free revision witness prevents stale writes after clear/recreate. */
  cleared?: true
  references: ContinuityReference[]
  updatedAt: string
  author: { provider: ProviderId; runId: string; providerSessionId?: string }
}

export interface ContinuityDelivery {
  key: string
  seatId: string
  revision: number
  sourceId?: string
  provider?: ProviderId
  providerSessionId?: string | null
  boundaryId?: string
  observedAt?: string
}

/** Renderer round-trips cannot mint or erase main-owned adapter receipts. */
export function preserveContinuityRunReceipts(
  runs: readonly ChatRun[],
  previous: readonly ChatRun[],
  authoritative = false
): ChatRun[] {
  const prior = new Map(previous.map((run) => [run.runId, run.continuityCheckpointDelivery]))
  return runs.map((run) => {
    const receipt = authoritative ? run.continuityCheckpointDelivery : prior.get(run.runId)
    if (receipt === run.continuityCheckpointDelivery) return run
    const { continuityCheckpointDelivery: _untrusted, ...rest } = run
    return receipt ? { ...rest, continuityCheckpointDelivery: receipt } : rest
  })
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
    JSON.stringify(value.text).length > CONTINUITY_TEXT_MAX_CHARS + 2 ||
    !Array.isArray(value.references) ||
    value.references.length > CONTINUITY_MAX_REFS ||
    !value.author?.runId ||
    typeof value.updatedAt !== 'string' ||
    value.updatedAt.length > 40 ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return null
  if (
    value.references.some(
      (ref) =>
        !ref ||
        typeof ref.messageId !== 'string' ||
        !ref.messageId ||
        ref.messageId.length > 160 ||
        (ref.activityId !== undefined &&
          (typeof ref.activityId !== 'string' || !ref.activityId || ref.activityId.length > 160))
    )
  )
    return null
  if (
    typeof value.author.runId !== 'string' ||
    value.author.runId.length > 160 ||
    typeof value.author.provider !== 'string' ||
    value.author.provider.length > 40 ||
    (value.author.providerSessionId !== undefined &&
      (typeof value.author.providerSessionId !== 'string' ||
        value.author.providerSessionId.length > 160))
  )
    return null
  if (value.cleared && (value.text !== '' || value.references.length > 0)) return null
  return {
    schemaVersion: 1,
    chatId: value.chatId,
    seatId: value.seatId,
    revision: value.revision,
    text: value.text,
    references: value.references.map((ref) => ({
      messageId: ref.messageId,
      ...(ref.activityId ? { activityId: ref.activityId } : {})
    })),
    updatedAt: new Date(value.updatedAt).toISOString(),
    ...(value.cleared ? { cleared: true as const } : {}),
    author: {
      provider: value.author.provider,
      runId: value.author.runId,
      ...(value.author.providerSessionId
        ? { providerSessionId: value.author.providerSessionId }
        : {})
    }
  }
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
  const next: Record<string, SeatContinuityCheckpoint> = Object.assign(
    Object.create(null),
    chat.continuityCheckpoints
  )
  const liveSeats = new Set([
    SOLO_CONTINUITY_SEAT,
    ...(chat.ensemble?.participants.map((p) => p.id) || [])
  ])
  for (const seat of Object.keys(next)) if (!liveSeats.has(seat)) delete next[seat]
  if (input.text === null) {
    next[input.seatId] = {
      schemaVersion: 1,
      chatId: chat.appChatId,
      seatId: input.seatId,
      revision: (old?.revision || 0) + 1,
      text: '',
      references: [],
      cleared: true,
      updatedAt: input.now,
      author: input.author
    }
    return next
  }
  const text = input.text.trim()
  if (
    !text ||
    text.length > CONTINUITY_TEXT_MAX_CHARS ||
    JSON.stringify(text).length > CONTINUITY_TEXT_MAX_CHARS + 2
  ) {
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
