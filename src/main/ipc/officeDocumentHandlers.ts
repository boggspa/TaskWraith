import { dirname } from 'path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertSafeChatId } from '../ChatPath'
import { resolveWorkspaceChild } from '../PathScope'
import { officeFormatForPath } from '../../shared/office/officeFormats'
import type { OfficeDocumentReadResult } from '../../shared/office/officeFormats'
import {
  deleteOfficeDocument,
  importOfficeDocument,
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
  /** Reveals a file in the OS file manager. */
  showItemInFolder: (absolutePath: string) => void
  /**
   * Hands a file to the OS default application. Only ever called with an
   * authorized OFFICE-format path, so this can never launch a script or app
   * bundle — it opens documents in Word/Excel/PowerPoint/Outlook/Calendar.
   */
  openPathInDefaultApp: (absolutePath: string) => Promise<string>
}

interface ExternalOfficePayload {
  chatId: string
  path: string
  model?: unknown
  baseEtag?: string | null
}

/**
 * Rejects NUL and other control bytes before a path reaches any native
 * consumer. `IpcValidation`'s `'filePath'` ArgSpec does this for the
 * positional channels; the object-payload channels must do it themselves.
 */
function assertNoControlCharacters(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error('Office paths cannot contain control characters.')
  }
}

/** Office-extension gate shared by the shell actions. */
function requireOfficeFormat(filePath: string): void {
  assertNoControlCharacters(filePath)
  if (!officeFormatForPath(filePath)) {
    throw new Error('Only Office documents can be revealed or opened.')
  }
}

/**
 * Shell actions accept either a workspace document (registered workspace +
 * relative path) or an external one (chat grant + absolute path), and resolve
 * both to one authorized absolute path. Authority is identical to the read
 * lane — revealing or opening a file is a read-equivalent act.
 */
function resolveShellTarget(
  deps: OfficeDocumentHandlerDeps,
  event: IpcMainInvokeEvent,
  payload: unknown
): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Malformed office shell payload.')
  }
  const record = payload as Record<string, unknown>
  const workspace = typeof record.workspacePath === 'string' ? record.workspacePath : ''
  const filePath = typeof record.filePath === 'string' ? record.filePath : ''

  if (workspace) {
    const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
    deps.assertSenderScope(event, {
      capability: 'workspace-file',
      workspacePath: registeredWorkspace,
      operation: 'read'
    })
    // Extension gate + containment: resolveWorkspaceChild rejects escapes.
    requireOfficeFormat(filePath)
    return resolveWorkspaceChild(registeredWorkspace, filePath)
  }

  const { chatId, path } = parseExternalPayload(record)
  const { canonicalPath } = requireExternalAccess(deps, chatId, path, 'read')
  requireOfficeFormat(canonicalPath)
  deps.assertSenderScope(event, {
    capability: 'workspace-file',
    workspacePath: dirname(canonicalPath),
    operation: 'read'
  })
  return canonicalPath
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
  assertNoControlCharacters(path)
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
    'office:import-document',
    async (event, payload: unknown): Promise<OfficeDocumentReadResult> => {
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('Malformed office import payload.')
      }
      const record = payload as Record<string, unknown>
      const workspace = typeof record.workspacePath === 'string' ? record.workspacePath : ''
      const filePath = typeof record.filePath === 'string' ? record.filePath : ''
      const contentBase64 = typeof record.contentBase64 === 'string' ? record.contentBase64 : ''
      if (!contentBase64) throw new Error('Imported file content is required.')
      const registeredWorkspace = deps.requireRegisteredWorkspace(workspace)
      deps.assertSenderScope(event, {
        capability: 'workspace-file',
        workspacePath: registeredWorkspace,
        operation: 'write'
      })
      const workspaceRecord = deps.findRegisteredWorkspace(registeredWorkspace)
      const result = await importOfficeDocument({
        workspacePath: registeredWorkspace,
        workspaceId: workspaceRecord?.id,
        filePath,
        contentBase64,
        recordChange: deps.recordWorkspaceEditorChange
      })
      deps.scheduleRemoteGitSnapshotRefresh(workspaceRecord?.id, { delayMs: 50, force: true })
      return result
    }
  )

  ipcMain.handle('office:reveal-document', async (event, payload: unknown) => {
    const target = resolveShellTarget(deps, event, payload)
    deps.showItemInFolder(target)
    return { ok: true }
  })

  ipcMain.handle('office:open-document-in-default-app', async (event, payload: unknown) => {
    const target = resolveShellTarget(deps, event, payload)
    // Electron resolves with '' on success and an error string otherwise.
    const failure = await deps.openPathInDefaultApp(target)
    return failure ? { ok: false, error: failure } : { ok: true }
  })

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
