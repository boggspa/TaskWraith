/**
 * Effective ensemble roster — the panel as it is SEEN, assembled at read time
 * from two independent stores instead of persisted as one.
 *
 * THE DECISION THIS FILE ENCODES. External human collaborators occupy roster
 * seats, but they are NOT written into `chat.ensemble.participants`. Two
 * readers of the codebase disagreed about this and it is worth recording why
 * derive won, because the merge option looks cheaper right up until it isn't:
 *
 *   - `EnsembleParticipant.provider` is a REQUIRED, closed 10-member
 *     `ProviderId` union validated against the live-selectable set at every
 *     roster admission path. An external has no provider. Widening the union is
 *     barred outright — a baseline id with no adapter throws at module scope and
 *     the app will not launch — so a merge needs a sentinel provider, and every
 *     one of ~200 sites that reads `provider` would then be reading a lie.
 *   - Persisting an external seat puts it inside the collapse/stash path, which
 *     stashes an outgoing roster into `providerMetadata.stashedEnsemble` that a
 *     later preset-apply CONSUMES. A seat removed by a collapse can come back —
 *     so a person removed from a thread could have their seat resurrect.
 *   - Preset-apply replaces `ensemble.participants` wholesale, and
 *     `ensemble_roster_edit` lets the panel's own models add and remove seats.
 *     Both would reach external seats for free.
 *   - The spec's own governing principle is already derive-don't-persist for
 *     `chatKind`. Deriving the roster is the same principle applied twice.
 *
 * Cost of deriving, stated honestly: every consumer that wants the PANEL view
 * has to ask for it rather than reading a field, and poll eligibility no longer
 * comes for free. That is the trade, and it is the cheap side.
 *
 * Ordering lives with the external's own record (the share participant), never
 * here and never on the chat, so a join or a leave never rewrites chat state.
 *
 * This module is PURE: no I/O, no store access, no Electron. It is the single
 * place that knows how the two halves compose.
 */

import type { ChatRecord, EnsembleParticipant } from '../main/store/types'

export type EffectiveSeatKind = 'model' | 'external'

interface EffectiveSeatBase {
  /** Sort key across BOTH kinds — externals can interleave with model seats. */
  order: number
  /** False for a seat the host has muted; it holds its position regardless. */
  enabled: boolean
  /** Display label. Never an identity — see `seatId`. */
  label: string
}

export interface EffectiveModelSeat extends EffectiveSeatBase {
  kind: 'model'
  seatId: string
  participant: EnsembleParticipant
}

export interface EffectiveExternalSeat extends EffectiveSeatBase {
  kind: 'external'
  /**
   * The `collaboratorId`, which is stable per pinned pubkey within a share.
   * Deliberately the same identifier the authority fields store, so an external
   * can hold Boss/Captain without a translation layer.
   */
  seatId: string
  shareId: string
  collaboratorId: string
  /** True while connected OR inside the reconnect grace window. */
  present: boolean
}

export type EffectiveSeat = EffectiveModelSeat | EffectiveExternalSeat

/** What the collaboration layer contributes. Shaped to be a cheap projection of
 * a share participant plus its presence, not a new record to maintain. */
export interface ExternalSeatInput {
  shareId: string
  collaboratorId: string
  displayName: string
  /** Host-set roster position. Absent ⇒ appended after the model seats. */
  seatOrder?: number
  /** Connected or in grace. Absent ⇒ treated as present. */
  present?: boolean
  /** Host-muted. Absent ⇒ enabled. */
  enabled?: boolean
}

export interface EffectiveRoster {
  /** Ordered, deduped, ready to render or to walk as a turn queue. */
  seats: EffectiveSeat[]
  modelSeatCount: number
  /** Model seats that can actually take a turn — the real panel floor. */
  enabledModelSeatCount: number
  externalSeatCount: number
  /** External seats connected or in grace. Drives the panel predicate. */
  presentExternalSeatCount: number
  totalSeatCount: number
  /**
   * External seats discarded because their id collided with a model seat's.
   * Surfaced rather than dropped silently: a collision means an identity is
   * ambiguous, which is exactly the kind of thing that must never be invisible.
   */
  collidedExternalSeatIds: string[]
}

function labelForModelSeat(participant: EnsembleParticipant): string {
  const role = typeof participant.role === 'string' ? participant.role.trim() : ''
  if (role) return role
  const model = typeof participant.model === 'string' ? participant.model.trim() : ''
  return model || participant.provider
}

/**
 * Compose the panel. Model seats keep their stored `order`; externals sort into
 * the same space by `seatOrder` when the host has set one, and otherwise land
 * after every model seat in the order they were supplied.
 *
 * Sorting is STABLE on ties (order, then kind, then seatId) so a render and a
 * turn queue built from the same inputs can never disagree — a mismatch there
 * would show one thing and dispatch another.
 */
