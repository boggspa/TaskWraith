/**
 * Host-safe active-goal contract.
 *
 * The App authors goals and writes them onto chat records; the standalone Node
 * Host reads those same records. For the Host to honour a goal it needs the
 * goal's facts and two pure rules — whether the goal binds this run, and how it
 * is phrased to a provider.
 *
 * Those rules live HERE rather than in src/main/GoalState.ts because the Host
 * Node closure forbids importing the Electron main bundle, and they are MOVED
 * rather than copied because a second implementation would drift from the
 * authority that writes the records: the App and the Host would then disagree
 * about whether a goal binds, which is exactly the failure a shared contract
 * exists to prevent. src/main/GoalState.ts delegates to this module.
 *
 * The shapes are structural on purpose. The App's richer ActiveGoal is
 * assignable to them, so no goal type had to leave the store's ownership.
 */

import {
  activeGoalModeLabel,
  type ActiveGoalPresentationMode
} from '../shared/activeGoalPresentation'

export type HostActiveGoalStatus = 'active' | 'paused' | 'blocked' | 'completed'

export interface HostGoalRuntimeLedgerIntervalFacts {
  readonly status: string
  readonly startedAt: string
  readonly endedAt?: string
}

export interface HostGoalRuntimeLedgerFacts {
  readonly startedAt: string
  readonly endedAt?: string
  readonly intervals: readonly HostGoalRuntimeLedgerIntervalFacts[]
}

/** The goal facts these rules read. The App's ActiveGoal satisfies this. */
export interface HostActiveGoalFacts {
  readonly objective: string
  readonly status: HostActiveGoalStatus
  readonly mode: ActiveGoalPresentationMode
  readonly blockedReason?: string
  readonly runtimeLedger?: HostGoalRuntimeLedgerFacts
}

export interface HostGoalRuntimeTiming {
  activeMs: number
  wallMs: number
  pausedMs: number
  blockedMs: number
}

export type HostGoalTimestampInput = Date | string | number

/**
 * Whether a goal binds the next run. Native provider modes are excluded because
 * the provider owns its own goal loop there — injecting a second objective
 * block would have TaskWraith and the provider steering the same run.
 */
export function hostShouldInjectActiveGoal(
  goal: HostActiveGoalFacts | null | undefined
): goal is HostActiveGoalFacts {
  return Boolean(
    goal &&
    (goal.status === 'active' || goal.status === 'blocked') &&
    goal.mode !== 'codex_native' &&
    goal.mode !== 'claude_native' &&
    goal.mode !== 'grok_native'
  )
}

/** The exact objective block the App injects, so a Host run reads identically. */
export function hostFormatActiveGoalPromptBlock(goal: HostActiveGoalFacts): string {
  const statusLine =
    goal.status === 'blocked' && goal.blockedReason
      ? `Status: blocked — ${goal.blockedReason}`
      : `Status: ${goal.status}`
  return [
    '<taskwraith_active_goal>',
    `Provider mode: ${activeGoalModeLabel(goal.mode)}`,
    statusLine,
    'Objective:',
    goal.objective,
    '',
    'Rules:',
    '- Treat this as the current thread objective and stopping condition.',
    '- Do not replace, clear, or silently reinterpret the objective; the user owns it.',
    '- Use goal_read to inspect the objective and goal_complete or goal_blocked when the objective is achieved or genuinely blocked.',
    '- todo_write may publish visible steps, but it does not complete the active goal.',
    '- If the user asks for work that conflicts with this goal, ask before switching objectives.',
    '</taskwraith_active_goal>'
  ].join('\n')
}

function hostGoalTimestamp(value: HostGoalTimestampInput): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

/** The latest moment an OPEN interval may run to: now, or the thread's last activity. */
function hostGoalLiveEndAt(nowAt: string, lastActivityAt?: HostGoalTimestampInput): string {
  if (lastActivityAt === undefined) return nowAt
  const lastAt = hostGoalTimestamp(lastActivityAt)
  const lastMs = Date.parse(lastAt)
  const nowMs = Date.parse(nowAt)
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return nowAt
  return lastMs < nowMs ? lastAt : nowAt
}

function hostGoalDurationMs(startedAt: string, endedAt: string): number {
  const startMs = Date.parse(startedAt)
  const endMs = Date.parse(endedAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0
  return endMs - startMs
}

export interface HostGoalRuntimeTimingOptions {
  /**
   * When the goal's thread last did anything. An OPEN interval is only extended
   * this far, never to `now`.
   *
   * Nothing closes an interval except an explicit pause / block / complete, so
   * a goal left `active` on an abandoned thread otherwise counts forever.
   * Measured on a live profile: four such goals, one reading 18.8 days of
   * "active" time on a thread idle for 17.7 days, and one reading 12.8 days on
   * a thread that had never had a single run. A goal cannot have been working
   * after its thread stopped changing, so that is the ceiling.
   *
   * Omitted means "no last-activity fact available", which leaves the old
   * unbounded behaviour rather than silently freezing a live goal at zero.
   */
  readonly lastActivityAt?: HostGoalTimestampInput
}

/** Durable wall-clock accounting for a goal's active/paused/blocked intervals. */
export function hostComputeGoalRuntimeTiming(
  ledger: HostGoalRuntimeLedgerFacts | null | undefined,
  now: HostGoalTimestampInput = new Date(),
  options: HostGoalRuntimeTimingOptions = {}
): HostGoalRuntimeTiming {
  if (!ledger) {
    return { activeMs: 0, wallMs: 0, pausedMs: 0, blockedMs: 0 }
  }

  const timestamp = hostGoalTimestamp(now)
  // The clamp is a ceiling on the LIVE tail only. A closed interval and a ledger
  // that recorded its own `endedAt` are durable facts and are never rewritten.
  const effectiveEndAt = ledger.endedAt || hostGoalLiveEndAt(timestamp, options.lastActivityAt)
  const timing: HostGoalRuntimeTiming = {
    activeMs: 0,
    wallMs: hostGoalDurationMs(ledger.startedAt, effectiveEndAt),
    pausedMs: 0,
    blockedMs: 0
  }

  for (const interval of ledger.intervals) {
    const intervalEndAt = interval.endedAt || effectiveEndAt
    const durationMs = hostGoalDurationMs(interval.startedAt, intervalEndAt)
    if (interval.status === 'active') timing.activeMs += durationMs
    else if (interval.status === 'paused') timing.pausedMs += durationMs
    else if (interval.status === 'blocked') timing.blockedMs += durationMs
  }

  return timing
}
