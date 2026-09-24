/**
 * Proof that a native agy tool actually ran.
 *
 * The agy print-mode lane has two places it could claim an execution, and only
 * one of them is honest. The PreToolUse hook fires BEFORE a tool runs and can
 * only veto, so its "allowed" outcome proves the host permitted an attempt, not
 * that anything executed — agy's own settings layer can still refuse an allowed
 * call. The brain transcript is agy's durable after-the-fact step log, and a
 * model-sourced step there carries a real status. That is the completion.
 *
 * The resulting list is a LOWER BOUND and must stay marked as one. The
 * projection deliberately drops bridge-covered shell and write steps to avoid
 * duplicating the broker's own transcript rows, the live tail lags the file,
 * and long fields are truncated. So a name's presence proves that tool ran; a
 * name's absence proves nothing at all.
 */
export interface AgyExecutionReporter {
  executed: (surface: 'native' | 'managed', toolName: string) => boolean
}

/** The fields of a projected agy transcript event this needs, structurally. */
export interface AgyExecutionCandidate {
  type?: string
  tool_name?: string
  status?: string
}

/**
 * Record a proven native execution, and return whether one was recorded.
 *
 * Deliberately narrow: only a `tool_result` that succeeded counts. A
 * `tool_use` is a request, and an errored result means the tool did not do
 * what was asked, which `executed` has no way to express.
 */
export function recordAgyExecutedTool(
  receipt: AgyExecutionReporter | null | undefined,
  event: AgyExecutionCandidate | null | undefined
): boolean {
  if (!receipt || !event) return false
  if (event.type !== 'tool_result' || event.status !== 'success') return false
  const toolName = typeof event.tool_name === 'string' ? event.tool_name.trim() : ''
  if (!toolName) return false
  try {
    // Native: these are agy's own tools. Brokered calls are arbitrated and
    // recorded server-side, and the projection excludes them here.
    return receipt.executed('native', toolName)
  } catch {
    /* Evidence recording can never change what the run did. */
    return false
  }
}
