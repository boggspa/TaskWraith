import { type BrowserWindow, type OpenDialogOptions, ipcMain } from 'electron'
import type { ChatRecord, ExternalPathGrant, ProviderId, WorkspaceRecord } from '../store/types'

interface ExternalPathGrantDialogResult {
  canceled: boolean
  filePaths: string[]
  bookmarks?: string[]
}

interface ExternalPathGrantStatLike {
  isDirectory(): boolean
}

interface RegisteredExplicitExternalPath {
  path: string
  workspace: WorkspaceRecord
}

type PickAndPersistResult =
  | { ok: true; grants: ExternalPathGrant[]; path: string }
  | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }

interface ExternalPathGrantPersistPayload {
  chatId?: string
  access?: 'read' | 'write'
  path?: string
  deferPersist?: boolean
}

export interface ExternalPathGrantHandlersDeps {
  getMainWindow: () => BrowserWindow | null
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<ExternalPathGrantDialogResult>
  stat: (pathValue: string) => Promise<ExternalPathGrantStatLike>
  resolvePath: (pathValue: string) => string
  providerLabel: (provider: ProviderId) => string
  issueExternalPathGrant: (
    grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>
  ) => ExternalPathGrant
  getChat: (chatId: string) => ChatRecord | null | undefined
  saveChat: (chat: ChatRecord) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  collectExternalPathGrantsFromMetadata: (
    metadata: Record<string, unknown> | null | undefined
  ) => ExternalPathGrant[]
  canonicalizeExternalPathGrantMetadata: (
    metadata: Record<string, unknown> | null | undefined,
    nextGrants?: ExternalPathGrant[]
  ) => Record<string, unknown>
  isExternalPathGrantDispatchProvider: (provider: ProviderId) => boolean
  resolveRegisteredExplicitExternalPath: (input: {
    explicitPath: string
    findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
    canonicalPath: (value: string) => string
  }) => RegisteredExplicitExternalPath | null
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  canonicalPath: (value: string) => string
  optionalString: (value: unknown) => string | undefined
  randomBytes: (size: number) => Buffer
  securityScopedBookmarks: boolean
  probeExternalPath: (absolutePath: string) => Promise<unknown>
}

