import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ProviderId,
  RunDiffResult,
  WorkspaceChangeFilter,
  WorkspaceChangeSet,
  WorkspaceRecord,
  WorkspaceRunChangeInput,
  WorkspaceSnapshot
} from '../store/types'

export interface WorkspaceChangeLedgerHandlerDeps {
  assertSenderCanReadWorkspaceChangeLedger: (event: IpcMainInvokeEvent) => void
  assertSenderRunChangeScope: (
    event: IpcMainInvokeEvent,
    input: { chatId: string; workspacePath: string }
  ) => void
  getWorkspaceChangeSets: (filter: WorkspaceChangeFilter) => WorkspaceChangeSet[]
  computeRunDiff: (
    preSnapshot: WorkspaceSnapshot,
    postSnapshot: WorkspaceSnapshot,
    runId: string
  ) => RunDiffResult
  recordWorkspaceRunChange: (input: WorkspaceRunChangeInput) => WorkspaceChangeSet
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  assertProviderId: (provider: unknown) => ProviderId
  assertRunChangeContext: (input: {
    runId: string
    changeContext: Partial<WorkspaceRunChangeInput>
    workspace: WorkspaceRecord | undefined
    workspacePath: string
    effectiveWorkspacePath: string
    preSnapshot: WorkspaceSnapshot
    postSnapshot: WorkspaceSnapshot
  }) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  return value.trim()
}

/**
 * Workspace change sets contain cross-run filesystem evidence. Keep collection
 * reads main-renderer-owned. A chat popout may still finish a run it owns, but
 * only after main binds that write to the popout's exact chat/workspace and the
 * persisted run context below.
 */
export function registerWorkspaceChangeLedgerHandlers(
  deps: WorkspaceChangeLedgerHandlerDeps
): void {
  ipcMain.handle(
    'get-workspace-change-sets',
    async (event, filter?: WorkspaceChangeFilter): Promise<WorkspaceChangeSet[]> => {
      deps.assertSenderCanReadWorkspaceChangeLedger(event)
      return deps.getWorkspaceChangeSets(filter || {})
    }
  )

  ipcMain.handle(
    'compute-run-diff',
    async (
      event,
      rawRunId: string,
      preSnapshot: WorkspaceSnapshot,
      postSnapshot: WorkspaceSnapshot,
      changeContext?: Partial<WorkspaceRunChangeInput>
    ): Promise<RunDiffResult> => {
      const runId = nonEmptyString(rawRunId, 'Run id')
      if (!changeContext || !isRecord(changeContext)) {
        deps.assertSenderCanReadWorkspaceChangeLedger(event)
        return deps.computeRunDiff(preSnapshot, postSnapshot, runId)
      }

      const workspacePath = deps.requireRegisteredWorkspace(
        nonEmptyString(changeContext.workspacePath, 'Workspace')
      )
      const workspace = deps.findRegisteredWorkspace(workspacePath)
      if (changeContext.workspaceId && workspace && changeContext.workspaceId !== workspace.id) {
        throw new Error('Run diff workspace id does not match the registered workspace.')
      }
      const effectiveWorkspacePath = changeContext.effectiveWorkspacePath
        ? deps.requireRegisteredWorkspace(
            changeContext.effectiveWorkspacePath,
            'Effective workspace'
          )
        : workspacePath
      const chatId = nonEmptyString(changeContext.chatId, 'Run diff chat id')
      deps.assertSenderRunChangeScope(event, { chatId, workspacePath: effectiveWorkspacePath })
      deps.assertRunChangeContext({
        runId,
        changeContext,
        workspace,
        workspacePath,
        effectiveWorkspacePath,
        preSnapshot,
        postSnapshot
      })
      const runDiff = deps.computeRunDiff(preSnapshot, postSnapshot, runId)
      const changeSet = deps.recordWorkspaceRunChange({
        ...changeContext,
        runId,
        workspaceId: workspace?.id || changeContext.workspaceId,
        workspacePath,
        effectiveWorkspacePath,
        provider: changeContext.provider
          ? deps.assertProviderId(changeContext.provider)
          : undefined,
        runDiff
      })
      return { ...runDiff, changeSetId: changeSet.id }
    }
  )
}
