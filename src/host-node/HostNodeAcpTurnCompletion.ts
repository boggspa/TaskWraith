import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const PROMPT_RPC_ID = 3
const GRACEFUL_EOF_MS = 250
const FORCE_KILL_MS = 4_000

export interface HostNodeAcpTurnCompletion {
  /** Returns true only for this turn's exact, terminal session/prompt result. */
  acceptPromptResult(frame: Record<string, unknown>): boolean
  /** Provider outcome proven by terminal ACP evidence, independent of child exit code. */
  promptOutcome(): HostNodeAcpPromptOutcome | null
  /** Idempotently asks the persistent ACP server to leave this one-shot Host run. */
  requestStop(): void
  /** Clears teardown backstops after process close owns settlement. */
  dispose(): void
}

export interface HostNodeAcpPromptOutcome {
  readonly stopReason: string
  readonly status: 'completed' | 'cancelled'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function promptStopReason(frame: Record<string, unknown>): string | null {
  if (frame.id !== PROMPT_RPC_ID) return null
  const result = record(frame.result)
  const stopReason = typeof result?.stopReason === 'string' ? result.stopReason.trim() : ''
  // eslint-disable-next-line no-control-regex -- ACP status metadata must reject terminal controls.
  if (!stopReason || stopReason.length > 128 || /[\u0000-\u001f\u007f]/.test(stopReason)) {
    return null
  }
  return stopReason
}

function outcomeForStopReason(stopReason: string): HostNodeAcpPromptOutcome {
  const normalized = stopReason.toLowerCase().replace(/[\s_-]+/g, '')
  const cancelled =
    normalized.includes('cancel') ||
    normalized.includes('abort') ||
    normalized.includes('interrupt') ||
    normalized === 'permissionrejected'
  return { stopReason, status: cancelled ? 'cancelled' : 'completed' }
}

/**
 * Joins a terminal ACP prompt result to real process teardown.
 *
 * Grok, Kimi and Mistral expose persistent stdio servers: a successful
 * session/prompt response ends the turn but does not close the child. The
 * standalone Host runs one turn per child, so EOF is the graceful boundary;
 * SIGTERM and SIGKILL are bounded backstops rather than completion evidence.
 */
export function createHostNodeAcpTurnCompletion(
  child: ChildProcessWithoutNullStreams
): HostNodeAcpTurnCompletion {
  let promptOutcome: HostNodeAcpPromptOutcome | null = null
  let stopRequested = false
  let disposed = false
  let termTimer: ReturnType<typeof setTimeout> | null = null
  let killTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (termTimer) clearTimeout(termTimer)
    if (killTimer) clearTimeout(killTimer)
    termTimer = null
    killTimer = null
  }

  const forceKill = (): void => {
    if (disposed) return
    try {
      child.kill('SIGKILL')
    } catch {
      // A concurrent close already owns settlement.
    }
  }

  const terminate = (): void => {
    if (disposed) return
    try {
      child.kill('SIGTERM')
    } catch {
      forceKill()
      return
    }
    killTimer = setTimeout(forceKill, FORCE_KILL_MS)
    killTimer.unref?.()
  }

  const requestStop = (): void => {
    if (disposed || stopRequested) return
    stopRequested = true
    try {
      child.stdin.end()
    } catch {
      terminate()
      return
    }
    termTimer = setTimeout(terminate, GRACEFUL_EOF_MS)
    termTimer.unref?.()
  }

  const dispose = (): void => {
    disposed = true
    clearTimers()
  }

  return {
    acceptPromptResult(frame) {
      if (disposed) return false
      const stopReason = promptStopReason(frame)
      if (!stopReason) return false
      promptOutcome ??= outcomeForStopReason(stopReason)
      requestStop()
      return true
    },
    promptOutcome: () => promptOutcome,
    requestStop,
    dispose
  }
}
