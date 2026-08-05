/**
 * Resolve the seat that SENT a peer thread message, at send time.
 *
 * The receiving card renders this as "who sent this" — provider, model,
 * reasoning, permission tier and role — so the reader can weigh a relayed
 * message by what produced it. That makes accuracy worth more than coverage
 * here: every path below returns null rather than guessing, and the card has a
 * designed seatless line for exactly that answer.
 *
 * Captured rather than resolved later on purpose. Reading the sender's config
 * at RENDER time would let a subsequent reconfiguration of that thread silently
 * rewrite what the reader is told about a message they already received, and a
 * solo peer chat has no participant to resolve at all.
 *
 * Pure and shape-narrow (no ChatRecord import) so it can be exercised without
 * the store.
 */

import type { SeatChangeSeatState } from '../shared/seatChange'

/** The seat-bearing fields of an `EnsembleParticipant`, structurally. */
export interface ThreadMessageSeatParticipant {
  id?: string
  provider?: string
  model?: string
  role?: string
  stageRole?: string
  reasoningEffort?: string
  thinkingEnabled?: boolean
  permissionPresetId?: string
}

/** The seat-bearing fields of a `ChatRecord`, structurally. */
export interface ThreadMessageSeatChat {
  provider?: string
  /** What actually ran, preferred over what was merely selected. */
  lastActualModel?: string
  requestedModel?: string
  ensemble?: { participants?: readonly ThreadMessageSeatParticipant[] } | undefined
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build a seat from an ensemble participant.
 *
 * `seatNumber` and `grantsCount` are deliberately never set. `seatNumber` is
 * `participant.order`, 1-based within ONE roster — the reader of a peer message
 * is in a different roster, so "#3" would be a number they cannot interpret.
 * (It IS meaningful for a fan-out lane, which shares the reader's roster.)
 * `grantsCount` describes the sending workspace, not the sender.
 */
export function seatFromParticipant(
  participant: ThreadMessageSeatParticipant | null | undefined
): SeatChangeSeatState | null {
  if (!participant) return null
  const provider = trimmed(participant.provider)
  const model = trimmed(participant.model)
  if (!provider || !model) return null
  const role = trimmed(participant.role)
  const reasoningEffort = trimmed(participant.reasoningEffort)
  const permissionPresetId = trimmed(participant.permissionPresetId)
  // What KIND of seat sent this. Unlike `seatNumber`, which is an ordinal in a
  // roster the reader is not in, a stage role is a universal concept and is
  // exactly what a reader wants to know about an unfamiliar sender.
  const stage = trimmed(participant.stageRole)
  const stageRole =
    stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
      ? stage
      : undefined
  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    // A separate input from `reasoningEffort` that renders the same chip
    // suffix; `false` is meaningful, so this is a type check, not truthiness.
    ...(typeof participant.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
}

/**
 * Build a seat for a solo chat, which has no roster.
 *
 * Only provider and model are knowable from a chat record — reasoning and
 * permission live on participants. Omitting `permissionPresetId` is accurate
 * rather than lossy: the seat element resolves an absent preset to `'default'`,
 * which is the tier the dispatch layer would itself resolve for a seat that
 * names none.
 */
export function seatFromSoloChat(
  chat: ThreadMessageSeatChat | null | undefined
): SeatChangeSeatState | null {
  if (!chat) return null
  const provider = trimmed(chat.provider)
  const model = trimmed(chat.lastActualModel) || trimmed(chat.requestedModel)
  if (!provider || !model) return null
  return { provider, model }
}

/**
 * The sending seat for a chat, preferring the named participant when the send
 * came from a roster seat and falling back to the chat itself.
 *
 * A participant id that does not resolve falls through to the solo shape rather
 * than returning a different seat — naming the wrong sender is the one failure
 * this whole capture exists to avoid.
 */
export function resolveThreadMessageSenderSeat(
  chat: ThreadMessageSeatChat | null | undefined,
  participantId?: string | null
): SeatChangeSeatState | null {
  if (!chat) return null
  const wanted = trimmed(participantId)
  if (wanted) {
    const participants = chat.ensemble?.participants || []
    const match = participants.find((entry) => trimmed(entry?.id) === wanted)
    const seat = seatFromParticipant(match)
    if (seat) return seat
  }
  return seatFromSoloChat(chat)
}
