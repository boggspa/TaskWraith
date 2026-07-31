import type { AgentRunRoute } from '../run/AgentRunTypes'
import type {
  ChatKind,
  ChatListItem,
  ChatMessage,
  ChatRecord,
  EnsembleParticipant,
  PinnedMessageGroup,
  ProviderId,
  RunEventInput,
  SideChatMode,
  WorkspaceRecord
} from '../store/types'
import { assertSafeChatId } from '../ChatPath'
import { randomUUID } from 'crypto'
import {
  autoDraftedCollaboratorPrompt,
  humanCollaboratorMetadata,
  isHumanCollaboratorComment,
  makeHumanCollaboratorComment,
  promotedCollaboratorPrompt,
  type HumanCollaboratorContributionKind
} from '../collaboration/HumanCollaboratorMessages'
import type {
  ConsumeInviteResult,
  CreateShareResult,
  HumanCollaborationMode,
  HumanCollaborationShare,
  HumanCollaborationStore
} from '../collaboration/HumanCollaborationStore'
import { HumanCollaborationDenialError } from '../collaboration/HumanContributionRules'
import {
  MAX_QUEUED_PER_COLLABORATOR,
  type ExternalContributionEntry,
  type ExternalContributionQueueStore
} from '../collaboration/ExternalContributionQueueStore'
import {
  effectiveContributionRules,
  type HumanContributionPreset
} from '../collaboration/HumanContributionRules'
import {
  auditContentHash,
  type HumanCollaborationAuditLike
} from '../collaboration/HumanCollaborationAuditLog'
import { isTaskWraithMcpProfileReceiptForSession } from '../mcp/McpSessionProfileFence'
import { ANTIGRAVITY_PROVIDER_ID, isLiveSelectableProvider } from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import { isAntigravityAgyOptInEnabled } from '../antigravity/AntigravityAgyOptInEnabledSignal'
import { clearPendingProviderChange, readPendingProviderChange } from '../providerChangeQueue'
import {
  clearPendingWorkspaceRebind,
  queuePendingWorkspaceRebind,
  type PendingWorkspaceRebind
} from '../pendingWorkspaceRebind'
import { hasPendingEnsembleRosterPresetApply } from '../../shared/ensembleRosterPresetApply'
import { isEnsembleRoundDispatchLive } from '../../shared/ensembleRoundLifecycle'
import {
  EXTERNAL_JOIN_CONVERTED_KEY,
  chatNeedsExternalJoinConversion,
  clearExternalJoinConvertedMark,
  markChatConvertedByExternalJoin,
  clearPendingExternalJoinConversion,
  hasPendingExternalJoinConversion,
  queuePendingExternalJoinConversion,
  readPendingExternalJoinConversion,
  type PendingExternalJoinConversion
} from '../externalJoinConversion'
import {
  EXTERNAL_PATH_GRANT_METADATA_KEYS,
  canonicalizeExternalPathGrantMetadata,
  collectExternalPathGrantsFromMetadata,
  externalPathGrantMetadataLists
} from '../store/ExternalPathGrants'

// Known ids for historical decode. New chat lifecycles use the shared live
// admission predicate through `assertLiveProviderId` below.
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
])

export interface CreateSubThreadInput {
  parentChatId: string
  provider: ProviderId
  delegationPrompt: string
  returnResultToParent: boolean
  workspaceId?: string
  workspacePath?: string
}

export interface CreateSideChatInput {
  parentChatId: string
  chatKind?: ChatRecord['chatKind']
  provider?: ProviderId
  title?: string
  originMessageId?: string
  originRunId?: string
  sideChatMode?: SideChatMode
  selectedModelType?: string
  codexReasoningEffort?: string | null
  claudeReasoningEffort?: string | null
}

export interface CreateForkChatInput {
  parentChatId: string
  provider?: ProviderId
  title?: string
  sourceProviderThreadId?: string
  sourceModel?: string
}

/** Slice C — in-place mid-thread ensemble toggle. */
export interface SetChatKindInput {
  chatId: string
  targetKind: ChatKind
  /** Solo→Ensemble: the single seed participant built by the renderer. */
  seedParticipant?: EnsembleParticipant
  /** Ensemble→Solo: the canonical provider the user picked in the modal. */
  canonicalProvider?: ProviderId
  canonicalProviderMetadata?: Record<string, unknown>
}

export type RebindChatWorkspaceInput =
  | {
      chatId: string
      scope: 'global'
      deferIfBusy?: boolean
    }
  | {
      chatId: string
      scope: 'workspace'
      workspaceId: string
      workspacePath: string
      deferIfBusy?: boolean
    }

export interface RebindChatWorkspaceOptions {
  /**
   * Main-owned lifecycle fence. The IPC layer supplies a synchronous guard
   * backed by the run manager + durable queue so the canonical record cannot
   * move while any turn still owns its workspace.
   */
  assertIdle?: (chat: ChatRecord) => void
  now?: number
}

type ResolvedChatWorkspaceRebindTarget =
  | {
      chatId: string
      scope: 'global'
    }
  | {
      chatId: string
      scope: 'workspace'
      workspaceId: string
      workspacePath: string
    }

export interface PrepareForkMessagesInput {
  /** Canonical main-owned source record loaded immediately before the fork. */
  sourceChat: Readonly<ChatRecord>
  /** Draft fork record with relation metadata established and no copied messages. */
  targetFork: Readonly<ChatRecord>
  /** Detached copies of the source transcript for ownership preparation/redaction. */
  copiedMessages: ChatMessage[]
}

export type PrepareForkMessages = (input: PrepareForkMessagesInput) => ChatMessage[]

export interface ChatServiceStore {
  getChats: (workspaceId?: string) => ChatRecord[]
  getChatList: (workspaceId?: string) => ChatListItem[]
  getPinnedMessages: (workspaceId?: string) => PinnedMessageGroup[]
  getChat: (chatId: string) => ChatRecord | null
  createChat: (workspaceId: string, workspacePath: string) => ChatRecord
  createGlobalChat: () => ChatRecord
  createEnsembleChat: (args?: { workspaceId?: string; workspacePath?: string }, configuredProviders?: Set<ProviderId>) => ChatRecord
  createSubThread: (args: CreateSubThreadInput) => ChatRecord
  createSideChat: (args: CreateSideChatInput) => ChatRecord
  setChatKind: (
    chatId: string,
    targetKind: ChatKind,
    opts?: {
      seedParticipant?: EnsembleParticipant
      canonicalProvider?: ProviderId
      canonicalProviderMetadata?: Record<string, unknown>
    }
  ) => ChatRecord
  getChildChats: (parentChatId: string) => ChatRecord[]
  getSideChats: (parentChatId: string) => ChatRecord[]
  saveChat: (chat: ChatRecord) => ChatRecord
  deleteChat: (chatId: string) => void
  truncateChatHistory?: (chatId: string) => ChatRecord | null
  clearChats: (workspaceId?: string) => void
}

export interface ChatServiceDeps {
  appStore: ChatServiceStore
  humanCollaborationStore?: HumanCollaborationStore
  /** P2a durable audit sink for host-visible collaboration events. */
  humanCollaborationAudit?: HumanCollaborationAuditLike
  findRegisteredWorkspace: (path: string) => WorkspaceRecord | undefined
  canonicalPath: (path: string) => string
  /** Main-owned authority seam; must prepare copied media before the fork is persisted. */
  prepareForkMessages: PrepareForkMessages
  sanitizeChatForSave: (chat: ChatRecord) => ChatRecord
  /** Main-owned topology fence checked immediately before child persistence. */
  assertParentChatCreationAllowed?: (parentChatId: string) => void
  /**
   * Host-review queue. Optional so a ChatService built without one simply never
   * offers host review — a share that asks for it then fails loudly rather than
   * silently appending unreviewed text, which is the safe direction.
   */
  externalContributionQueue?: ExternalContributionQueueStore
  /** Clears history stored outside Electron userData (currently bridge diagnostics). */
  clearExternalChatHistory?: (workspaceId?: string) => void | Promise<void>
  /**
   * Drop the relay room behind a collaboration invite, which also disconnects
   * every runtime session bound to it. The transport lives in main, so this is
   * a thin seam — the same one the revoke IPC handlers use.
   *
   * Load-bearing on every destructive chat path. Revoking a share only flips a
   * record; the collaborator's sealed socket stays open and their app keeps
   * rendering a transcript whose chat no longer exists. Without this the next
   * projection build throws 'Chat not found.' and the external is left staring
   * at a frozen transcript with no indication anything happened.
   */
  closeCollaborationRoom?: (roomId: string) => void
  /** Main-owned durable prepare/quiesce/commit single-flight. */
  clearHistoryTransaction?: (workspaceId?: string) => Promise<void>
  /** Releases the scope admission fence after the durable clear commits/fails. */
  finishExternalChatHistoryClear?: (workspaceId?: string) => void
  appendDurableRunEventForRoute: (
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    kind: RunEventInput['kind'],
    phase: RunEventInput['phase'],
    title: string,
    payload?: unknown
  ) => void
}

/**
 * ChatService — Phase B2 extraction.
 *
 * Keeps chat IPC behaviour in one testable service while leaving the
 * persistence rules in AppStore. Validation messages intentionally
 * mirror the previous inline handlers because the renderer surfaces
 * these errors directly.
 */
export class ChatService {
  constructor(private deps: ChatServiceDeps) {}

  getChats(workspaceId?: string): ChatRecord[] {
    return this.deps.appStore.getChats(workspaceId)
  }

  getChatList(workspaceId?: string): ChatListItem[] {
    return this.deps.appStore.getChatList(workspaceId)
  }

  getPinnedMessages(workspaceId?: string): PinnedMessageGroup[] {
    return this.deps.appStore.getPinnedMessages(optionalString(workspaceId))
  }

  getChat(chatId: string): ChatRecord | null {
    return this.deps.appStore.getChat(requireSafeChatId(chatId, 'Chat id'))
  }

  createChat(workspaceId: string, workspacePath: string): ChatRecord {
    const registered = this.deps.findRegisteredWorkspace(workspacePath)
    if (!registered || registered.id !== workspaceId) {
      throw new Error('Chat workspace must be a registered TaskWraith workspace.')
    }
    return this.deps.appStore.createChat(workspaceId, this.deps.canonicalPath(workspacePath))
  }

