import {
  cancelExecutionGraphsInitiatedByParentRun,
  type ExecutionGraphParentCancellationCoordinator,
  type ExecutionGraphParentCancellationResult
} from './ExecutionGraphParentCancellation'

export interface ExecutionGraphParentStopResult {
  readonly accepted: boolean
  readonly parentCancelled: boolean
  readonly graphCancellation?: ExecutionGraphParentCancellationResult
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
  }
): Promise<ExecutionGraphParentStopResult> {
  if (!deps.claimParentCancellation(input.parentRunId)) {
    return { accepted: false, parentCancelled: false }
  }
  deps.cancelParentPrompts(input.parentRunId)
  const graphCancellation = deps.coordinator
    ? await cancelExecutionGraphsInitiatedByParentRun(
        {
          parentRunId: input.parentRunId,
          parentThreadId: input.parentThreadId,
          reason: 'Cancelled with the owning parent run.'
        },
        deps.coordinator
      )
    : undefined
  const parentCancelled = await deps.cancelParentTransport()
  return {
    accepted: true,
    parentCancelled,
    ...(graphCancellation ? { graphCancellation } : {})
  }
}
