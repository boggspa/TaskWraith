import type {
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  PermissionOverrides
} from '../../../main/store/types'
import type { DiscordContextSelection } from '../../../main/channels/DiscordContextService'
import { CHAT_COMPOSER_SELECTION_METADATA_KEYS } from '../../../shared/chatComposerSelectionPatch'
import type { ImageAttachment } from './imageAttachments'
import type { QueuedRunRequest } from './runRequestTypes'

export interface WelcomeBackgroundShortcutInput {
  isWelcomeChat: boolean
  isWorkflowChatWelcome: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing: boolean
}

export interface WelcomeBackgroundThreadTarget {
  chat: ChatRecord
  prompt: string
  sessionTrust: boolean
  imageAttachments: ImageAttachment[]
  discordContextSelection: DiscordContextSelection | null
}

export interface WelcomeBackgroundLaunchDependencies {
  createWorkspaceChat: (workspaceId: string, workspacePath: string) => Promise<ChatRecord>
  createGlobalChat: () => Promise<ChatRecord>
  createEnsembleChat: (args?: {
    workspaceId?: string
    workspacePath?: string
  }) => Promise<ChatRecord>
  saveChat: (chat: ChatRecord) => Promise<ChatRecord>
  recordChat: (chat: ChatRecord) => void
  projectIdsForChat: (chatId: string) => string[]
  addChatToProject: (projectId: string, chatId: string) => void
  createRunId: () => string
  queueRun: (request: QueuedRunRequest, reason: string) => void
  executeRun: (request: QueuedRunRequest) => void
  currentDraft: (chatId: string) => string
  clearDraft: (chatId: string) => void
  clearSubmittedContext: (request: QueuedRunRequest, sourceChatId: string) => void
  reapAbandonedChats: (keepChatId: string) => void
  formatScheduledRunTime: (scheduledRunAt: string) => string
}

/**
 * Command/Ctrl+Return is a background-launch gesture only on an ordinary
 * pristine welcome composer. Workflow compose keeps its existing submit path
 * because that gesture creates a WorkflowDefinition rather than a normal
 * independently-running thread.
 */
export function shouldStartWelcomeThreadInBackground(
  input: WelcomeBackgroundShortcutInput
): boolean {
  return (
    input.isWelcomeChat &&
    !input.isWorkflowChatWelcome &&
    (input.metaKey || input.ctrlKey) &&
    !input.shiftKey &&
    !input.altKey &&
    !input.isComposing
  )
}

function chatScope(chat: ChatRecord): 'workspace' | 'global' {
  return chat.scope === 'global' || (!chat.workspaceId && !chat.workspacePath)
    ? 'global'
    : 'workspace'
}

function clonePermissionOverrides(
  source: PermissionOverrides | undefined
): PermissionOverrides | undefined {
  if (!source) return undefined
  const { externalPathGrants: _dropChatBoundExternalGrants, ...rest } = source
  const cloned: PermissionOverrides = {
    ...rest,
    ...(rest.agenticServices ? { agenticServices: { ...rest.agenticServices } } : {})
  }
  return Object.keys(cloned).length > 0 ? cloned : undefined
}

function cloneStartingParticipant(source: EnsembleParticipant): EnsembleParticipant {
  const {
    contextCompactionSummary: _dropContextSummary,
    kimiAcpNativeSession: _dropKimiSessionMarker,
    kimiAcpPostureVersion: _dropKimiPosture,
    linkedProviderSessionId: _dropLinkedSession,
    permissionOverrides,
    promptDynamicStateVersion: _dropDynamicReceipt,
    promptShellVersion: _dropPromptShellReceipt,
    seatGeneration: _dropSeatGeneration,
    taskWraithMcpProfileReceipt: _dropMcpProfileReceipt,
    tokenTotals: _dropTokenTotals,
    ...configuration
  } = source
  const safePermissionOverrides = clonePermissionOverrides(permissionOverrides)
  return {
    ...configuration,
    linkedProviderSessionId: null,
    ...(safePermissionOverrides ? { permissionOverrides: safePermissionOverrides } : {})
  }
}

function cloneStartingEnsemble(source: EnsembleConfig, now: number): EnsembleConfig {
  const {
    activeRound: _dropActiveRound,
    blackboard: _dropBlackboard,
    blackboardTombstones: _dropBlackboardTombstones,
    bossmanControlState: _dropBossRuntime,
    escalationSignals: _dropEscalationSignals,
    lastRoundSummary: _dropLastSummary,
    roundSummaries: _dropRoundSummaries,
    sessionActivityLedger: _dropActivityLedger,
    updatedAt: _dropUpdatedAt,
    wakeups: _dropWakeups,
    workSession: _dropLegacyWorkSession,
    ...configuration
  } = source
  return {
    ...configuration,
    participants: (configuration.participants || []).map(cloneStartingParticipant),
    ...(configuration.captainParticipantIds
      ? { captainParticipantIds: [...configuration.captainParticipantIds] }
      : {}),
    ...(configuration.bossmanAutoApprovals
      ? { bossmanAutoApprovals: { ...configuration.bossmanAutoApprovals } }
      : {}),
    updatedAt: new Date(now).toISOString()
  }
}

