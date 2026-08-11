import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  captureWorkspaceSnapshot,
  getCommitFilePreview,
  getWorkspaceDiff
} from '../DiffService'

export type WorkspaceDiffRequest = {
  workspacePath?: string
  repoPath?: string
  chatId?: string
  commitHash?: string
}

export interface WorkspaceDiffSnapshotHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  resolveWorkspaceDiffPath?: (
    input: string | WorkspaceDiffRequest
  ) => string
  assertSenderScope: (
    event: IpcMainInvokeEvent,
    input: { capability: 'workspace-diff'; chatId?: string; workspacePath: string }
  ) => void
}

export function registerWorkspaceDiffSnapshotHandlers(
  deps: WorkspaceDiffSnapshotHandlerDeps
): void {
  ipcMain.handle(
    'get-diff',
    async (
      event,
      workspace: string | WorkspaceDiffRequest
    ) => {
      const resolved = deps.resolveWorkspaceDiffPath
        ? deps.resolveWorkspaceDiffPath(workspace)
        : deps.requireRegisteredWorkspace(
            typeof workspace === 'string'
              ? workspace
              : workspace.repoPath || workspace.workspacePath || ''
          )
      const chatId = typeof workspace === 'string' ? undefined : workspace.chatId
      deps.assertSenderScope(event, {
        capability: 'workspace-diff',
        ...(chatId ? { chatId } : {}),
        workspacePath: resolved
      })
      if (typeof workspace !== 'string' && typeof workspace.commitHash === 'string') {
        return getCommitFilePreview(resolved, workspace.commitHash)
      }
      return getWorkspaceDiff(resolved)
    }
  )

  ipcMain.handle('capture-snapshot', async (event, workspace: string) => {
    // Snapshot capture has the same repository-boundary semantics as diff
    // loading. In particular, a registered subdirectory inside a larger Git
    // repository must not widen `git status` to the ancestor repository.
    const resolved = deps.resolveWorkspaceDiffPath
      ? deps.resolveWorkspaceDiffPath(workspace)
      : deps.requireRegisteredWorkspace(workspace)
    deps.assertSenderScope(event, {
      capability: 'workspace-diff',
      workspacePath: resolved
    })
    return captureWorkspaceSnapshot(resolved)
  })
}