  createGlobalChat(): ChatRecord {
    return this.deps.appStore.createGlobalChat()
  }

  createEnsembleChat(args?: { workspaceId?: string; workspacePath?: string }, configuredProviders?: Set<ProviderId>): ChatRecord {
    if (!args?.workspaceId && !args?.workspacePath) {
      return this.deps.appStore.createEnsembleChat(undefined, configuredProviders)
    }
    const workspaceId = requireNonEmptyString(args.workspaceId, 'Workspace id')
    const workspacePath = requireNonEmptyString(args.workspacePath, 'Workspace path')
    const registered = this.deps.findRegisteredWorkspace(workspacePath)
    if (!registered || registered.id !== workspaceId) {
      throw new Error('Ensemble workspace must be a registered TaskWraith workspace.')
    }
    return this.deps.appStore.createEnsembleChat({
      workspaceId,
      workspacePath: this.deps.canonicalPath(workspacePath)
    }, configuredProviders)
  }

  createSubThread(args: CreateSubThreadInput | undefined): ChatRecord {
    const parentChatId = requireSafeChatId(args?.parentChatId, 'Parent chat id')
    const provider = assertLiveProviderId(args?.provider)
    const delegationPrompt = requireNonEmptyString(args?.delegationPrompt, 'Delegation prompt')
    const returnResultToParent = Boolean(args?.returnResultToParent)
    this.deps.assertParentChatCreationAllowed?.(parentChatId)
    const subThread = this.deps.appStore.createSubThread({
      parentChatId,
      provider,
      delegationPrompt,
      returnResultToParent,
      workspaceId: args?.workspaceId,
      workspacePath: args?.workspacePath
    })

    try {
      this.deps.appendDurableRunEventForRoute(
        this.deps.appStore.getChat(parentChatId)?.provider ?? 'gemini',
        { appChatId: parentChatId },
        'subthread_spawned',
        'control',
        `Delegated to ${provider} sub-thread`,
        {
          subThreadId: subThread.appChatId,
          provider,
          delegationPrompt,
          returnResultToParent
        }
      )
    } catch {
      // Parent run may not be active — durable trace is best-effort.
    }

    return subThread
  }

  createSideChat(args: CreateSideChatInput | undefined): ChatRecord {
    const parentChatId = requireSafeChatId(args?.parentChatId, 'Parent chat id')
    const inheritedProvider = this.deps.appStore.getChat(parentChatId)?.provider
    if (args?.provider === undefined && inheritedProvider) assertLiveProviderId(inheritedProvider)
    const provider = args?.provider === undefined ? undefined : assertLiveProviderId(args.provider)
    const sideChatMode =
      args?.sideChatMode === 'ensembleClone' ||
      args?.sideChatMode === 'singleProvider' ||
      args?.sideChatMode === 'fanOut'
        ? args.sideChatMode
        : undefined
    this.deps.assertParentChatCreationAllowed?.(parentChatId)
    const sideChat = this.deps.appStore.createSideChat({
      parentChatId,
      chatKind: args?.chatKind === 'ensemble' ? 'ensemble' : args?.chatKind === 'single' ? 'single' : undefined,
      provider,
      title: typeof args?.title === 'string' ? args.title : undefined,
      selectedModelType: optionalString(args?.selectedModelType),
      codexReasoningEffort: optionalString(args?.codexReasoningEffort),
      claudeReasoningEffort: optionalString(args?.claudeReasoningEffort),
      originMessageId:
        typeof args?.originMessageId === 'string' && args.originMessageId.trim()
          ? args.originMessageId
          : undefined,
      originRunId:
        typeof args?.originRunId === 'string' && args.originRunId.trim() ? args.originRunId : undefined,
      sideChatMode
    })

    try {
      this.deps.appendDurableRunEventForRoute(
        this.deps.appStore.getChat(parentChatId)?.provider ?? 'gemini',
        { appChatId: parentChatId },
        'side_chat_created',
        'control',
        `Opened side chat`,
        {
          sideChatId: sideChat.appChatId,
          chatKind: sideChat.chatKind || 'single',
          provider: sideChat.provider
        }
      )
    } catch {
      // Parent run may not be active — durable trace is best-effort.
    }

    return sideChat
  }

  createForkChat(args: CreateForkChatInput | undefined): ChatRecord {
    const parentChatId = requireSafeChatId(args?.parentChatId, 'Parent chat id')
    const parent = this.deps.appStore.getChat(parentChatId)
    if (!parent || parent.archived) throw new Error('Parent chat is not available for forking.')
    const provider = assertLiveProviderId(
      args?.provider === undefined ? parent.provider : args.provider
    )
    const title =
      optionalString(args?.title) ||
      `Fork of ${parent.title && parent.title !== 'New Chat' ? parent.title : 'chat'}`
    const sideChat = this.createSideChat({
      parentChatId,
      chatKind: parent.chatKind === 'ensemble' ? 'ensemble' : 'single',
      provider,
      title,
      sideChatMode: parent.chatKind === 'ensemble' ? 'ensembleClone' : 'singleProvider'
    })
    const now = Date.now()
    const targetFork: ChatRecord = {
      ...sideChat,
      title,
      messages: [],
      runs: [],
      linkedProviderSessionId: undefined,
      linkedGeminiSessionId: undefined,
      forkContext: {
        kind: 'emulated',
        createdAt: now,
        sourceChatId: parent.appChatId,
        sourceProvider: parent.provider,
        sourceProviderThreadId: optionalString(args?.sourceProviderThreadId),
        sourceModel: optionalString(args?.sourceModel),
        note: 'TaskWraith emulated fork: transcript copied into an isolated sibling chat.'
      },
      providerMetadata: {
        ...(sideChat.providerMetadata || {}),
        taskwraithForkKind: 'emulated',
        taskwraithForkSourceChatId: parent.appChatId,
        ...(args?.sourceProviderThreadId
          ? { taskwraithForkSourceProviderThreadId: args.sourceProviderThreadId }
          : {})
      },
      updatedAt: now
    }
    const preparedMessages = this.deps.prepareForkMessages({
      sourceChat: parent,
      targetFork,
      copiedMessages: structuredClone(parent.messages)
    })
    if (!Array.isArray(preparedMessages)) {
      throw new Error('Fork transcript preparation did not return a message list.')
    }
    const forked: ChatRecord = {
      ...targetFork,
      messages: preparedMessages
    }
    return this.saveChat(forked)
  }

  /** Slice C — in-place mid-thread ensemble toggle. Validates + delegates to
   * the AppStore mutation (which enforces the idle-only running guard + the
   * single-participant seed). */
  setChatKind(args: SetChatKindInput | undefined): ChatRecord {
    const chatId = requireSafeChatId(args?.chatId, 'Chat id')
    const targetKind: ChatKind = args?.targetKind === 'ensemble' ? 'ensemble' : 'single'
    const seedParticipant = args?.seedParticipant
      ? clearParticipantExternalPathGrantOverrides(args.seedParticipant)
      : undefined
    if (seedParticipant) assertLiveProviderId(seedParticipant.provider)
    // A SHARED thread cannot leave panel mode — not the host, not an agent, not
    // any renderer. Collapsing routes through AppStore.setChatKind, which strips
    // the roster into `providerMetadata.stashedEnsemble`; a later preset-apply
    // consumes that stash, so a seat removed by a collapse can RESURRECT. With
    // externals occupying seats, that means a kicked person's seat coming back.
    //
    // The refusal lives HERE because this is the only thing all the doors have
    // in common. The desktop `set-chat-kind` handler and the bridge/iOS action
    // both check it too, so their callers get shaped errors instead of a throw —
    // but the bridge path reaches this method directly, and a comment on the
    // desktop handler used to claim it was "the gate every surface goes
    // through". It was not. This is.
    if (targetKind !== 'ensemble') {
      // ACTIVE PARTICIPANTS, not enabled shares. An enabled share with nobody
      // admitted protects nothing — and keying on it made the guard refuse the
      // very revert it exists to make safe, because both revoke paths leave the
      // share record behind. What must never happen is collapsing a panel
      // somebody is still admitted to.
      if (
        this.activeExternalCountForChat(chatId) > 0 &&
        this.deps.appStore.getChat(chatId)?.chatKind === 'ensemble'
      ) {
        throw new Error(
          'This chat is shared. Stop sharing before switching it out of panel mode.'
        )
      }
    }
    const canonicalProviderMetadata =
      args?.canonicalProviderMetadata && typeof args.canonicalProviderMetadata === 'object'
        ? clearExternalPathGrantMetadata(args.canonicalProviderMetadata)
        : undefined
    const result = this.deps.appStore.setChatKind(chatId, targetKind, {
      seedParticipant,
      canonicalProvider:
        args?.canonicalProvider === undefined
          ? undefined
          : assertLiveProviderId(args.canonicalProvider),
      canonicalProviderMetadata
    })

    try {
      this.deps.appendDurableRunEventForRoute(
        result.provider ?? 'gemini',
        { appChatId: chatId },
        'lifecycle',
        'control',
        targetKind === 'ensemble' ? 'Converted chat to Ensemble' : 'Converted chat to solo',
        { chatKind: targetKind }
      )
    } catch {
      // No active run — durable trace is best-effort.
    }

    return result
  }

  getSubThreads(parentChatId: string): ChatRecord[] {
    return this.deps.appStore.getChildChats(requireSafeChatId(parentChatId, 'Parent chat id'))
  }

  getSideChats(parentChatId: string): ChatRecord[] {
    return this.deps.appStore.getSideChats(requireSafeChatId(parentChatId, 'Parent chat id'))
  }

  saveChat(chat: ChatRecord): ChatRecord {
    return this.saveChatInternal(chat, false)
  }

