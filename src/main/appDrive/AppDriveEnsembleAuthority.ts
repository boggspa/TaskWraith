import type { EnsembleAuthorityRole } from '../../shared/ensembleAuthority'

/**
 * Who, inside an Ensemble, may put a running process under agent control.
 *
 * Driving a real app window is a control action, not ordinary lane work, so in
 * a multi-participant thread it belongs to the Boss and its Captains. A solo
 * thread has nobody to rank and is unaffected.
 *
 * Authority is decided by participant-ID equality against the roster's
 * `bossmanParticipantId` / captain ids — never by `role` or `stageRole`. Those
 * are patchable by participants through `ensemble_roster_edit`, so gating on
 * them would let a seat award itself the authority this check exists to
 * withhold. Every other authority check in the app reads the ids for the same
 * reason.
 */

export interface AppDriveEnsembleRoster {
  readonly bossmanParticipantId?: string
  readonly captainParticipantIds?: readonly string[]
  /** Pre-dates multi-captain rosters; still present on older chats. */
  readonly secondInCommandParticipantId?: string
}

export interface AppDriveEnsembleAuthorityInput {
  /** Absent or null for a solo thread. */
  readonly ensemble?: AppDriveEnsembleRoster | null
  /** The participant whose run is making the call. */
  readonly callerParticipantId?: string | null
}

export type AppDriveEnsembleAuthorityResult =
  | { readonly ok: true; readonly authorityRole?: EnsembleAuthorityRole }
  | { readonly ok: false; readonly reason: string }

const REFUSAL =
  'In an Ensemble thread, only the Boss or a Captain may put a process under agent control. Ask the Boss to run this, or ask the user to do it.'

export function resolveAppDriveEnsembleAuthority(
  input: AppDriveEnsembleAuthorityInput | null | undefined
): AppDriveEnsembleAuthorityResult {
  const roster = isRecord(input?.ensemble) ? (input.ensemble as AppDriveEnsembleRoster) : null
  // A solo thread has no roster and therefore no authority ranking to enforce.
  if (!roster) return { ok: true }

  const boss = canonical(roster.bossmanParticipantId)
  // An Ensemble with no Boss cannot prove anyone holds authority, so nobody does.
  if (!boss) {
    return {
      ok: false,
      reason: 'This Ensemble has no Boss assigned, so no participant holds App Drive authority.'
    }
  }

  const caller = canonical(input?.callerParticipantId)
  if (!caller) return { ok: false, reason: REFUSAL }

  const captains = Array.isArray(roster.captainParticipantIds)
    ? roster.captainParticipantIds
    : roster.secondInCommandParticipantId
      ? [roster.secondInCommandParticipantId]
      : []
  if (caller === boss) return { ok: true, authorityRole: 'boss' }
  const captainIds = new Set(captains.map(canonical).filter(Boolean) as string[])
  return captainIds.has(caller)
    ? { ok: true, authorityRole: 'captain' }
    : { ok: false, reason: REFUSAL }
}

function canonical(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
