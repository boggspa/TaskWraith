import type { ActiveGoal, ActiveGoalMode, ActiveGoalStatus, ProviderId } from './store/types'

export const MAX_ACTIVE_GOAL_OBJECTIVE_CHARS = 4000
export const MAX_ACTIVE_GOAL_REASON_CHARS = 800

export function normalizeActiveGoalObjective(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.trim().slice(0, MAX_ACTIVE_GOAL_OBJECTIVE_CHARS)
}

export function normalizeActiveGoalReason(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.trim().slice(0, MAX_ACTIVE_GOAL_REASON_CHARS)
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

export function activeGoalModeLabel(mode: ActiveGoalMode): string {
  switch (mode) {
    case 'codex_native':
      return 'Native Codex goal'
    case 'claude_native':
      return 'Native Claude goal'
    case 'grok_native':
      return 'Native Grok goal'
    case 'ollama_harness':
      return 'Ollama managed'
    case 'taskwraith_steered':
    default:
      return 'Guided by TaskWraith'
  }
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
  } = {}
): ActiveGoal {
  const now = options.now || new Date()
  const timestamp = now.toISOString()
  const normalizedObjective = normalizeActiveGoalObjective(objective)
  if (!normalizedObjective) {
    throw new Error('Goal objective is required.')
  }
  return {
    id: `goal-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    objective: normalizedObjective,
    status: 'active',
    mode: resolveActiveGoalMode(provider, {
      codexNativeAvailable: options.codexNativeAvailable,
      claudeNativeAvailable: options.claudeNativeAvailable,
      grokNativeAvailable: options.grokNativeAvailable,
      allowProviderNative: options.allowProviderNative
    }),
    provider,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function isUnfinishedActiveGoal(goal: ActiveGoal | null | undefined): boolean {
  return Boolean(goal && goal.status !== 'completed')
}

export function resolveActiveGoalForEnsemble(goal: ActiveGoal | null | undefined): ActiveGoal | null {
  if (!goal) return null
  if (goal.mode === 'taskwraith_steered') return goal
  return { ...goal, mode: 'taskwraith_steered' }
}

export function shouldInjectActiveGoal(goal: ActiveGoal | null | undefined): goal is ActiveGoal {
  return Boolean(
    goal &&
      (goal.status === 'active' || goal.status === 'blocked') &&
      goal.mode !== 'codex_native' &&
      goal.mode !== 'claude_native' &&
      goal.mode !== 'grok_native'
  )
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
    lastStatusReason: normalizedReason || goal.lastStatusReason
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

export function formatActiveGoalPromptBlock(goal: ActiveGoal): string {
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
