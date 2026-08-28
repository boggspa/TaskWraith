import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ChatService,
  RebindChatWorkspaceInput,
  SetChatKindInput
} from '../services/ChatService'
import {
  isChatGitWorkflowState,
  type ChatGitWorkflowInput
} from '../../shared/chatGitWorkflow'
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
import { readPendingWorkspaceRebind } from '../pendingWorkspaceRebind'
import {
  RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
  chatPersistenceRevision,
  parseRendererChatTranscriptMutationRequest,
  type RendererChatTranscriptMutationResult
} from '../../shared/rendererChatTranscriptMutation'
import {
  chatUpdateProducerEnvelopeFor,
  computeChatSubRevisions,
  type ChatTranscriptOp
} from '../../shared/chatUpdateTransport'
import { ChatTranscriptMutationIndex } from '../store/ChatTranscriptMutationAuthoring'
import { assertSafeChatId } from '../ChatPath'
import {
  parseChatComposerSelectionPatchRequest,
  type ChatComposerSelectionPatchResult
} from '../../shared/chatComposerSelectionPatch'
import {
  createDesktopHostThreadKindCommandClient,
  createHostThreadKindMutation
} from '../host/HostThreadKindCommand'

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
    | 'patchChatComposerSelection'
    | 'deleteChat'
    | 'truncateChatHistory'
    | 'clearChats'
    | 'prepareClearChats'
    | 'commitClearChats'
    | 'finishClearChats'
    | 'createChat'
    | 'createGlobalChat'
    | 'createEnsembleChat'
    | 'createSubThread'
    | 'getSubThreads'
    | 'createSideChat'
    | 'rebindChatWorkspace'
    | 'queueChatWorkspaceRebind'
    | 'getSideChats'
    // Required, not optional: the set-chat-kind gate needs to know whether a
    // chat is shared, and a missing method must be a compile error rather than
    // a silently-permitted collapse of a shared panel.
    | 'listHumanCollaborationShares'
  >
  /** Host-owned chat-kind mutation; tests inject it, production uses a narrow main-only Host session. */
  setChatKindMutation?: (input: SetChatKindInput) => Promise<ChatRecord>
  /**
   * Host-routed chat-persistence durability barrier (AppStore.saveChat's
   * Host-owned-gate branch enqueues; this drains). Awaited after ensemble-chat
   * creation so a persistence failure rejects the IPC instead of returning an
   * unpersisted chat. Optional so unit-test harnesses can omit it.
   */
  awaitChatRecordPersisted?: (chatId: string) => Promise<void>
  /** Main-owned graph cleanup must settle live graph work before chat deletion. */
  deleteExecutionGraphHistoryForChat: (chatId: string) => Promise<void>
  /** Revoke/claim provider approval authority synchronously before graph awaits. */
  revokeApprovalsForChat: (chatId: string) => void
  /** Fence new run/tool/approval admission for delete/truncate transaction. */
  beginChatHistoryMutation: (chatId: string) => void | Promise<void>
  /** Release the chat-scoped admission fence after commit/failure. */
  finishChatHistoryMutation: (chatId: string) => void
  /** Shared recursive lifecycle choke used by every chat-deletion path. */
  deleteChatWithLifecycle: (chatId: string) => Promise<unknown>
  /** Shared strict lifecycle choke used by every chat-truncation path. */
  truncateChatWithLifecycle: (chatId: string) => Promise<ChatRecord | null>
  /**
   * True while a durable history-deletion intent is pending (fail closed on an
   * unreadable intent). The store admits one durable intent at a time, so the
   * reaper defers instead of colliding with an in-flight erasure.
   */
  isHistoryErasureInFlight: () => boolean
  /** Reject child/side-chat persistence while a parent/ancestor is mutating. */
  assertParentChatCreationAllowed: (parentChatId: string) => void
  /** Global clear erases the entire graph repository; scoped clear erases that workspace. */
  clearExecutionGraphHistory: (workspaceId?: string) => Promise<void>
  getSettings: () => AppSettings
  detectConfiguredProviders: (settings: AppSettings) => Promise<Set<ProviderId>>
  normalizeTranscriptMarkdownMediaForChat: (chat: ChatRecord) => ChatRecord
  maybeScheduleCodexNativeGoalSync: (
    previous: ChatRecord | null | undefined,
    next: ChatRecord,
    reason: string
  ) => void
  /** Observe an accepted exact steer row even when local history is disabled. */
  observeSoloSteerTranscriptRows: (chat: ChatRecord) => void
  broadcastThreadUpdate: (chatId: string | undefined) => void
  broadcastThreadList: () => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  adoptRendererChatMutation: (
    senderId: number,
    chat: ChatRecord,
    basePersistenceRevision: number
  ) => boolean
  /** Compact renderer saves are already reflected locally; notify only peers. */
  broadcastChatUpdatedExcept: (chat: ChatRecord, senderId: number) => void
  broadcastChatPopoutUpdate: (chat: ChatRecord) => void
  pushRemoteTaskCardDelta: (chatId: string) => void
  pushRemoteThreadSnapshot: (chat: ChatRecord, workspaceId: string) => void
  canonicalRemoteWorkspaceId: (workspaceId?: string | null) => string | null
  globalRemoteScope: string
  reapAbandonedChats: (
    deps: ReapAbandonedChatsDeps,
    renderer?: RendererReapContext
  ) => string[] | Promise<string[]>
  getWorkflowChatIds: () => Set<string>
  getScheduledChatIds: () => Set<string>
  /** Chat ids with a live share or a contribution awaiting host review. */
  getSharedChatIds: () => Set<string>
  /**
   * Main-owned chat popout windows that are currently alive. The renderer's
   * one-shot handoff payload is consumed on mount, so it cannot be the durable
   * authority for protecting an open empty chat from create-time cleanup.
   */
  getOpenChatPopoutIds: () => Set<string>
  getOpenCanvasChatIds: () => Set<string>
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
      | 'patch-chat-composer-selection'
      | 'mutate-chat-transcript'
      | 'delete-chat'
      | 'truncate-chat'
      | 'set-chat-git-workflow'
  ) => void
  /**
   * Main-owned async atomic patch for the per-thread git workflow marker
   * (AppStore.persistChatGitWorkflow). Null clears the marker.
   */
  persistChatGitWorkflow: (
    chatId: string,
    gitWorkflow: ChatGitWorkflowInput | null
  ) => Promise<ChatRecord>
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

