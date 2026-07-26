/*
 * ensembleRosterFloor — the "an Ensemble is a panel, not one agent" rule,
 * renderer side.
 *
 * A one-seat roster gives the user every cost of Ensemble mode (chip strip,
 * roster presets, orchestration row, round cards, per-round synthesis) and none
 * of its benefit: there is nobody to disagree with. So the live floor is TWO,
 * enforced from both ends —
 *
 *   ON  — `AppStore.setChatKind` tops a solo→Ensemble conversion up to the
 *         floor (`withMinimumEnsembleRoster` in main's EnsembleDefaults), so
 *         switching the mode on always lands on a real panel.
 *   OFF — removing a seat that would drop the roster below the floor switches
 *         Ensemble off instead of persisting the degenerate roster, handing the
 *         thread to whichever seat survives.
 *
 * EXEMPT, deliberately: rosters an Agent states explicitly. The MCP roster edit
 * allows removal down to one seat (`EnsembleRosterMutation`'s E4 note) and a
 * roster preset may hold one (`MIN_ROSTER_PRESET_PARTICIPANTS`). Neither routes
 * through `setChatKind` or the chip strip, so neither is topped up or collapsed
 * behind the caller's back. Such a roster still LIVES at one seat — the user
 * can end it from the chip strip or the Ensemble toggle, but nothing does it
 * for them.
 */

import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

/** Mirrors `MIN_LIVE_ENSEMBLE_PARTICIPANTS` in `src/main/EnsembleDefaults.ts`. */
export const MIN_LIVE_ENSEMBLE_PARTICIPANTS = 2

/**
 * Which seat inherits the thread when removing `removedId` would leave the
 * roster below the floor, or `null` when the removal is an ordinary one the
 * roster can absorb.
 *
 * At two seats that is the OTHER seat — the panel becomes a solo chat on the
 * agent the user chose to keep. At one seat (an exempt roster, or a chat that
 * predates the floor) there is no other seat, so the sole participant carries
 * its own model + permissions across: removing the last chip means "no more
 * panel", not "no more agent".
 */
export function resolveEnsembleCollapseTarget(
  participants: readonly EnsembleParticipant[],
  removedId: string
): EnsembleParticipant | null {
  if (!participants.some((participant) => participant.id === removedId)) return null
  if (participants.length > MIN_LIVE_ENSEMBLE_PARTICIPANTS) return null
  return (
    participants.find((participant) => participant.id !== removedId) ||
    participants.find((participant) => participant.id === removedId) ||
    null
  )
}

/**
 * The one seat an Ensemble-off toggle can only possibly resolve to, or `null`
 * when the user genuinely has a choice and the canonical-provider modal should
 * open.
 *
 * "Only possibly" is stricter than "one participant": the modal also offers the
 * chat's own `provider` when no seat uses it, so a lone seat on a DIFFERENT
 * provider than the thread still leaves two candidates and still asks. Seats
 * are compared by provider, not by count — a two-Claude panel has one provider
 * but two distinct configurations, and picking either behind the user's back
 * would silently drop the other's model/reasoning.
 */
export function resolveSoleEnsembleSoloCandidate(
  chat: Pick<ChatRecord, 'chatKind' | 'ensemble' | 'provider'>
): EnsembleParticipant | null {
  if (chat.chatKind !== 'ensemble') return null
  const participants = chat.ensemble?.participants
  if (!Array.isArray(participants) || participants.length !== 1) return null
  const [sole] = participants
  if (chat.provider && chat.provider !== sole.provider) return null
  return sole
}
