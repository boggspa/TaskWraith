import { ipcMain } from 'electron'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile,
  type RecordWorkspaceEditorChangeFn,
  type WorkspaceFileListResult
} from '../services/WorkspaceFileEditorService'
import type {
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
  WorkspaceRecord
} from '../store/types'
import { isRecord, optionalNumber, optionalString } from '../settings/MainSanitizers'

export interface WorkspaceFileEditorHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  recordWorkspaceEditorChange: RecordWorkspaceEditorChangeFn
  scheduleRemoteGitSnapshotRefresh: (
    workspaceId: string | null | undefined,
    options?: { delayMs?: number; force?: boolean }
  ) => void
}

export function registerWorkspaceFileEditorHandlers(
  deps: WorkspaceFileEditorHandlerDeps
): void {
  ipcMain.handle(
    'list-workspace-files',
    async (_event, workspace: string): Promise<WorkspaceFileEntry[]> => {
      return (await listWorkspaceFiles(deps.requireRegisteredWorkspace(workspace))).entries
    }
  )

  ipcMain.handle(
    'list-workspace-files-for-editor',
    async (_event, workspace: string, options?: unknown): Promise<WorkspaceFileListResult> => {
      const request = isRecord(options) ? options : {}
      const limit = optionalNumber(request.limit)
      return listWorkspaceFiles(deps.requireRegisteredWorkspace(workspace), {
        path: optionalString(request.path),
        query: optionalString(request.query),
        ...(typeof request.includeDirectories === 'boolean'
          ? { includeDirectories: request.includeDirectories }
          : {}),
        ...(limit !== undefined ? { limit } : {})
      })
    }
  )

  ipcMain.handle(
    'read-workspace-file',
    async (_event, workspace: string, filePath: string): Promise<WorkspaceFileReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      return readWorkspaceFile(registeredWorkspace, filePath)
    }
  )

  ipcMain.handle(
    'write-workspace-file',
    async (
      _event,
      workspace: string,
      filePath: string,
      content: string,
      baseEtag?: string | null
    ): Promise<WorkspaceFileReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      const result = await writeWorkspaceFile({
        workspacePath: registeredWorkspace,
        filePath,
        content,
        baseEtag,
        origin: 'file-editor',
        recordChange: deps.recordWorkspaceEditorChange
      })
      const workspaceRecord = deps.findRegisteredWorkspace(registeredWorkspace)
      deps.scheduleRemoteGitSnapshotRefresh(workspaceRecord?.id, { delayMs: 50, force: true })
      return result
    }
  )

  ipcMain.handle(
    'delete-workspace-file',
    async (_event, workspace: string, filePath: string, baseEtag?: string | null) => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      const result = await deleteWorkspaceFile({
        workspacePath: registeredWorkspace,
        filePath,
        baseEtag,
        origin: 'file-editor',
        recordChange: deps.recordWorkspaceEditorChange
      })
      const workspaceRecord = deps.findRegisteredWorkspace(registeredWorkspace)
      deps.scheduleRemoteGitSnapshotRefresh(workspaceRecord?.id, { delayMs: 50, force: true })
      return result
    }
  )
}
