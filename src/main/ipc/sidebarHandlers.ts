import { basename } from 'node:path'
import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type SaveDialogOptions,
  type WebContents,
  ipcMain
} from 'electron'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import type {
  TranscriptMessageTextExportResult,
  TranscriptMarkdownExportOptions,
  TranscriptMarkdownExportResult,
  TranscriptMarkdownStreamResult
} from '../TranscriptMarkdownExport'
import {
  isTranscriptExportScope,
  scopeChatForTranscriptExport,
  transcriptExportScopeLabel,
  type ScopedTranscriptChat,
  type TranscriptExportScope
} from '../../shared/transcriptExportScope'

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

type CopyChatMessageTranscriptResult = CopyChatMarkdownTranscriptResult

/** Round downloads carry Markdown for the renderer's ordinary Blob path. */
interface DownloadChatMarkdownTranscriptRendererSuccess
  extends CopyChatMarkdownTranscriptSuccess {
  markdown: string
  fileName: string
  streamed?: false
}

interface DownloadChatMarkdownTranscriptStreamedSuccess
  extends CopyChatMarkdownTranscriptSuccess {
  fileName: string
  streamed: true
}

type DownloadChatMarkdownTranscriptResult =
  | SidebarPathActionResult
  | { ok: false; reason: 'unauthorized' | 'empty' }
  | CopyChatMarkdownTranscriptTooLarge
  | DownloadChatMarkdownTranscriptRendererSuccess
  | DownloadChatMarkdownTranscriptStreamedSuccess

const TRANSCRIPT_FILE_NAME_MAX = 80

/**
 * Code-point predicate rather than a control-character regex range on purpose:
 * `scripts/control-byte-guard.cjs` bans raw C0 bytes in source, and an escape
 * spelled in a character class has landed as the raw byte more than once.
 */
function isPrintableTitleChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= 0x20 && code !== 0x7f
}

/**
 * Thread title -> the `.md` name the user sees in their downloads. Path
 * separators and the Windows-reserved set become dashes, and leading/trailing
 * dots and spaces go because Explorer silently drops them; a title that
 * sanitizes down to nothing (emoji-only, whitespace-only) falls back rather
 * than producing a bare dotfile.
 */
export function chatTranscriptFileName(
  title: string | null | undefined,
  roundOrdinal?: number
): string {
  const collapsed = (typeof title === 'string' ? title : '').replace(/\s+/g, ' ').trim()
  const cleaned = Array.from(collapsed)
    .filter(isPrintableTitleChar)
    .join('')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const roundSuffix =
    Number.isSafeInteger(roundOrdinal) && Number(roundOrdinal) > 0
      ? ` - Round ${roundOrdinal}`
      : ''
  const availableTitleLength = Math.max(1, TRANSCRIPT_FILE_NAME_MAX - roundSuffix.length)
  const clipped = cleaned.slice(0, availableTitleLength).replace(/[.\s]+$/, '')
  return `${clipped || 'transcript'}${roundSuffix}.md`
}

export interface SidebarHandlersDeps {
  fromWebContents: (webContents: WebContents) => BrowserWindow | null
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
  buildChatMessageTranscript: (chat: ChatRecord) => TranscriptMessageTextExportResult
  estimateChatMessageTranscriptChars: (chat: ChatRecord) => number
  showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
  writeChatMarkdownTranscriptToFile: (
    chat: ChatRecord,
    options: TranscriptMarkdownExportOptions,
    filePath: string
  ) => Promise<TranscriptMarkdownStreamResult>
  assertSafeChatId: (chatIdRaw: unknown, label: string) => string
  assertSenderWorkspaceScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
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

/**
 * Failure-only so the shared preparation can hand its rejection straight back
 * from either channel; the success shapes diverge (clipboard vs. file) and are
 * built by the handlers themselves.
 */
type ChatMarkdownTranscriptFailure = Extract<CopyChatMarkdownTranscriptResult, { ok: false }>

interface TranscriptRequest {
  window: BrowserWindow
  scope: TranscriptExportScope
  scopeProvided: boolean
  scoped: ScopedTranscriptChat
  options: TranscriptMarkdownExportOptions
}

type TranscriptRequestResolution =
  | { ok: false; failure: ChatMarkdownTranscriptFailure }
  | { ok: true; request: TranscriptRequest }

type MarkdownTranscriptPreparation =
  | { ok: false; failure: ChatMarkdownTranscriptFailure }
  | { ok: true; request: TranscriptRequest; built: TranscriptMarkdownExportResult }

function resolveTranscriptRequest(
  deps: SidebarHandlersDeps,
  event: IpcMainInvokeEvent,
  chatId: string,
  scopeRaw: unknown,
  label: string
): TranscriptRequestResolution {
  const window = deps.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) {
    return { ok: false, failure: { ok: false, reason: 'unauthorized' } }
  }
  deps.assertSafeChatId(chatId, `${label} chatId`)
  deps.assertSenderChatScope(event, chatId)
  const chat = deps.getChat(chatId)
  if (!chat) return { ok: false, failure: { ok: false, reason: 'not-found' } }
  if (chat.archived) return { ok: false, failure: { ok: false, reason: 'archived' } }
  if (!chat.messages?.length) return { ok: false, failure: { ok: false, reason: 'empty' } }

