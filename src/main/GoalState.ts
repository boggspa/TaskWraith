import { activeGoalModeLabel } from '../shared/activeGoalPresentation'
import {
  hostComputeGoalRuntimeTiming,
  hostFormatActiveGoalPromptBlock,
  hostShouldInjectActiveGoal
} from '../host-shared/ActiveGoalContract'
import type {
  ActiveGoal,
  ActiveGoalMode,
  ActiveGoalObjectiveSource,
  ActiveGoalSpecification,
  ActiveGoalStatus,
  GoalRuntimeLedger,
  GoalRuntimeLedgerInterval,
  GoalRuntimeLedgerStatus,
  ProviderId
} from './store/types'

export { activeGoalModeLabel }

export const MAX_ACTIVE_GOAL_OBJECTIVE_CHARS = 4000
export const MAX_ACTIVE_GOAL_REASON_CHARS = 800
export const MAX_ACTIVE_GOAL_ACCEPTANCE_CRITERIA = 24
export const MAX_ACTIVE_GOAL_ACCEPTANCE_CRITERION_CHARS = 1000

export function normalizeActiveGoalObjective(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.trim().slice(0, MAX_ACTIVE_GOAL_OBJECTIVE_CHARS)
}

export function normalizeActiveGoalReason(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.trim().slice(0, MAX_ACTIVE_GOAL_REASON_CHARS)
}

export function normalizeActiveGoalSpecification(
  value: unknown
): ActiveGoalSpecification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'user_prompt' && kind !== 'expected_outcome' && kind !== 'approved_plan') {
    return undefined
  }
  const sourceMessageId = String(record.sourceMessageId || '')
    .trim()
    .slice(0, 512)
  const intendedPlanId = String(record.intendedPlanId || '')
    .trim()
    .slice(0, 512)
  const acceptanceCriteria = Array.isArray(record.acceptanceCriteria)
    ? [
        ...new Set(
          record.acceptanceCriteria
            .map((criterion) => String(criterion || '').trim())
            .filter(Boolean)
            .map((criterion) => criterion.slice(0, MAX_ACTIVE_GOAL_ACCEPTANCE_CRITERION_CHARS))
        )
      ].slice(0, MAX_ACTIVE_GOAL_ACCEPTANCE_CRITERIA)
    : []
  return {
    kind,
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(intendedPlanId ? { intendedPlanId } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {})
  }
}

export function resolveActiveGoalMode(
  provider: ProviderId,
  options: {
    codexNativeAvailable?: boolean
    claudeNativeAvailable?: boolean
    grokNativeAvailable?: boolean
    allowProviderNative?: boolean
  } = {}
): ActiveGoalMode {
  if (options.allowProviderNative === false) return 'taskwraith_steered'
  if (provider === 'codex' && options.codexNativeAvailable) return 'codex_native'
  if (provider === 'claude' && options.claudeNativeAvailable) return 'claude_native'
  if (provider === 'grok' && options.grokNativeAvailable) return 'grok_native'
  if (provider === 'ollama') return 'ollama_harness'
  return 'taskwraith_steered'
}

export function resolveActiveGoalForProvider(
  goal: ActiveGoal | null | undefined,
  provider: ProviderId,
  options: {
    codexNativeAvailable?: boolean
    claudeNativeAvailable?: boolean
    grokNativeAvailable?: boolean
    allowProviderNative?: boolean
  } = {}
): ActiveGoal | null {
  if (!goal) return null
  const mode = resolveActiveGoalMode(provider, options)
  if (goal.provider === provider && goal.mode === mode) return goal
  return { ...goal, provider, mode }
}

export interface GoalRuntimeTiming {
  activeMs: number
  wallMs: number
  pausedMs: number
  blockedMs: number
}

export type GoalRuntimeTimestampInput = Date | string | number

export function createGoalRuntimeLedger(
  now: GoalRuntimeTimestampInput = new Date()
): GoalRuntimeLedger {
  const startedAt = goalRuntimeTimestamp(now)
  return {
    startedAt,
    intervals: [{ status: 'active', startedAt }]
  }
}

export function transitionGoalRuntimeLedger(
  ledger: GoalRuntimeLedger | null | undefined,
  status: GoalRuntimeLedgerStatus,
  now: GoalRuntimeTimestampInput = new Date()
): GoalRuntimeLedger {
  const timestamp = goalRuntimeTimestamp(now)
  const base = ledger ? cloneGoalRuntimeLedger(ledger) : createGoalRuntimeLedger(timestamp)
  if (base.intervals.length === 0) {
    base.intervals.push({ status: 'active', startedAt: base.startedAt })
  }

  if (status === 'completed' || status === 'cancelled') {
    if (base.endedAt) return base
    closeOpenGoalRuntimeInterval(base.intervals, timestamp)
    return {
      ...base,
      endedAt: timestamp,
      endStatus: status
    }
  }

  const intervals = base.intervals
  const open = intervals[intervals.length - 1]
  if (!open || open.endedAt) {
    intervals.push({ status, startedAt: timestamp })
  } else if (open.status !== status) {
    open.endedAt = timestamp
    intervals.push({ status, startedAt: timestamp })
  }

  delete base.endedAt
  delete base.endStatus
  return base
}

