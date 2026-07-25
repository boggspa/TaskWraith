import { dirname } from 'path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertSafeChatId } from '../ChatPath'
import type { OfficeDocumentReadResult } from '../../shared/office/officeFormats'
import {
  deleteOfficeDocument,
  readExternalOfficeDocument,
  readOfficeDocument,
  writeExternalOfficeDocument,
  writeOfficeDocument
} from '../services/OfficeDocumentService'
import type { RecordWorkspaceEditorChangeFn } from '../services/WorkspaceFileEditorService'
import type { ChatRecord, ExternalPathGrant, WorkspaceRecord } from '../store/types'

/**
 * Renderer-facing marker for "no grant covers this path". The renderer's
 * Office panel matches on it to switch into the consent flow; everything
 * after the colon is the human-readable half.
 */
export const OFFICE_EXTERNAL_GRANT_REQUIRED = 'external-grant-required'

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
  /** Fresh chat read — grant authority is re-derived on EVERY call so a
   * revoke mid-edit takes effect at the next read/save. */
  getChatForExternalGrants: (chatId: string) => ChatRecord | undefined
  executableExternalPathGrantsForChat: (chat: ChatRecord) => ExternalPathGrant[]
  externalGrantAllowsPath: (
    grant: ExternalPathGrant,
    targetPath: string,
    access: 'read' | 'write'
  ) => boolean
  canonicalExternalGrantPath: (value: string) => string | null
}

interface ExternalOfficePayload {
  chatId: string
  path: string
  model?: unknown
  baseEtag?: string | null
}

function parseExternalPayload(payload: unknown): ExternalOfficePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Malformed external office payload.')
  }
  const record = payload as Record<string, unknown>
  const chatId = typeof record.chatId === 'string' ? record.chatId : ''
  assertSafeChatId(chatId)
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (!path || !/^([/\\~]|[A-Za-z]:[\\/])/.test(path)) {
    throw new Error('External office paths must be absolute.')
  }
  const baseEtag =
    record.baseEtag === null || record.baseEtag === undefined
      ? record.baseEtag
      : typeof record.baseEtag === 'string'
        ? record.baseEtag
        : undefined
  return { chatId, path, model: record.model, baseEtag: baseEtag ?? null }
}

/**
 * Resolves the canonical target and the strongest access a chat's grants
 * confer on it. Throws the grant-required marker when `required` is not
 * covered. Authority is anchored to the signed grant strings via
 * externalGrantAllowsPath — never re-derived from the live filesystem.
 */
function requireExternalAccess(
  deps: OfficeDocumentHandlerDeps,
  chatId: string,
  path: string,
  required: 'read' | 'write'
): { canonicalPath: string; access: 'read' | 'write' } {
  const canonicalPath = deps.canonicalExternalGrantPath(path)
  if (!canonicalPath) {
    throw new Error(`${OFFICE_EXTERNAL_GRANT_REQUIRED}: ${path} cannot be resolved.`)
  }
  const chat = deps.getChatForExternalGrants(chatId)
  const grants = chat ? deps.executableExternalPathGrantsForChat(chat) : []
  const canRead = grants.some((grant) => deps.externalGrantAllowsPath(grant, canonicalPath, 'read'))
  const canWrite = grants.some((grant) =>
    deps.externalGrantAllowsPath(grant, canonicalPath, 'write')
  )
  const allowed = required === 'read' ? canRead : canWrite
  if (!allowed) {
    throw new Error(
      `${OFFICE_EXTERNAL_GRANT_REQUIRED}: this chat has no ${required} access to ${canonicalPath}.`
    )
  }
  return { canonicalPath, access: canWrite ? 'write' : 'read' }
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

  ipcMain.handle(
    'office:read-external-document',
    async (event, payload: unknown): Promise<OfficeDocumentReadResult> => {
      const { chatId, path } = parseExternalPayload(payload)
      const { canonicalPath, access } = requireExternalAccess(deps, chatId, path, 'read')
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: dirname(canonicalPath),
        operation: 'read'
      })
      const result = await readExternalOfficeDocument(canonicalPath)
      return { ...result, externalAccess: access }
    }
  )

  ipcMain.handle(
    'office:write-external-document',
    async (event, payload: unknown): Promise<OfficeDocumentReadResult> => {
      const { chatId, path, model, baseEtag } = parseExternalPayload(payload)
      // Fresh grant re-check on the write itself: a revoke issued while the
      // user was editing wins over any earlier read-time authority.
      const { canonicalPath, access } = requireExternalAccess(deps, chatId, path, 'write')
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: dirname(canonicalPath),
        operation: 'write'
      })
      const result = await writeExternalOfficeDocument({
        absolutePath: canonicalPath,
        model,
        baseEtag
      })
      return { ...result, externalAccess: access }
    }
  )

  ipcMain.handle(
    'office:delete-document',
    async (event, workspace: string, filePath: string, baseEtag?: string | null) => {
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'write'
      })
      const workspaceRecord = deps.findRegisteredWorkspace(registeredWorkspace)
      const result = await deleteOfficeDocument({
        workspacePath: registeredWorkspace,
        workspaceId: workspaceRecord?.id,
        filePath,
        baseEtag,
        recordChange: deps.recordWorkspaceEditorChange
      })
      deps.scheduleRemoteGitSnapshotRefresh(workspaceRecord?.id, { delayMs: 50, force: true })
      return result
    }
  )
}
