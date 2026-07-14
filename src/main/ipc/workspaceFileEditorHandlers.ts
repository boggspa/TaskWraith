import { ipcMain, type IpcMainInvokeEvent } from 'electron'
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
  assertSenderScope: (
    event: IpcMainInvokeEvent,
    input: {
      capability: 'workspace-file'
      workspacePath: string
      operation: 'read' | 'write'
    }
  ) => void
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
    async (event, workspace: string): Promise<WorkspaceFileEntry[]> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'read'
      })
      return (await listWorkspaceFiles(registeredWorkspace)).entries
    }
  )

  ipcMain.handle(
    'list-workspace-files-for-editor',
    async (event, workspace: string, options?: unknown): Promise<WorkspaceFileListResult> => {
      const request = isRecord(options) ? options : {}
      const limit = optionalNumber(request.limit)
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'read'
      })
      return listWorkspaceFiles(registeredWorkspace, {
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
    async (event, workspace: string, filePath: string): Promise<WorkspaceFileReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'read'
      })
      return readWorkspaceFile(registeredWorkspace, filePath)
    }
  )

  ipcMain.handle(
    'write-workspace-file',
    async (
      event,
      workspace: string,
      filePath: string,
      content: string,
      baseEtag?: string | null
    ): Promise<WorkspaceFileReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'write'
      })
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
    async (event, workspace: string, filePath: string, baseEtag?: string | null) => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'write'
      })
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
