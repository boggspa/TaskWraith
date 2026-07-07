import type { ActiveGoal, ActiveGoalStatus } from './store/types'
import { transitionGoalRuntimeLedger } from './GoalState'

export const CODEX_THREAD_GOAL_SET_METHOD = 'thread/goal/set'
export const CODEX_THREAD_GOAL_GET_METHOD = 'thread/goal/get'
export const CODEX_THREAD_GOAL_CLEAR_METHOD = 'thread/goal/clear'

export type CodexThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export interface CodexThreadGoal {
  threadId: string
  objective: string
  status: CodexThreadGoalStatus | string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number | string
  updatedAt?: number | string
}

export interface CodexThreadGoalSetParams {
  threadId: string
  objective?: string | null
  status?: CodexThreadGoalStatus | null
  tokenBudget?: number | null
}

export function codexGoalStatusFromActiveGoal(status: ActiveGoalStatus): CodexThreadGoalStatus {
  return status === 'completed' ? 'complete' : status
}

export function activeGoalStatusFromCodexGoal(status: unknown): ActiveGoalStatus {
  if (status === 'complete') return 'completed'
  if (status === 'paused') return 'paused'
  if (status === 'blocked' || status === 'usageLimited' || status === 'budgetLimited') {
    return 'blocked'
  }
  return 'active'
}

export function codexThreadGoalSetParams(
  threadId: string,
  goal: ActiveGoal
): CodexThreadGoalSetParams {
  return {
    threadId,
    objective: goal.objective,
    status: codexGoalStatusFromActiveGoal(goal.status),
    tokenBudget: null
  }
}

export function activeGoalFromCodexThreadGoal(
  nativeGoal: CodexThreadGoal,
  existingGoal?: ActiveGoal | null
): ActiveGoal {
  const status = activeGoalStatusFromCodexGoal(nativeGoal.status)
  const createdAt = codexGoalTimestamp(nativeGoal.createdAt) || existingGoal?.createdAt || nowIso()
  const updatedAt = codexGoalTimestamp(nativeGoal.updatedAt) || existingGoal?.updatedAt || nowIso()
  const objective = String(nativeGoal.objective || existingGoal?.objective || '').trim()
  const goal: ActiveGoal = {
    id: existingGoal?.id || `codex-goal-${nativeGoal.threadId}`,
    objective,
    status,
    mode: 'codex_native',
    provider: 'codex',
    createdAt,
    updatedAt,
    runtimeLedger: transitionGoalRuntimeLedger(existingGoal?.runtimeLedger, status, updatedAt),
    ...(existingGoal?.lastStatusReason ? { lastStatusReason: existingGoal.lastStatusReason } : {})
  }

  if (status === 'paused') {
    goal.pausedAt = updatedAt
  } else if (status === 'blocked') {
    goal.blockedAt = updatedAt
    goal.blockedReason =
      existingGoal?.blockedReason ||
      (nativeGoal.status === 'usageLimited'
        ? 'Codex reported a usage limit.'
        : nativeGoal.status === 'budgetLimited'
          ? 'Codex reported a goal budget limit.'
          : 'Codex reported the goal is blocked.')
  } else if (status === 'completed') {
    goal.completedAt = updatedAt
    if (existingGoal?.completedSummary) goal.completedSummary = existingGoal.completedSummary
  }

  return goal
}

export function isCodexNativeGoalUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  return (
    normalized.includes('method not found') ||
    normalized.includes('unknown method') ||
    normalized.includes('not implemented') ||
    normalized.includes('unsupported method') ||
    normalized.includes('-32601')
  )
}

function codexGoalTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 0 && value < 10_000_000_000 ? value * 1000 : value
    const date = new Date(millis)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  return undefined
}

function nowIso(): string {
  return new Date().toISOString()
}