  const scopeProvided = scopeRaw !== undefined && scopeRaw !== null
  if (scopeProvided && !isTranscriptExportScope(scopeRaw)) {
    return { ok: false, failure: { ok: false, reason: 'invalid-scope' } }
  }
  const scope: TranscriptExportScope = scopeProvided
    ? (scopeRaw as TranscriptExportScope)
    : { kind: 'entire-task' }
  const scoped = scopeChatForTranscriptExport(chat, scope)
  if (!scoped) return { ok: false, failure: { ok: false, reason: 'round-not-found' } }
  if (!scoped.chat.messages.length) {
    return { ok: false, failure: { ok: false, reason: 'empty' } }
  }
  const workspace = chat.workspaceId
    ? deps.getWorkspaces().find((candidate) => candidate.id === chat.workspaceId) || null
    : null
  return {
    ok: true,
    request: {
      window,
      scope,
      scopeProvided,
      scoped,
      options: {
        workspace,
        homeDir: deps.homedir(),
        ...(scopeProvided
          ? { scopeLabel: transcriptExportScopeLabel(scoped.round, scoped.roundCount) }
          : {})
      }
    }
  }
}

/**
 * Shared front half of the copy and download transcript channels: scope the
 * sender, reject the chats that have nothing exportable, and build the safe
 * handoff Markdown. Only the disposition of the built text differs between
 * them, so `tooLargeNote` is the one caller-specific string.
 */
function prepareChatMarkdownTranscript(
  deps: SidebarHandlersDeps,
  event: IpcMainInvokeEvent,
  chatId: string,
  scopeRaw: unknown,
  label: string,
  tooLargeNote: string
): MarkdownTranscriptPreparation {
  const resolved = resolveTranscriptRequest(deps, event, chatId, scopeRaw, label)
  if (!resolved.ok) return resolved
  return prepareResolvedChatMarkdownTranscript(deps, resolved.request, tooLargeNote)
}

function prepareResolvedChatMarkdownTranscript(
  deps: SidebarHandlersDeps,
  request: TranscriptRequest,
  tooLargeNote: string
): MarkdownTranscriptPreparation {
  const estimatedCharCount = deps.estimateChatMarkdownTranscriptChars(request.scoped.chat)
  if (estimatedCharCount > 2_000_000) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: 'too-large',
        messageCount: request.scoped.chat.messages.length,
        charCount: estimatedCharCount,
        omissions: [tooLargeNote]
      }
    }
  }
  const built = deps.buildChatMarkdownTranscript(request.scoped.chat, request.options)
  if (!built.markdown.trim()) return { ok: false, failure: { ok: false, reason: 'empty' } }
  if (built.charCount > 2_000_000) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: 'too-large',
        messageCount: built.messageCount,
        charCount: built.charCount,
        omissions: built.omissions
      }
    }
  }
  return { ok: true, request, built }
}

