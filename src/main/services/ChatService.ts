import type { AgentRunRoute } from '../run/AgentRunTypes'
import type {
  ChatListItem,
  ChatMessage,
  ChatRecord,
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

// Grok + Cursor are first-class providers; no eligibility gate (see ProviderId).
const PROVIDER_IDS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])

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

export interface SetGuestParticipantInput {
  parentChatId: string
  provider: ProviderId
  selectedModelType?: string
  customModel?: string
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
}

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
  setGuestParticipant: (args: SetGuestParticipantInput) => { parent: ChatRecord; guest: ChatRecord }
  removeGuestParticipant: (parentChatId: string) => { parent: ChatRecord; guest?: ChatRecord }
  getChildChats: (parentChatId: string) => ChatRecord[]
  getSideChats: (parentChatId: string) => ChatRecord[]
  saveChat: (chat: ChatRecord) => void
  deleteChat: (chatId: string) => void
  clearChats: (workspaceId?: string) => void
}

export interface ChatServiceDeps {
  appStore: ChatServiceStore
  humanCollaborationStore?: HumanCollaborationStore
  /** P2a durable audit sink for host-visible collaboration events. */
  humanCollaborationAudit?: HumanCollaborationAuditLike
  findRegisteredWorkspace: (path: string) => WorkspaceRecord | undefined
  canonicalPath: (path: string) => string
  sanitizeChatForSave: (chat: ChatRecord) => ChatRecord
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
    const provider = assertProviderId(args?.provider)
    const delegationPrompt = requireNonEmptyString(args?.delegationPrompt, 'Delegation prompt')
    const returnResultToParent = Boolean(args?.returnResultToParent)
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
    const provider = args?.provider === undefined ? undefined : assertProviderId(args.provider)
    const sideChatMode =
      args?.sideChatMode === 'ensembleClone' ||
      args?.sideChatMode === 'singleProvider' ||
      args?.sideChatMode === 'fanOut' ||
      args?.sideChatMode === 'guestParticipant'
        ? args.sideChatMode
        : undefined
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

  setGuestParticipant(args: SetGuestParticipantInput | undefined): {
    parent: ChatRecord
    guest: ChatRecord
  } {
    const parentChatId = requireSafeChatId(args?.parentChatId, 'Parent chat id')
    const provider = assertProviderId(args?.provider)
    const selectedModelType = optionalString(args?.selectedModelType) || 'default'
    const customModel = optionalString(args?.customModel) || ''
    const result = this.deps.appStore.setGuestParticipant({
      parentChatId,
      provider,
      selectedModelType,
      customModel,
      codexReasoningEffort: optionalString(args?.codexReasoningEffort),
      codexServiceTier: optionalString(args?.codexServiceTier),
      claudeReasoningEffort: optionalString(args?.claudeReasoningEffort),
      claudeFastMode:
        typeof args?.claudeFastMode === 'boolean' ? args.claudeFastMode : undefined,
      kimiThinkingEnabled:
        typeof args?.kimiThinkingEnabled === 'boolean' ? args.kimiThinkingEnabled : undefined
    })

    try {
      this.deps.appendDurableRunEventForRoute(
        result.parent.provider ?? 'gemini',
        { appChatId: parentChatId },
        'lifecycle',
        'control',
        `Attached ${provider} guest participant`,
        {
          guestChatId: result.guest.appChatId,
          provider,
          selectedModelType
        }
      )
    } catch {
      // Parent run may not be active — durable trace is best-effort.
    }

    return result
  }

  removeGuestParticipant(parentChatIdInput: string | undefined): {
    parent: ChatRecord
    guest?: ChatRecord
  } {
    const parentChatId = requireSafeChatId(parentChatIdInput, 'Parent chat id')
    const result = this.deps.appStore.removeGuestParticipant(parentChatId)
    try {
      this.deps.appendDurableRunEventForRoute(
        result.parent.provider ?? 'gemini',
        { appChatId: parentChatId },
        'lifecycle',
        'control',
        'Removed guest participant',
        {
          guestChatId: result.guest?.appChatId
        }
      )
    } catch {
      // Parent run may not be active — durable trace is best-effort.
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
    const sanitized = this.preserveCollaboratorComments(this.deps.sanitizeChatForSave(chat))
    assertSafeChatId(sanitized.appChatId)
    this.deps.appStore.saveChat(sanitized)
    return sanitized
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

  clearChats(workspaceId?: string): void {
    this.deps.appStore.clearChats(workspaceId)
  }

  private requireHumanCollaborationStore(): HumanCollaborationStore {
    if (!this.deps.humanCollaborationStore) {
      throw new Error('Human collaboration store is not configured.')
    }
    return this.deps.humanCollaborationStore
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
