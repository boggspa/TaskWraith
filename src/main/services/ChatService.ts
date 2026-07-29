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
import { clearPendingProviderChange, readPendingProviderChange } from '../providerChangeQueue'
import {
  clearPendingWorkspaceRebind,
  queuePendingWorkspaceRebind,
  type PendingWorkspaceRebind
} from '../pendingWorkspaceRebind'
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
  /** Clears history stored outside Electron userData (currently bridge diagnostics). */
  clearExternalChatHistory?: (workspaceId?: string) => void | Promise<void>
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
    const providerAdmissionFenced = fenceSavedProviderAdmission(sanitizedInput, current)
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

  listHumanCollaborationShares(chatId?: string): HumanCollaborationShare[] {
    const store = this.requireHumanCollaborationStore()
    const normalizedChatId = chatId ? requireSafeChatId(chatId, 'Chat id') : undefined
    return store.listShares(normalizedChatId)
  }

  revokeHumanCollaborationShare(shareId: string): HumanCollaborationShare | null {
    const revoked = this.requireHumanCollaborationStore().revokeShare(
      requireNonEmptyString(shareId, 'Share id')
    )
    if (revoked) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'share.revoked',
        chatId: revoked.chatId,
        shareId: revoked.shareId
      })
    }
    return revoked
  }

  revokeHumanCollaborationParticipant(
    shareId: string,
    collaboratorId: string
  ): HumanCollaborationShare | null {
    const updated = this.requireHumanCollaborationStore().revokeParticipant({
      shareId: requireNonEmptyString(shareId, 'Share id'),
      collaboratorId: requireNonEmptyString(collaboratorId, 'Collaborator id')
    })
    if (updated) {
      this.deps.humanCollaborationAudit?.append({
        kind: 'participant.revoked',
        chatId: updated.chatId,
        shareId: updated.shareId,
        collaboratorId
      })
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
  }): { chat: ChatRecord; message: ChatMessage; deduped: boolean; autoDraft?: string } {
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
    }

    const messageId = randomUUID()
    const sequence = store.recordAppend({
      shareId: validation.share.shareId,
      chatId,
      collaboratorId: validation.participant.collaboratorId,
      clientMessageId: args.clientMessageId,
      messageId
    })
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

  deleteChat(chatId: string): void {
    const id = requireSafeChatId(chatId, 'Chat id')
    // Settle any active shares first so deleting a shared chat actually ends the
    // share (revocation bites on the collaborator's next inbound action) instead
    // of leaving an orphaned enabled share record pointing at a missing chat.
    const store = this.deps.humanCollaborationStore
    if (store && store.hasShareForChat(id)) {
      for (const share of store.listShares(id)) {
        if (share.enabled) store.revokeShare(share.shareId)
      }
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
    await this.deps.clearExternalChatHistory?.(workspaceId)
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
 * The official agy/CLI AntiGravity lane never dispatches through subthreads,
 * forks, side chats, or ensemble participants created here (it opens an
 * external terminal), so it is never admitted regardless of opt-in. The
 * independent Gemini API-key lane DOES dispatch an in-app turn through the
 * Gemini kernel, so it is admitted here on a currently configured key alone
 * -- see `AntigravityGeminiApiKeyConfiguredSignal`.
 */
function assertLiveProviderId(value: unknown): ProviderId {
  const provider = assertProviderId(value)
  if (isLiveSelectableProvider(provider)) return provider
  if (provider === ANTIGRAVITY_PROVIDER_ID && isAntigravityGeminiApiKeyConfigured()) {
    return provider
  }
  throw new Error(`${provider} is unavailable for new chats or delegated runs.`)
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
