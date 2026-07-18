import type { RunTerminalJoinState } from '../RunManager'

export const EXECUTION_GRAPH_TERMINAL_JOIN_TIMEOUT_MS = 15_000
export const EXECUTION_GRAPH_TERMINAL_JOIN_POLL_MS = 1_000

export type ExecutionGraphTerminalJoinWatchdogDecision =
  | { readonly kind: 'stop' }
  | { readonly kind: 'wait'; readonly delayMs: number }
  | { readonly kind: 'contain'; readonly reason: string }

function terminalJoinDescription(state: RunTerminalJoinState): string {
  const lifecycle = state.lifecycleStatus ?? 'missing'
  const provider = state.providerStatus ?? 'missing'
  return `lifecycle=${lifecycle}, provider=${provider}`
}

/**
 * Decide the next watchdog action for a main-owned execution-graph attempt.
 *
 * Requiring confirmation does not itself start a failure deadline: providers
 * may legitimately run for hours. The bounded window starts only when either
 * side of the terminal join has produced its first real signal.
 */
export function decideExecutionGraphTerminalJoinWatchdog(input: {
  readonly active: boolean
  readonly nowMs: number
  readonly state: RunTerminalJoinState
  readonly timeoutMs?: number
  readonly pollMs?: number
}): ExecutionGraphTerminalJoinWatchdogDecision {
  if (!input.active || !input.state.required) return { kind: 'stop' }

  const timeoutMs = input.timeoutMs ?? EXECUTION_GRAPH_TERMINAL_JOIN_TIMEOUT_MS
  const pollMs = input.pollMs ?? EXECUTION_GRAPH_TERMINAL_JOIN_POLL_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Execution graph terminal join timeout must be positive.')
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('Execution graph terminal join poll interval must be positive.')
  }

  const firstSignalAt = input.state.firstSignalAt
  if (firstSignalAt === undefined) return { kind: 'wait', delayMs: pollMs }

  const remainingMs = Math.max(0, firstSignalAt + timeoutMs - input.nowMs)
  if (remainingMs > 0) {
    return { kind: 'wait', delayMs: Math.min(pollMs, remainingMs) }
  }

  const evidence = terminalJoinDescription(input.state)
  return {
    kind: 'contain',
    reason: input.state.conflict
      ? `Provider and lifecycle terminal signals conflicted after the bounded join window (${evidence}).`
      : `Provider and lifecycle terminal confirmation did not converge within ${timeoutMs}ms (${evidence}).`
  }
}
