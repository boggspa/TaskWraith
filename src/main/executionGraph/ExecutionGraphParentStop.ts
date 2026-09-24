import {
  cancelExecutionGraphsInitiatedByParentRun,
  type ExecutionGraphParentCancellationCoordinator,
  type ExecutionGraphParentCancellationResult
} from './ExecutionGraphParentCancellation'

/**
 * How long owned-graph cancellation may hold the Stop path before the parent
 * transport is signalled regardless. Graph cleanup is bookkeeping; the provider
 * kill is what the user actually pressed Stop for, so cleanup never gets to
 * hold it hostage. A coordinator whose `cancelExecution` never settles is the
 * exact shape that used to strand this call — and, behind it, the awaiting
 * `cancel-agent-run` IPC — with the provider never signalled at all.
 */
export const EXECUTION_GRAPH_PARENT_STOP_GRAPH_TIMEOUT_MS = 10_000

export interface ExecutionGraphParentStopResult {
  readonly accepted: boolean
  readonly parentCancelled: boolean
  readonly graphCancellation?: ExecutionGraphParentCancellationResult
  /** Set only when the deadline released the parent transport first. */
  readonly graphCancellationTimedOut?: true
}

/**
 * Resolves to the cancellation result, or to `'timed-out'` once the deadline
 * passes. A rejection still propagates, preserving the caller's existing
 * contract; a rejection that arrives *after* the deadline is absorbed so it
 * cannot surface as an unhandled rejection once the race has already settled.
 */
async function settleGraphCancellationWithinDeadline(
  cancellation: Promise<ExecutionGraphParentCancellationResult>,
  timeoutMs: number
): Promise<ExecutionGraphParentCancellationResult | 'timed-out'> {
  void cancellation.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      cancellation,
      new Promise<'timed-out'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timed-out'), Math.max(0, timeoutMs))
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Explicit user Stop orchestration. Natural provider completion never enters
 * this path. The terminal intent is fenced first, then every exactly-owned
 * graph is cancelled before the parent transport can release its chat lane.
 */
export async function stopParentRunAndOwnedExecutions(
  input: { readonly parentRunId: string; readonly parentThreadId: string },
  deps: {
    claimParentCancellation(runId: string): boolean
    cancelParentPrompts(runId: string): void
    coordinator?: ExecutionGraphParentCancellationCoordinator | null
    cancelParentTransport(): Promise<boolean>
    graphCancellationTimeoutMs?: number
  }
): Promise<ExecutionGraphParentStopResult> {
  if (!deps.claimParentCancellation(input.parentRunId)) {
    return { accepted: false, parentCancelled: false }
  }
  deps.cancelParentPrompts(input.parentRunId)
  const graphCancellation = deps.coordinator
    ? await settleGraphCancellationWithinDeadline(
        cancelExecutionGraphsInitiatedByParentRun(
          {
            parentRunId: input.parentRunId,
            parentThreadId: input.parentThreadId,
            reason: 'Cancelled with the owning parent run.'
          },
          deps.coordinator
        ),
        deps.graphCancellationTimeoutMs ?? EXECUTION_GRAPH_PARENT_STOP_GRAPH_TIMEOUT_MS
      )
    : undefined
  const parentCancelled = await deps.cancelParentTransport()
  return {
    accepted: true,
    parentCancelled,
    ...(graphCancellation && graphCancellation !== 'timed-out' ? { graphCancellation } : {}),
    ...(graphCancellation === 'timed-out' ? { graphCancellationTimedOut: true as const } : {})
  }
}