export function computeGoalRuntimeTiming(
  ledger: GoalRuntimeLedger | null | undefined,
  now: GoalRuntimeTimestampInput = new Date()
): GoalRuntimeTiming {
  return hostComputeGoalRuntimeTiming(ledger, now)
}

export function createActiveGoal(
  provider: ProviderId,
  objective: string,
  options: {
    now?: Date
    codexNativeAvailable?: boolean
    claudeNativeAvailable?: boolean
    grokNativeAvailable?: boolean
    allowProviderNative?: boolean
    /** Omit for legacy/unknown callers. Callers that accept a human's goal
     * text must label it `user`; agent control actions must label it `agent`. */
    objectiveSource?: ActiveGoalObjectiveSource
    specification?: ActiveGoalSpecification
  } = {}
): ActiveGoal {
  const now = options.now || new Date()
  const timestamp = now.toISOString()
  const normalizedObjective = normalizeActiveGoalObjective(objective)
  if (!normalizedObjective) {
    throw new Error('Goal objective is required.')
  }
  const specification =
    normalizeActiveGoalSpecification(options.specification) ||
    (options.objectiveSource === 'user' ? { kind: 'expected_outcome' as const } : undefined)
  return {
    id: `goal-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    objective: normalizedObjective,
    ...(options.objectiveSource ? { objectiveSource: options.objectiveSource } : {}),
    ...(specification ? { specification } : {}),
    status: 'active',
    mode: resolveActiveGoalMode(provider, {
      codexNativeAvailable: options.codexNativeAvailable,
      claudeNativeAvailable: options.claudeNativeAvailable,
      grokNativeAvailable: options.grokNativeAvailable,
      allowProviderNative: options.allowProviderNative
    }),
    provider,
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeLedger: createGoalRuntimeLedger(timestamp)
  }
}

/**
 * C2 P2 — should a set_goal / generic op:'set' operation MINT a FRESH goal
 * identity (new id + createdAt) instead of reusing the prior goal's id? True when
 * there is no prior goal, the prior goal is completed, or the objective materially
 * changed (normalized inequality). A materially-new objective is a genuinely new
 * goal, so its review gates must not inherit the prior goal's id — that
 * inheritance is the reuse trap that would make C2's goalId gate filter a no-op.
 * edit/update/reopen of the SAME goal NEVER call this — they preserve identity via
 * updateActiveGoalLifecycle.
 */
export function shouldMintFreshGoalIdentity(
  priorGoal: Pick<ActiveGoal, 'status' | 'objective'> | null | undefined,
  objective: string
): boolean {
  if (!priorGoal) return true
  if (priorGoal.status === 'completed') return true
  return normalizeActiveGoalObjective(objective) !== priorGoal.objective
}

export function isUnfinishedActiveGoal(goal: ActiveGoal | null | undefined): boolean {
  return Boolean(goal && goal.status !== 'completed')
}

export function resolveActiveGoalForEnsemble(
  goal: ActiveGoal | null | undefined
): ActiveGoal | null {
  if (!goal) return null
  if (goal.mode === 'taskwraith_steered') return goal
  return { ...goal, mode: 'taskwraith_steered' }
}

export function shouldInjectActiveGoal(goal: ActiveGoal | null | undefined): goal is ActiveGoal {
  // The rule lives in the host-shared contract so the standalone Host and the
  // App can never disagree about whether a goal binds a run.
  return hostShouldInjectActiveGoal(goal)
}

export function updateActiveGoalLifecycle(
  goal: ActiveGoal,
  status: ActiveGoalStatus,
  reason?: string,
  now = new Date()
): ActiveGoal {
  const timestamp = now.toISOString()
  const normalizedReason = normalizeActiveGoalReason(reason)
  const next: ActiveGoal = {
    ...goal,
    status,
    updatedAt: timestamp,
    lastStatusReason: normalizedReason || goal.lastStatusReason,
    runtimeLedger: transitionGoalRuntimeLedger(goal.runtimeLedger, status, timestamp)
  }
  if (status === 'active') {
    delete next.pausedAt
    delete next.blockedAt
    delete next.blockedReason
    delete next.completedAt
    delete next.completedSummary
  } else if (status === 'paused') {
    next.pausedAt = timestamp
  } else if (status === 'blocked') {
    next.blockedAt = timestamp
    next.blockedReason = normalizedReason || goal.blockedReason || 'Blocked without details.'
  } else if (status === 'completed') {
    next.completedAt = timestamp
    if (normalizedReason) next.completedSummary = normalizedReason
  }
  return next
}

function cloneGoalRuntimeLedger(ledger: GoalRuntimeLedger): GoalRuntimeLedger {
  return {
    ...ledger,
    intervals: ledger.intervals.map((interval) => ({ ...interval }))
  }
}

function closeOpenGoalRuntimeInterval(
  intervals: GoalRuntimeLedgerInterval[],
  endedAt: string
): void {
  const open = intervals[intervals.length - 1]
  if (open && !open.endedAt) open.endedAt = endedAt
}

function goalRuntimeTimestamp(value: GoalRuntimeTimestampInput): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

export function formatActiveGoalPromptBlock(goal: ActiveGoal): string {
  return hostFormatActiveGoalPromptBlock(goal)
}