  private saveChatInternal(chat: ChatRecord, allowWorkspaceTransition: boolean): ChatRecord {
    const sanitizedInput = this.deps.sanitizeChatForSave(chat)
    assertSafeChatId(sanitizedInput.appChatId)
    const current = this.deps.appStore.getChat(sanitizedInput.appChatId)
    // A renderer can finish a debounced save after main has rebound this chat.
    // Treat that whole clone as stale: merging any part of it could restore an
    // old provider session, delivery receipt, prompt stamp, grant, or transcript.
    if (current && !allowWorkspaceTransition && !sameChatWorkspace(sanitizedInput, current)) {
      return current
    }
    // Full renderer records are optimistic snapshots, not patches. Without a
    // canonical revision check, a second window can save an older clone after
    // main has appended transcript/run/config state and silently erase those
    // newer fields. There is no honest three-way merge without the renderer's
    // base record, so reject the stale clone as a unit and broadcast the
    // canonical record back to every view.
    if (
      current &&
      !allowWorkspaceTransition &&
      chatPersistenceRevision(sanitizedInput) !== chatPersistenceRevision(current)
    ) {
      return current
    }
    const kindFenced = preserveCanonicalChatKind(sanitizedInput, current)
    const providerAdmissionFenced = fenceSavedProviderAdmission(kindFenced, current)
    const grantFenced = allowWorkspaceTransition
      ? providerAdmissionFenced
      : preserveCanonicalExternalPathGrantMetadata(providerAdmissionFenced, current)
    const continuityFenced = allowWorkspaceTransition
      ? grantFenced
      : this.preserveTaskWraithMcpProfileReceipts(grantFenced)
    const sanitized = this.preserveCollaboratorComments(continuityFenced)
    return this.deps.appStore.saveChat(sanitized)
  }

  /**
   * Atomically move one canonical chat to another registered workspace (or to
   * global scope). Provider-native sessions are workspace-bound, so a genuine
   * transition always starts every seat fresh while preserving transcript,
   * runs, roster, roles, permissions, and the rest of the Ensemble config.
   *
   * The optional idle assertion executes after loading the canonical chat and
   * before any mutation. It is deliberately synchronous: the main process can
   * inspect live + queued ownership and persist the transition in one event-loop
   * turn, without a renderer-authored clone entering the decision.
   */
  rebindChatWorkspace(
    input: RebindChatWorkspaceInput | undefined,
    options: RebindChatWorkspaceOptions = {}
  ): ChatRecord {
    const target = this.resolveChatWorkspaceRebindTarget(input)
    const current = this.deps.appStore.getChat(target.chatId)
    if (!current) throw new Error('Chat not found.')

    if (chatMatchesRebindTarget(current, target)) {
      const cleared = clearPendingWorkspaceRebind(current)
      if (cleared === current) return current
      return this.saveChatInternal(
        { ...cleared, updatedAt: options.now ?? Date.now() },
        false
      )
    }
    options.assertIdle?.(current)

    const now = options.now ?? Date.now()
    const source = clearPendingWorkspaceRebind(current)
    const participants = source.ensemble?.participants.map(clearParticipantWorkspaceContinuity)
    const providerMetadata = clearExternalPathGrantMetadata(source.providerMetadata)
    const rebound: ChatRecord = {
      ...source,
      scope: target.scope,
      workspaceId: target.scope === 'workspace' ? target.workspaceId : undefined,
      workspacePath: target.scope === 'workspace' ? target.workspacePath : undefined,
      updatedAt: now,
      providerMetadata,
      ...(source.ensemble && participants
        ? {
            ensemble: {
              ...source.ensemble,
              participants,
              updatedAt: new Date(now).toISOString()
            }
          }
        : {})
    }
    delete rebound.linkedProviderSessionId
    delete rebound.linkedGeminiSessionId
    delete rebound.taskWraithMcpProfileReceipt
    delete rebound.seatGeneration
    delete rebound.contextCompactionSummary

    // Route through the ordinary sanitizer/comment-preservation path. This is
    // the sole path allowed to persist a workspace transition; ordinary saves
    // return the canonical record when their binding is stale.
    const saved = this.saveChatInternal(rebound, true)
    return this.deps.appStore.getChat(target.chatId) ?? saved
  }

  queueChatWorkspaceRebind(
    input: RebindChatWorkspaceInput | undefined,
    options: Pick<RebindChatWorkspaceOptions, 'now'> = {}
  ): ChatRecord {
    const target = this.resolveChatWorkspaceRebindTarget(input)
    const current = this.deps.appStore.getChat(target.chatId)
    if (!current) throw new Error('Chat not found.')
    const now = options.now ?? Date.now()

    if (chatMatchesRebindTarget(current, target)) {
      const cleared = clearPendingWorkspaceRebind(current)
      if (cleared === current) return current
      return this.saveChatInternal({ ...cleared, updatedAt: now }, false)
    }

    const pending: PendingWorkspaceRebind =
      target.scope === 'global'
        ? {
            schemaVersion: 1,
            scope: 'global',
            queuedAt: new Date(now).toISOString()
          }
        : {
            schemaVersion: 1,
            scope: 'workspace',
            workspaceId: target.workspaceId,
            workspacePath: target.workspacePath,
            queuedAt: new Date(now).toISOString()
          }
    return this.saveChatInternal(
      {
        ...queuePendingWorkspaceRebind(current, pending),
        updatedAt: now
      },
      false
    )
  }

  private resolveChatWorkspaceRebindTarget(
    input: RebindChatWorkspaceInput | undefined
  ): ResolvedChatWorkspaceRebindTarget {
    const chatId = requireSafeChatId(input?.chatId, 'Chat id')
    if (input?.scope === 'global') {
      return { chatId, scope: 'global' }
    }
    if (input?.scope !== 'workspace') {
      throw new Error('Chat workspace scope is invalid.')
    }
    const workspaceId = requireNonEmptyString(input.workspaceId, 'Workspace id')
    const requestedPath = requireNonEmptyString(input.workspacePath, 'Workspace path')
    const registered = this.deps.findRegisteredWorkspace(requestedPath)
    if (!registered || registered.id !== workspaceId) {
      throw new Error('Chat workspace must be a registered TaskWraith workspace.')
    }
    return {
      chatId,
      scope: 'workspace',
      workspaceId,
      workspacePath: this.deps.canonicalPath(registered.path)
    }
  }

  createHumanCollaborationShare(args: {
    chatId: string
    mode: HumanCollaborationMode
    preset?: HumanContributionPreset
    inviteTtlMs?: number
  }): CreateShareResult {
    const store = this.requireHumanCollaborationStore()
    const chatId = requireSafeChatId(args.chatId, 'Chat id')
    const chat = this.deps.appStore.getChat(chatId)
    if (!chat || chat.archived) throw new Error('Chat is not available for collaboration.')
    const result = store.createShare({
      chatId,
      mode: args.mode === 'comments' ? 'comments' : 'readOnly',
      ...(args.preset ? { preset: args.preset } : {}),
      inviteTtlMs: args.inviteTtlMs
    })
    this.deps.humanCollaborationAudit?.append({
      kind: 'share.created',
      chatId,
      shareId: result.share.shareId,
      detail: `preset ${result.share.contributionRules?.preset ?? result.share.mode}`
    })
    this.deps.humanCollaborationAudit?.append({
      kind: 'invite.created',
      chatId,
      shareId: result.share.shareId,
      detail: `invite ${result.invite.inviteId}`
    })
    return result
  }