function cloneComposerMetadata(source: ChatRecord): Record<string, unknown> | undefined {
  const sourceMetadata = source.providerMetadata || {}
  const metadata: Record<string, unknown> = {}
  for (const key of CHAT_COMPOSER_SELECTION_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sourceMetadata, key)) {
      metadata[key] = sourceMetadata[key]
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

/**
 * Copy only starting configuration onto a newly-created canonical chat.
 * Transcript, provider-session, grant, run, project, relation, and other
 * lifecycle identities always come from the fresh record (or remain absent).
 */
export function cloneWelcomeBackgroundChat(
  source: ChatRecord,
  fresh: ChatRecord,
  now: number = Date.now()
): ChatRecord {
  const sourceKind = source.chatKind === 'ensemble' ? 'ensemble' : 'single'
  const freshKind = fresh.chatKind === 'ensemble' ? 'ensemble' : 'single'
  if (sourceKind !== freshKind) {
    throw new Error('Background thread factory returned the wrong chat kind.')
  }
  if (chatScope(source) !== chatScope(fresh)) {
    throw new Error('Background thread factory returned the wrong chat scope.')
  }
  if (source.messages.length > 0 || source.runs.length > 0 || source.archived) {
    throw new Error('Only a pristine welcome chat can launch a background thread.')
  }

  const composerMetadata = cloneComposerMetadata(source)
  return {
    ...fresh,
    provider: source.provider || fresh.provider,
    workflowMode: source.workflowMode || fresh.workflowMode || 'normal',
    ...(composerMetadata ? { providerMetadata: composerMetadata } : {}),
    ...(sourceKind === 'ensemble' && source.ensemble
      ? { ensemble: cloneStartingEnsemble(source.ensemble, now) }
      : {}),
    updatedAt: now
  }
}

/**
 * Materialize, persist, expose, and dispatch the independent chat while the
 * source welcome draft remains selected. Admission/consent validation belongs
 * to the caller's ordinary run seam; this function starts only an already
 * validated immutable request snapshot.
 */
export async function launchWelcomeBackgroundThread(
  input: {
    target: WelcomeBackgroundThreadTarget
    request: QueuedRunRequest
    scheduledRunAt?: string
  },
  dependencies: WelcomeBackgroundLaunchDependencies
): Promise<ChatRecord> {
  const sourceChat = input.target.chat
  const sourceScope = chatScope(sourceChat)
  let freshChat: ChatRecord
  if (sourceChat.chatKind === 'ensemble') {
    freshChat = await dependencies.createEnsembleChat(
      sourceScope === 'workspace' && sourceChat.workspaceId && sourceChat.workspacePath
        ? { workspaceId: sourceChat.workspaceId, workspacePath: sourceChat.workspacePath }
        : undefined
    )
  } else if (sourceScope === 'global') {
    freshChat = await dependencies.createGlobalChat()
  } else {
    if (!sourceChat.workspaceId || !sourceChat.workspacePath) {
      throw new Error('The welcome chat no longer has a workspace.')
    }
    freshChat = await dependencies.createWorkspaceChat(
      sourceChat.workspaceId,
      sourceChat.workspacePath
    )
  }

  const backgroundChat = await dependencies.saveChat(
    cloneWelcomeBackgroundChat(sourceChat, freshChat)
  )
  dependencies.recordChat(backgroundChat)
  for (const projectId of dependencies.projectIdsForChat(sourceChat.appChatId)) {
    dependencies.addChatToProject(projectId, backgroundChat.appChatId)
  }

  const backgroundRequest: QueuedRunRequest = {
    ...input.request,
    appRunId: dependencies.createRunId(),
    scope: chatScope(backgroundChat),
    chatRecord: backgroundChat,
    workspaceRecord:
      chatScope(backgroundChat) === 'global' ? undefined : input.request.workspaceRecord,
    // Grants are signed to one chat. The new thread obtains its own through
    // normal preflight instead of inheriting the welcome draft's authority.
    externalPathGrants: [],
    ...(input.scheduledRunAt ? { scheduledRunAt: input.scheduledRunAt } : {})
  }
  if (input.scheduledRunAt) {
    dependencies.queueRun(
      backgroundRequest,
      `Scheduled for ${dependencies.formatScheduledRunTime(input.scheduledRunAt)}.`
    )
  } else {
    dependencies.executeRun(backgroundRequest)
  }

  if (dependencies.currentDraft(sourceChat.appChatId) === input.target.prompt) {
    dependencies.clearDraft(sourceChat.appChatId)
  }
  dependencies.clearSubmittedContext(input.request, sourceChat.appChatId)
  dependencies.reapAbandonedChats(backgroundChat.appChatId)
  return backgroundChat
}
