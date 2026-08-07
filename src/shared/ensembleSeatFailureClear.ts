/**
 * Stale-failure reset for authoritative Ensemble seat changes.
 *
 * A participant's `failed` / `unreachable` round status deliberately persists
 * after the round ends (the chip strip keeps the warning up so the user knows
 * the seat needs attention). But once the user — or an authoritative panel
 * member via the orchestrator's seat-change path — changes the seat's
 * EXECUTION config (provider, model, reasoning, runtime profile, permissions,
 * auth profile, …), that warning describes a config that no longer exists:
 * it is a false alarm until the seat actually fails again.
 *
 * Both writers of a seat change route through here:
 *   - EnsembleOrchestrator.applyParticipantSeatChangeToChat (live-round
 *     immediate applies, execution-boundary applies of queued changes, and
 *     Boss/Captain-initiated authoritative changes),
 *   - App.tsx patchParticipantImmediate (post-round composer edits, when no
 *     runtime exists and the renderer patches the chat directly).
 *
 * Participant state is RESET (failed/unreachable → idle, reasons wiped) —
 * safe mid-round because dispatch order lives in the runtime's in-memory
 * queue, not in these statuses; the only behavioural effect is that explicit
 * routing (Boss targeting, follow-ups) can reach the fixed seat again, which
 * is the point. Lanes are NOT reset: a lane's terminal status is the factual
 * record of an attempt, so a superseded failure is STAMPED
 * (`failureSupersededBySeatChangeAt`) and presentation surfaces suppress the
 * paint instead.
 */
import type { ConcurrentLane, EnsembleParticipant, EnsembleRoundState } from '../main/store/types'

/**
 * The seat fields that change what a dispatch actually runs. Identity and
 * wording (role, instructions, stage, order, enabled) stay out: renaming a
 * seat fixes nothing. `linkedProviderSessionId` stays out on purpose — the
 * orchestrator's own seat-change path nulls it as a side effect of provider
 * re-application, and session adoption rotates it automatically after runs;
 * treating it as an execution change would clear real failures behind the
 * user's back.
 */
export const ENSEMBLE_SEAT_EXECUTION_CONFIG_FIELDS = [
  'provider',
  'model',
  'reasoningEffort',
  'fastModeEnabled',
  'thinkingEnabled',
  'serviceTier',
  'permissionPresetId',
  'permissionOverrides',
  'geminiAuthProfileId',
  'runtimeProfileId',
  'ollamaRunProfile'
] as const satisfies readonly (keyof EnsembleParticipant)[]

export function ensembleSeatExecutionConfigChanged(
  before: EnsembleParticipant,
  after: EnsembleParticipant
): boolean {
  return ENSEMBLE_SEAT_EXECUTION_CONFIG_FIELDS.some((field) => before[field] !== after[field])
}

const CLEARABLE_PARTICIPANT_STATUSES: ReadonlySet<string> = new Set(['failed', 'unreachable'])
/** Terminal lane failures; live statuses stay untouched so in-flight paint
 * (and cancel bookkeeping) is never disturbed. */
const CLEARABLE_LANE_STATUSES: ReadonlySet<ConcurrentLane['status']> = new Set([
  'failed',
  'blocked'
])

export function isLaneFailureSupersededBySeatChange(lane: ConcurrentLane): boolean {
  return Boolean(lane.failureSupersededBySeatChangeAt && CLEARABLE_LANE_STATUSES.has(lane.status))
}

/**
 * Returns the round with the participant's stale failure cleared, or the SAME
 * round reference when there is nothing to clear — callers use identity to
 * skip pointless rewrites.
 */
export function clearEnsembleRoundFailureForSeatChange(
  round: EnsembleRoundState | undefined,
  participantId: string,
  nowIso: string
): EnsembleRoundState | undefined {
  if (!round) return round
  let changed = false
  const participants = round.participants.map((state) => {
    if (state.participantId !== participantId) return state
    if (!CLEARABLE_PARTICIPANT_STATUSES.has(state.status)) return state
    changed = true
    return {
      ...state,
      status: 'idle' as const,
      reason: undefined,
      lastFailureReason: undefined
    }
  })
  let lanes = round.lanes
  if (round.lanes) {
    const nextLanes: Record<string, ConcurrentLane> = {}
    let lanesChanged = false
    for (const [laneId, lane] of Object.entries(round.lanes)) {
      if (
        lane.participantId === participantId &&
        CLEARABLE_LANE_STATUSES.has(lane.status) &&
        !lane.failureSupersededBySeatChangeAt
      ) {
        nextLanes[laneId] = { ...lane, failureSupersededBySeatChangeAt: nowIso }
        lanesChanged = true
      } else {
        nextLanes[laneId] = lane
      }
    }
    if (lanesChanged) {
      lanes = nextLanes
      changed = true
    }
  }
  return changed ? { ...round, participants, lanes } : round
}
