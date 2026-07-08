import { ipcMain } from 'electron'
import type { ChatService } from '../services/ChatService'
import type {
  AppSettings,
  ChatKind,
  ChatRecord,
  ChatRun,
  EnsembleParticipant,
  ProviderId
} from '../store/types'
import type {
  ReapAbandonedChatsDeps,
  RendererReapContext
} from '../AbandonedChatReaper'

export interface ChatHandlerDeps {
  chatService: Pick<
    ChatService,
    | 'getChats'
    | 'getChatList'
    | 'getPinnedMessages'
    | 'getChat'
    | 'saveChat'
    | 'deleteChat'
    | 'clearChats'
    | 'createChat'
    | 'createGlobalChat'
    | 'createEnsembleChat'
    | 'createSubThread'
    | 'getSubThreads'
    | 'createSideChat'
    | 'setChatKind'
    | 'getSideChats'
  >
  getSettings: () => AppSettings
  detectConfiguredProviders: (settings: AppSettings) => Promise<Set<ProviderId>>
  normalizeTranscriptMarkdownMediaForChat: (chat: ChatRecord) => ChatRecord
  maybeScheduleCodexNativeGoalSync: (
    previous: ChatRecord | null | undefined,
    next: ChatRecord,
    reason: string
  ) => void
  broadcastThreadUpdate: (chatId: string | undefined) => void
  broadcastThreadList: () => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  broadcastChatPopoutUpdate: (chat: ChatRecord) => void
  pushRemoteTaskCardDelta: (chatId: string) => void
  pushRemoteThreadSnapshot: (chat: ChatRecord, workspaceId: string) => void
  canonicalRemoteWorkspaceId: (workspaceId?: string | null) => string | null
  globalRemoteScope: string
  reapAbandonedChats: (
    deps: ReapAbandonedChatsDeps,
    renderer?: RendererReapContext
  ) => string[]
  getWorkflowChatIds: () => Set<string>
  getScheduledChatIds: () => Set<string>
}

const runHasDiff = (run: ChatRun | undefined): boolean =>
  Boolean(run?.runDiff || (run?.runDiffByPath && Object.keys(run.runDiffByPath).length > 0))

