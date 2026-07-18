import type {
  ExecutionGraphHistoryClearReport,
  ExecutionGraphHistoryDeletionReport,
  ExecutionGraphRepository
} from './ExecutionGraphRepository'
import {
  isExecutionRunTerminal,
  type ExecutionRunProjection
} from './ExecutionGraphRun'

export interface ExecutionGraphHistoryRetentionCoordinator {
  listExecutions(filter?: {
    readonly workspaceId?: string
    readonly rootChatId?: string
    readonly includeTerminal?: boolean
  }): readonly ExecutionRunProjection[]
  cancelExecution(executionId: string, reason?: string): Promise<void>
}

export interface ExecutionGraphHistoryRetentionDeps {
  readonly repository: Pick<
    ExecutionGraphRepository,
    | 'deleteExecutionsForRootChat'
    | 'deleteExecutionsForWorkspace'
    | 'clearAllHistory'
    | 'hasHistoryForRootChat'
    | 'hasHistoryForWorkspace'
  >
  readonly coordinator: ExecutionGraphHistoryRetentionCoordinator
}

const HISTORY_DELETION_REASON = 'Execution history is being permanently deleted by the user.'

const EMPTY_DELETION_REPORT: ExecutionGraphHistoryDeletionReport = Object.freeze({
  deletedExecutionIds: Object.freeze([]),
  deletedRunTemplateIds: Object.freeze([]),
  unscopedQuarantinedExecutionIds: Object.freeze([])
})

function unresolvedExecutionIds(
  projections: readonly ExecutionRunProjection[]
): readonly string[] {
  return projections
    .filter((projection) => !isExecutionRunTerminal(projection.state))
    .map((projection) => projection.executionId)
    .sort()
}

async function settleExecutions(
  deps: ExecutionGraphHistoryRetentionDeps,
  filter: { readonly workspaceId?: string; readonly rootChatId?: string }
): Promise<void> {
  const before = deps.coordinator.listExecutions({ ...filter, includeTerminal: true })
  for (const executionId of unresolvedExecutionIds(before)) {
    await deps.coordinator.cancelExecution(executionId, HISTORY_DELETION_REASON)
  }
  const unresolved = unresolvedExecutionIds(
    deps.coordinator.listExecutions({ ...filter, includeTerminal: true })
  )
  if (unresolved.length > 0) {
    throw new Error(
      `Execution-graph history deletion could not prove terminal cleanup for: ${unresolved.join(', ')}.`
    )
  }
}

/** Cancels exact live graph work, then erases one chat's graph-owned history. */
export async function deleteExecutionGraphHistoryForChat(
  deps: ExecutionGraphHistoryRetentionDeps,
  rootChatId: string
): Promise<ExecutionGraphHistoryDeletionReport> {
  if (!deps.repository.hasHistoryForRootChat(rootChatId)) return EMPTY_DELETION_REPORT
  await settleExecutions(deps, { rootChatId })
  return deps.repository.deleteExecutionsForRootChat(rootChatId)
}

/**
 * Cancels exact live graph work before any destructive write. Global clear is
 * deliberately repository-wide so graph definitions and prompt-bearing run
 * templates cannot survive Settings -> Delete all chat history.
 */
export async function clearExecutionGraphHistory(
  deps: ExecutionGraphHistoryRetentionDeps,
  workspaceId?: string
): Promise<ExecutionGraphHistoryDeletionReport | ExecutionGraphHistoryClearReport> {
  if (workspaceId && !deps.repository.hasHistoryForWorkspace(workspaceId)) {
    return EMPTY_DELETION_REPORT
  }
  await settleExecutions(deps, workspaceId ? { workspaceId } : {})
  return workspaceId
    ? deps.repository.deleteExecutionsForWorkspace(workspaceId)
    : deps.repository.clearAllHistory()
}
