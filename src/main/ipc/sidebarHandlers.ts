import { type WebContents, ipcMain } from 'electron'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import type {
  TranscriptMarkdownExportOptions,
  TranscriptMarkdownExportResult
} from '../TranscriptMarkdownExport'

type SidebarPathActionResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; error?: string }

interface CopyChatMarkdownTranscriptSuccess {
  ok: true
  messageCount: number
  charCount: number
  omissions: string[]
}

interface CopyChatMarkdownTranscriptTooLarge {
  ok: false
  reason: 'too-large'
  messageCount: number
  charCount: number
  omissions: string[]
}

type CopyChatMarkdownTranscriptResult =
  | SidebarPathActionResult
  | { ok: false; reason: 'unauthorized' | 'empty' }
  | CopyChatMarkdownTranscriptTooLarge
  | CopyChatMarkdownTranscriptSuccess

export interface SidebarHandlersDeps {
  fromWebContents: (webContents: WebContents) => { isDestroyed: () => boolean } | null
  getWorkspaces: () => WorkspaceRecord[]
  getChat: (chatId: string) => ChatRecord | null | undefined
  getSettings: () => { storeLocalChatHistory?: boolean }
  getChatRecordPath: (appChatId: string) => string | null | undefined
  existsSync: (pathValue: string) => boolean
  showItemInFolder: (pathValue: string) => void
  writeClipboardText: (text: string, type: 'clipboard') => void
  buildChatMarkdownTranscript: (
    chat: ChatRecord,
    options: TranscriptMarkdownExportOptions
  ) => TranscriptMarkdownExportResult
  estimateChatMarkdownTranscriptChars: (chat: ChatRecord) => number
  assertSafeChatId: (chatIdRaw: unknown, label: string) => string
  homedir: () => string
}

function isAuthorizedSender(deps: SidebarHandlersDeps, sender: WebContents): boolean {
  const senderWindow = deps.fromWebContents(sender)
  return Boolean(senderWindow && !senderWindow.isDestroyed())
}

function resolveSidebarWorkspace(
  deps: SidebarHandlersDeps,
  workspaceIdRaw: unknown
): WorkspaceRecord | null {
  const workspaceId = typeof workspaceIdRaw === 'string' ? workspaceIdRaw.trim() : ''
  if (!workspaceId || workspaceId !== workspaceIdRaw) return null
  return deps.getWorkspaces().find((workspace) => workspace.id === workspaceId) || null
}

function resolveSidebarChat(
  deps: SidebarHandlersDeps,
  chatIdRaw: unknown
): ChatRecord | SidebarPathActionResult {
  let chatId: string
  try {
    chatId = deps.assertSafeChatId(chatIdRaw, 'sidebar chat id')
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-chat-id',
      error: error instanceof Error ? error.message : String(error)
    }
  }
  const chat = deps.getChat(chatId)
  if (!chat) return { ok: false, reason: 'not-found' }
  if (chat.archived) return { ok: false, reason: 'archived' }
  return chat
}

function resolveWorkspaceForSidebarChat(
  deps: SidebarHandlersDeps,
  chatIdRaw: unknown
): WorkspaceRecord | SidebarPathActionResult {
  const chat = resolveSidebarChat(deps, chatIdRaw)
  if ('ok' in chat) return chat
  if (chat.scope === 'global' || (!chat.workspaceId && !chat.workspacePath)) {
    return { ok: false, reason: 'no-workspace' }
  }
  const workspaces = deps.getWorkspaces()
  const registeredById = chat.workspaceId
    ? workspaces.find((workspace) => workspace.id === chat.workspaceId)
    : null
  if (registeredById) return registeredById
  const registeredByPath = chat.workspacePath
    ? workspaces.find((workspace) => workspace.path === chat.workspacePath)
    : null
  return registeredByPath || { ok: false, reason: 'workspace-not-found' }
}

function revealSidebarPath(
  deps: SidebarHandlersDeps,
  pathValue: string
): SidebarPathActionResult {
  if (!deps.existsSync(pathValue)) return { ok: false, reason: 'missing' }
  try {
    deps.showItemInFolder(pathValue)
    return { ok: true, path: pathValue }
  } catch (error) {
    return {
      ok: false,
      reason: 'finder-error',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function copySidebarPath(deps: SidebarHandlersDeps, pathValue: string): SidebarPathActionResult {
  deps.writeClipboardText(pathValue, 'clipboard')
  return { ok: true, path: pathValue }
}

export function registerSidebarHandlers(deps: SidebarHandlersDeps): void {
  ipcMain.handle('sidebar:show-workspace-in-finder', (event, workspaceId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveSidebarWorkspace(deps, workspaceId)
    if (!workspace) return { ok: false, reason: 'workspace-not-found' }
    return revealSidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-workspace-directory', (event, workspaceId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveSidebarWorkspace(deps, workspaceId)
    if (!workspace) return { ok: false, reason: 'workspace-not-found' }
    return copySidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:show-chat-workspace-in-finder', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveWorkspaceForSidebarChat(deps, chatId)
    if ('ok' in workspace) return workspace
    return revealSidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-chat-working-directory', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveWorkspaceForSidebarChat(deps, chatId)
    if ('ok' in workspace) return workspace
    return copySidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-chat-transcript-path', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    if (deps.getSettings().storeLocalChatHistory === false) {
      return { ok: false, reason: 'local-history-disabled' }
    }
    const chat = resolveSidebarChat(deps, chatId)
    if ('ok' in chat) return chat
    const chatPath = deps.getChatRecordPath(chat.appChatId)
    if (!chatPath || !deps.existsSync(chatPath)) {
      return { ok: false, reason: 'missing' }
    }
    return copySidebarPath(deps, chatPath)
  })

  ipcMain.handle(
    'copy-chat-markdown-transcript',
    async (event, chatId: string): Promise<CopyChatMarkdownTranscriptResult> => {
      if (!isAuthorizedSender(deps, event.sender)) {
        return { ok: false, reason: 'unauthorized' }
      }
      deps.assertSafeChatId(chatId, 'copy-chat-markdown-transcript chatId')
      const chat = deps.getChat(chatId)
      if (!chat) return { ok: false, reason: 'not-found' }
      if (chat.archived) return { ok: false, reason: 'archived' }
      if (!chat.messages?.length) return { ok: false, reason: 'empty' }
      const estimatedCharCount = deps.estimateChatMarkdownTranscriptChars(chat)
      if (estimatedCharCount > 2_000_000) {
        return {
          ok: false,
          reason: 'too-large',
          messageCount: chat.messages.length,
          charCount: estimatedCharCount,
          omissions: ['transcript too large for clipboard copy']
        }
      }
      const workspace = chat.workspaceId
        ? deps.getWorkspaces().find((candidate) => candidate.id === chat.workspaceId) || null
        : null
      const result = deps.buildChatMarkdownTranscript(chat, {
        workspace,
        homeDir: deps.homedir()
      })
      if (!result.markdown.trim()) return { ok: false, reason: 'empty' }
      if (result.charCount > 2_000_000) {
        return {
          ok: false,
          reason: 'too-large',
          messageCount: result.messageCount,
          charCount: result.charCount,
          omissions: result.omissions
        }
      }
      deps.writeClipboardText(result.markdown, 'clipboard')
      return {
        ok: true,
        messageCount: result.messageCount,
        charCount: result.charCount,
        omissions: result.omissions
      }
    }
  )
}
