import type { ExecutionOwnerRef, ExecutionRunState } from './ExecutionGraphModel'

interface OwnedExecutionProjection {
  readonly executionId: string
  readonly state: ExecutionRunState
  readonly owner?: ExecutionOwnerRef
}

export interface ExecutionGraphParentCancellationCoordinator {
  listExecutions(options: { includeTerminal: false }): readonly OwnedExecutionProjection[]
  cancelExecution(executionId: string, reason: string): Promise<void>
}

export interface ExecutionGraphParentCancellationFailure {
  readonly executionId: string
  readonly message: string
}

export interface ExecutionGraphParentCancellationResult {
  readonly matchedExecutionIds: readonly string[]
  readonly cancelledExecutionIds: readonly string[]
  readonly failures: readonly ExecutionGraphParentCancellationFailure[]
}

function exact(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required.`)
  return normalized
}

/**
 * Cancel every nonterminal graph launched by one exact parent run before the
 * parent transport is stopped. Natural parent completion does not call this
 * path: it is exclusively the explicit run-cancel cascade.
 */
export async function cancelExecutionGraphsInitiatedByParentRun(
  input: {
    readonly parentRunId: string
    readonly parentThreadId: string
    readonly reason?: string
  },
  coordinator: ExecutionGraphParentCancellationCoordinator
): Promise<ExecutionGraphParentCancellationResult> {
  const parentRunId = exact(input.parentRunId, 'Parent run id')
  const parentThreadId = exact(input.parentThreadId, 'Parent thread id')
  const reason = input.reason?.trim() || 'Cancelled with the owning parent run.'
  const matches = coordinator
    .listExecutions({ includeTerminal: false })
    .filter(
      (projection) =>
        projection.owner?.initiatingRunId === parentRunId &&
        projection.owner.threadId === parentThreadId
    )
    .sort((left, right) => left.executionId.localeCompare(right.executionId))

  const settlements = await Promise.allSettled(
    matches.map((projection) => coordinator.cancelExecution(projection.executionId, reason))
  )
  const cancelledExecutionIds: string[] = []
  const failures: ExecutionGraphParentCancellationFailure[] = []
  settlements.forEach((settlement, index) => {
    const executionId = matches[index]!.executionId
    if (settlement.status === 'fulfilled') {
      cancelledExecutionIds.push(executionId)
      return
    }
    failures.push({
      executionId,
      message: String(
        settlement.reason instanceof Error ? settlement.reason.message : settlement.reason
      ).slice(0, 2_048)
    })
  })
  return Object.freeze({
    matchedExecutionIds: Object.freeze(matches.map((projection) => projection.executionId)),
    cancelledExecutionIds: Object.freeze(cancelledExecutionIds),
    failures: Object.freeze(failures)
  })
}