  /**
   * P2a: host-only contribution-rules update. Store enforces that the preset
   * is settable (the direct-dispatch tier is rejected) and keeps `mode` in
   * lockstep. Returns null when the share is unknown or already revoked.
   */
  updateHumanCollaborationShareRules(args: {
    shareId: string
    preset: HumanContributionPreset
  }): HumanCollaborationShare | null {
    const store = this.requireHumanCollaborationStore()
    const updated = store.updateShareRules({
      shareId: requireNonEmptyString(args.shareId, 'Share id'),
      preset: args.preset
    })
    if (updated) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'share.rules_changed',
        chatId: updated.chatId,
        shareId: updated.shareId,
        detail: `preset ${updated.contributionRules?.preset ?? updated.mode}`
      })
    }
    return updated
  }

  /**
   * Host review of queued external contributions.
   *
   * The three verbs below are deliberately split so the IPC layer can do the
   * one thing it must do FIRST: resolve the entry and scope on the entry's OWN
   * chatId. `ExternalContributionQueueStore.approve/deny` match on entryId
   * across a single global array and verify NOTHING about ownership, so a
   * handler that scoped on a renderer-supplied chatId would let a popout bound
   * to chat A resolve and approve chat B's contribution. Read the entry, assert
   * against what it says, then mutate.
   */
  getExternalContribution(entryId: string): ExternalContributionEntry | null {
    const queue = this.deps.externalContributionQueue
    if (!queue) return null
    return queue.get(requireNonEmptyString(entryId, 'Contribution id'))
  }

  /**
   * Queued-and-unreviewed contributions for ONE chat.
   *
   * `chatId` is required, unlike the store's optional parameter: `listQueued()`
   * with it omitted returns every chat's entries including the raw body, so an
   * optional pass-through here would leak the whole cross-chat queue to any
   * caller that forgot to supply one.
   */
  listPendingExternalContributions(chatId: string): ExternalContributionEntry[] {
    const queue = this.deps.externalContributionQueue
    if (!queue) return []
    const id = requireSafeChatId(chatId, 'Chat id')
    const queued = queue.listQueued(id)

    // HELD BY MUTE. Muting a seat holds an already-approved contribution rather
    // than delivering it — but approval had already removed it from this list,
    // and the delivery rule then refuses it forever, so before this it was
    // neither delivered nor denied and nobody could see it at all. Approval is
    // therefore no longer final: a held contribution comes BACK here so the host
    // can deny it or unmute the seat.
    //
    // Derived at read time from current seat state, never stored. A mute is a
    // live property of the seat; persisting "held" would go stale the moment
    // the host unmuted, and the entry would have to be rewritten to recover.
    const mutedCollaborators = new Set<string>()
    for (const share of this.deps.humanCollaborationStore?.listShares(id) ?? []) {
      if (!share.enabled) continue
      for (const participant of share.participants || []) {
        if (participant.status === 'active' && participant.seatDisabled === true) {
          mutedCollaborators.add(participant.collaboratorId)
        }
      }
    }
    if (mutedCollaborators.size === 0) return queued

    const held = queue
      .listAwaitingMaterialisation()
      .filter((entry) => entry.chatId === id && mutedCollaborators.has(entry.collaboratorId))
      .map((entry) => ({ ...entry, heldByMute: true }))
    return [...queued, ...held]
  }

  /**
   * Release a queued contribution for delivery.
   *
   * This marks ONLY. Delivery happens at the contributor's dispatch turn, which
   * does not exist yet, so an approved entry waits in
   * `listAwaitingMaterialisation()` — that is the seam the dispatch slice
   * consumes. The store deliberately exempts approved-but-undelivered entries
   * from every eviction path (`isReapable`), because an approval the host
   * granted must not silently expire before it is delivered.
   *
   * Returns null when the entry is already resolved. That is "nothing to do",
   * not a failure — but it must not be reported as a successful approval.
   */
  approveExternalContribution(entryId: string): ExternalContributionEntry | null {
    const queue = this.deps.externalContributionQueue
    if (!queue) return null
    const approved = queue.approve(requireNonEmptyString(entryId, 'Contribution id'))
    if (approved) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'contribution.approved',
        chatId: approved.chatId,
        shareId: approved.shareId,
        collaboratorId: approved.collaboratorId,
        detail: 'released for delivery at the contributor’s next turn'
      })
    }
    return approved
  }

  /** Refuse a queued contribution. The body is retained for a bounded window so
   *  the host can see what they denied; the contributor is told it was refused. */
  denyExternalContribution(entryId: string, reason?: string): ExternalContributionEntry | null {
    const queue = this.deps.externalContributionQueue
    if (!queue) return null
    const denied = queue.deny(
      requireNonEmptyString(entryId, 'Contribution id'),
      typeof reason === 'string' && reason.trim() ? reason.trim() : undefined
    )
    if (denied) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'contribution.denied',
        chatId: denied.chatId,
        shareId: denied.shareId,
        collaboratorId: denied.collaboratorId,
        ...(denied.hostReason ? { detail: denied.hostReason } : {})
      })
    }
    return denied
  }

  /**
   * Per-share host review opt-in. Deliberately NOT folded into
   * `updateHumanCollaborationShareRules`: a contribution PRESET is something
   * the collaborator is shown, and whether the host reviews before delivery is
   * not. Keeping them separate keeps a host-only fact out of a
   * collaborator-displayable field.
   */
  /**
   * Turn the full-history opt-in on or off for one share.
   *
   * Audited unconditionally, and that is not bookkeeping: this is the only
   * control that changes what an outsider can see RETROACTIVELY, so "who opened
   * this thread's history, and when" has to be answerable afterwards. The
   * caller republishes, so a connected collaborator's view re-floors
   * immediately rather than at their next reconnect.
   */
  setHumanCollaborationFullHistory(args: {
    shareId: string
    fullHistory: boolean
  }): HumanCollaborationShare | null {
    const store = this.requireHumanCollaborationStore()
    const updated = store.setFullHistory({
      shareId: requireNonEmptyString(args.shareId, 'Share id'),
      fullHistory: args.fullHistory === true
    })
    if (updated) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'share.rules_changed',
        chatId: updated.chatId,
        shareId: updated.shareId,
        detail: `full history ${updated.fullHistory === true ? 'SHARED' : 'restricted to the share'}`
      })
    }
    return updated
  }

  setHumanCollaborationHostReview(args: {
    shareId: string
    requiresHostApproval: boolean
  }): HumanCollaborationShare | null {
    const store = this.requireHumanCollaborationStore()
    const updated = store.setRequiresHostApproval({
      shareId: requireNonEmptyString(args.shareId, 'Share id'),
      requiresHostApproval: args.requiresHostApproval === true
    })
    if (updated) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'share.rules_changed',
        chatId: updated.chatId,
        shareId: updated.shareId,
        detail: `host review ${updated.requiresHostApproval === true ? 'on' : 'off'}`
      })
    }
    return updated
  }

  /**
   * An external joined — make the thread a panel, now or at the next boundary.
   *
   * Called from BOTH join doors: the runtime's `confirmSas` (every real remote
   * join) and `consumeHumanCollaborationInvite` (a second, SAS-free door that
   * has no renderer callers today but still mints an active participant). A
   * hook on only one leaves the other producing an external on a solo chat,
   * where they would hold a seat that can never take a turn.
   *
   * NEVER THROWS AND NEVER FAILS THE JOIN. `AppStore.setChatKind` refuses while
   * a run streams or a round is live; that refusal is right for a host toggling
   * the panel and wrong for a person arriving, who did nothing and cannot
   * usefully retry. So a busy chat gets the marker and the next turn boundary
   * converts.
   *
   * Returns whether a conversion was applied, queued, or was already unnecessary
   * — the caller uses it to decide whether to broadcast, because the transport
   * lane does not notify the host renderer by itself.
   */
  convertChatForExternalJoin(args: {
    chatId: string
    shareId: string
    collaboratorId: string
  }): { outcome: 'converted' | 'queued' | 'noop' } {
    const chatId = requireSafeChatId(args.chatId, 'Chat id')
    const chat = this.deps.appStore.getChat(chatId)
    // Idempotent on CHAT STATE, never on the handshake. A reconnect fires on
    // every tab reload, and a first join whose conversion was deferred arrives
    // next AS a reconnect and must still convert.
    if (!chat || !chatNeedsExternalJoinConversion(chat)) return { outcome: 'noop' }

    const seedParticipant = buildExternalJoinSeedParticipant(chat)
    if (!seedParticipant) return { outcome: 'noop' }

    // The same two conditions AppStore.setChatKind throws on, asked before it
    // is called rather than catching the throw — a caught throw cannot tell
    // "busy" apart from "genuinely broken".
    const busy =
      (chat.runs ?? []).some((run) => run.status === 'running') ||
      isEnsembleRoundDispatchLive(chat.ensemble?.activeRound)

    try {
      return this.applyOrQueueExternalJoinConversion(chat, args, seedParticipant, busy)
    } catch {
      // The header promises this never fails a join, so it must actually not.
      // A chat on a retired provider, a seed the admission path rejects, a
      // concurrent mutation — none of them are the joiner's problem, and none
      // is worth refusing an admission that already succeeded.
      return { outcome: 'noop' }
    }
  }

  private applyOrQueueExternalJoinConversion(
    chat: ChatRecord,
    args: { chatId: string; shareId: string; collaboratorId: string },
    seedParticipant: EnsembleParticipant,
    busy: boolean
  ): { outcome: 'converted' | 'queued' | 'noop' } {
    if (busy) {
      if (hasPendingExternalJoinConversion(chat)) return { outcome: 'queued' }
      const plan: PendingExternalJoinConversion = {
        schemaVersion: 1,
        collaboratorId: args.collaboratorId,
        shareId: args.shareId,
        queuedAt: new Date().toISOString(),
        seedParticipant
      }
      this.saveChat({ ...queuePendingExternalJoinConversion(chat, plan), updatedAt: Date.now() })
      return { outcome: 'queued' }
    }

    const converted = this.setChatKind({
      chatId: chat.appChatId,
      targetKind: 'ensemble',
      seedParticipant
    })
    // Stamped AFTER, not before: the solo→ensemble branch rewrites
    // providerMetadata (it consumes any stashed roster), so a mark set first
    // would be discarded.
    const record = converted ?? this.deps.appStore.getChat(chat.appChatId)
    if (record) {
      this.saveChat({ ...markChatConvertedByExternalJoin(record), updatedAt: Date.now() })
    }
    return { outcome: 'converted' }
  }

  /**
   * Drain a queued conversion at a turn boundary. Safe to call on every
   * terminal run — it is a no-op without a marker, which is the overwhelming
   * majority of runs.
   */
  applyPendingExternalJoinConversion(chatId: string): boolean {
    const chat = this.deps.appStore.getChat(requireSafeChatId(chatId, 'Chat id'))
    const plan = readPendingExternalJoinConversion(chat)
    if (!chat || !plan) return false
    // Clear the marker FIRST and unconditionally. A marker that survives a
    // failed conversion would retry on every subsequent turn forever; the join
    // itself is already durable in the share store, so a lost conversion is
    // recoverable by the next join or by the host.
    this.saveChat({ ...clearPendingExternalJoinConversion(chat), updatedAt: Date.now() })
    // Is anyone still here? The marker was written when an external joined a
    // BUSY chat, and the drain can fire arbitrarily later — at the next terminal
    // run of any kind, surviving a restart. If the host removed that person in
    // the meantime, `reconcileChatKindForExternalDeparture` could not undo the
    // conversion (it bails while the kind is still 'single') and nothing clears
    // this marker on departure, so without this check the thread converts to a
    // panel the host never asked for, minutes after the only collaborator left
    // — and keeps `externalJoinConverted` forever, which arms the revert path
    // against a roster the host has since built themselves.
    if (this.activeExternalCountForChat(chat.appChatId) === 0) return false
    if (!chatNeedsExternalJoinConversion(chat)) return false
    try {
      const converted = this.setChatKind({
        chatId: chat.appChatId,
        targetKind: 'ensemble',
        seedParticipant: plan.seedParticipant
      })
      const record = converted ?? this.deps.appStore.getChat(chat.appChatId)
      if (record) {
        this.saveChat({ ...markChatConvertedByExternalJoin(record), updatedAt: Date.now() })
      }
      return true
    } catch {
      // Still busy, or the chat changed underneath. Not fatal and not retried.
      return false
    }
  }

  /**
   * How many externals are ADMITTED to this chat right now.
   *
   * Store status, deliberately not presence. Both revoke paths mark a
   * participant `revoked` synchronously, so a kick is reflected immediately;
   * a closed tab or a sleeping laptop leaves them `active`, which is correct —
   * they still hold their seat and can reconnect. Keying this on presence would
   * collapse a panel on a network blip and would depend on expiry hooks that
   * have no production caller.
   */
  private activeExternalCountForChat(chatId: string): number {
    const shares = this.deps.humanCollaborationStore?.listShares(chatId) ?? []
    let count = 0
    for (const share of shares) {
      if (!share.enabled) continue
      for (const participant of share.participants || []) {
        if (participant.status === 'active') count += 1
      }
    }
    return count
  }

  /**
   * The last external left — hand the thread back to solo.
   *
   * The mirror of `convertChatForExternalJoin`, and like it, never throws: a
   * revoke must not fail because the chat happens to be mid-turn. A thread left
   * as a panel it did not ask for is a cosmetic problem; a revoke that errors is
   * not. `AppStore.setChatKind` derives the canonical provider from the Boss
   * seat when none is passed, so this needs no renderer.
   */
  reconcileChatKindForExternalDeparture(chatId: string): boolean {
    try {
      const id = requireSafeChatId(chatId, 'Chat id')
      if (this.activeExternalCountForChat(id) > 0) return false
      const chat = this.deps.appStore.getChat(id)
      if (chat?.chatKind !== 'ensemble') return false
      // Only reverse a conversion this feature caused. A panel the host built
      // themselves is theirs, and sharing it must not silently dismantle it.
      if (!chat.providerMetadata?.[EXTERNAL_JOIN_CONVERTED_KEY]) return false
      const reverted = this.setChatKind({ chatId: id, targetKind: 'single' }) ?? this.deps.appStore.getChat(id)
      if (reverted) {
        this.saveChat({ ...clearExternalJoinConvertedMark(reverted), updatedAt: Date.now() })
      }
      return true
    } catch {
      return false
    }
  }

  listHumanCollaborationShares(chatId?: string): HumanCollaborationShare[] {
    const store = this.requireHumanCollaborationStore()
    const normalizedChatId = chatId ? requireSafeChatId(chatId, 'Chat id') : undefined
    return store.listShares(normalizedChatId)
  }

  revokeHumanCollaborationShare(shareId: string): HumanCollaborationShare | null {
    const id = requireNonEmptyString(shareId, 'Share id')
    // Lapse BEFORE the revoke lands. Two reasons, and the order matters for
    // both: a queued contribution left behind stays APPROVABLE after trust was
    // withdrawn — the host would be releasing a message from someone they had
    // just removed — and this is the last moment the person is still connected
    // and can be told what happened to what they sent.
    this.deps.externalContributionQueue?.lapseAll({ shareId: id }, 'shareEnded')
    const revoked = this.requireHumanCollaborationStore().revokeShare(id)
    if (revoked) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'share.revoked',
        chatId: revoked.chatId,
        shareId: revoked.shareId
      })
      // Both revoke paths mark participants `revoked` synchronously, so by here
      // the count is already right and the panel-mode guard no longer refuses.
      this.reconcileChatKindForExternalDeparture(revoked.chatId)
    }
    return revoked
  }

  revokeHumanCollaborationParticipant(
    shareId: string,
    collaboratorId: string
  ): HumanCollaborationShare | null {
    const id = requireNonEmptyString(shareId, 'Share id')
    const collaborator = requireNonEmptyString(collaboratorId, 'Collaborator id')
    // Same rule, scoped to the one person: removing them must not leave their
    // pending messages sitting in the host's approval stack. Other
    // collaborators on the same share are untouched, hence both predicates.
    this.deps.externalContributionQueue?.lapseAll(
      { shareId: id, collaboratorId: collaborator },
      'revoked'
    )
    const updated = this.requireHumanCollaborationStore().revokeParticipant({
      shareId: id,
      collaboratorId: collaborator
    })
    if (updated) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'participant.revoked',
        chatId: updated.chatId,
        shareId: updated.shareId,
        collaboratorId
      })
      // Removing the last person hands the thread back; removing one of two
      // leaves the panel exactly as it was.
      this.reconcileChatKindForExternalDeparture(updated.chatId)
    }
    return updated
  }

  consumeHumanCollaborationInvite(args: {
    shareId: string
    inviteToken: string
    displayName: string
    publicKeyId: string
  }): ConsumeInviteResult {
    const result = this.requireHumanCollaborationStore().consumeInvite({
      shareId: requireNonEmptyString(args.shareId, 'Share id'),
      inviteToken: requireNonEmptyString(args.inviteToken, 'Invite token'),
      displayName: requireNonEmptyString(args.displayName, 'Display name'),
      publicKeyId: requireNonEmptyString(args.publicKeyId, 'Collaborator identity')
    })
    this.deps.humanCollaborationAudit?.append({
      kind: 'invite.consumed',
      chatId: result.share.chatId,
      shareId: result.share.shareId,
      collaboratorId: result.participant.collaboratorId,
      detail: result.participant.displayName
    })
    // An active external on a solo chat would hold a seat that can never take a
    // turn. This door mints one without SAS, so it converts too.
    this.convertChatForExternalJoin({
      chatId: result.share.chatId,
      shareId: result.share.shareId,
      collaboratorId: result.participant.collaboratorId
    })
    return result
  }

  appendCollaboratorComment(args: {
    shareId: string
    chatId: string
    collaboratorId: string
    clientMessageId: string
    content: string
    /** P2b intent; anything but the exact action-request string is a comment. */
    intent?: HumanCollaboratorContributionKind
  }): {
    chat: ChatRecord
    /** Absent when the contribution was QUEUED — there is no transcript row yet. */
    message?: ChatMessage
    deduped: boolean
    autoDraft?: string
    /** True when this went to host review instead of the transcript. */
    queued?: boolean
    queueEntryId?: string
  } {
    const store = this.requireHumanCollaborationStore()
    const content = requireBoundedText(args.content, 'Comment', 8000)
    const chatId = requireSafeChatId(args.chatId, 'Chat id')
    const isActionRequest = args.intent === 'requestHostAction'
    const validation = store.validateAppend({
      shareId: requireNonEmptyString(args.shareId, 'Share id'),
      chatId,
      collaboratorId: requireNonEmptyString(args.collaboratorId, 'Collaborator id'),
      clientMessageId: requireNonEmptyString(args.clientMessageId, 'Client message id'),
      ...(isActionRequest ? { intent: 'requestHostAction' as const } : {})
    })

    // P2a: the share's contribution rules can NARROW the accepted payload size
    // below the hard 8000 bound above (never widen it).
    const rules = effectiveContributionRules(validation.share)
    if (Buffer.byteLength(content, 'utf8') > rules.maxContributionBytes) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'contribution.rejected',
        chatId,
        shareId: validation.share.shareId,
        collaboratorId: validation.participant.collaboratorId,
        code: 'rule_denied',
        detail: 'contribution exceeds the share byte limit'
      })
      throw new Error('Comment is too long for this share.')
    }

    const current = this.deps.appStore.getChat(chatId)
    if (!current || current.archived) throw new Error('Chat is not available for collaboration.')
    if (validation.existingMessageId) {
      const existing = current.messages.find((message) => message.id === validation.existingMessageId)
      if (existing) {
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.deduped',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          contentHash: auditContentHash(content)
        })
        return { chat: current, message: existing, deduped: true }
      }
      // THE THIRD STATE. The idempotency map binds a clientMessageId to a
      // messageId, and this branch used to ask only "is that message in the
      // transcript?". A QUEUED contribution is mapped but not yet appended, so
      // the answer is no and the retry fell straight through and enqueued a
      // second copy of the same message. Ask the queue before giving up.
      const pending = this.deps.externalContributionQueue?.findByClientMessageId(
        chatId,
        validation.participant.collaboratorId,
        args.clientMessageId
      )
      if (pending) {
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.deduped',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          contentHash: auditContentHash(content)
        })
        // `queued` is derived from the entry's STATE, not from its existence.
        // The lookup matches any state, so a retry after the host denied — or
        // after a lapse, or after an approve not yet materialised — would
        // otherwise report "still awaiting review" about something already
        // resolved.
        return {
          chat: current,
          deduped: true,
          queued: pending.state === 'queued',
          queueEntryId: pending.entryId
        }
      }
    }

    // Both host-review refusals are decided BEFORE `recordAppend`, on purpose.
    // That call allocates a sequence number and binds the idempotency key to a
    // messageId; refusing after it means every retry against a misconfigured or
    // full queue burns a sequence and leaves a binding naming a row that will
    // never exist, so `nextSequence` climbs forever.
    if (validation.share.requiresHostApproval === true) {
      const queue = this.deps.externalContributionQueue
      if (!queue) {
        // Typed, like every other refusal in this method — a generic Error
        // reaches a code-mapping caller as an internal failure rather than a
        // reason. Fail CLOSED: a share that asked for review must never quietly
        // append unreviewed text because the queue was missing.
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.rejected',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          code: 'rule_denied',
          detail: 'host review is enabled but the review queue is unavailable'
        })
        throw new HumanCollaborationDenialError(
          'rule_denied',
          'Host review is enabled for this share but the review queue is unavailable.'
        )
      }
      // Ask the queue BEFORE allocating, not only inside the idempotency guard
      // above. The share's binding is capped and evicts oldest-first, so a retry
      // whose binding is gone but whose entry survives would otherwise reach
      // `enqueue`, burn a sequence, and only then be told it is a duplicate.
      const alreadyQueued = queue.findByClientMessageId(
        chatId,
        validation.participant.collaboratorId,
        args.clientMessageId
      )
      if (alreadyQueued) {
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.deduped',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          contentHash: auditContentHash(content)
        })
        return {
          chat: current,
          deduped: true,
          queued: alreadyQueued.state === 'queued',
          queueEntryId: alreadyQueued.entryId
        }
      }
      if (
        queue.queuedCountForCollaborator(chatId, validation.participant.collaboratorId) >=
        MAX_QUEUED_PER_COLLABORATOR
      ) {
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.rejected',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          code: 'quota_exceeded',
          detail: 'too many contributions awaiting host review'
        })
        throw new HumanCollaborationDenialError(
          'quota_exceeded',
          'You have too many messages awaiting review.'
        )
      }
    }

    // The messageId is minted HERE, before the branch, and a queued entry
    // carries it from the start. That keeps sequence allocation and the
    // idempotency binding exactly where they were — one atomic store write —
    // and means an approved entry materialises under the id the map already
    // points at, so the dedupe branch above resolves normally the moment the row
    // exists. Splitting allocation across enqueue and approve would have meant
    // two writes and two failure windows for no gain.
    const messageId = randomUUID()
    const sequence = store.recordAppend({
      shareId: validation.share.shareId,
      chatId,
      collaboratorId: validation.participant.collaboratorId,
      clientMessageId: args.clientMessageId,
      messageId
    })

    // HOST REVIEW. Nothing reaches the transcript until the host approves. The
    // gates above all still ran — validation, the share's byte ceiling, the rate
    // limit upstream — so the queue only ever receives bounded, authenticated,
    // sequence-allocated work.
    if (validation.share.requiresHostApproval === true) {
      // Presence was proven above, before the sequence was allocated.
      const queue = this.deps.externalContributionQueue!
      const result = queue.enqueue({
        chatId,
        shareId: validation.share.shareId,
        collaboratorId: validation.participant.collaboratorId,
        displayName: validation.participant.displayName,
        clientMessageId: args.clientMessageId,
        messageId,
        sequence,
        body: content,
        ...(isActionRequest ? { intent: 'requestHostAction' as const } : {})
      })
      if (!result.ok && result.denial === 'duplicate' && result.existing) {
        // The share's idempotency map is capped and evicts oldest-first, so a
        // binding can disappear while its entry is still pending — that retry
        // misses the dedupe branch above and lands here. The queue returns
        // `existing` precisely so this is answerable rather than an error.
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.deduped',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          contentHash: auditContentHash(content)
        })
        return {
          chat: current,
          deduped: true,
          queued: result.existing.state === 'queued',
          queueEntryId: result.existing.entryId
        }
      }
      if (!result.ok || !result.entry) {
        this.deps.humanCollaborationAudit?.append({
          kind: 'contribution.rejected',
          chatId,
          shareId: validation.share.shareId,
          collaboratorId: validation.participant.collaboratorId,
          code: result.denial === 'quota_exceeded' ? 'quota_exceeded' : 'rule_denied',
          detail: `queue refused the contribution: ${result.denial ?? 'unknown'}`
        })
        throw new HumanCollaborationDenialError(
          result.denial === 'quota_exceeded' ? 'quota_exceeded' : 'rule_denied',
          result.denial === 'quota_exceeded'
            ? 'You have too many messages awaiting review.'
            : 'That message could not be queued for review.'
        )
      }
      this.deps.humanCollaborationAudit?.append({
        kind: 'contribution.received',
        chatId,
        shareId: validation.share.shareId,
        collaboratorId: validation.participant.collaboratorId,
        preview: content,
        contentHash: auditContentHash(content)
      })
      // The chat is returned UNCHANGED — deliberately. A queued contribution is
      // not in the transcript, so nothing about the chat has moved, and a caller
      // that broadcasts this is broadcasting a no-op rather than leaking a row.
      return { chat: current, deduped: false, queued: true, queueEntryId: result.entry.entryId }
    }
    let message = makeHumanCollaboratorComment({
      id: messageId,
      content,
      timestamp: new Date().toISOString(),
      shareId: validation.share.shareId,
      collaboratorId: validation.participant.collaboratorId,
      collaboratorDisplayName: validation.participant.displayName,
      clientMessageId: args.clientMessageId,
      sequence,
      ...(isActionRequest ? { contributionKind: 'requestHostAction' as const } : {})
    })

    // P2b auto-draft: under the autoDraft rules an ACTION REQUEST also stamps a
    // wrapped, provenance-carrying draft onto the row (promotedBy 'auto', never
    // 'host' — no host click happened) and returns the draft so the caller can
    // place it in the host composer. It must NEVER send or queue a run; the
    // host still reviews and sends (spec §4 Tier P2b).
    const rulesForDraft = effectiveContributionRules(validation.share)
    let autoDraft: string | undefined
    if (isActionRequest && rulesForDraft.createHostDraft === 'auto-draft') {
      autoDraft = autoDraftedCollaboratorPrompt(message)
      message = {
        ...message,
        metadata: {
          ...(message.metadata || {}),
          promotedAt: Date.now(),
          promotedBy: 'auto',
          promotedDraft: autoDraft
        }
      }
    }

    const updated: ChatRecord = {
      ...current,
      messages: [...(current.messages || []), message],
      updatedAt: Date.now()
    }
    this.deps.appStore.saveChat(updated)
    this.deps.humanCollaborationAudit?.append({
      kind: 'contribution.received',
      chatId,
      shareId: validation.share.shareId,
      collaboratorId: validation.participant.collaboratorId,
      preview: content,
      contentHash: auditContentHash(content),
      ...(isActionRequest ? { detail: 'requestHostAction' } : {})
    })
    if (autoDraft) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'draft.inserted',
        chatId,
        shareId: validation.share.shareId,
        collaboratorId: validation.participant.collaboratorId,
        contentHash: auditContentHash(message.content),
        detail: 'auto-draft'
      })
    }
    return { chat: updated, message, deduped: false, ...(autoDraft ? { autoDraft } : {}) }
  }

  promoteCollaboratorComment(args: {
    chatId: string
    messageId: string
  }): { chat: ChatRecord; draft: string } {
    const chatId = requireSafeChatId(args.chatId, 'Chat id')
    const messageId = requireNonEmptyString(args.messageId, 'Message id')
    const chat = this.deps.appStore.getChat(chatId)
    if (!chat) throw new Error('Chat not found.')
    const message = chat.messages.find((candidate) => candidate.id === messageId)
    if (!message || !isHumanCollaboratorComment(message)) {
      throw new Error('Collaborator comment not found.')
    }
    const draft = promotedCollaboratorPrompt(message)
    const updatedMessages = chat.messages.map((candidate) => {
      if (candidate.id !== message.id) return candidate
      return {
        ...candidate,
        metadata: {
          ...(candidate.metadata || {}),
          promotedAt: Date.now(),
          promotedBy: 'host',
          promotedDraft: draft
        }
      }
    })
    const updated: ChatRecord = { ...chat, messages: updatedMessages, updatedAt: Date.now() }
    this.deps.appStore.saveChat(updated)
    const promotedMetadata = humanCollaboratorMetadata(message)
    this.deps.humanCollaborationAudit?.append({
      kind: 'draft.inserted',
      chatId,
      ...(promotedMetadata?.shareId ? { shareId: promotedMetadata.shareId } : {}),
      ...(promotedMetadata?.collaboratorId
        ? { collaboratorId: promotedMetadata.collaboratorId }
        : {}),
      contentHash: auditContentHash(message.content)
    })
    return { chat: updated, draft }
  }

  /**
   * End every live channel for these shares, then revoke them.
   *
   * Revoking alone is not enough on a destructive path. `revokeShare` flips a
   * record, and the runtime only notices on the collaborator's NEXT inbound
   * frame — but a collaborator who is merely watching sends nothing. Their
   * sealed socket stays open against a chat that no longer exists, the next
   * projection build throws, and they are left on a frozen transcript with no
   * signal at all. Closing the room drops the socket and, via the transport,
   * every runtime session bound to it.
   *
   * Every invite room is closed, not just the first: a share mints a fresh
   * roomId per invite, so a share that has been invited from twice has two live
   * doors and closing one leaves the other open.
   */
  private endCollaborationShares(shares: readonly HumanCollaborationShare[]): void {
    const store = this.deps.humanCollaborationStore
    if (!store) return
    for (const share of shares) {
      for (const invite of share.invites) {
        if (!invite.roomId) continue
        // A transport in a bad state must never block the deletion the user
        // asked for. Failing to close a socket is a leaked channel; throwing
        // here would abort the caller and leave the chat undeleted with its
        // share half-torn — strictly worse, and on the destructive path the
        // deletion is the part that has to be unconditional.
        try {
          this.deps.closeCollaborationRoom?.(invite.roomId)
        } catch {
          // Best-effort: revocation below still fails the collaborator closed
          // on their next inbound frame.
        }
      }
      if (share.enabled) store.revokeShare(share.shareId)
    }
  }

  deleteChat(chatId: string): void {
    const id = requireSafeChatId(chatId, 'Chat id')
    // Settle any active shares first so deleting a shared chat actually ends the
    // share (revocation bites on the collaborator's next inbound action) instead
    // of leaving an orphaned enabled share record pointing at a missing chat.
    const store = this.deps.humanCollaborationStore
    if (store && store.hasShareForChat(id)) {
      this.endCollaborationShares(store.listShares(id))
    }
    this.deps.appStore.deleteChat(id)
  }

  truncateChatHistory(chatId: string): ChatRecord | null {
    const id = requireSafeChatId(chatId, 'Chat id')
    if (!this.deps.appStore.truncateChatHistory) {
      throw new Error('Strict chat history truncation is unavailable.')
    }
    return this.deps.appStore.truncateChatHistory(id)
  }

  async clearChats(workspaceId?: string): Promise<void> {
    if (this.deps.clearHistoryTransaction) {
      await this.deps.clearHistoryTransaction(workspaceId)
      return
    }
    try {
      await this.prepareClearChats(workspaceId)
      this.commitClearChats(workspaceId)
    } finally {
      this.finishClearChats(workspaceId)
    }
  }

  /**
   * Revoke live external history authorities before any other clear step is
   * allowed to await. The IPC clear flow deliberately invokes this prepare
   * phase before execution-graph deletion so a pending signed-elevated Canvas
   * approval cannot be accepted while that deletion is in flight.
   */
  async prepareClearChats(workspaceId?: string): Promise<void> {
    // Collaboration is an external history authority too, and it was the one
    // authority this phase never revoked: the chats went and every
    // collaborator's socket stayed open against them.
    //
    // NB this is the FALLBACK path. When `clearHistoryTransaction` is supplied
    // — and main does supply it — `clearChats` delegates and never reaches this
    // method at all; that route closes rooms in `purgeHumanCollaborationForErasure`
    // instead, from the deletion coordinator's commit. Both paths are covered
    // deliberately; do not delete this one as dead code.
    this.endCollaborationSharesInClearScope(workspaceId)
    await this.deps.clearExternalChatHistory?.(workspaceId)
  }

  /** Shares whose chat is about to be cleared. No workspace ⇒ the whole store. */
  private endCollaborationSharesInClearScope(workspaceId?: string): void {
    const store = this.deps.humanCollaborationStore
    if (!store) return
    const shares = store.listShares()
    if (!shares.length) return
    if (!workspaceId) {
      this.endCollaborationShares(shares)
      return
    }
    // Summary lists, not one getChat per share — the chat-list index already
    // answers both questions and never materialises a full record.
    const scoped = new Set(this.deps.appStore.getChatList(workspaceId).map((c) => c.appChatId))
    const known = new Set(this.deps.appStore.getChatList().map((c) => c.appChatId))
    this.endCollaborationShares(
      shares.filter(
        // In the doomed workspace, OR orphaned. An orphan — a share whose chat
        // no longer exists anywhere — has to end here, because no other path
        // will ever come for it and it is a live channel to content that is
        // already gone. Scoping on the workspace list alone would silently keep
        // that door open. A share belonging to a DIFFERENT, surviving workspace
        // is untouched: over-reaching would kill a share whose chat is fine.
        (share) => scoped.has(share.chatId) || !known.has(share.chatId)
      )
    )
  }

  /** Commit the durable chat deletion after every external store has cleared. */
  commitClearChats(workspaceId?: string): void {
    this.deps.appStore.clearChats(workspaceId)
  }

  /** Release the prepare-phase admission hold for the same clear scope. */
  finishClearChats(workspaceId?: string): void {
    this.deps.finishExternalChatHistoryClear?.(workspaceId)
  }

  private requireHumanCollaborationStore(): HumanCollaborationStore {
    if (!this.deps.humanCollaborationStore) {
      throw new Error('Human collaboration store is not configured.')
    }
    return this.deps.humanCollaborationStore
  }

  /**
   * MCP-profile receipts describe a provider session's immutable tool surface,
   * so they are owned by main just like the linked native-session transition
   * that creates them. Renderer saves may omit a receipt from a stale clone,
   * but must never mint or replace one. While main has a valid receipt, the
   * Claude linked-session identity is main-owned even for legacy sessions that
   * predate receipts: preserve the exact canonical session (including a cleared
   * value) across stale renderer saves. A provider boundary clears the incoming
   * session/receipt pair, and renderer-authored receipts are always stripped.
   */
  private preserveTaskWraithMcpProfileReceipts(chat: ChatRecord): ChatRecord {
    const current = this.deps.appStore.getChat(chat.appChatId)
    const workspaceChanged = Boolean(current && !sameChatWorkspace(current, chat))
    const currentSoloReceipt =
      current?.provider &&
      isTaskWraithMcpProfileReceiptForSession(current.taskWraithMcpProfileReceipt, {
        provider: current.provider,
        providerSessionId: current.linkedProviderSessionId
      })
        ? current.taskWraithMcpProfileReceipt
        : undefined
    const sameClaudeLane =
      !workspaceChanged && current?.provider === 'claude' && chat.provider === 'claude'
    const crossesClaudeBoundary = Boolean(
      (!current && chat.provider === 'claude') ||
        (current && (current.provider === 'claude') !== (chat.provider === 'claude'))
    )
    const suppressIncomingSoloRerouteSession = Boolean(
      current?.provider === chat.provider &&
        isEphemeralProviderRerouteSession(chat, chat.linkedProviderSessionId)
    )
    let canonicalSoloSession = chat.linkedProviderSessionId
    if (workspaceChanged || crossesClaudeBoundary) canonicalSoloSession = undefined
    if (!workspaceChanged && (suppressIncomingSoloRerouteSession || sameClaudeLane)) {
      canonicalSoloSession = current?.linkedProviderSessionId
    }
    const canonicalSoloReceipt =
      !workspaceChanged &&
      (suppressIncomingSoloRerouteSession || sameClaudeLane || current?.provider === chat.provider)
        ? currentSoloReceipt
        : undefined

    let changed =
      chat.linkedProviderSessionId !== canonicalSoloSession ||
      !sameTaskWraithMcpProfileReceipt(chat.taskWraithMcpProfileReceipt, canonicalSoloReceipt)
    let participants = chat.ensemble?.participants
    if (participants) {
      const currentParticipants = new Map(
        (current?.ensemble?.participants || []).map((participant) => [participant.id, participant])
      )
      participants = participants.map((participant) => {
        const currentParticipant = currentParticipants.get(participant.id)
        const currentReceipt =
          currentParticipant &&
          isTaskWraithMcpProfileReceiptForSession(
            currentParticipant.taskWraithMcpProfileReceipt,
            {
              provider: currentParticipant.provider,
              providerSessionId: currentParticipant.linkedProviderSessionId
            }
          )
            ? currentParticipant.taskWraithMcpProfileReceipt
            : undefined
        const sameClaudeParticipant = Boolean(
          !workspaceChanged &&
            currentParticipant?.provider === 'claude' &&
            participant.provider === 'claude'
        )
        const suppressIncomingRerouteSession = Boolean(
          currentParticipant?.provider === participant.provider &&
            isEphemeralProviderRerouteSession(
              chat,
              participant.linkedProviderSessionId,
              participant.id
            )
        )
        const crossesClaudeParticipantBoundary = Boolean(
          !currentParticipant ||
            (currentParticipant.provider === 'claude') !== (participant.provider === 'claude')
        )
        let canonicalSession = participant.linkedProviderSessionId
        if (workspaceChanged || crossesClaudeParticipantBoundary) canonicalSession = undefined
        if (!workspaceChanged && (suppressIncomingRerouteSession || sameClaudeParticipant)) {
          canonicalSession = currentParticipant?.linkedProviderSessionId
        }
        const canonicalReceipt =
          !workspaceChanged &&
          (suppressIncomingRerouteSession ||
            sameClaudeParticipant ||
            currentParticipant?.provider === participant.provider)
            ? currentReceipt
            : undefined
        if (
          participant.linkedProviderSessionId === canonicalSession &&
          sameTaskWraithMcpProfileReceipt(participant.taskWraithMcpProfileReceipt, canonicalReceipt)
        ) {
          return participant
        }
        changed = true
        const next = { ...participant }
        if (canonicalSession === undefined) delete next.linkedProviderSessionId
        else next.linkedProviderSessionId = canonicalSession
        if (canonicalReceipt) {
          next.taskWraithMcpProfileReceipt = canonicalReceipt
        } else {
          delete next.taskWraithMcpProfileReceipt
        }
        return next
      })
    }

    if (!changed) return chat
    const next: ChatRecord = {
      ...chat,
      ...(chat.ensemble && participants
        ? { ensemble: { ...chat.ensemble, participants } }
        : {})
    }
    if (canonicalSoloSession === undefined) delete next.linkedProviderSessionId
    else next.linkedProviderSessionId = canonicalSoloSession
    if (canonicalSoloReceipt) next.taskWraithMcpProfileReceipt = canonicalSoloReceipt
    else delete next.taskWraithMcpProfileReceipt
    return next
  }

  private preserveCollaboratorComments(chat: ChatRecord): ChatRecord {
    const store = this.deps.humanCollaborationStore
    if (!store) return chat
    // Cheap existence check FIRST: saveChat is on the hot path (every renderer
    // save, including streaming) for EVERY chat; listShares() deep-clones the
    // entire share store, so gate it on a no-clone .some() so unshared chats
    // (the overwhelming majority) pay nothing.
    if (!store.hasShareForChat(chat.appChatId)) return chat
    const shares = store.listShares(chat.appChatId)
    if (shares.length === 0) return chat
    const shareIds = new Set(shares.map((share) => share.shareId))
    const current = this.deps.appStore.getChat(chat.appChatId)
    if (!current) return chat
    const canonicalCollaboratorComments = (current.messages || []).filter((message) => {
      if (!isHumanCollaboratorComment(message)) return false
      const metadata = humanCollaboratorMetadata(message)
      return Boolean(metadata?.shareId && shareIds.has(metadata.shareId))
    })
    if (canonicalCollaboratorComments.length === 0) return chat
    const canonicalById = new Map(
      canonicalCollaboratorComments.map((message) => [message.id, message] as const)
    )
    const preservedIds = new Set<string>()
    const sanitizedMessages: ChatMessage[] = []
    let changed = false
    for (const message of chat.messages || []) {
      if (!isHumanCollaboratorComment(message)) {
        sanitizedMessages.push(message)
        continue
      }
      const canonical = canonicalById.get(message.id)
      if (!canonical) {
        changed = true
        continue
      }
      preservedIds.add(canonical.id)
      sanitizedMessages.push(canonical)
      if (canonical !== message) changed = true
    }
    const missingCollaboratorComments = canonicalCollaboratorComments.filter(
      (message) => !preservedIds.has(message.id)
    )
    if (missingCollaboratorComments.length === 0 && !changed) return chat
    const messages = [...sanitizedMessages, ...missingCollaboratorComments].sort(compareMessagesByTime)
    return {
      ...chat,
      messages
    }
  }
}

