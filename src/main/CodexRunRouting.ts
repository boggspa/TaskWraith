import {
  isActiveRunSessionStatus,
  isTerminalRunSessionStatus,
  type RunSessionStatus
} from './RunManager'

export function shouldRouteCodexRunSession(input: {
  ensemble: boolean
  status: RunSessionStatus
  stateCompleted: boolean
  allowTerminalNativeGoal?: boolean
}): boolean {
  if (!input.ensemble && input.allowTerminalNativeGoal) return true
  return isActiveRunSessionStatus(input.status) && !input.stateCompleted
}

export type CodexExplicitThreadRoute = 'session' | 'child_owner' | 'none' | 'active_fallback'

export function resolveCodexExplicitThreadRoute(input: {
  hasExplicitThreadId: boolean
  exactSessionRoutable: boolean
  registeredChildOwner: boolean
}): CodexExplicitThreadRoute {
  if (!input.hasExplicitThreadId) return 'active_fallback'
  if (input.exactSessionRoutable) return 'session'
  if (input.registeredChildOwner) return 'child_owner'
  return 'none'
}

export type CodexEnsembleFenceDecision =
  | { action: 'route' }
  | { action: 'drop' }
  | { action: 'interrupt'; turnId: string }
  | { action: 'clear_native_goal' }

export function decideCodexEnsembleFence(input: {
  taskWraithSteeredThread: boolean
  sessionStatus?: RunSessionStatus
  sessionIsEnsemble: boolean
  method: string
  turnId?: string
}): CodexEnsembleFenceDecision {
  const sessionMissingOrTerminal =
    input.sessionStatus === undefined || isTerminalRunSessionStatus(input.sessionStatus)
  const shouldFence =
    (input.taskWraithSteeredThread && sessionMissingOrTerminal) ||
    (input.sessionIsEnsemble &&
      input.sessionStatus !== undefined &&
      isTerminalRunSessionStatus(input.sessionStatus))
  if (!shouldFence) return { action: 'route' }
  if (input.method === 'turn/started' && input.turnId) {
    return { action: 'interrupt', turnId: input.turnId }
  }
  if (input.method === 'thread/goal/updated') return { action: 'clear_native_goal' }
  return { action: 'drop' }
}