function rendererMutationNeedsMediaNormalization(
  operations: readonly ChatTranscriptOp[]
): boolean {
  for (const operation of operations) {
    const changedMessages =
      operation.op === 'append'
        ? operation.messages
        : operation.op === 'update'
          ? [operation.message]
          : []
    for (const message of changedMessages) {
      if (message.role !== 'assistant' && message.role !== 'system') continue
      if (message.content.includes('![')) return true
      if (Array.isArray(message.metadata?.mediaRefs)) return true
    }
  }
  return false
}

function executionGraphOwnedRunIds(chat: ChatRecord): Set<string> {
  return new Set(
    (chat.runs ?? [])
      .filter((run) => run.providerMetadata?.executionGraphAttempt !== undefined)
      .map((run) => run.runId)
  )
}

function messageClaimsExecutionGraphOwnership(
  message: ChatRecord['messages'][number],
  ownedRunIds: ReadonlySet<string>
): boolean {
  return Boolean(
    (message.runId && ownedRunIds.has(message.runId)) ||
      message.metadata?.kind === 'executionGraphAttempt' ||
      message.metadata?.kind === 'executionGraphAttemptOutput'
  )
}

function preserveExecutionGraphTranscript(
  previous: ChatRecord | null | undefined,
  incoming: ChatRecord
): ChatRecord {
  if (!previous) return incoming
  const ownedRuns = (previous.runs ?? []).filter(
    (run) => run.providerMetadata?.executionGraphAttempt !== undefined
  )
  const ownedRunIds = new Set(ownedRuns.map((run) => run.runId).filter(Boolean))
  const ownedMessages = previous.messages.filter(
    (message) => message.runId !== undefined && ownedRunIds.has(message.runId)
  )
  const ownedMessagesById = new Map(ownedMessages.map((message) => [message.id, message]))
  const retainedMessageIds = new Set<string>()
  const messages = incoming.messages.flatMap((message) => {
    const durable = ownedMessagesById.get(message.id)
    if (durable) {
      if (retainedMessageIds.has(durable.id)) return []
      retainedMessageIds.add(durable.id)
      return [durable]
    }
    if (
      (message.runId !== undefined && ownedRunIds.has(message.runId)) ||
      message.metadata?.kind === 'executionGraphAttempt' ||
      message.metadata?.kind === 'executionGraphAttemptOutput'
    ) {
      return []
    }
    return [message]
  })
  for (const message of ownedMessages) {
    if (!retainedMessageIds.has(message.id)) messages.push(message)
  }

  const ownedRunsById = new Map(ownedRuns.map((run) => [run.runId, run]))
  const retainedRunIds = new Set<string>()
  const runs = (incoming.runs ?? []).flatMap((run) => {
    const durable = ownedRunsById.get(run.runId)
    if (durable) {
      if (retainedRunIds.has(durable.runId)) return []
      retainedRunIds.add(durable.runId)
      return [durable]
    }
    if (run.providerMetadata?.executionGraphAttempt !== undefined) return []
    return [run]
  })
  for (const run of ownedRuns) {
    if (!retainedRunIds.has(run.runId)) runs.push(run)
  }
  return { ...incoming, messages, runs }
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
  const rendererTranscriptIndexes = new Map<string, ChatTranscriptMutationIndex>()
  const setChatKindMutation =
    deps.setChatKindMutation ??
    (() => {
      return createHostThreadKindMutation({
        client: createDesktopHostThreadKindCommandClient({
          userDataPath: app.getPath('userData'),
          appVersion: app.getVersion()
        }),
        getChat: (chatId) => deps.chatService.getChat(chatId)
      })
    })()
  const observeNoHistoryChat = (chat: ChatRecord): void => {
    if (deps.getSettings().storeLocalChatHistory === false) {
      deps.observeSoloSteerTranscriptRows(chat)
    }
  }
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
    observeNoHistoryChat(chat)
    deps.broadcastThreadUpdate(chat?.appChatId)
    return chat
  })
  ipcMain.handle('create-global-chat', (event) => {
    deps.assertSenderCanManageChatCollection(event, 'create-global-chat')
    const chat = deps.chatService.createGlobalChat()
    observeNoHistoryChat(chat)
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
      // Durability barrier: the new ensemble record must be persisted through
      // the Host before the renderer receives it; a failure rejects this IPC.
      if (chat) await deps.awaitChatRecordPersisted?.(chat.appChatId)
      observeNoHistoryChat(chat)
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )
  ipcMain.handle(
    'create-sub-thread',
    async (
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
      deps.assertParentChatCreationAllowed(args.parentChatId)
      const chat = deps.chatService.createSubThread(args)
      observeNoHistoryChat(chat)
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
      deps.assertParentChatCreationAllowed(args.parentChatId)
      const chat = deps.chatService.createSideChat(args)
      observeNoHistoryChat(chat)
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
    async (
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
      // A SHARED thread cannot leave panel mode — not by the host, not by an
      // agent, not by any renderer. Collapsing routes through
      // AppStore.setChatKind, which strips the roster and stashes it in
      // `providerMetadata.stashedEnsemble`; the next preset-apply consumes that
      // stash, so a seat removed by a collapse can silently RESURRECT later.
      // With external collaborators occupying seats that is not a cosmetic
      // problem — a kicked person's seat could come back.
      //
      // `ChatService.setChatKind` refuses this too, and THAT is the gate every
      // door goes through; this copy is kept because it is cheap and because it
      // fails before any of the argument validation below. The share check runs
      // first because it is cheap; only then do we pay for a chat read to
      // confirm this is actually a collapse and not a no-op.
      if (args?.targetKind !== 'ensemble') {
        // ACTIVE participants, not enabled shares — both revoke paths leave the
        // share record behind, and an enabled share nobody is admitted to
        // protects nothing. ChatService.setChatKind is the authority; this copy
        // is the cheap early check.
        const admitted = deps.chatService
          .listHumanCollaborationShares(args.chatId)
          .filter((share) => share.enabled)
          .some((share) => (share.participants || []).some((p) => p.status === 'active'))
        if (admitted && deps.chatService.getChat(args.chatId)?.chatKind === 'ensemble') {
          throw new Error(
            'This chat is shared. Stop sharing before switching it out of panel mode.'
          )
        }
      }
      const chat = await setChatKindMutation({
        chatId: args.chatId,
        targetKind: args.targetKind,
        ...(args.canonicalProvider ? { canonicalProvider: args.canonicalProvider } : {})
      })
      deps.broadcastThreadUpdate(chat?.appChatId)
      return chat
    }
  )

  ipcMain.handle('rebind-chat-workspace', (event, args: RebindChatWorkspaceInput) => {
    deps.assertSenderCanRebindChatWorkspace(event, args?.chatId)
    const before = deps.chatService.getChat(args?.chatId)
    if (!deps.getChatWorkspaceRebindBlocker) {
      throw new Error('Chat workspace rebind lifecycle guard is unavailable.')
    }
    const blocker = deps.getChatWorkspaceRebindBlocker(args?.chatId)
    if (blocker && args?.deferIfBusy === true) {
      const queued = deps.chatService.queueChatWorkspaceRebind(args)
      const deferred = readPendingWorkspaceRebind(queued) !== null
      if (
        JSON.stringify(readPendingWorkspaceRebind(before ?? queued)) !==
        JSON.stringify(readPendingWorkspaceRebind(queued))
      ) {
        deps.broadcastChatUpdated(queued)
        deps.broadcastThreadUpdate(queued.appChatId)
      }
      return { chat: queued, changed: false, deferred }
    }
    const rebound = deps.chatService.rebindChatWorkspace(args, {
      assertIdle: (canonical) => {
        const lateBlocker = deps.getChatWorkspaceRebindBlocker?.(canonical.appChatId)
        if (lateBlocker) {
          throw new Error(
            `Cannot change chat workspace while a turn is ${lateBlocker} — finish or cancel it first.`
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
    const pendingChanged =
      JSON.stringify(readPendingWorkspaceRebind(before ?? rebound)) !==
      JSON.stringify(readPendingWorkspaceRebind(rebound))
    if (changed || pendingChanged) {
      deps.broadcastChatUpdated(rebound)
      deps.broadcastThreadUpdate(rebound.appChatId)
    }
    if (changed) {
      // Moving a chat changes its workspace grouping in remote projections.
      deps.broadcastThreadList()
    }
    return { chat: rebound, changed }
  })

  ipcMain.handle('save-chat', (event, chat: ChatRecord) => {
    const chatId = chat.appChatId
    deps.assertSenderChatScope(event, chatId, 'save-chat')
    const previous = deps.chatService.getChat(chatId)
    const normalized = preserveExecutionGraphTranscript(
      previous,
      deps.normalizeTranscriptMarkdownMediaForChat(chat)
    )
    const saved = deps.chatService.saveChat(normalized)
    observeNoHistoryChat(saved)
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

  ipcMain.handle(
    'patch-chat-composer-selection',
    async (event, payload: unknown): Promise<ChatComposerSelectionPatchResult> => {
      const request = parseChatComposerSelectionPatchRequest(payload)
      if (!request) throw new Error('Invalid chat composer selection patch.')
      assertSafeChatId(request.chatId)
      deps.assertSenderChatScope(event, request.chatId, 'patch-chat-composer-selection')
      const previous = deps.chatService.getChat(request.chatId)
      if (!previous) {
        return {
          ok: false,
          changed: false,
          chatId: request.chatId,
          reason: 'chat-not-found'
        }
      }
      const result = await deps.chatService.patchChatComposerSelection(request)
      if (!result.changed) {
        return {
          ok: true,
          changed: false,
          chatId: previous.appChatId,
          revision: persistenceRevision(previous),
          updatedAt: previous.updatedAt
        }
      }
      const saved = result.chat
      observeNoHistoryChat(saved)
      deps.broadcastChatUpdated(saved)
      deps.broadcastThreadUpdate(saved.appChatId)
      return {
        ok: true,
        changed: true,
        chatId: saved.appChatId,
        revision: persistenceRevision(saved),
        updatedAt: saved.updatedAt
      }
    }
  )

  ipcMain.handle(
    'mutate-chat-transcript',
    (event, payload: unknown): RendererChatTranscriptMutationResult => {
      const request = parseRendererChatTranscriptMutationRequest(payload)
      const requestedChatId =
        payload && typeof payload === 'object' && typeof (payload as { chatId?: unknown }).chatId === 'string'
          ? (payload as { chatId: string }).chatId
          : ''
      if (!request) {
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: requestedChatId,
          revision: 0,
          reason: 'invalid-request',
          canonical: null
        }
      }

      deps.assertSenderChatScope(event, request.chatId, 'mutate-chat-transcript')
      const previous = deps.chatService.getChat(request.chatId)
      if (!previous) {
        rendererTranscriptIndexes.delete(request.chatId)
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: request.chatId,
          revision: 0,
          reason: 'chat-not-found',
          canonical: null
        }
      }
      if (chatPersistenceRevision(previous) !== request.baseRevision) {
        rendererTranscriptIndexes.delete(request.chatId)
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: request.chatId,
          revision: chatPersistenceRevision(previous),
          reason: 'revision-conflict',
          canonical: previous
        }
      }

      let index = rendererTranscriptIndexes.get(request.chatId)
      if (!index?.isCurrent(previous.persistenceRevision, previous.messages.length)) {
        try {
          index = new ChatTranscriptMutationIndex(
            previous.messages,
            previous.persistenceRevision
          )
          rendererTranscriptIndexes.set(request.chatId, index)
          if (rendererTranscriptIndexes.size > 256) {
            const oldestChatId = rendererTranscriptIndexes.keys().next().value
            if (oldestChatId && oldestChatId !== request.chatId) {
              rendererTranscriptIndexes.delete(oldestChatId)
            }
          }
        } catch {
          rendererTranscriptIndexes.delete(request.chatId)
          return {
            version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
            accepted: false,
            chatId: request.chatId,
            revision: chatPersistenceRevision(previous),
            reason: 'operation-conflict',
            canonical: previous
          }
        }
      }

      const transaction = index!.begin()
      const messages = previous.messages.slice()
      const graphOwnedRunIds = executionGraphOwnedRunIds(previous)
      try {
        for (const operation of request.transcriptOps) {
          if (operation.op === 'append') {
            if (
              operation.messages.some((message) =>
                messageClaimsExecutionGraphOwnership(message, graphOwnedRunIds)
              )
            ) {
              throw new Error('Renderer cannot append main-owned graph transcript rows')
            }
            transaction.append(operation.messages)
            messages.push(...operation.messages)
            continue
          }
          const messageIndex = transaction.indexOf(operation.id)
          if (messageIndex < 0) throw new Error('Transcript operation target is absent')
          if (
            messageClaimsExecutionGraphOwnership(
              messages[messageIndex],
              graphOwnedRunIds
            ) ||
            (operation.op === 'update' &&
              messageClaimsExecutionGraphOwnership(operation.message, graphOwnedRunIds))
          ) {
            throw new Error('Renderer cannot mutate main-owned graph transcript rows')
          }
          if (operation.op === 'update') {
            transaction.update(operation.message)
            messages[messageIndex] = operation.message
          } else {
            transaction.splice(messageIndex, 1, [operation.id], [])
            messages.splice(messageIndex, 1)
          }
        }
      } catch {
        transaction.abort()
        rendererTranscriptIndexes.delete(request.chatId)
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: request.chatId,
          revision: chatPersistenceRevision(previous),
          reason: 'operation-conflict',
          canonical: previous
        }
      }

      const candidate = { ...previous, messages }
      const normalized = rendererMutationNeedsMediaNormalization(request.transcriptOps)
        ? deps.normalizeTranscriptMarkdownMediaForChat(candidate)
        : candidate
      const authoredTranscript = transaction.finish()
      const saved = deps.chatService.saveChat(
        normalized,
        normalized.messages === messages ? { authoredTranscript } : undefined
      )
      const accepted =
        deps.getSettings().storeLocalChatHistory === false ||
        chatPersistenceRevision(saved) > chatPersistenceRevision(previous)
      if (!accepted) {
        transaction.abort()
        rendererTranscriptIndexes.delete(request.chatId)
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: request.chatId,
          revision: chatPersistenceRevision(saved),
          reason: 'save-conflict',
          canonical: saved
        }
      }

      if (saved.messages.length === messages.length) {
        transaction.commit(saved.persistenceRevision)
      } else {
        transaction.abort()
        rendererTranscriptIndexes.delete(request.chatId)
      }
      observeNoHistoryChat(saved)
      if (
        deps.adoptRendererChatMutation(
          event.sender.id,
          saved,
          request.baseRevision
        )
      ) {
        deps.broadcastChatUpdatedExcept(saved, event.sender.id)
      } else {
        deps.broadcastChatUpdated(saved)
      }
      deps.maybeScheduleCodexNativeGoalSync(previous, saved, 'renderer-mutate-chat-transcript')
      deps.broadcastThreadUpdate(saved.appChatId)
      const envelope = chatUpdateProducerEnvelopeFor(saved)
      const contentSub = computeChatSubRevisions(saved)
      return {
        version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
        accepted: true,
        chatId: saved.appChatId,
        revision: chatPersistenceRevision(saved),
        updatedAt: saved.updatedAt,
        messageCount: saved.messages.length,
        recordHash: contentSub.recordHash,
        ...(envelope?.state.transcriptHash
          ? { transcriptHash: envelope.state.transcriptHash }
          : {})
      }
    }
  )

  // Per-thread git workflow marker (sidebar git icon + "Git" section). The
  // field is MAIN-OWNED like watchedPr: reporters send a small observation and
  // the store applies it as an async atomic patch, so a lagging whole-record
  // save-chat can never clobber it. Deep field validation happens here AND in
  // the persistence normalizer; null clears the marker ("Remove from Git").
  ipcMain.handle(
    'set-chat-git-workflow',
    async (
      event,
      payload?: { chatId?: string; gitWorkflow?: Partial<ChatGitWorkflowInput> | null }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : ''
      if (!chatId) return { ok: false, error: 'A chat is required to record a git workflow.' }
      deps.assertSenderChatScope(event, chatId, 'set-chat-git-workflow')
      const raw = payload?.gitWorkflow
      let gitWorkflow: ChatGitWorkflowInput | null = null
      if (raw != null) {
        if (!isChatGitWorkflowState(raw.state)) {
          return { ok: false, error: 'Unknown git workflow state.' }
        }
        gitWorkflow = { state: raw.state }
        if (
          typeof raw.prNumber === 'number' &&
          Number.isSafeInteger(raw.prNumber) &&
          raw.prNumber > 0
        ) {
          gitWorkflow.prNumber = raw.prNumber
        }
        if (
          typeof raw.prUrl === 'string' &&
          raw.prUrl.startsWith('https://github.com/') &&
          raw.prUrl.length <= 2048
        ) {
          gitWorkflow.prUrl = raw.prUrl
        }
      }
      try {
        const saved = await deps.persistChatGitWorkflow(chatId, gitWorkflow)
        deps.broadcastChatUpdated(saved)
        deps.broadcastThreadUpdate(saved.appChatId)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Couldn't record this thread's git workflow."
        }
      }
    }
  )

  ipcMain.handle('delete-chat', (event, chatId: string) => {
    deps.assertSenderChatScope(event, chatId, 'delete-chat')
    return (async () => {
      await deps.deleteChatWithLifecycle(chatId)
      deps.broadcastThreadList()
    })()
  })

  /**
   * Reap abandoned never-started "New Chat" tombstones (delete-only). The
   * renderer supplies the do-not-reap signals the main process can't see —
   * the active/multiview selection and chats with unsent composer text — plus
   * the just-created `keepChatId`. The main side adds authoritative live-chat
   * popouts plus workflow + scheduled-task links. Ensembles are never reaped
   * (the service supplies no default-roster check), so a curated roster is
   * never lost.
   *
   * Deletions are sequential and fenced: the store admits one durable
   * deletion intent at a time, so a Promise.all fan-out would self-collide,
   * and a candidate inside an in-flight erasure must be deferred, never
   * adopted. Each candidate is re-validated against the live records
   * immediately before its own deletion so a chat that gained content or
   * links while an earlier candidate was deleting stays protected.
   * Returns the ids actually deleted so the renderer drops exactly those.
   */
  ipcMain.handle(
    'reap-abandoned-chats',
    async (
      event,
      renderer: { protectedChatIds?: string[]; draftChatIds?: string[]; keepChatId?: string } = {}
    ) => {
      deps.assertSenderCanManageChatCollection(event, 'reap-abandoned-chats')
      const deleted: string[] = []
      try {
        const openChatPopoutIds = deps.getOpenChatPopoutIds()
        const effectiveRenderer =
          openChatPopoutIds.size > 0 || deps.getOpenCanvasChatIds().size > 0
            ? {
                ...(renderer ?? {}),
                protectedChatIds: Array.from(
                  new Set([
                    ...(renderer?.protectedChatIds ?? []),
                    ...openChatPopoutIds,
                    ...deps.getOpenCanvasChatIds()
                  ])
                )
              }
            : renderer ?? {}
        // selectCandidates() walks the whole chat corpus (AppStore.getChats())
        // to find abandoned drafts, so it is not free to call repeatedly. The
        // loop still re-validates a candidate against LIVE state immediately
        // before deleting it -- awaiting deleteChatWithLifecycle can let
        // anything change (a message arrives, the chat gets pinned or opened
        // in a popout) -- but it no longer re-fetches when nothing could have
        // changed. The candidate list a fresh selectCandidates() call just
        // produced is still exactly correct for every candidate reached
        // before the next `await`: the first candidate is checked against the
        // very computation that selected it (a zero-width window), and any
        // candidate reached via a `continue` (no await) reuses that same
        // fetch. Once a deleteChatWithLifecycle await happens, the next
        // candidate forces a fresh selectCandidates() call again. This
        // narrows call COUNT only -- every candidate that follows an await is
        // still re-checked against a fresh corpus read, exactly as before.
        const selectCandidates = (): string[] => {
          const collected: string[] = []
          deps.reapAbandonedChats(
            {
              getChats: () => deps.chatService.getChats(),
              getWorkflowChatIds: deps.getWorkflowChatIds,
              getScheduledChatIds: deps.getScheduledChatIds,
              getSharedChatIds: deps.getSharedChatIds,
              deleteChat: (id) => collected.push(id)
            },
            effectiveRenderer
          )
          return collected
        }
        const candidates = deps.isHistoryErasureInFlight() ? [] : selectCandidates()
        let latestCandidateIds = candidates
        let latestCandidateIdsFresh = true
        for (const id of candidates) {
          // Defer the remainder as soon as any erasure is pending — every
          // further deletion attempt would reject against that intent anyway.
          if (deps.isHistoryErasureInFlight()) break
          if (!latestCandidateIdsFresh) {
            latestCandidateIds = selectCandidates()
            latestCandidateIdsFresh = true
          }
          if (!latestCandidateIds.includes(id)) continue
          await deps.deleteChatWithLifecycle(id)
          deleted.push(id)
          // An await just happened -- another IPC call or a live provider
          // could have changed a sibling candidate's state, so the next one
          // needs a genuinely fresh re-check rather than this stale fetch.
          latestCandidateIdsFresh = false
        }
        if (deleted.length > 0) deps.broadcastThreadList()
        return { ok: true, reaped: deleted }
      } catch (error) {
        console.warn('[reap-abandoned-chats] failed:', error)
        if (deleted.length > 0) deps.broadcastThreadList()
        return { ok: false, reaped: deleted }
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
    return (async () => {
      const truncated = await deps.truncateChatWithLifecycle(chatId)
      if (truncated) {
        deps.broadcastChatUpdated(truncated)
        deps.broadcastThreadUpdate(chatId)
      }
      return truncated
    })()
  })

  ipcMain.handle('clear-chats', (event, workspaceId?: string) => {
    deps.assertSenderCanManageChatCollection(event, 'clear-chats')
    return (async () => {
      await deps.chatService.clearChats(workspaceId)
      deps.broadcastThreadList()
    })()
  })
}
