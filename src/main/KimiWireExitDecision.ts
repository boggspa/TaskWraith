/**
 * Pure decision helper for the Kimi wire-mode child-close handler.
 *
 * The historical close handler had three branches:
 *   1. `state.completed`         -> finish('completed'), no exit emitted.
 *   2. `!promptSent`             -> finish('failed'), wire resolves false.
 *   3. otherwise                 -> emit synthetic result + exit, finish.
 *
 * Branch 1 is the bug: `state.completed` flips to true on the prompt
 * response branch AND on any `handleCliProviderJsonEvent` reaction to a
 * `result`/`TurnEnd` notification. The second path NEVER publishes
 * `agent-exit`, so when the child closed after such a notification (or
 * raced past the prompt response) the renderer never cleared the chat
 * from `runningChatIds` and the sidebar kept showing "Running".
 *
 * Extracted as a pure function so the regression test below can pin
 * the decision tree without spinning up an Electron child process.
 */
export interface KimiWireCloseInputs {
  /** Whether the close handler already fired or another path settled the run. */
  settled: boolean
  /** Whether the `prompt` JSON-RPC request was written to stdin. */
  promptSent: boolean
  /** Whether any path has flipped `state.completed = true`. */
  stateCompleted: boolean
  /** Whether a previous code path already emitted `agent-exit`. */
  exitAlreadyEmitted: boolean
  /** The exit code reported to the close handler. */
  code: number | null
}

export interface KimiWireCloseDecision {
  /** True iff `child.on('close')` should early-return without side effects. */
  ignore: boolean
  /** True iff the handler should emit a synthetic `result` line for the renderer. */
  emitResultLine: boolean
  /** True iff the handler should emit `agent-exit` (gated by idempotence). */
  emitExit: boolean
  /** Terminal status to report to `RunManager.finish`, absent for a retryable startup failure. */
  terminalStatus?: 'completed' | 'failed'
  /** Value to resolve the wire-mode promise with. */
  resolveWire: boolean
}

export type KimiWireTerminalStatus = 'completed' | 'failed' | 'cancelled'

export interface KimiWireTerminalEvidence {
  readonly status?: KimiWireTerminalStatus
  readonly conflict: boolean
}

/** Preserve typed provisional evidence and fail closed on disagreement. */
export function mergeKimiWireTerminalEvidence(
  current: KimiWireTerminalEvidence,
  incoming: KimiWireTerminalStatus
): KimiWireTerminalEvidence {
  if (!current.status) return { status: incoming, conflict: current.conflict }
  if (current.status === incoming) return current
  return { status: 'failed', conflict: true }
}

export function resolveKimiWireTerminalStatus(
  closeStatus: 'completed' | 'failed' | undefined,
  evidence: KimiWireTerminalEvidence
): KimiWireTerminalStatus | undefined {
  if (!closeStatus) return undefined
  if (closeStatus === 'failed' || evidence.conflict) return 'failed'
  return evidence.status ?? 'completed'
}

export type KimiContentFilterRetryPass = 'keyword' | 'classifier'

export interface KimiContentFilterRetryInputs {
  attemptedPasses: ReadonlyArray<KimiContentFilterRetryPass>
  keywordCanRetry: boolean
  classifierAvailable: boolean
  classifierCanRetry: boolean
}

export type KimiContentFilterRetryDecision =
  | {
      action: 'retry'
      pass: KimiContentFilterRetryPass
    }
  | {
      action: 'fail'
      reason:
        | 'keyword_unavailable'
        | 'classifier_unavailable'
        | 'classifier_no_redaction'
        | 'retry_passes_exhausted'
    }

export function decideKimiWireClose(inputs: KimiWireCloseInputs): KimiWireCloseDecision {
  if (inputs.settled) {
    return {
      ignore: true,
      emitResultLine: false,
      emitExit: false,
      terminalStatus: 'completed',
      resolveWire: true
    }
  }

  if (inputs.stateCompleted) {
    // The fix: backfill exit when an upstream path (typically
    // `handleCliProviderJsonEvent` reacting to a notification) flipped
    // `state.completed` without publishing `agent-exit`. A non-zero child
    // close still wins over that provisional notification: Kimi can emit an
    // early success result immediately before a quota/auth error and exit 1.
    // Idempotence is enforced separately by the caller.
    return {
      ignore: false,
      emitResultLine: false,
      emitExit: true,
      terminalStatus: inputs.code === null || inputs.code === 0 ? 'completed' : 'failed',
      resolveWire: true
    }
  }

  if (!inputs.promptSent) {
    // Wire startup failed before we even sent the prompt. The caller
    // falls back to print-mode, which publishes its own exit, so we
    // leave the IPC alone here.
    return {
      ignore: false,
      emitResultLine: false,
      emitExit: false,
      resolveWire: false
    }
  }

  // Prompt was sent but the child closed before signalling completion
  // — synthesize the result + exit and report the exit code.
  return {
    ignore: false,
    emitResultLine: true,
    emitExit: true,
    terminalStatus: inputs.code === 0 ? 'completed' : 'failed',
    resolveWire: true
  }
}

export function decideKimiContentFilterRetry(
  inputs: KimiContentFilterRetryInputs
): KimiContentFilterRetryDecision {
  const attempted = new Set(inputs.attemptedPasses)

  if (!attempted.has('keyword')) {
    if (inputs.keywordCanRetry) {
      return { action: 'retry', pass: 'keyword' }
    }
    if (!inputs.classifierAvailable) {
      return { action: 'fail', reason: 'classifier_unavailable' }
    }
  }

  if (!attempted.has('classifier')) {
    if (!inputs.classifierAvailable) {
      return { action: 'fail', reason: 'classifier_unavailable' }
    }
    if (inputs.classifierCanRetry) {
      return { action: 'retry', pass: 'classifier' }
    }
    return { action: 'fail', reason: 'classifier_no_redaction' }
  }

  return {
    action: 'fail',
    reason: inputs.keywordCanRetry ? 'retry_passes_exhausted' : 'keyword_unavailable'
  }
}