export function resolveEffectiveRoster(input: {
  participants?: readonly EnsembleParticipant[] | null
  externals?: readonly ExternalSeatInput[] | null
}): EffectiveRoster {
  const participants = Array.isArray(input.participants) ? input.participants : []
  const externals = Array.isArray(input.externals) ? input.externals : []

  const modelSeats: EffectiveModelSeat[] = []
  const seenSeatIds = new Set<string>()
  for (const participant of participants) {
    if (!participant || typeof participant.id !== 'string' || !participant.id) continue
    if (seenSeatIds.has(participant.id)) continue
    seenSeatIds.add(participant.id)
    modelSeats.push({
      kind: 'model',
      seatId: participant.id,
      order: Number.isFinite(participant.order) ? participant.order : modelSeats.length,
      enabled: participant.enabled !== false,
      label: labelForModelSeat(participant),
      participant
    })
  }

  // Externals with no explicit position append AFTER the highest model order,
  // never at 0 — an unpositioned human should not silently pre-empt the panel.
  const maxModelOrder = modelSeats.reduce((max, seat) => Math.max(max, seat.order), -1)
  const externalSeats: EffectiveExternalSeat[] = []
  const collidedExternalSeatIds: string[] = []
  let appendCursor = 0
  for (const external of externals) {
    if (!external || typeof external.collaboratorId !== 'string' || !external.collaboratorId) {
      continue
    }
    const seatId = external.collaboratorId
    if (seenSeatIds.has(seatId)) {
      // A model seat (or an earlier external) already owns this id. Keep the
      // incumbent and report the loser; resolving it silently would let one
      // identity shadow another.
      collidedExternalSeatIds.push(seatId)
      continue
    }
    seenSeatIds.add(seatId)
    const hasExplicitOrder = Number.isFinite(external.seatOrder)
    externalSeats.push({
      kind: 'external',
      seatId,
      shareId: typeof external.shareId === 'string' ? external.shareId : '',
      collaboratorId: seatId,
      order: hasExplicitOrder ? (external.seatOrder as number) : maxModelOrder + 1 + appendCursor++,
      enabled: external.enabled !== false,
      present: external.present !== false,
      label:
        typeof external.displayName === 'string' && external.displayName.trim()
          ? external.displayName.trim()
          : 'External'
    })
  }

  const seats: EffectiveSeat[] = [...modelSeats, ...externalSeats].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    // Model seats win a dead heat: the panel that can actually run comes first.
    if (a.kind !== b.kind) return a.kind === 'model' ? -1 : 1
    return a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0
  })

  return {
    seats,
    modelSeatCount: modelSeats.length,
    enabledModelSeatCount: modelSeats.filter((seat) => seat.enabled).length,
    externalSeatCount: externalSeats.length,
    presentExternalSeatCount: externalSeats.filter((seat) => seat.present).length,
    totalSeatCount: seats.length,
    collidedExternalSeatIds
  }
}

export function isExternalSeat(seat: EffectiveSeat): seat is EffectiveExternalSeat {
  return seat.kind === 'external'
}

/** Seat ids belonging to externals — the set a permission chokepoint must
 * refuse, so an authority grant can never become a permission grant. */
export function externalSeatIds(roster: EffectiveRoster): string[] {
  return roster.seats.filter(isExternalSeat).map((seat) => seat.seatId)
}

/**
 * PRESENTATION ONLY. Does this thread show the panel surfaces — chip strip,
 * roster row, per-speaker transcript naming, participant filter?
 *
 * LANDMINE, and the reason this is spelled out longhand instead of reusing an
 * existing helper: do NOT copy `projectChatKind`, which answers
 * `ensemble?.enabled || participants.length > 0`. Solo records carry STALE
 * `ensemble` blocks — `normalizeChatRecord` declines to re-add one but never
 * DELETES it, and only `setChatKind` strips it explicitly. So that formula
 * reports "ensemble" for ordinary solo chats with no external, no share and no
 * invite anywhere near them. Shipping it as a presentation predicate would flip
 * their composer, chip strip, labelling, Stop button, steer routing and send
 * dispatch onto the ensemble lane.
 *
 * Only two things make a thread present as a panel: the PERSISTED kind, or a
 * live external seat. Never `ensemble?.enabled`, never `participants.length`.
 */
export function chatPresentsAsPanel(
  chat: Pick<ChatRecord, 'chatKind'> | null | undefined,
  presentExternalSeatCount = 0
): boolean {
  if (!chat) return false
  return chat.chatKind === 'ensemble' || presentExternalSeatCount > 0
}

/**
 * ROUTING AND AUTHORITY ONLY. Does this thread DISPATCH as an ensemble — send,
 * Stop, steer, cancel, scheduled-occurrence authority?
 *
 * Deliberately NOT the same question as `chatPresentsAsPanel`, and deliberately
 * NOT interchangeable with it. A shared solo thread presents as a panel while
 * still dispatching as solo; routing a solo send down the ensemble lane because
 * someone joined would break the thread for the host. This one reads the
 * persisted kind and nothing else, forever.
 */
export function chatDispatchesAsEnsemble(
  chat: Pick<ChatRecord, 'chatKind'> | null | undefined
): boolean {
  return chat?.chatKind === 'ensemble'
}
