import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatService, RebindChatWorkspaceInput } from '../services/ChatService'
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

export type SenderChatReadScope =
  | { kind: 'all' }
  | { kind: 'chat'; chatId: string; workspaceId?: string }

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
    | 'rebindChatWorkspace'
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
  /**
   * Main-owned chat popout windows that are currently alive. The renderer's
   * one-shot handoff payload is consumed on mount, so it cannot be the durable
   * authority for protecting an open empty chat from create-time cleanup.
   */
  getOpenChatPopoutIds: () => Set<string>
  /**
   * Main may read the complete chat collection. A chat popout receives only
   * its main-owned chat/workspace identity; non-chat secondary renderers must
   * throw. Handler-side filtering keeps payload ids from becoming authority.
   */
  resolveSenderChatReadScope: (event: IpcMainInvokeEvent) => SenderChatReadScope
  /**
   * Sender-bound authority check for mutations that create or remove chats
   * across the collection rather than operating on one owned chat.
   */
  assertSenderCanManageChatCollection: (
    event: IpcMainInvokeEvent,
    capability:
      | 'create-chat'
      | 'create-global-chat'
      | 'create-ensemble-chat'
      | 'clear-chats'
      | 'reap-abandoned-chats'
  ) => void
  /**
   * Sender-bound authority check for mutations scoped to an existing chat.
   * A payload chat ID is not proof that a secondary renderer owns that chat.
   */
  assertSenderChatScope: (
    event: IpcMainInvokeEvent,
    chatId: string,
    capability:
      | 'create-sub-thread'
      | 'create-side-chat'
      | 'set-chat-kind'
      | 'save-chat'
      | 'delete-chat'
      | 'truncate-chat'
  ) => void
  /**
   * Sender-bound authority check for moving a canonical chat between scopes.
   * Payload chat IDs are not proof that a secondary renderer owns that chat.
   */
  assertSenderCanRebindChatWorkspace: (
    event: IpcMainInvokeEvent,
    chatId: string
  ) => void
  /**
   * Late-bound main lifecycle ownership. Implementations must inspect both
   * active provider sessions and queued/starting work for this chat.
   */
  getChatWorkspaceRebindBlocker?: (chatId: string) => 'active' | 'queued' | null
}

const runHasDiff = (run: ChatRun | undefined): boolean =>
  Boolean(run?.runDiff || (run?.runDiffByPath && Object.keys(run.runDiffByPath).length > 0))

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'> | null): number {
  const revision = chat?.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

function assertReadableChat(scope: SenderChatReadScope, chatId: string): void {
  if (scope.kind === 'chat' && scope.chatId !== chatId) {
    throw new Error('Renderer does not own this chat read.')
  }
}

function assertReadableWorkspace(
  scope: SenderChatReadScope,
  requestedWorkspaceId?: string
): void {
  if (
    scope.kind === 'chat' &&
    requestedWorkspaceId !== undefined &&
    scope.workspaceId !== requestedWorkspaceId
  ) {
    throw new Error('Renderer does not own this workspace chat collection.')
  }
}