function clearParticipantWorkspaceContinuity(
  participant: EnsembleParticipant
): EnsembleParticipant {
  const next = { ...participant }
  delete next.linkedProviderSessionId
  delete next.taskWraithMcpProfileReceipt
  delete next.promptShellVersion
  delete next.promptDynamicStateVersion
  delete next.seatGeneration
  delete next.contextCompactionSummary
  const permissionOverrides = clearExternalPathGrantOverrides(next.permissionOverrides)
  if (permissionOverrides) next.permissionOverrides = permissionOverrides
  else delete next.permissionOverrides
  return next
}

function clearParticipantExternalPathGrantOverrides(
  participant: EnsembleParticipant
): EnsembleParticipant {
  const next = { ...participant }
  const permissionOverrides = clearExternalPathGrantOverrides(next.permissionOverrides)
  if (permissionOverrides) next.permissionOverrides = permissionOverrides
  else delete next.permissionOverrides
  return next
}

function sameChatWorkspace(
  left: Pick<ChatRecord, 'scope' | 'workspaceId' | 'workspacePath'>,
  right: Pick<ChatRecord, 'scope' | 'workspaceId' | 'workspacePath'>
): boolean {
  const leftScope = left.scope === 'global' ? 'global' : 'workspace'
  const rightScope = right.scope === 'global' ? 'global' : 'workspace'
  if (leftScope !== rightScope) return false
  if (leftScope === 'global') return true
  return left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath
}

function chatPersistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  return Number.isSafeInteger(chat.persistenceRevision) && (chat.persistenceRevision ?? -1) >= 0
    ? (chat.persistenceRevision as number)
    : 0
}

function chatMatchesRebindTarget(
  chat: Pick<ChatRecord, 'scope' | 'workspaceId' | 'workspacePath'>,
  target: Pick<ChatRecord, 'scope' | 'workspaceId' | 'workspacePath'>
): boolean {
  if (target.scope === 'global') {
    return chat.scope === 'global' && !chat.workspaceId && !chat.workspacePath
  }
  return (
    chat.scope !== 'global' &&
    chat.workspaceId === target.workspaceId &&
    chat.workspacePath === target.workspacePath
  )
}

function clearExternalPathGrantMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const next = { ...metadata }
  for (const key of EXTERNAL_PATH_GRANT_METADATA_KEYS) {
    delete next[key]
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Full renderer records are not grant-authoring requests. Strip every
 * renderer-supplied grant key, then restore only main's current canonical
 * values. The sole renderer-owned field is display `order`, accepted only when
 * both canonical id and signature match; membership and every signed field stay
 * main-owned. A new record has no canonical grant state, so forged grant
 * metadata is removed. Workspace rebind bypasses this helper and deliberately
 * clears the old workspace's grants.
 */
function preserveCanonicalExternalPathGrantMetadata(
  incoming: ChatRecord,
  current: ChatRecord | null | undefined
): ChatRecord {
  const providerMetadata = clearExternalPathGrantMetadata(incoming.providerMetadata)
  const currentMetadata = current?.providerMetadata
  const currentHasGrantMetadata = Boolean(
    currentMetadata &&
      EXTERNAL_PATH_GRANT_METADATA_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(currentMetadata, key)
      )
  )
  const next = { ...incoming }
  if (!currentHasGrantMetadata) {
    if (providerMetadata) next.providerMetadata = providerMetadata
    else delete next.providerMetadata
    return next
  }

  const incomingOrderByIdentity = new Map<string, number>()
  for (const grant of externalPathGrantMetadataLists(incoming.providerMetadata)) {
    if (!grant.signature || !Number.isSafeInteger(grant.order) || (grant.order ?? -1) < 0) continue
    incomingOrderByIdentity.set(`${grant.id}\u0000${grant.signature}`, grant.order as number)
  }
  const canonicalGrants = collectExternalPathGrantsFromMetadata(currentMetadata).map(
    (grant) => {
      if (!grant.signature) return grant
      const order = incomingOrderByIdentity.get(`${grant.id}\u0000${grant.signature}`)
      return order === undefined ? grant : { ...grant, order }
    }
  )
  next.providerMetadata = canonicalizeExternalPathGrantMetadata(
    providerMetadata,
    canonicalGrants
  )
  return next
}

