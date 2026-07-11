import type { GeminiStreamAdapter } from './GeminiAdapter'
import type { ImageAttachment } from './imageAttachments'
import type {
  DiscordContextSelection,
  DiscordContextSnapshot
} from '../../../main/channels/DiscordContextService'
import type {
  ChatScope,
  ProviderId,
  WorkspaceRecord,
  ChatRecord,
  ChatWorkflowMode,
  ExternalPathGrant,
  GeminiWorktreeConfig,
  PermissionPresetId,
  ProviderRunReroute,
  RunWarning
} from '../../../main/store/types'

export interface QueuedRunRequest {
  appRunId?: string
  scope?: ChatScope
  provider: ProviderId
  providerReroute?: ProviderRunReroute
  prompt: string
  displayPrompt?: string
  overrideModel?: string
  existingPrompt?: string
  selectedModelType: string
  customModel: string
  approvalMode: string
  permissionPresetId?: PermissionPresetId
  workflowMode?: ChatWorkflowMode
  sessionTrust: boolean
  imageAttachments: ImageAttachment[]
  discordContextSelection?: DiscordContextSelection
  discordContextSnapshots?: DiscordContextSnapshot[]
  externalPathGrants?: ExternalPathGrant[]
  geminiWorktree?: GeminiWorktreeConfig
  codexNativeReview?: boolean
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  grokReasoningEffort?: string | null
  cursorReasoningEffort?: string | null
  cursorFastMode?: boolean | null
  scheduledTaskId?: string
  scheduledRunAt?: string
  workspaceRecord?: WorkspaceRecord
  chatRecord?: ChatRecord
  preserveComposer?: boolean
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  /**
   * A2 (1.0.3) — DM routing through the ensemble orchestrator. When
   * set on an ensemble chat dispatch, the resulting round contains
   * just this one participant. Ignored on solo chats. Held on the
   * request envelope (not chat-level state) because each dispatch is
   * an independent decision — the next send might be a full round.
   */
  dmTargetParticipantId?: string
  /** Provider-native slash dispatch (e.g. the Claude `/compact` run): compose
   * the prompt VERBATIM — no context injection or preamble prepends, which
   * would push the slash off the start and stop the provider executing it. */
  verbatimPrompt?: boolean
}

export interface RunRouteEventPayload {
  provider?: ProviderId
  appRunId?: string
  appChatId?: string
  data?: string
  error?: string
  code?: number | null
  stats?: any
}

export interface ActiveRunContext {
  runId: string
  chatId: string
  provider: ProviderId
  adapter: GeminiStreamAdapter
  warnings: RunWarning[]
  usageResetHints: Map<string, { resetAt?: string; resetText?: string }>
  errorCount: number
  toolCallsCount: number
  preSnapshot: any
  baseWorkspacePath: string | null
  workspacePath: string | null
  workspaceId?: string
  worktree?: GeminiWorktreeConfig
  checkpointingEnabled?: boolean
  startedAt: string | null
  diffUnavailable: boolean
  scheduledTaskId: string | null
}
