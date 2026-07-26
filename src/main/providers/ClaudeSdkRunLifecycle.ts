export type ClaudeSdkTerminalStatus = 'completed' | 'failed' | 'cancelled'

export interface ClaudeSdkTerminalRunManager {
  getClaimedTerminalStatus(
    runId: string | undefined
  ): Extract<ClaudeSdkTerminalStatus, 'failed' | 'cancelled'> | undefined
  finish(runId: string | undefined, status: ClaudeSdkTerminalStatus): unknown
  confirmTerminalStatus(runId: string | undefined, status: ClaudeSdkTerminalStatus): unknown
}

/**
 * Terminal UI projection is observational. A detached renderer or malformed
 * frame must not strand the RunManager owner (or turn a completed SDK request
 * into a second CLI attempt), and a failing finish hook must not suppress the
 * provider-side confirmation required by graph-owned runs.
 */
export function settleClaudeSdkTerminal(input: {
  runManager: ClaudeSdkTerminalRunManager
  runId: string | undefined
  status: ClaudeSdkTerminalStatus
  project: (effectiveStatus: ClaudeSdkTerminalStatus) => void
  onError?: (phase: 'projection' | 'finish' | 'confirmation', error: unknown) => void
}): ClaudeSdkTerminalStatus {
  const terminalStatus = input.runManager.getClaimedTerminalStatus(input.runId) ?? input.status
  const report = (phase: 'projection' | 'finish' | 'confirmation', error: unknown): void => {
    try {
      input.onError?.(phase, error)
    } catch {
      // Lifecycle settlement is independent of diagnostics.
    }
  }
  try {
    input.project(terminalStatus)
  } catch (error) {
    report('projection', error)
  }
  try {
    input.runManager.finish(input.runId, terminalStatus)
  } catch (error) {
    report('finish', error)
  }
  try {
    input.runManager.confirmTerminalStatus(input.runId, terminalStatus)
  } catch (error) {
    report('confirmation', error)
  }
  return terminalStatus
}