export function registerExternalPathGrantHandlers(deps: ExternalPathGrantHandlersDeps): void {
  ipcMain.handle(
    'select-external-path-grant',
    async (_, access: 'read' | 'write' = 'read', provider?: unknown) => {
      const mainWindow = deps.getMainWindow()
      if (!mainWindow) return null
      const grantProvider: ProviderId =
        provider === 'gemini' ||
        provider === 'codex' ||
        provider === 'claude' ||
        provider === 'kimi'
          ? provider
          : 'codex'
      const providerLabelText = deps.providerLabel(grantProvider)
      const result = await deps.showOpenDialog(mainWindow, {
        title:
          access === 'write'
            ? `Select file or folder ${providerLabelText} can edit`
            : `Select file or folder ${providerLabelText} can view`,
        properties: ['openFile', 'openDirectory', 'createDirectory'],
        securityScopedBookmarks: deps.securityScopedBookmarks
      } as OpenDialogOptions)

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const selectedPath = deps.resolvePath(result.filePaths[0])
      let kind: ExternalPathGrant['kind'] = 'file'
      try {
        const stat = await deps.stat(selectedPath)
        kind = stat.isDirectory() ? 'directory' : 'file'
      } catch {
        kind = 'file'
      }

      return deps.issueExternalPathGrant({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        provider: grantProvider,
        path: selectedPath,
        kind,
        access: access === 'write' ? 'write' : 'read',
        duration: 'thisThread',
        securityScopedBookmark: Array.isArray((result as any).bookmarks)
          ? (result as any).bookmarks[0]
          : undefined,
        createdAt: new Date().toISOString()
      })
    }
  )

  ipcMain.handle(
    'external-path:pick-and-persist',
    async (_event, payload: ExternalPathGrantPersistPayload): Promise<PickAndPersistResult> => {
      const mainWindow = deps.getMainWindow()
      if (!mainWindow) return { ok: false, reason: 'no-window' }
      const chatId = deps.optionalString(payload?.chatId)
      if (!chatId) return { ok: false, reason: 'no-chat' }
      const chat = deps.getChat(chatId)
      if (!chat) return { ok: false, reason: 'no-chat' }

      const access: 'read' | 'write' = payload?.access === 'write' ? 'write' : 'read'

      const targetProviders: ProviderId[] = []
      if (chat.chatKind === 'ensemble' && chat.ensemble?.participants?.length) {
        const seen = new Set<ProviderId>()
        for (const participant of chat.ensemble.participants) {
          if (!participant.enabled) continue
          if (seen.has(participant.provider)) continue
          seen.add(participant.provider)
          targetProviders.push(participant.provider)
        }
      } else if (chat.provider) {
        targetProviders.push(chat.provider)
      }
      const dispatchProviders = targetProviders.filter((provider) =>
        deps.isExternalPathGrantDispatchProvider(provider)
      )
      if (dispatchProviders.length === 0) {
        return { ok: false, reason: 'no-provider' }
      }

      const explicitPath = deps.optionalString(payload?.path)
      let selectedPath: string
      let bookmark: string | undefined
      let registeredExplicitWorkspace: WorkspaceRecord | undefined
      if (explicitPath) {
        const registeredExplicitPath = deps.resolveRegisteredExplicitExternalPath({
          explicitPath,
          findRegisteredWorkspace: deps.findRegisteredWorkspace,
          canonicalPath: deps.canonicalPath
        })
        if (!registeredExplicitPath) {
          return { ok: false, reason: 'cancelled' }
        }
        selectedPath = registeredExplicitPath.path
        registeredExplicitWorkspace = registeredExplicitPath.workspace
        try {
          await deps.stat(selectedPath)
        } catch {
          return { ok: false, reason: 'cancelled' }
        }
        bookmark = undefined
      } else {
        const accessVerb = access === 'write' ? 'can edit' : 'can read'
        const dialogResult = await deps.showOpenDialog(mainWindow, {
          title: `Select folder agents in this chat ${accessVerb}`,
          message: `Issues a ${
            access === 'write' ? 'read+write' : 'read-only'
          } grant scoped to this chat. ${
            dispatchProviders.length > 1
              ? `One grant per panelist provider (${dispatchProviders
                  .map((provider) => deps.providerLabel(provider))
                  .join(', ')}).`
              : ''
          }`,
          properties: ['openFile', 'openDirectory', 'createDirectory'],
          securityScopedBookmarks: deps.securityScopedBookmarks
        } as OpenDialogOptions)
        if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
          return { ok: false, reason: 'cancelled' }
        }
        selectedPath = deps.resolvePath(dialogResult.filePaths[0])
        bookmark = Array.isArray((dialogResult as any).bookmarks)
          ? (dialogResult as any).bookmarks[0]
          : undefined
      }
      let kind: ExternalPathGrant['kind'] = 'file'
      try {
        const stat = await deps.stat(selectedPath)
        kind = stat.isDirectory() ? 'directory' : 'file'
      } catch {
        kind = 'file'
      }

      if (payload?.deferPersist) {
        return { ok: true, grants: [], path: selectedPath }
      }

      const now = Date.now()
      const newGrants: ExternalPathGrant[] = dispatchProviders.map((provider) =>
        deps.issueExternalPathGrant({
          id: `proactive-${now}-${provider}-${deps.randomBytes(4).toString('hex')}`,
          provider,
          workspaceId: registeredExplicitWorkspace?.id,
          chatId,
          path: selectedPath,
          kind,
          access,
          duration: 'thisThread',
          securityScopedBookmark: bookmark,
          createdAt: new Date(now).toISOString()
        })
      )

      const existing = deps.collectExternalPathGrantsFromMetadata(chat.providerMetadata)
      const updatedChat: ChatRecord = {
        ...chat,
        providerMetadata: deps.canonicalizeExternalPathGrantMetadata(chat.providerMetadata, [
          ...existing,
          ...newGrants
        ]),
        updatedAt: now
      }
      deps.saveChat(updatedChat)
      deps.broadcastChatUpdated(updatedChat)

      return { ok: true, grants: newGrants, path: selectedPath }
    }
  )

  ipcMain.handle('probe-external-path', async (_, absolutePath: string) => {
    return deps.probeExternalPath(absolutePath)
  })
}
