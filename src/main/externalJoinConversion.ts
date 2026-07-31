/**
 * Convert a shared thread to an Ensemble when an external human joins it.
 *
 * WHY THE THREAD CONVERTS AT ALL. An approved external contribution is
 * delivered at that person's SEAT TURN, and a seat turn only exists inside a
 * round. A solo thread has no rounds, so a shared solo thread must genuinely
 * become an Ensemble or an external can never take a turn. This reverses an
 * earlier "derive the panel, never flip `chatKind`" rule, deliberately and with
 * the user's confirmation (2026-07-31). The ROSTER still derives — externals are
 * never rows in `chat.ensemble.participants` — only the KIND flips.
 *
 * WHY A PENDING MARKER. `AppStore.setChatKind` throws while a run streams or an
 * ensemble round is live, because flipping the kind mid-turn would swap the
 * whole dispatch model out from under an in-flight run. A join must never fail
 * for that reason — the person on the other end did nothing wrong and has no way
 * to retry usefully — so a join during a live turn QUEUES the conversion here
 * and the next turn boundary applies it.
 *
 * WHY THE SEED IS BAKED AT QUEUE TIME. Converting solo → ensemble needs a seat
 * to seed the roster from, and every existing caller gets one from the renderer.
 * A relay join has no renderer at all. The seed is therefore built main-side
 * from the chat's own provider, which is honestly lower fidelity than the
 * renderer's: it carries provider and model, but not the composer's live
 * reasoning effort, permission preset, runtime profile or auth profile. Baking
 * it when the join happens — rather than when the marker drains — means the
 * conversion reflects the chat as it was at the moment somebody joined it.
 *
 * IDEMPOTENCY IS KEYED ON CHAT STATE, NEVER ON THE HANDSHAKE. A reconnect is a
 * join-shaped event that fires on every tab reload and network roam, and a first
 * join whose conversion was DEFERRED arrives next as a reconnect and must still
 * convert. Keying on "was this an admission or a reconnect" gets both cases
 * wrong in opposite directions. Ask the chat instead.
 *
 * Pure and node-free: never mutates its input, never sets `updatedAt`, never
 * touches messages, runs or the ensemble block. Callers own persistence.
 */
import type { ChatRecord, EnsembleParticipant } from './store/types'

export const PENDING_EXTERNAL_JOIN_CONVERSION_KEY = 'pendingExternalJoinConversion'

export interface PendingExternalJoinConversion {
  schemaVersion: 1
  /** Who caused it. Diagnostic only — never authority. */
  collaboratorId: string
  shareId: string
  queuedAt: string
  /** Baked at queue time; see the header for why, and what it costs. */
  seedParticipant: EnsembleParticipant
}

export function readPendingExternalJoinConversion(
  chat: Pick<ChatRecord, 'providerMetadata'> | null | undefined
): PendingExternalJoinConversion | null {
  const value = chat?.providerMetadata?.[PENDING_EXTERNAL_JOIN_CONVERSION_KEY]
  if (!value || typeof value !== 'object') return null
  const plan = value as PendingExternalJoinConversion
  const valid =
    plan.schemaVersion === 1 &&
    typeof plan.collaboratorId === 'string' &&
    Boolean(plan.collaboratorId) &&
    typeof plan.shareId === 'string' &&
    Boolean(plan.shareId) &&
    typeof plan.queuedAt === 'string' &&
    Boolean(plan.seedParticipant) &&
    typeof plan.seedParticipant === 'object' &&
    typeof plan.seedParticipant.provider === 'string'
  return valid ? plan : null
}

export function hasPendingExternalJoinConversion(
  chat: Pick<ChatRecord, 'providerMetadata'> | null | undefined
): boolean {
  return readPendingExternalJoinConversion(chat) !== null
}

export function queuePendingExternalJoinConversion(
  chat: ChatRecord,
  plan: PendingExternalJoinConversion
): ChatRecord {
  return {
    ...chat,
    providerMetadata: {
      ...(chat.providerMetadata || {}),
      [PENDING_EXTERNAL_JOIN_CONVERSION_KEY]: plan
    }
  }
}

/**
 * Drop the marker, and the whole metadata bag when it was the only thing in it.
 *
 * Deliberately its own function rather than reusing the roster-preset path's
 * `withoutPendingMetadata`: that one strips exactly three OTHER keys and would
 * leave this marker behind, so a roster-preset finalize must not be mistaken for
 * having cleared this one.
 */
export function clearPendingExternalJoinConversion(chat: ChatRecord): ChatRecord {
  if (!chat.providerMetadata || !(PENDING_EXTERNAL_JOIN_CONVERSION_KEY in chat.providerMetadata)) {
    return chat
  }
  const { [PENDING_EXTERNAL_JOIN_CONVERSION_KEY]: _dropped, ...rest } = chat.providerMetadata
  return {
    ...chat,
    providerMetadata: Object.keys(rest).length > 0 ? rest : undefined
  }
}

/**
 * Does this chat still need converting?
 *
 * The single idempotency question, asked of chat state. An already-ensemble chat
 * answers no however it got there — a second collaborator joining a converted
 * thread, a reconnect, or a host who turned the panel on themselves.
 */
export function chatNeedsExternalJoinConversion(
  chat: Pick<ChatRecord, 'chatKind'> | null | undefined
): boolean {
  if (!chat) return false
  return chat.chatKind !== 'ensemble'
}
