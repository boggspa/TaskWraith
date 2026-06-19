import type { AgentRunRoute } from '../run/AgentRunTypes'
import type {
  ChatListItem,
  ChatRecord,
  PinnedMessageGroup,
  ProviderId,
  RunEventInput,
  SideChatMode,
  WorkspaceRecord
} from '../store/types'
import { assertSafeChatId } from '../ChatPath'

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

  saveChat(chat: ChatRecord): void {
    const sanitized = this.deps.sanitizeChatForSave(chat)
    assertSafeChatId(sanitized.appChatId)
    this.deps.appStore.saveChat(sanitized)
  }

  deleteChat(chatId: string): void {
    this.deps.appStore.deleteChat(requireSafeChatId(chatId, 'Chat id'))
  }

  clearChats(workspaceId?: string): void {
    this.deps.appStore.clearChats(workspaceId)
  }
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