export function registerChatHandlers(deps: ChatHandlerDeps): void {
  ipcMain.handle('get-chats', (event, workspaceId?: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableWorkspace(scope, workspaceId)
    if (scope.kind === 'all') return deps.chatService.getChats(workspaceId)
    const owned = deps.chatService.getChat(scope.chatId)
    return owned ? [owned] : []
  })
  ipcMain.handle('get-chat-list', (event, workspaceId?: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableWorkspace(scope, workspaceId)
    const list = deps.chatService.getChatList(
      scope.kind === 'chat' ? scope.workspaceId : workspaceId
    )
    return scope.kind === 'all'
      ? list
      : list.filter((chat) => chat.appChatId === scope.chatId)
  })
  ipcMain.handle('get-pinned-messages', (event, workspaceId?: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableWorkspace(scope, workspaceId)
    const groups = deps.chatService.getPinnedMessages(
      scope.kind === 'chat' ? scope.workspaceId : workspaceId
    )
    if (scope.kind === 'all') return groups
    return groups
      .map((group) => ({
        ...group,
        chats: group.chats.filter((chat) => chat.chatId === scope.chatId)
      }))
      .filter((group) => group.chats.length > 0)
  })
  ipcMain.handle('get-chat', (event, chatId: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableChat(scope, chatId)
    return deps.chatService.getChat(chatId)
  })
  ipcMain.handle('create-chat', (event, workspaceId: string, workspacePath: string) => {
    deps.assertSenderCanManageChatCollection(event, 'create-chat')
    const chat = deps.chatService.createChat(workspaceId, workspacePath)
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle('create-global-chat', (event) => {
    deps.assertSenderCanManageChatCollection(event, 'create-global-chat')
    const chat = deps.chatService.createGlobalChat()
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle(
    'create-ensemble-chat',
    async (event, args?: { workspaceId?: string; workspacePath?: string }) => {
      deps.assertSenderCanManageChatCollection(event, 'create-ensemble-chat')
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
      event,
      args: {
        parentChatId: string
        provider: ProviderId
        delegationPrompt: string
        returnResultToParent: boolean
        workspaceId?: string
        workspacePath?: string
      }
    ) => {
      deps.assertSenderChatScope(event, args.parentChatId, 'create-sub-thread')
      const chat = deps.chatService.createSubThread(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-sub-threads', (event, parentChatId: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableChat(scope, parentChatId)
    return scope.kind === 'all' ? deps.chatService.getSubThreads(parentChatId) : []
  })
  ipcMain.handle(
    'create-side-chat',
    (
      event,
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
      deps.assertSenderChatScope(event, args.parentChatId, 'create-side-chat')
      const chat = deps.chatService.createSideChat(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle('get-side-chats', (event, parentChatId: string) => {
    const scope = deps.resolveSenderChatReadScope(event)
    assertReadableChat(scope, parentChatId)
    return scope.kind === 'all' ? deps.chatService.getSideChats(parentChatId) : []
  })
  ipcMain.handle(
    'set-chat-kind',
    (
      event,
      args: {
        chatId: string
        targetKind: ChatKind
        seedParticipant?: EnsembleParticipant
        canonicalProvider?: ProviderId
        canonicalProviderMetadata?: Record<string, unknown>
      }
    ) => {
      deps.assertSenderChatScope(event, args.chatId, 'set-chat-kind')
      if (args?.targetKind === 'ensemble' && deps.getSettings().ensembleModeEnabled === false) {
        throw new Error('Ensemble Mode is disabled.')
      }
      const chat = deps.chatService.setChatKind(args)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )

  ipcMain.handle('rebind-chat-workspace', (event, args: RebindChatWorkspaceInput) => {
    deps.assertSenderCanRebindChatWorkspace(event, args?.chatId)
    const before = deps.chatService.getChat(args?.chatId)
    const rebound = deps.chatService.rebindChatWorkspace(args, {
      assertIdle: (canonical) => {
        if (!deps.getChatWorkspaceRebindBlocker) {
          throw new Error('Chat workspace rebind lifecycle guard is unavailable.')
        }
        const blocker = deps.getChatWorkspaceRebindBlocker(canonical.appChatId)
        if (blocker) {
          throw new Error(
            `Cannot change chat workspace while a turn is ${blocker} — finish or cancel it first.`
          )
        }
      }
    })
    const changed = Boolean(
      !before ||
        before.scope !== rebound.scope ||
        before.workspaceId !== rebound.workspaceId ||
        before.workspacePath !== rebound.workspacePath
    )
    if (changed) {
      deps.broadcastChatUpdated(rebound)
      deps.broadcastThreadUpdate(rebound.appChatId)
      // Moving a chat changes its workspace grouping in remote projections.
      deps.broadcastThreadList()
    }
    return { chat: rebound, changed }
  })

  ipcMain.handle('save-chat', (event, chat: ChatRecord) => {
    const chatId = chat.appChatId
    deps.assertSenderChatScope(event, chatId, 'save-chat')
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
    return {
      chat: saved,
      // The preload needs the exact canonical base that participated in this
      // compare-and-swap to perform an honest three-way rebase of a queued
      // renderer snapshot. Queue order alone is never a dependency proof.
      previous: previous ?? null,
      accepted:
        !previous ||
        deps.getSettings().storeLocalChatHistory === false ||
        persistenceRevision(saved) > persistenceRevision(previous)
    }
  })

  ipcMain.handle('delete-chat', (event, chatId: string) => {
    deps.assertSenderChatScope(event, chatId, 'delete-chat')
    deps.chatService.deleteChat(chatId)
    deps.broadcastThreadList()
  })

  /**
   * Reap abandoned never-started "New Chat" tombstones (delete-only). The
   * renderer supplies the do-not-reap signals the main process can't see —
   * the active/multiview selection and chats with unsent composer text — plus
   * the just-created `keepChatId`. The main side adds authoritative live-chat
   * popouts plus workflow + scheduled-task links. Ensembles are never reaped
   * (the service supplies no default-roster check), so a curated roster is
   * never lost.
   * Returns the reaped ids so the renderer can drop them from its own state.
   */
  ipcMain.handle(
    'reap-abandoned-chats',
    (
      event,
      renderer: { protectedChatIds?: string[]; draftChatIds?: string[]; keepChatId?: string } = {}
    ) => {
      deps.assertSenderCanManageChatCollection(event, 'reap-abandoned-chats')
      try {
        const openChatPopoutIds = deps.getOpenChatPopoutIds()
        const effectiveRenderer =
          openChatPopoutIds.size > 0
            ? {
                ...(renderer ?? {}),
                protectedChatIds: Array.from(
                  new Set([...(renderer?.protectedChatIds ?? []), ...openChatPopoutIds])
                )
              }
            : renderer ?? {}
        const reaped = deps.reapAbandonedChats(
          {
            getChats: () => deps.chatService.getChats(),
            getWorkflowChatIds: deps.getWorkflowChatIds,
            getScheduledChatIds: deps.getScheduledChatIds,
            deleteChat: (id) => deps.chatService.deleteChat(id)
          },
          effectiveRenderer
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
  ipcMain.handle('truncate-chat', (event, chatId: string) => {
    deps.assertSenderChatScope(event, chatId, 'truncate-chat')
    const existing = deps.chatService.getChat(chatId)
    if (!existing) return null
    const truncated: ChatRecord = {
      ...existing,
      messages: [],
      runs: [],
      updatedAt: Date.now()
    }
    const saved = deps.chatService.saveChat(truncated)
    deps.broadcastChatUpdated(saved)
    deps.broadcastThreadUpdate(chatId)
    return saved
  })

  ipcMain.handle('clear-chats', (event, workspaceId?: string) => {
    deps.assertSenderCanManageChatCollection(event, 'clear-chats')
    deps.chatService.clearChats(workspaceId)
    deps.broadcastThreadList()
  })
}