function clearExternalPathGrantOverrides(
  overrides: EnsembleParticipant['permissionOverrides']
): EnsembleParticipant['permissionOverrides'] {
  if (!overrides) return undefined
  const next = { ...overrides }
  delete next.externalPathGrants
  return Object.keys(next).length > 0 ? next : undefined
}

function isEphemeralProviderRerouteSession(
  chat: ChatRecord,
  providerSessionId: string | null | undefined,
  ensembleParticipantId?: string
): boolean {
  const normalizedSessionId =
    typeof providerSessionId === 'string' ? providerSessionId.trim() : ''
  if (!normalizedSessionId) return false
  return (chat.runs || []).some((run) => {
    const reroute = run.providerReroute
    if (!reroute || reroute.from === reroute.to) return false
    if (run.providerThreadId !== normalizedSessionId) return false
    return ensembleParticipantId
      ? run.ensembleParticipantId === ensembleParticipantId
      : !run.ensembleParticipantId
  })
}

function sameTaskWraithMcpProfileReceipt(
  left: ChatRecord['taskWraithMcpProfileReceipt'],
  right: ChatRecord['taskWraithMcpProfileReceipt']
): boolean {
  if (!left || !right) return left === right
  return (
    left.schemaVersion === right.schemaVersion &&
    left.profileId === right.profileId &&
    left.provider === right.provider &&
    left.providerSessionId === right.providerSessionId &&
    left.pinnedAt === right.pinnedAt
  )
}

