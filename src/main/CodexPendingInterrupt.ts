// Pure decision helpers for the DEFERRED Codex turn/interrupt (budget-kill
// residual 1). When cancelProviderRun / a budget kill targets a Codex run, it
// stops the run by issuing a `turn/interrupt` JSON-RPC — but that needs a
// `turnId`, which only exists AFTER the `turn/started` notification. Between
// registerRunSession and turn/started the session is findable but has no turnId,
// so a cancel landing in that window would skip the interrupt and the server
// turn could start + keep running after the "cancel".
//
// The fix (in index.ts): a `pendingCodexInterrupts` Set keyed by threadId.
// cancelProviderRun records the threadId when it can't interrupt yet;
// handleCodexNotification flushes it the instant `turn/started` arrives. This
// module is the PURE branch logic so it unit-tests without a live Codex client
// (the Set + the JSON-RPC dispatch stay in index.ts). Also corrects manual
// cancel, not just budget-kill.

export interface CancelInterruptDecision {
  /** Issue turn/interrupt now (turnId already known). */
  interruptNow: boolean
  /** Defer: record this threadId until turn/started fires (null = nothing to do). */
  deferThreadId: string | null
}

/**
 * Decide how cancelProviderRun should stop a Codex run given its current state.
 *   - no threadId        → nothing to interrupt (run hasn't reached a thread yet)
 *   - threadId + turnId   → interrupt now
 *   - threadId, no turnId → defer (record the threadId; flush on turn/started)
 */
export function decideCancelInterrupt(
  state: { threadId?: string; turnId?: string } | null | undefined
): CancelInterruptDecision {
  if (!state?.threadId) return { interruptNow: false, deferThreadId: null }
  if (state.turnId) return { interruptNow: true, deferThreadId: null }
  return { interruptNow: false, deferThreadId: state.threadId }
}

/**
 * On a `turn/started` notification: should we flush a deferred interrupt for this
 * thread (i.e. a cancel landed before the turn started)? True iff the thread now
 * has a turnId AND it was recorded as pending.
 */
export function shouldFlushPendingInterrupt(
  pending: ReadonlySet<string>,
  state: { threadId?: string; turnId?: string }
): boolean {
  return Boolean(state.threadId && state.turnId && pending.has(state.threadId))
}