export function registerChatHandlers(deps: ChatHandlerDeps): void {
  ipcMain.handle('get-chats', (_event, workspaceId?: string) =>
    deps.chatService.getChats(workspaceId)
  )
  ipcMain.handle('get-chat-list', (_event, workspaceId?: string) =>
    deps.chatService.getChatList(workspaceId)
  )
  ipcMain.handle('get-pinned-messages', (_event, workspaceId?: string) =>
    deps.chatService.getPinnedMessages(workspaceId)
  )
  ipcMain.handle('get-chat', (_event, chatId: string) => deps.chatService.getChat(chatId))
  ipcMain.handle('create-chat', (_event, workspaceId: string, workspacePath: string) => {
    const chat = deps.chatService.createChat(workspaceId, workspacePath)
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle('create-global-chat', () => {
    const chat = deps.chatService.createGlobalChat()
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle(
    'create-ensemble-chat',
    async (_event, args?: { workspaceId?: string; workspacePath?: string }) => {
      if (deps.getSettings().ensembleModeEnabled === false) {
        throw new Error('Ensemble Mode is disabled.')
      }
      const configuredProviders = await deps.detectConfiguredProviders(deps.getSettings())
      const chat = deps.chatService.createEnsembleChat(args, configuredProviders)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle(
    'create-sub-thread',
    (
      _event,
      args: {
        parentChatId: string
        provider: ProviderId
        delegationPrompt: string
        returnResultToParent: boolean
        workspaceId?: string
        workspacePath?: string
      }
    ) => {
      const chat = deps.chatService.createSubThread(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-sub-threads', (_event, parentChatId: string) =>
    deps.chatService.getSubThreads(parentChatId)
  )
  ipcMain.handle(
    'create-side-chat',
    (
      _event,
      args: {
        parentChatId: string
        chatKind?: ChatRecord['chatKind']
        provider?: ProviderId
        title?: string
        originMessageId?: string
        originRunId?: string
        sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut'
      }
    ) => {
      const chat = deps.chatService.createSideChat(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-side-chats', (_event, parentChatId: string) =>
    deps.chatService.getSideChats(parentChatId)
  )
  ipcMain.handle(
    'set-chat-kind',
    (
      _event,
      args: {
        chatId: string
        targetKind: ChatKind
        seedParticipant?: EnsembleParticipant
        canonicalProvider?: ProviderId
        canonicalProviderMetadata?: Record<string, unknown>
      }
    ) => {
      if (args?.targetKind === 'ensemble' && deps.getSettings().ensembleModeEnabled === false) {
        throw new Error('Ensemble Mode is disabled.')
      }
      const chat = deps.chatService.setChatKind(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )

  ipcMain.handle('save-chat', (_, chat: ChatRecord) => {
    const normalized = deps.normalizeTranscriptMarkdownMediaForChat(chat)
    const previous = deps.chatService.getChat(normalized.appChatId)
    const saved = deps.chatService.saveChat(normalized)
    deps.broadcastChatUpdated(saved)
    deps.maybeScheduleCodexNativeGoalSync(previous, saved, 'renderer-save-chat')
    deps.broadcastThreadUpdate(saved?.appChatId)
    if (previous?.title !== saved.title) {
      deps.pushRemoteTaskCardDelta(saved.appChatId)
    }
    const latestRun = saved.runs?.[saved.runs.length - 1]
    const previousRun = previous?.runs?.find((run) => run.runId === latestRun?.runId)
    if (latestRun?.endedAt && runHasDiff(latestRun) && !runHasDiff(previousRun)) {
      const workspaceId =
        deps.canonicalRemoteWorkspaceId(saved.workspaceId) ??
        (!saved.workspaceId || saved.scope === 'global' ? deps.globalRemoteScope : null)
      if (workspaceId) {
        // First diff availability rides a targeted thread delta; keep full snapshots coalesced.
        deps.pushRemoteThreadSnapshot(saved, workspaceId)
      }
    }
  })

  ipcMain.handle('delete-chat', (_, chatId: string) => {
    deps.chatService.deleteChat(chatId)
    deps.broadcastThreadList()
  })

  /**
   * Reap abandoned never-started "New Chat" tombstones (delete-only). The
   * renderer supplies the do-not-reap signals the main process can't see —
   * the active/multiview/popout selection and chats with unsent composer
   * text — plus the just-created `keepChatId`. The main side adds the
   * workflow + scheduled-task links. Ensembles are never reaped (the service
   * supplies no default-roster check), so a curated roster is never lost.
   * Returns the reaped ids so the renderer can drop them from its own state.
   */
  ipcMain.handle(
    'reap-abandoned-chats',
    (
      _,
      renderer: { protectedChatIds?: string[]; draftChatIds?: string[]; keepChatId?: string } = {}
    ) => {
      try {
        const reaped = deps.reapAbandonedChats(
          {
            getChats: () => deps.chatService.getChats(),
            getWorkflowChatIds: deps.getWorkflowChatIds,
            getScheduledChatIds: deps.getScheduledChatIds,
            deleteChat: (id) => deps.chatService.deleteChat(id)
          },
          renderer ?? {}
        )
        if (reaped.length > 0) deps.broadcastThreadList()
        return { ok: true, reaped }
      } catch (error) {
        console.warn('[reap-abandoned-chats] failed:', error)
        return { ok: false, reaped: [] as string[] }
      }
    }
  )

  /**
   * Slash-picker `/clear`: wipe the chat's message + run history while
   * keeping the chat record so the user stays anchored to the same
   * provider session id, workspace, settings. Mirrors what a "Reset
   * conversation" affordance does in native Claude / Codex apps.
   */
  ipcMain.handle('truncate-chat', (_, chatId: string) => {
    const existing = deps.chatService.getChat(chatId)
    if (!existing) return null
    const truncated: ChatRecord = {
      ...existing,
      messages: [],
      runs: [],
      updatedAt: Date.now()
    }
    deps.chatService.saveChat(truncated)
    deps.broadcastThreadUpdate(chatId)
    return truncated
  })

  ipcMain.handle('clear-chats', (_, workspaceId?: string) => {
    deps.chatService.clearChats(workspaceId)
    deps.broadcastThreadList()
  })
}