function compareMessagesByTime(a: ChatMessage, b: ChatMessage): number {
  const at = Date.parse(a.timestamp || '')
  const bt = Date.parse(b.timestamp || '')
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
  return 0
}

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
}

/**
 * Subthreads, forks, side chats and ensemble participants admit AntiGravity's
 * two lanes INDEPENDENTLY, each on evidence about itself: the agy/CLI ban-risk
 * lane on its recorded opt-in, the Gemini API-key lane on a currently
 * configured key. Neither lane's absence may strand the other — see the note
 * in `ComposerService.assertLiveProviderId` for why gating on the key alone
 * broke agy seats, and `AntigravityAgyOptInEnabledSignal` for why this reads a
 * wired boolean rather than `AppSettings`.
 *
 * The previous comment here claimed the agy lane "opens an external terminal".
 * It does not — `runAntigravityAgyProvider` spawns an in-app PTY child through
 * `runCliProviderProcess`, like every other CLI transport.
 */
function assertLiveProviderId(value: unknown): ProviderId {
  const provider = assertProviderId(value)
  if (isLiveSelectableProvider(provider)) return provider
  if (
    provider === ANTIGRAVITY_PROVIDER_ID &&
    (isAntigravityAgyOptInEnabled() || isAntigravityGeminiApiKeyConfigured())
  ) {
    return provider
  }
  throw new Error(`${provider} is unavailable for new chats or delegated runs.`)
}

/**
 * A roster seat to convert a solo chat from, built main-side.
 *
 * Honestly lower fidelity than the renderer's equivalent: it carries the chat's
 * provider and model and nothing else, because a relay join has no renderer and
 * no composer selection to read. `AppStore.setChatKind` tops the roster up to
 * the floor from here.
 */
function buildExternalJoinSeedParticipant(chat: ChatRecord): EnsembleParticipant | null {
  if (!chat.provider) return null
  return {
    id: 'seat-1',
    provider: chat.provider,
    enabled: true,
    role: 'Lead',
    instructions: '',
    order: 1,
    ...(typeof chat.providerMetadata?.selectedModelType === 'string'
      ? { model: chat.providerMetadata.selectedModelType }
      : {})
  }
}

/**
 * `chatKind` is main-owned. `setChatKind` is the door for changing it: it
 * enforces the idle-only running guard, seeds or strips the roster, and refuses
 * to collapse a SHARED chat out of panel mode. `save-chat` accepts a whole
 * renderer-authored record and walked straight past all of that — a fence with a
 * gate standing open beside it.
 *
 * The stored kind therefore wins. Two carve-outs, both narrow:
 *
 *   - NO STORED RECORD. This is a creation (fork, side chat, sub-thread) and the
 *     incoming kind is the only one that exists.
 *   - A PENDING ROSTER-PRESET PLAN, or a PENDING EXTERNAL-JOIN CONVERSION, on
 *     the STORED record authorises exactly one transition — single → ensemble —
 *     at the turn or round boundary that consumes it. Both are written by main;
 *     neither can be asserted by the incoming snapshot. The plan is main-verifiable and was written by the
 *     preset-apply path, so it is authority rather than renderer assertion, and
 *     it can only ever turn panel mode ON. It cannot launder a collapse.
 *
 * Pinning rather than rejecting the record is deliberate. A save carrying a
 * stale kind usually also carries real transcript work, and every other fence in
 * this chain preserves one field rather than discarding the whole snapshot.
 *
 * Restoring the stored ensemble block alongside the kind is load-bearing:
 * `normalizeChatRecord` seeds a DEFAULT multi-provider roster onto any chat that
 * is `ensemble` without one, so pinning the kind while leaving the incoming
 * record's dropped roster in place would replace the user's seats with defaults.
 */
function preserveCanonicalChatKind(next: ChatRecord, current: ChatRecord | null): ChatRecord {
  if (!current) return next
  const storedKind: ChatKind = current.chatKind === 'ensemble' ? 'ensemble' : 'single'
  const incomingKind: ChatKind = next.chatKind === 'ensemble' ? 'ensemble' : 'single'
  if (storedKind === incomingKind) return next
  if (
    storedKind === 'single' &&
    incomingKind === 'ensemble' &&
    (hasPendingEnsembleRosterPresetApply(current) || hasPendingExternalJoinConversion(current))
  ) {
    return next
  }
  return {
    ...next,
    chatKind: storedKind,
    ...(storedKind === 'ensemble' && !next.ensemble && current.ensemble
      ? { ensemble: current.ensemble }
      : {})
  }
}

/**
 * Renderer-authored records may round-trip historical providers for decode and
 * display, but they cannot mint a new executable lane by copying or mutating a
 * record. Compare retired values against the canonical record by stable seat
 * id; deletion or migration to a live provider remains allowed.
 */
function fenceSavedProviderAdmission(incoming: ChatRecord, current: ChatRecord | null): ChatRecord {
  if (
    incoming.provider &&
    !isLiveSelectableProvider(incoming.provider) &&
    current?.provider !== incoming.provider
  ) {
    assertLiveProviderId(incoming.provider)
  }

  const currentParticipants = new Map(
    (current?.ensemble?.participants || []).map((participant) => [participant.id, participant])
  )
  for (const participant of incoming.ensemble?.participants || []) {
    if (
      !isLiveSelectableProvider(participant.provider) &&
      currentParticipants.get(participant.id)?.provider !== participant.provider
    ) {
      assertLiveProviderId(participant.provider)
    }
  }

  const incomingPending = readPendingProviderChange(incoming)
  if (incomingPending && !isLiveSelectableProvider(incomingPending.provider)) {
    const currentPending = current ? readPendingProviderChange(current) : null
    if (currentPending?.provider !== incomingPending.provider) assertLiveProviderId(incomingPending.provider)
    // A conditional AntiGravity switch that reaches this point was either
    // admitted just above against the configured API-key lane or already
    // existed in canonical state. Preserve that user-authored control state so
    // turn-end finalization can apply it. Current run dispatch still performs
    // its own credential admission; this does not widen the static offer set.
    if (incomingPending.provider === ANTIGRAVITY_PROVIDER_ID) return incoming
    // An old queued switch is actionable runtime control, not identity needed
    // for transcript rendering. Clear it on the first accepted historical save.
    return clearPendingProviderChange(incoming)
  }
  return incoming
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requireSafeChatId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return assertSafeChatId(value, label)
}

function requireBoundedText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxChars) {
    throw new Error(`${label} is too long.`)
  }
  return trimmed
}
