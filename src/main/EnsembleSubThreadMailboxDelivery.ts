/**
 * EnsembleSubThreadMailboxDelivery — pure helpers for delivering queued
 * sub-thread mailbox events into an Ensemble parent's authority seat
 * (Boss, or Captain while Boss is unavailable).
 *
 * Solo parents already auto-wake via `shouldAutoResumeParent` +
 * `maybeDrainParentSubThreadMailbox`. Ensemble parents intentionally
 * fail that gate (`parentChatIsEnsemble`) so a solo provider continuation
 * cannot hijack round semantics. This module owns the Ensemble-side
 * gate and authority resolution so the main-process drain can wake only
 * the controlling seat when the parent is idle.
 *
 * Invariants (Captain-amended P3 v2):
 * - Never flip `parentChatIsEnsemble` false in `shouldAutoResumeParent`.
 * - Drain only when join-ready AND parent idle AND authority resolvable.
 * - Busy parents retain mailbox events (mirror solo).
 * - Projection-only transcript cards stay audit-only until a delivery ack.
 */

/** Terminal / non-authoritative round statuses that make a Boss seat unavailable. */
const AUTHORITY_TERMINAL_STATUSES = new Set([
  'failed',
  'unreachable',
  'cancelled',
  'skipped'
])

export type EnsembleMailboxRosterParticipant = {
  id: string
  provider: string
  role?: string
  enabled?: boolean
}

export type EnsembleMailboxRoundParticipantState = {
  participantId: string
  status: string
  lastFailureReason?: string
  reason?: string
}

export type ResolveAuthoritySeatInput = {
  bossmanParticipantId?: string | null
  secondInCommandParticipantId?: string | null
  participants: readonly EnsembleMailboxRosterParticipant[]
  /**
   * Soft unavailability (e.g. provider quota wall on Boss's own terminal).
   * Caller evaluates via the shared pure helper so authority consumers cannot
   * drift.
   */
  bossSoftUnavailable?: boolean
  /** Active-round participant rows; only consulted when `roundLive` is true. */
  roundParticipantStates?: readonly EnsembleMailboxRoundParticipantState[]
  /** When true, round-status failure/skip marks Boss unavailable. */
  roundLive?: boolean
}

export type ResolvedAuthoritySeat = {
  participantId: string
  role: 'boss' | 'second_in_command'
  provider: string
  seatRoleLabel: string
  bossUnavailableReason?: string
}

export type ShouldDrainEnsembleMailboxInput = {
  /** `autoResumeParentOnSubThreadCompletion` app setting (default true). */
  autoResumeSetting: boolean
  parentChatExists: boolean
  parentChatIsEnsemble: boolean
  /**
   * True when any provider run is active on the parent chat OR the ensemble
   * round is still dispatch-live (including Continuous mid-hop). Busy parents
   * retain mailbox events.
   */
  parentBusy: boolean
  hasDeliverableEvents: boolean
  authoritySeatResolvable: boolean
  /** Main window + EnsembleOrchestrator available to start a directed round. */
  deliveryRuntimeReady: boolean
}

export type EnsembleParentBusyInput = {
  parentChatHasActiveRun: boolean
  ensembleRoundDispatchLive: boolean
}

/** True when a seat status means that participant cannot own authority. */
export function isAuthorityTerminalStatus(status: string | undefined | null): boolean {
  if (!status) return false
  return AUTHORITY_TERMINAL_STATUSES.has(status)
}

/**
 * Composite idle gate for Ensemble parents. Active provider runs and
 * dispatch-live Continuous/serial rounds both count as busy so delivery
 * cannot interrupt a turn or burn a hop mid-round.
 */
export function isEnsembleParentBusy(input: EnsembleParentBusyInput): boolean {
  return Boolean(input.parentChatHasActiveRun || input.ensembleRoundDispatchLive)
}

function findRosterParticipant(
  participants: readonly EnsembleMailboxRosterParticipant[],
  participantId: string | null | undefined
): EnsembleMailboxRosterParticipant | undefined {
  if (!participantId) return undefined
  return participants.find((participant) => participant.id === participantId)
}

function describeSeat(participant: EnsembleMailboxRosterParticipant): string {
  const role = participant.role?.trim()
  if (role) return role
  return participant.provider || 'participant'
}

function bossHardUnavailable(
  input: ResolveAuthoritySeatInput,
  boss: EnsembleMailboxRosterParticipant | undefined
): { unavailable: boolean; reason?: string } {
  if (!boss) {
    return { unavailable: true, reason: 'no Boss is assigned' }
  }
  if (boss.enabled === false) {
    return {
      unavailable: true,
      reason: `${describeSeat(boss)} is disabled`
    }
  }
  if (input.roundLive) {
    const state = input.roundParticipantStates?.find(
      (participant) => participant.participantId === boss.id
    )
    if (state && isAuthorityTerminalStatus(state.status)) {
      return {
        unavailable: true,
        reason:
          state.lastFailureReason ||
          state.reason ||
          `${describeSeat(boss)} is ${state.status}`
      }
    }
  }
  if (input.bossSoftUnavailable) {
    return {
      unavailable: true,
      reason: `${describeSeat(boss)} hit a provider quota wall`
    }
  }
  return { unavailable: false }
}

/**
 * Resolve the Ensemble authority seat that should receive a sub-thread
 * mailbox continuation.
 *
 * Preference order:
 * 1. Assigned Boss when present, enabled, and not hard/soft-unavailable
 * 2. Captain (second-in-command) only while Boss is unavailable
 * 3. null when neither seat can own delivery
 *
 * BG seats must never appear as bossman/secondInCommand ids for delivery;
 * callers should filter them before assigning those config fields (orchestrator
 * already does). This helper only requires the seat to be on the roster and
 * enabled.
 */
export function resolveAuthoritySeat(
  input: ResolveAuthoritySeatInput
): ResolvedAuthoritySeat | null {
  const boss = findRosterParticipant(input.participants, input.bossmanParticipantId)
  const captain = findRosterParticipant(
    input.participants,
    input.secondInCommandParticipantId
  )
  const primary = bossHardUnavailable(input, boss)

  if (boss && !primary.unavailable) {
    return {
      participantId: boss.id,
      role: 'boss',
      provider: boss.provider,
      seatRoleLabel: describeSeat(boss)
    }
  }

  if (captain && captain.enabled !== false) {
    // Captain must not equal Boss id — dual-role seats keep Boss ownership.
    if (boss && captain.id === boss.id) {
      return null
    }
    return {
      participantId: captain.id,
      role: 'second_in_command',
      provider: captain.provider,
      seatRoleLabel: describeSeat(captain),
      ...(primary.reason ? { bossUnavailableReason: primary.reason } : {})
    }
  }

  return null
}

/**
 * Gate for Ensemble mailbox auto-delivery. False never drops events: the
 * caller leaves `processedAt` null and retries on the next idle drain.
 *
 * Solo parents must use `shouldAutoResumeParent` instead — this gate
 * requires `parentChatIsEnsemble` so a mistaken call cannot dual-path a
 * solo chat through Ensemble delivery.
 */
export function shouldDrainEnsembleMailbox(
  input: ShouldDrainEnsembleMailboxInput
): boolean {
  if (!input.autoResumeSetting) return false
  if (!input.parentChatExists) return false
  if (!input.parentChatIsEnsemble) return false
  if (input.parentBusy) return false
  if (!input.hasDeliverableEvents) return false
  if (!input.authoritySeatResolvable) return false
  if (!input.deliveryRuntimeReady) return false
  return true
}
