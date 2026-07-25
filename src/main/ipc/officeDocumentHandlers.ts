import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { OfficeDocumentReadResult } from '../../shared/office/officeFormats'
import { readOfficeDocument, writeOfficeDocument } from '../services/OfficeDocumentService'
import type { RecordWorkspaceEditorChangeFn } from '../services/WorkspaceFileEditorService'
import type { WorkspaceRecord } from '../store/types'

export interface OfficeDocumentHandlerDeps {
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

export function registerOfficeDocumentHandlers(deps: OfficeDocumentHandlerDeps): void {
  ipcMain.handle(
    'office:read-document',
    async (event, workspace: string, filePath: string): Promise<OfficeDocumentReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'read'
      })
      return readOfficeDocument(registeredWorkspace, filePath)
    }
  )

  ipcMain.handle(
    'office:write-document',
    async (
      event,
      workspace: string,
      filePath: string,
      model: unknown,
      baseEtag?: string | null
    ): Promise<OfficeDocumentReadResult> => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'write'
      })
      const workspaceRecord = deps.findRegisteredWorkspace(registeredWorkspace)
      const result = await writeOfficeDocument({
        workspacePath: registeredWorkspace,
        workspaceId: workspaceRecord?.id,
        filePath,
        model,
        baseEtag,
        recordChange: deps.recordWorkspaceEditorChange
      })
      deps.scheduleRemoteGitSnapshotRefresh(workspaceRecord?.id, { delayMs: 50, force: true })
      return result
    }
  )
}
