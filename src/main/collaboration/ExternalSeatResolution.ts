/**
 * Bridge between the two halves of the effective roster.
 *
 * `src/shared/effectiveEnsembleRoster.ts` knows how model seats and external
 * seats compose, but it is deliberately pure and knows nothing about shares or
 * presence. This module is the only place that turns collaboration state — a
 * share's participants plus their live presence — into the `ExternalSeatInput[]`
 * that resolver expects.
 *
 * Keeping the mapping here rather than inside the shared resolver matters for
 * one reason: the rules about WHICH collaborators hold a seat are collaboration
 * rules, not roster rules, and they are security-adjacent. A revoked
 * participant holds nothing. A pending one has not completed SAS. An expired
 * presence means the grace window ran out. Every one of those is a "no", and
 * they belong next to the store that defines them.
 */

import {
  externalSeatsForShare as sharedExternalSeatsForShare,
  resolveEffectiveRoster,
  type EffectiveRoster,
  type ExternalSeatInput
} from '../../shared/effectiveEnsembleRoster'
import type { EnsembleParticipant } from '../store/types'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import type { HumanCollaborationPresenceState } from './HumanCollaborationPresence'

/** How the caller answers "is this collaborator still here?". Returning
 * `undefined` means "no presence record", which is treated as NOT present —
 * absence of evidence is not evidence of presence. */
export type ResolveCollaboratorPresence = (
  collaboratorId: string
) => HumanCollaborationPresenceState | 'unknown' | undefined

/**
 * External seats for one share.
 *
 * A seat is contributed only for an ACTIVE participant. `present` follows
 * presence: `live` and `grace` both count as present, because the whole point of
 * the grace window is that a reconnecting collaborator does not vanish from the
 * panel mid-reconnect. `expired` and `unknown` do not.
 *
 * A muted seat (`seatDisabled`) still appears and still holds its position — it
 * is presentation, not removal. That is deliberately different from revocation,
 * which withdraws trust and yields no seat at all.
 */
export function externalSeatsForShare(
  share: HumanCollaborationShare | null | undefined,
  resolvePresence?: ResolveCollaboratorPresence
): ExternalSeatInput[] {
  // Delegates to the shared implementation. The mapping RULES documented above
  // are unchanged and still belong with the store that defines them — but the
  // renderer needs the same mapping for the chip strip, and a main-process
  // import from the renderer is the exact edge the architecture guard forbids.
  // One implementation, structurally typed, reachable from both processes.
  return sharedExternalSeatsForShare(share, resolvePresence)
}

/**
 * Does this chat have an approval authority that is NOT an external human?
 *
 * A configured Boss is mandatory; configured Captains are fallback seats. An
 * authority held by an external is no authority at all for permission
 * purposes: externals never receive approval prompts, so consent recorded
 * against one would auto-allow other seats on the strength of somebody who is
 * never asked.
 *
 * FAILS CLOSED on an unknown external set (`externalSeatIds: null`). Both
 * callers use `true` to PERMIT — an unattended auto-approval, and the enable
 * door for auto-approvals — so answering `true` while unable to enumerate
 * externals elevates on an authority nobody verified. This deliberately
 * replaces the previous fail-OPEN behaviour, whose premise was that the gate
 * is only reachable during a live run where an external id cannot satisfy a
 * roster check. That premise defends the id, not the decision, and the
 * Channel-native seat authority can legitimately answer "recovery blocked" —
 * a real unknown that must not read as "no externals exist".
 *
 * Structural input, not `ChatRecord`: permission gates run on hot paths and
 * some callers hold only a summary.
 */
export function hasNonExternalApprovalAuthority(input: {
  ensemble?: {
    bossmanParticipantId?: string
    captainParticipantIds?: string[]
    secondInCommandParticipantId?: string
  } | null
  /** `null` means "cannot enumerate externals" — never "there are none". */
  externalSeatIds: readonly string[] | null
}): boolean {
  const ensemble = input.ensemble ?? null
  if (!ensemble) return false
  const boss = ensemble.bossmanParticipantId
  if (!boss) return false
  const captains = Array.isArray(ensemble.captainParticipantIds)
    ? ensemble.captainParticipantIds
    : ensemble.secondInCommandParticipantId
      ? [ensemble.secondInCommandParticipantId]
      : []
  const assigned = [boss, ...captains].filter((id): id is string => Boolean(id))
  if (assigned.length === 0) return false
  if (input.externalSeatIds === null) return false
  const externals = new Set(input.externalSeatIds)
  return assigned.some((id) => !externals.has(id))
}

/**
 * The effective roster for one chat: its model seats plus its share's externals.
 *
 * The chat argument is intentionally a narrow structural type rather than
 * `ChatRecord` — resolving a roster must never require materialising a whole
 * chat, because the callers that need it most (permission gates, projection
 * builds) run on hot paths and some of them only hold a summary.
 */
export function resolveChatEffectiveRoster(input: {
  participants?: readonly EnsembleParticipant[] | null
  share?: HumanCollaborationShare | null
  resolvePresence?: ResolveCollaboratorPresence
}): EffectiveRoster {
  return resolveEffectiveRoster({
    participants: input.participants ?? [],
    externals: externalSeatsForShare(input.share, input.resolvePresence)
  })
}
