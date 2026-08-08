/**
 * Host Arc Track3 Mixed Wave A — ChatRecord.activeGoal shadow → Host missions.
 *
 * WHAT THIS IS. Desktop goals live on ChatRecord.activeGoal. Host mission
 * cards on the wire reuse the goal id as missionId (dual-stamped as goalId)
 * so clients can join. This adapter owns the allowlisted mapping into
 * HostMissionProjection without importing electron, AppStore, or goal
 * store symbols.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / GoalState value imports;
 * - constructs allowlisted HostMissionProjection fields only;
 * - never forwards objectiveSource, mode, provider, ledger intervals,
 *   blockedReason, or completion summaries onto the wire;
 * - never invents threadId / activeRoundId (optional — omit when absent).
 *
 * HONESTY:
 * - ActiveGoalStatus `paused` has no HostMissionOutcome twin — mapped
 *   explicitly to `blocked` (never invent completed);
 * - unrecognized statuses map to `unknown`, not to a terminal outcome;
 * - updatedAt is parsed from ISO — unparseable rows are skipped;
 * - a throwing listGoals propagates (fail closed, never a false empty);
 * - every listMissions call re-reads (no cache of a moving set).
 */

import type { HostMissionOutcome, HostMissionProjection } from '../../shared/hostProtocol'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_MISSION_ID_MAX = 512
/** Title bound — matches decode ceiling HOST_PROTOCOL_MAX_SHORT. */
const HOST_MISSION_TITLE_MAX = 200

/**
 * Thin activeGoal-shaped row the composition root adapts from
 * ChatRecord.activeGoal (+ chat id / round id when known). Deliberately
 * narrow so this module never pulls store symbols.
 */
export interface HostActiveGoalShadowEntry {
  /** ActiveGoal.id — becomes missionId and dual-stamped goalId. */
  readonly id: string
  /** ActiveGoal.objective → bounded title. */
  readonly objective: string
  /**
   * ActiveGoal / GoalRuntimeLedger status string.
   * Known: active|paused|blocked|completed|cancelled|failed.
   */
  readonly status: string
  /** ISO-8601 ActiveGoal.updatedAt; parsed to updatedAt ms. */
  readonly updatedAt: string
  /** Chat id when known — optional on the wire. */
  readonly threadId?: string
  /** Ensemble active round id when known — optional on the wire. */
  readonly activeRoundId?: string
}

export interface HostProductionMissionShadowDeps {
  listGoals: () => readonly HostActiveGoalShadowEntry[]
}

/**
 * Optional missions port for createHostProductionBootstrap /
 * createHostProductionSuppliers (Wave B wiring). Defined here so Wave A
 * can land without touching Suppliers.
 */
export interface HostProductionMissionListPort {
  listMissions(): HostMissionProjection[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function parseUpdatedAtMs(updatedAt: string): number | null {
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) return null
  const ms = Date.parse(updatedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.floor(ms)
}

/**
 * Map ActiveGoal-like status onto HostMissionOutcome.
 *
 * `paused` is the skew case: Host has no twin. Map to `blocked` so a
 * held goal is never painted as completed. Unrecognized → `unknown`.
 */
export function mapActiveGoalStatusToHostMissionOutcome(status: string): HostMissionOutcome {
  switch (status) {
    case 'active':
      return 'active'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'paused':
      // Explicit pin: paused ≠ completed. Closest non-terminal hold.
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

/**
 * Map activeGoal-shaped entries into allowlisted HostMissionProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionMissionShadow}.
 */
export function mapActiveGoalShadowsToHostMissions(
  entries: readonly HostActiveGoalShadowEntry[]
): HostMissionProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostMissionProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.id)) continue
    if (entry.id.length > HOST_MISSION_ID_MAX) continue

    const objective =
      typeof entry.objective === 'string' && entry.objective.trim().length > 0
        ? entry.objective.trim()
        : ''
    if (objective.length === 0) continue

    if (typeof entry.status !== 'string' || entry.status.trim().length === 0) continue

    const updatedAt = parseUpdatedAtMs(entry.updatedAt)
    if (updatedAt === null) continue

    // ALLOWLIST REBUILD: only these fields reach the wire.
    const row: HostMissionProjection = {
      missionId: entry.id,
      title: boundText(objective, HOST_MISSION_TITLE_MAX),
      status: mapActiveGoalStatusToHostMissionOutcome(entry.status.trim()),
      updatedAt,
      goalId: entry.id
    }
    if (isUsableId(entry.threadId) && entry.threadId.length <= HOST_MISSION_ID_MAX) {
      row.threadId = entry.threadId
    }
    if (isUsableId(entry.activeRoundId) && entry.activeRoundId.length <= HOST_MISSION_ID_MAX) {
      row.activeRoundId = entry.activeRoundId
    }
    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `missions` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionMissionShadow(
  deps: HostProductionMissionShadowDeps
): HostProductionMissionListPort {
  if (!deps || typeof deps.listGoals !== 'function') {
    throw new Error('HostProductionMissionShadow requires listGoals to be a function')
  }
  return {
    listMissions(): HostMissionProjection[] {
      // Live read every call — no caching of a moving goal set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapActiveGoalShadowsToHostMissions(deps.listGoals())
    }
  }
}
