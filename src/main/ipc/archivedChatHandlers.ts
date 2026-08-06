import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type SaveDialogOptions,
  ipcMain
} from 'electron'
import { extname } from 'path'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import type { ChatService } from '../services/ChatService'
import {
  archivedChatExportExtension,
  isArchivedChatExportFormat,
  type ArchivedChatExportFormat
} from '../../shared/archivedChatExport'
import { buildArchivedChatExport } from '../ArchivedChatExport'

type ArchivedChatActionResult =
  | { ok: true; chat: ChatRecord }
  | { ok: false; reason: 'not-found' | 'not-archived' }

export interface ArchivedChatHandlersDeps {
  chatService: Pick<ChatService, 'getChat' | 'saveChat'>
  getWorkspaces: () => WorkspaceRecord[]
  getRequestingWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
  showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (filePath: string, data: string | Buffer) => Promise<void>
  assertSafeChatId: (chatIdRaw: unknown, label: string) => string
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  homedir: () => string
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastThreadList: () => void
}

interface ExportArchivedChatInput {
  chatId?: unknown
  format?: unknown
}

interface ExportArchivedChatSuccess {
  ok: true
  canceled: false
  path: string
  format: ArchivedChatExportFormat
  messageCount: number
  charCount: number
}

interface ExportArchivedChatCanceled {
  ok: true
  canceled: true
  format: ArchivedChatExportFormat
}

type ExportArchivedChatResult =
  | ExportArchivedChatSuccess
  | ExportArchivedChatCanceled
  | { ok: false; reason: 'not-found' | 'not-archived' | 'invalid-request'; error?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function safeExportStem(title: string): string {
  const stem = [...title.trim()]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f ? '-' : character
    })
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
  return stem || 'archived-thread'
}

function defaultExportPath(chat: ChatRecord, format: ArchivedChatExportFormat): string {
  return `${safeExportStem(chat.title || 'Archived thread')}.${archivedChatExportExtension(format)}`
}

function ensureExportExtension(filePath: string, format: ArchivedChatExportFormat): string {
  const extension = `.${archivedChatExportExtension(format)}`
  return extname(filePath).toLowerCase() === extension ? filePath : `${filePath}${extension}`
}

function workspaceForChat(
  deps: ArchivedChatHandlersDeps,
  chat: ChatRecord
): WorkspaceRecord | null {
  if (!chat.workspaceId) return null
  return deps.getWorkspaces().find((workspace) => workspace.id === chat.workspaceId) || null
}

export function registerArchivedChatHandlers(deps: ArchivedChatHandlersDeps): void {
  ipcMain.handle('unarchive-chat', (event, chatIdRaw: unknown): ArchivedChatActionResult => {
    const chatId = deps.assertSafeChatId(chatIdRaw, 'unarchive-chat chatId')
    deps.assertSenderChatScope(event, chatId)
    const chat = deps.chatService.getChat(chatId)
    if (!chat) return { ok: false, reason: 'not-found' }
    if (!chat.archived) return { ok: false, reason: 'not-archived' }
    const updated = deps.chatService.saveChat({ ...chat, archived: false, updatedAt: Date.now() })
    deps.broadcastChatUpdated(updated)
    deps.broadcastThreadList()
    return { ok: true, chat: updated }
  })

  ipcMain.handle(
    'export-archived-chat',
    async (event, input: unknown): Promise<ExportArchivedChatResult> => {
      if (!isRecord(input)) return { ok: false, reason: 'invalid-request' }
      const request = input as ExportArchivedChatInput
      const chatId = deps.assertSafeChatId(request.chatId, 'export-archived-chat chatId')
      deps.assertSenderChatScope(event, chatId)
      if (!isArchivedChatExportFormat(request.format)) {
        return { ok: false, reason: 'invalid-request', error: 'Unsupported export format.' }
      }
      const format = request.format
      const chat = deps.chatService.getChat(chatId)
      if (!chat) return { ok: false, reason: 'not-found' }
      if (!chat.archived) return { ok: false, reason: 'not-archived' }

      const requestingWindow = deps.getRequestingWindow(event)
      if (!requestingWindow) {
        return {
          ok: false,
          reason: 'invalid-request',
          error: 'The settings window is unavailable.'
        }
      }
      const result = await deps.showSaveDialog(requestingWindow, {
        defaultPath: defaultExportPath(chat, format),
        filters: [
          {
            name:
              format === 'docx'
                ? 'Word document'
                : format === 'html'
                  ? 'HTML document'
                  : format === 'text'
                    ? 'Plain text'
                    : 'Markdown',
            extensions: [archivedChatExportExtension(format)]
          }
        ]
      })
      if (result.canceled || !result.filePath) return { ok: true, canceled: true, format }

      const built = buildArchivedChatExport(chat, format, {
        workspace: workspaceForChat(deps, chat),
        homeDir: deps.homedir()
      })
      const targetPath = ensureExportExtension(result.filePath, format)
      await deps.writeFile(targetPath, built.content)
      return {
        ok: true,
        canceled: false,
        path: targetPath,
        format,
        messageCount: built.messageCount,
        charCount: built.charCount
      }
    }
  )
}

export { safeExportStem }