export function registerSidebarHandlers(deps: SidebarHandlersDeps): void {
  ipcMain.handle('sidebar:show-workspace-in-finder', (event, workspaceId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveSidebarWorkspace(deps, workspaceId)
    if (!workspace) return { ok: false, reason: 'workspace-not-found' }
    deps.assertSenderWorkspaceScope(event, workspace.path)
    return revealSidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-workspace-directory', (event, workspaceId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    const workspace = resolveSidebarWorkspace(deps, workspaceId)
    if (!workspace) return { ok: false, reason: 'workspace-not-found' }
    deps.assertSenderWorkspaceScope(event, workspace.path)
    return copySidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:show-chat-workspace-in-finder', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    deps.assertSenderChatScope(event, chatId)
    const workspace = resolveWorkspaceForSidebarChat(deps, chatId)
    if ('ok' in workspace) return workspace
    return revealSidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-chat-working-directory', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    deps.assertSenderChatScope(event, chatId)
    const workspace = resolveWorkspaceForSidebarChat(deps, chatId)
    if ('ok' in workspace) return workspace
    return copySidebarPath(deps, workspace.path)
  })

  ipcMain.handle('sidebar:copy-chat-transcript-path', (event, chatId: string) => {
    if (!isAuthorizedSender(deps, event.sender)) {
      return { ok: false, reason: 'unauthorized' }
    }
    deps.assertSenderChatScope(event, chatId)
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
    async (event, chatId: string, scope?: unknown): Promise<CopyChatMarkdownTranscriptResult> => {
      const prepared = prepareChatMarkdownTranscript(
        deps,
        event,
        chatId,
        scope,
        'copy-chat-markdown-transcript',
        'transcript too large for clipboard copy'
      )
      if (!prepared.ok) return prepared.failure
      deps.writeClipboardText(prepared.built.markdown, 'clipboard')
      return {
        ok: true,
        messageCount: prepared.built.messageCount,
        charCount: prepared.built.charCount,
        omissions: prepared.built.omissions
      }
    }
  )

  /**
   * Same safe handoff Markdown as the copy channel, returned to the renderer
   * so it can be saved as a file named for the thread. The clipboard is left
   * untouched — downloading is not meant to clobber what the user has copied.
   */
  ipcMain.handle(
    'download-chat-markdown-transcript',
    async (
      event,
      chatId: string,
      scope?: unknown
    ): Promise<DownloadChatMarkdownTranscriptResult> => {
      const resolved = resolveTranscriptRequest(
        deps,
        event,
        chatId,
        scope,
        'download-chat-markdown-transcript'
      )
      if (!resolved.ok) return resolved.failure
      const { request } = resolved

      // The explicit entire-task option is main-owned from dialog to disk. No
      // Markdown string crosses IPC or ever exists in renderer memory. Calls
      // from older renderers omit scope and retain the legacy Blob behavior.
      if (request.scopeProvided && request.scope.kind === 'entire-task') {
        const fileName = chatTranscriptFileName(request.scoped.chat.title)
        let selection: { canceled: boolean; filePath?: string }
        try {
          selection = await deps.showSaveDialog(request.window, {
            title: 'Download entire task transcript',
            buttonLabel: 'Download',
            defaultPath: fileName,
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
        } catch {
          return { ok: false, reason: 'save-failed' }
        }
        if (selection.canceled) return { ok: false, reason: 'cancelled' }
        if (!selection.filePath) return { ok: false, reason: 'save-failed' }
        try {
          const streamed = await deps.writeChatMarkdownTranscriptToFile(
            request.scoped.chat,
            request.options,
            selection.filePath
          )
          return {
            ok: true,
            streamed: true,
            fileName: basename(selection.filePath),
            messageCount: streamed.messageCount,
            charCount: streamed.charCount,
            omissions: streamed.omissions
          }
        } catch {
          return { ok: false, reason: 'save-failed' }
        }
      }

      const prepared = prepareResolvedChatMarkdownTranscript(
        deps,
        request,
        'transcript too large to download'
      )
      if (!prepared.ok) return prepared.failure
      return {
        ok: true,
        markdown: prepared.built.markdown,
        fileName: chatTranscriptFileName(
          prepared.request.scoped.chat.title,
          prepared.request.scoped.round?.ordinal
        ),
        messageCount: prepared.built.messageCount,
        charCount: prepared.built.charCount,
        omissions: prepared.built.omissions
      }
    }
  )

  ipcMain.handle(
    'copy-chat-messages',
    async (event, chatId: string, scope?: unknown): Promise<CopyChatMessageTranscriptResult> => {
      const resolved = resolveTranscriptRequest(
        deps,
        event,
        chatId,
        scope,
        'copy-chat-messages'
      )
      if (!resolved.ok) return resolved.failure
      const chat = resolved.request.scoped.chat
      const estimatedCharCount = deps.estimateChatMessageTranscriptChars(chat)
      if (estimatedCharCount > 2_000_000) {
        return {
          ok: false,
          reason: 'too-large',
          messageCount: chat.messages.length,
          charCount: estimatedCharCount,
          omissions: ['messages too large for clipboard copy']
        }
      }
      const result = deps.buildChatMessageTranscript(chat)
      if (!result.text.trim()) return { ok: false, reason: 'empty' }
      if (result.charCount > 2_000_000) {
        return {
          ok: false,
          reason: 'too-large',
          messageCount: result.messageCount,
          charCount: result.charCount,
          omissions: ['messages too large for clipboard copy']
        }
      }
      deps.writeClipboardText(result.text, 'clipboard')
      return {
        ok: true,
        messageCount: result.messageCount,
        charCount: result.charCount,
        omissions: []
      }
    }
  )
}
