import {
  AppSettings,
  BlackboardEntry,
  WorkspaceRecord,
  ChatRecord,
  ChatKind,
  ChatListItem,
  EnsembleParticipant,
  FanoutWorktreeCandidate,
  PinnedMessageGroup,
  UsageRecord,
  TrustStatusResult,
  TrustWriteResult,
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
  GeminiSessionListResult,
  GeminiWorktreeLaunchOption,
  ProviderId,
  AgenticWorkspaceGrantProviderId,
  ChatScope,
  ChatWorkflowMode,
  ExternalPathGrant,
  ScheduledTask,
  WorkflowDefinition,
  ScheduledTaskCreateInput,
  ScheduledTaskLifecycleUpdate,
  WorkflowDefinitionCreateInput,
  WorkflowDefinitionRendererUpdate,
  GeminiMcpBridgeStatus,
  ProviderApiKeyStatus,
  GeminiAuthStatus,
  GeminiAuthProfileSummary,
  GeminiOAuthLoginStatus,
  ProviderCapabilityContract,
  ProviderAdapterDescriptor,
  RunQueueJob,
  RunQueueJobFilter,
  RunEventFilter,
  RunEventRecord,
  RunEventReplay,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  RunRecoveryFilter,
  RunRecoveryRecord,
  WorkspaceChangeFilter,
  WorkspaceChangeSet,
  WorkspaceActivitySnapshot,
  ProductCrashFilter,
  ProductCrashInput,
  ProductCrashRecord,
  AuditRetentionPurgeRequest,
  AuditRetentionPurgeResult,
  ProductAuditBundleExportRequest,
  ProductAuditBundleExportResult,
  ProductAuditBundleVerificationRequest,
  ProductAuditBundleVerificationResult,
  ProductDiagnosticsExportResult,
  ProductOperationsStatus,
  ProductChangelogSnapshot,
  RuntimeProfile,
  HandoffCard,
  HandoffCardFilter,
  RunAnalystRequest,
  RunAnalystSnapshot,
  CloseoutSummaryRequest,
  CloseoutSummarySnapshot,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  AgenticServiceId,
  EffectiveRunPermissions,
  AuditRunRecord,
  ProviderRunReroute,
  CapabilityLedgerSnapshot,
  EvidencePackRecord,
  RepoConventionIndexSnapshot,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  PermissionOverrides,
  PooledAgentStatsSummary,
  PromptCacheCapability,
  PromptCacheSettings,
  MemoryProposal,
  MemoryProposalPack
} from '../main/store/types'
import type { QuotaSnapshotHookSnapshot } from '../shared/quotaSnapshotHook'
import type { ArchivedChatExportFormat } from '../shared/archivedChatExport'
import type {
  LiveSteeringCancelRequest,
  LiveSteeringCancelResult,
  LiveSteeringInjectionRequest,
  LiveSteeringInjectionResult
} from '../shared/liveSteering'
import type {
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasSinceResult,
  HostSnapshot
} from '../shared/hostProtocol'
import type {
  HostLifecycleActionRequest,
  HostLifecycleActionResult,
  HostLifecycleSnapshot,
  HostLifecycleStatusResult
} from '../shared/hostLifecycle'
import type {
  LicenseNoticeKind,
  LicenseNoticeStatus,
  OpenLicenseNoticeResult
} from '../shared/licenseNotices'
import type { PendingEnsembleRosterPresetApply } from '../main/EnsembleRosterPresetApply'
import type { EnsembleUserRosterMutationInput } from '../main/EnsembleUserRosterMutation'
import type { EnsembleUserRosterMutationResult } from '../main/services/EnsembleOrchestrator'
import type { ChatUpdateAck, ChatUpdateDelivery } from '../shared/chatUpdateTransport'
import type { ChannelAgentIpcApi } from '../shared/collaboration/ChannelAgentIpc'
import type { ChannelIpcApi } from '../shared/collaboration/ChannelIpc'
import type { ChannelMemberIpcApi } from '../shared/collaboration/ChannelMemberIpc'
import type { HostCliToolId } from '../shared/hostCliToolCatalog'
import type { OfficeDocumentReadResult } from '../shared/office/officeFormats'
import type { OutlookConnectionStatus } from '../main/outlook/OutlookCredentialStore'
import type { OutlookSignInPoll, OutlookSignInStart } from '../main/ipc/outlookAuthHandlers'
import type { OfficeDocumentModel } from '../shared/office/officeModels'
import type {
  Project,
  ProjectGraphEdge,
  ProjectGraphEdgeOp,
  ProjectOp,
  ProjectReference,
  ProjectReferenceOp,
  ProjectWorkProfile
} from '../shared/projects'
import type {
  ProjectReferenceContextSelection,
  ResolvedProjectReferenceContext
} from '../shared/projectReferenceContext'
import type {
  ProjectReferenceExtract,
  ProjectReferenceExtractConsent
} from '../shared/projectReferenceExtract'
import type { ProjectStudioCompanionMeta, ProjectStudioKind } from '../shared/projectStudio'
import type { DispatchResult } from '../main/services/RunCoordinator'
import type {
  ProjectLegacyImportMarker,
  ProjectLegacyImportResult,
  ProjectRegistryMutationResult,
  ProjectRegistryState
} from '../main/store/ProjectRegistry'
import type {
  ChatPopoutRoundExpansionSnapshot,
  ChatPopoutScrollState
} from '../shared/chatPopoutTransfer'
import type {
  WorkflowRunSummary,
  WorkflowRunEvent,
  WorkflowRunEventFilter
} from '../main/WorkflowRunStore'
import type {
  RemoteWorkspaceCapability,
  RemoteWorkspaceEntry
} from '../main/RemoteWorkspaceAllowlist'
import type { UpdateStateSnapshot } from '../main/UpdateService'
import type { LocalServersSnapshot } from '../main/localServers/types'
import type { LaunchTargetsSnapshot } from '../main/launchTargets/types'
import type {
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginActivationSnapshot,
  TaskWraithPluginContributionSnapshot,
  TaskWraithPluginMcpPresetMaterializationResult,
  TaskWraithPluginSecretMutationResult,
  TaskWraithPluginSecretStatusSnapshot
} from '../shared/plugins/PluginTypes'
import type { ContextCompactionProgressEvent } from '../shared/contextCompaction'
import type { ParticipantWorkingTelemetryEvent } from '../shared/participantWorkingTelemetry'
import type {
  LaunchSnapshot,
  LaunchStartInput,
  LaunchStartResult,
  LaunchStopInput,
  LaunchStopResult
} from '../main/launch/types'
import type {
  ExtensionSecretMutationResult,
  ExtensionSecretRef,
  ExtensionSecretStatusSnapshot
} from '../main/ExtensionSecretStore'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus
} from '../main/antigravity/AntigravityGeminiApiSecretStore'
import type { AntigravityGeminiApiDiscoveryOutcome } from '../main/antigravity/AntigravityGeminiApiDiscoveryOutcome'
import type { NativeCapabilitySnapshot } from '../main/NativeCapabilities'
import type {
  NativeWindowCoordinatorPickResult,
  NativeWindowCoordinatorRendererEvent,
  NativeWindowCoordinatorRendererStatus
} from '../main/nativeWindow/NativeWindowCoordinator'
import type { GrokUsageSnapshot } from '../main/grok/GrokUsage'
import type { MistralQuotaSnapshot } from '../main/mistral/MistralQuotaStore'
import type { AppShellStatsSnapshot } from '../main/services/AppShellStatsService'

import type { SessionCheckpointRecord } from '../main/checkpoints/SessionCheckpoint'
import type {
  ConsumeInviteResult,
  CreateShareResult,
  HumanCollaborationMode,
  HumanCollaborationShare
} from '../main/collaboration/HumanCollaborationStore'
import type { HumanShareProjection } from '../main/collaboration/HumanShareProjection'
import type { ExternalContributionEntry } from '../main/collaboration/ExternalContributionQueueStore'
import type {
  HumanCollaborationAppendCommentInput,
  HumanCollaborationBeginHandshakeInput,
  HumanCollaborationBeginHandshakeResult,
  HumanCollaborationConfirmSasInput,
  HumanCollaborationConfirmSasResult,
  HumanCollaborationDisconnectInput,
  HumanCollaborationEncryptedFrame,
  HumanCollaborationSubscribeProjectionInput
} from '../shared/collaboration/HumanCollaborationProtocol'
import type {
  DiscordContextSelection,
  DiscordContextTargets,
  DiscordContextSnapshot,
  DiscordContextReadMetadata
} from '../main/channels/DiscordContextService'
import type {
  GitCiStatusSummary,
  GitPrReadiness,
  GitPrSummary,
  GitBranchInfo,
  GitRepositorySnapshot,
  GitWorktreeInfo,
  GitResult
} from '../main/services/GitService'
import type { GitWorkspaceStats } from '../main/services/GitWorkspaceStats'
import type { GitUnpushedCommitStack } from '../main/services/GitCommitStack'
import type {
  GitCommitGroupPullRequestResult,
  GitPullRequestLifecycleAction,
  GitPullRequestLifecycleResult,
  GitPullRequestWorkspaceSnapshot
} from '../main/services/GitPullRequestWorkflow'
import type { CommitFilePreviewResult } from '../main/DiffService'
import type { WorkProvenanceSnapshot } from '../shared/workProvenance'
import type {
  SimulatorCapabilityStatus,
  SimulatorDeviceInfo,
  SimulatorGestureResult,
  SimulatorHardwareButton,
  SimulatorHostActionResult,
  SimulatorInspectResult,
  SimulatorInteractionStatus,
  SimulatorRotateDirection,
  SimulatorScrollGesture,
  SimulatorTapGesture,
  SimulatorTypeGesture
} from '../shared/simulatorCanvas'
import type {
  SimulatorControlSetupResult,
  SimulatorControlSetupStatus
} from '../shared/simulatorControlSetup'
import type {
  GitSnapshotChangedPayload,
  GitSnapshotInvalidationReason
} from '../main/services/GitSnapshotPublisher'
import type {
  WorkLockProjectionQuery,
  WorkLockProjectionSnapshot,
  WorkLockProjectionUpdate,
  WorkLockRecoveryRequest,
  WorkLockRecoveryResult
} from '../shared/workLockProjection'
import type { WatchPollProgress } from '../shared/watchPrPollCycle'
import type { WatchPrNotifyPayload } from '../main/services/WatchPrPoller'
import type {
  FallbackPromotedSteerInput,
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerInput,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerInput,
  PromoteQueuedJobForSteerResult
} from '../main/services/RunLifecycleCoordinator'
import type {
  ExecutionGraphLayout,
  ExecutionGraphRevision
} from '../main/executionGraph/ExecutionGraphModel'
import type {
  ExecutionRunEvent,
  ExecutionRunProjection
} from '../main/executionGraph/ExecutionGraphRun'
import type { ExecutionGraphChangedNotice } from '../main/services/ExecutionGraphCoordinator'
import type {
  ExecutionGraphDiagnosticsSnapshot,
  ExecutionRunCancelStepCommand,
  ExecutionRunFormalizeCommand,
  ExecutionRunListFilter,
  ExecutionStackAppendCommand
} from '../main/ipc/executionGraphHandlers'

type GeminiCapabilityKind = 'mcp' | 'extensions' | 'skills' | 'agents'
type GeminiCapabilityFormat = 'json' | 'raw' | 'error'

interface GeminiCapabilityItem {
  id: string
  name: string
  status?: string
  detail?: string
  raw: string
}

interface GeminiCapabilitySection {
  kind: GeminiCapabilityKind
  command: string[]
  format: GeminiCapabilityFormat
  items: GeminiCapabilityItem[]
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
  error?: string
  parsingError?: string
  truncated?: boolean
}

interface GeminiCapabilitiesState {
  refreshedAt: string
  workspace?: string
  sections: Record<GeminiCapabilityKind, GeminiCapabilitySection>
}

type HostWeatherKind =
  | 'clear'
  | 'partly_cloudy'
  | 'cloudy'
  | 'overcast'
  | 'rain'
  | 'heavy_rain'
  | 'snow'
  | 'mist'
  | 'fog'
  | 'storm'
  | 'unknown'

interface HostWeatherState {
  kind: HostWeatherKind
  description: string
  temperatureC?: number
  location?: string
  isDay: boolean
  updatedAt: string
  source: 'open-meteo' | 'fallback'
  error?: string
  /** Coordinates rounded to ~11 km; drive the renderer's local astronomy. */
  latitude?: number
  longitude?: number
  cloudCoverPct?: number
  precipitationMmHr?: number
  snowfallCmHr?: number
  windSpeedKph?: number
  windGustKph?: number
  humidityPct?: number
}

/**
 * Human-review projection of append-only agent proposal evidence. It carries
 * catalogue metadata only; the presence of a local locator grants no host
 * filesystem access and a URL is not fetched by this API.
 */
interface ProjectReferenceProposalView {
  proposalId: string
  projectId: string
  candidate: {
    kind: ProjectReference['kind']
    locator: string
    title: string
  }
  reason?: string
  proposedAt: number
  provider?: ProviderId
  runId: string
}

type AgentApprovalAction =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'
  | 'useProviderNative'
  | 'useTaskWraithSubthread'
  | 'grantExternalPathRead'
  | 'grantExternalPathEdit'
  | 'declineExternalPath'

interface AgentRunPayload {
  provider: ProviderId
  providerReroute?: ProviderRunReroute
  scope?: 'workspace' | 'global'
  workspace?: string
  prompt: string
  usagePromptText?: string
  appRunId?: string
  appChatId?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  imagePaths?: string[]
  providerSessionId?: string | null
  externalPathGrants?: ExternalPathGrant[]
  projectReferenceContext?: ResolvedProjectReferenceContext
  sessionTrust?: boolean
  geminiWorktree?: GeminiWorktreeLaunchOption
  runtimeProfileId?: string
  runtimeWorktree?: {
    requested: boolean
    source: 'runtimeProfile' | 'composer' | 'ensembleLane' | 'ephemeralFleet'
    profileId?: string
    profileName?: string
    baseWorkspacePath?: string
    effectiveWorkspacePath?: string
    status: 'selection-required' | 'selected'
  }
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  effectivePermissions?: EffectiveRunPermissions
  effectivePermissionsSignature?: string
}

interface ComposerImageAttachment {
  id?: string
  path?: string
  name?: string
  kind?: 'file' | 'directory'
}

interface ComposerRunInput {
  chatId: string
  appRunId?: string
  provider?: ProviderId
  providerReroute?: ProviderRunReroute
  scope?: ChatScope
  workspace?: string
  userInput?: string
  prompt?: string
  selectedModelType?: string
  customModel?: string
  overrideModel?: string
  approvalMode?: string
  permissionPresetId?: PermissionPresetId | string
  workflowMode?: ChatWorkflowMode
  sessionTrust?: boolean
  attachments?: ComposerImageAttachment[]
  imageAttachments?: ComposerImageAttachment[]
  externalPathGrants?: ExternalPathGrant[]
  projectReferenceContextSelection?: ProjectReferenceContextSelection
  geminiWorktree?: GeminiWorktreeLaunchOption
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiFastMode?: boolean
  kimiReasoningEffort?: string | null
  kimiThinkingEnabled?: boolean
  grokReasoningEffort?: string | null
  museReasoningEffort?: string | null
  cursorReasoningEffort?: string | null
  cursorFastMode?: boolean | null
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  discordContextSnapshots?: DiscordContextSnapshot[]
  chatSnapshot?: ChatRecord
  /** Provider-native slash dispatch: compose the prompt verbatim (no
   * context/preamble blocks) so the leading slash stays executable. */
  verbatimPrompt?: boolean
}

interface ComposerRunMetadata {
  finalPrompt: string
  contextTurnsApplied: number
  applicationLog: string
  providerLabel: string
  requestedModel?: string
  approvalMode: string
  workflowMode: ChatWorkflowMode
  providerSessionId?: string | null
  geminiResumeSkippedReason?: string
  clearLinkedGeminiSession?: boolean
  providerMetadataPatch?: Record<string, unknown>
  codexHandoffApplied?: {
    handoffKey: string
    previousModel: string
    nextModel: string
    appliedAt: string
  }
  uiNoticeMessage?: string
  imagePaths: string[]
  discordContextReads?: DiscordContextReadMetadata[]
  projectReferenceContext?: ResolvedProjectReferenceContext
  planModeParsed?: boolean
  /** Per-run prompt-envelope snapshot; the renderer copies it onto the
   * ChatRun it appends. Content fields present only when raw-event storage
   * was on at compose time. */
  promptEnvelope?: import('../shared/instructions/InstructionTypes').PromptEnvelopeSnapshot
}

type ComposerRunPayload = AgentRunPayload & {
  composer: ComposerRunMetadata
}

interface AgentRunRoute {
  appRunId?: string
  appChatId?: string
}

type GeminiStreamPayload =
  | string
  | {
      provider?: ProviderId
      appRunId?: string
      appChatId?: string
      data?: string
      error?: string
      code?: number | null
    }

interface AgentApprovalRequest {
  id: string
  provider: ProviderId
  appRunId?: string
  appChatId?: string
  method: string
  title: string
  body: string
  preview?: any
  params?: any
  actions: AgentApprovalAction[]
}

type CopyChatMarkdownTranscriptResult =
  | {
      ok: true
      messageCount: number
      charCount: number
      omissions: string[]
    }
  | {
      ok: false
      reason: 'not-found' | 'archived' | 'empty' | 'too-large' | 'unauthorized'
      messageCount?: number
      charCount?: number
      omissions?: string[]
    }

type CopyChatMessagesResult = CopyChatMarkdownTranscriptResult

type SidebarPathActionResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; error?: string }

interface SpellcheckContextResult {
  x: number
  y: number
  misspelledWord: string
  dictionarySuggestions: string[]
  createdAt: number
}

interface SpellcheckContextMenuPayload {
  point: {
    x: number
    y: number
  }
  spellcheckContext: SpellcheckContextResult | null
}

interface WorkspaceFileListOptions {
  path?: string
  query?: string
  includeDirectories?: boolean
  limit?: number
}

interface WorkspaceFileListResult {
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

type StickyAppWatchWindowMeta = Readonly<{
  title: string
  bundleID: string
  applicationName: string
}>
type StickyAppWatchSnapshot = Readonly<{
  chatId: string
  windowMeta: StickyAppWatchWindowMeta
  attachedAt: string
  stashedAt: string
  wasStreaming: boolean
}>
type StickyAppWatchStashInput = Readonly<{
  chatId: string
  windowMeta: StickyAppWatchWindowMeta
  attachedAt: string
  wasStreaming: boolean
}>

declare global {
  interface Window {
    api: {
      hostPlatform: NodeJS.Platform
      getRuntimeVersions: () => NodeJS.ProcessVersions
      channels: ChannelIpcApi
      channelAgents: ChannelAgentIpcApi
      channelMemberships: ChannelMemberIpcApi
      selectWorkspace: () => Promise<WorkspaceRecord | null>
      selectImageFiles: () => Promise<string[]>
      // Resolves a dragged/pasted File's absolute path (Electron 32+ removed
      // `File.path`; webUtils.getPathForFile is the replacement).
      getPathForFile: (file: File) => string
      saveClipboardImageAttachment: (appChatId: string) => Promise<string[]>
      readImagePreview: (path: string) => Promise<string | null>
      transcribeComposerAudio: (input: { localeIdentifier?: string; wav: ArrayBuffer }) => Promise<
        | {
            ok: true
            text: string
            segments: Array<{ text: string; startMs: number; endMs: number; confidence: number }>
            localeIdentifier: string
            onDevice: boolean
          }
        | { ok: false; error: string }
      >
      imageGenerationGetStatus: () => Promise<{
        enabled: boolean
        defaultProvider: 'openai' | 'xai'
        encryptionAvailable: boolean
        configured: { openai: boolean; xai: boolean }
      }>
      imageGenerationSetEnabled: (input: {
        enabled: boolean
        provider?: 'openai' | 'xai'
      }) => Promise<{ ok: boolean; error?: string }>
      imageGenerationSetKey: (input: {
        provider: 'openai' | 'xai'
        key: string
      }) => Promise<{ ok: boolean; error?: string }>
      imageGenerationClearKey: (input: {
        provider: 'openai' | 'xai'
      }) => Promise<{ ok: boolean; error?: string }>
      getLastSpellcheckContext: (point: {
        x: number
        y: number
      }) => Promise<SpellcheckContextResult | null>
      replaceMisspelling: (payload: {
        suggestion: string
        point: { x: number; y: number }
      }) => Promise<{ ok: boolean; reason?: string }>
      addWordToSpellCheckerDictionary: (payload: {
        point: { x: number; y: number }
      }) => Promise<{ ok: boolean; reason?: string }>
      onSpellcheckContextMenu: (
        callback: (payload: SpellcheckContextMenuPayload) => void
      ) => () => void
      sidebarShowWorkspaceInFinder: (workspaceId: string) => Promise<SidebarPathActionResult>
      sidebarCopyWorkspaceDirectory: (workspaceId: string) => Promise<SidebarPathActionResult>
      sidebarShowChatWorkspaceInFinder: (chatId: string) => Promise<SidebarPathActionResult>
      sidebarCopyChatWorkingDirectory: (chatId: string) => Promise<SidebarPathActionResult>
      sidebarCopyChatTranscriptPath: (chatId: string) => Promise<SidebarPathActionResult>
      copyChatMarkdownTranscript: (chatId: string) => Promise<CopyChatMarkdownTranscriptResult>
      copyChatMessages: (chatId: string) => Promise<CopyChatMessagesResult>
      selectExternalPathGrant: (
        access?: 'read' | 'write',
        provider?: string
      ) => Promise<ExternalPathGrant | null>
      /**
       * 1.0.5-EW42a — Proactive external-path grant from composer
       * workspace switcher. Opens an OS folder picker, issues one
       * grant per unique participant-provider on the chat, and
       * persists to the chat's metadata. Broadcasts chat-updated
       * so the ExternalPathAboveRow banner appears immediately.
       */
      pickAndPersistExternalPathGrant: (payload: {
        chatId: string
        access?: 'read' | 'write'
        // 1.0.6-EW69 — optional explicit path skips the OS dialog
        // (attach a known workspace as a secondary).
        path?: string
        // Defer metadata persistence until the user confirms grants in
        // the composer preflight modal.
        deferPersist?: boolean
        // Opaque, short-lived proof returned by a native deferred picker.
        // Required to confirm an unregistered external path.
        selectionReceipt?: string
        // Folder attachment flow: folder-only picker plus automatic read grant
        // when the selected reference is outside the chat workspace.
        purpose?: 'attachment'
      }) => Promise<
        | {
            ok: true
            grants: ExternalPathGrant[]
            path: string
            selectionReceipt?: string
          }
        | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }
        | { ok: false; reason: 'missing-path'; path: string }
      >
      repairStaleExternalPathGrants: (payload: { chatId: string }) => Promise<
        | {
            ok: true
            repairedPaths: string[]
            remainingGaps: Array<{
              path: string
              access: 'read' | 'write'
              missingProviders: ProviderId[]
            }>
          }
        | { ok: false; reason: 'no-chat' | 'no-provider' }
      >
      revokeExternalPathGrants: (payload: {
        chatId: string
        grantIds: string[]
      }) => Promise<
        | { ok: true; grants: ExternalPathGrant[]; revokedGrantIds: string[] }
        | { ok: false; reason: 'no-chat' | 'no-grants' }
      >
      probeExternalPath: (
        absolutePath: string
      ) => Promise<{ isRepo: boolean; repoRoot: string; branch?: string } | null>
      runGemini: (
        workspace: string,
        prompt: string,
        model: string,
        approvalMode: string,
        sessionTrust?: boolean,
        imagePaths?: string[],
        resumeSessionId?: string | null,
        worktree?: GeminiWorktreeLaunchOption,
        route?: AgentRunRoute | null
      ) => Promise<void>
      cancelGemini: (runId?: string) => Promise<void>
      composeRun: (input: ComposerRunInput) => Promise<ComposerRunPayload>
      runAgent: (payload: AgentRunPayload) => Promise<DispatchResult>
      cancelAgentRun: (provider?: ProviderId, runId?: string) => Promise<void>
      getAgentStatus: (provider: ProviderId, options?: { refreshAuth?: boolean }) => Promise<any>
      getProviderCapabilities: (
        provider: ProviderId,
        workspace?: string,
        approvalMode?: string
      ) => Promise<ProviderCapabilityContract>
      getProviderAdapters: () => Promise<ProviderAdapterDescriptor[]>
      getConfiguredProviderSnapshot: () => Promise<{
        ready: boolean
        providerIds: ProviderId[]
        modelsByProvider?: Partial<Record<ProviderId, Array<{ id: string; label: string }>>>
      }>
      // 1.0.5-EW35 — Currency sub-slice (c): live FX rate snapshot.
      getFxRates: () => Promise<{
        rates: { USD: 1; GBP: number; EUR: number }
        fetchedAt: string
        source: 'live' | 'cached' | 'fallback'
        errorMessage?: string
      }>
      refreshFxRates: (force?: boolean) => Promise<{
        rates: { USD: 1; GBP: number; EUR: number }
        fetchedAt: string
        source: 'live' | 'cached' | 'fallback'
        errorMessage?: string
      }>
      // 1.0.5-EW38 — Per-provider rate snapshot (baseline + probe).
      // Loose typing for the renderer; concrete shapes live in
      // src/main/services/ProviderRateService.ts.
      getProviderRates: () => Promise<unknown>
      probeProviderRates: () => Promise<unknown>
      getAgentModels: (provider: ProviderId) => Promise<
        Array<{
          id: string
          label?: string
          description?: string
          isDefault?: boolean
          disabled?: boolean
          disabledReason?: string
          supportedReasoningEfforts?: Array<{
            reasoningEffort: string
            description?: string
            disabled?: boolean
            disabledReason?: string
          }>
          defaultReasoningEffort?: string | null
          additionalSpeedTiers?: string[]
        }>
      >
      getAgentRateLimits: (provider: ProviderId, options?: { force?: boolean }) => Promise<any>
      importCodexUsageCredential: (filePath?: string) => Promise<any>
      clearCodexUsageCredential: () => Promise<boolean>
      getCodexUsageSnapshot: (options?: { force?: boolean }) => Promise<any>
      getExternalUsage: (options?: { force?: boolean }) => Promise<UsageRecord[]>
      getQuotaSnapshotHook: () => Promise<QuotaSnapshotHookSnapshot[]>
      probeGrokUsage: () => Promise<GrokUsageSnapshot>
      /** Locally accumulated Mistral burn estimate; null until the seat has run. */
      getMistralQuotaEstimate: () => Promise<MistralQuotaSnapshot | null>
      setMistralPlan: (plan: string) => Promise<MistralQuotaSnapshot | null>
      setMistralQuotaAnchor: (reading: {
        allowanceUsd: number
        spentUsd: number
        cycleResetsAt?: string
        declared?: { allowance: number; spent: number; currency: string }
      }) => Promise<MistralQuotaSnapshot | null>
      clearMistralQuotaAnchor: () => Promise<MistralQuotaSnapshot | null>
      getMistralAdminKeyStatus: () => Promise<{
        configured: boolean
        encryptionAvailable: boolean
        updatedAt?: string
      } | null>
      setMistralAdminKey: (apiKey: string) => Promise<{ ok: boolean; error?: string }>
      clearMistralAdminKey: () => Promise<{ ok: boolean; error?: string }>
      refreshMistralAdminUsage: () => Promise<{
        ok: boolean
        failure?: string
        snapshot?: MistralQuotaSnapshot | null
      }>
      gitSnapshot: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitUnpushedCommits: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<GitResult<GitUnpushedCommitStack>>
      gitWorkspaceStats: (payload: {
        workspacePath?: string
        repoPath?: string
        worktreePath?: string
        chatId?: string
      }) => Promise<GitResult<GitWorkspaceStats>>
      getCommitFilePreview: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        commitHash: string
      }) => Promise<CommitFilePreviewResult>
      gitWorkProvenance: (payload: {
        workspacePath?: string
        repoPath?: string
        worktreePath?: string
        chatId?: string
      }) => Promise<GitResult<WorkProvenanceSnapshot>>
      gitSubscribeSnapshot: (
        payload: {
          workspacePath?: string
          repoPath?: string
          chatId?: string
        },
        callback: (payload: GitSnapshotChangedPayload) => void
      ) => () => void
      gitInvalidateSnapshot: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        reason?: GitSnapshotInvalidationReason
      }) => Promise<{ ok: true } | { ok: false; error: string }>
      gitStage: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        paths?: string[]
        all?: boolean
        update?: boolean
        patch?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitUnstage: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        paths?: string[]
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitCommit: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        message: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitPush: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        setUpstream?: boolean
        remote?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      'git:list-branches': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<{
        ok: boolean
        branches: GitBranchInfo[]
        currentBranch?: string
        error?: string
      }>
      'git:checkout-branch': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        branch?: string
      }) => Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }>
      'git:create-branch': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        branch?: string
        from?: string
      }) => Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }>
      'git:list-worktrees': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<{ ok: boolean; worktrees: GitWorktreeInfo[]; error?: string }>
      'git:create-worktree': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        name?: string
        branch?: string
        path?: string
      }) => Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }>
      'git:remove-worktree': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        path?: string
        force?: boolean
      }) => Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }>
      'git:select-worktree': (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        path?: string
      }) => Promise<{ ok: boolean; snapshot?: GitRepositorySnapshot; error?: string }>
      listFanoutCandidates: (chatId: string) => Promise<FanoutWorktreeCandidate[]>
      fanoutCandidateDiff: (
        chatId: string,
        candidateId: string
      ) => Promise<import('../main/ipc/fanoutCandidateHandlers').FanoutCandidateWorkspaceDiff>
      promoteFanoutCandidate: (
        chatId: string,
        candidateId: string
      ) => Promise<import('../main/services/FanoutCandidateService').CandidateResolution>
      discardFanoutCandidate: (
        chatId: string,
        candidateId: string
      ) => Promise<import('../main/services/FanoutCandidateService').CandidateResolution>
      githubPrStatus: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<GitResult<GitPrSummary>>
      githubPrWorkspace: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<GitResult<GitPullRequestWorkspaceSnapshot>>
      githubCreateCommitGroupPr: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        commits: string[]
        branch: string
        baseBranch: string
        title: string
        body?: string
        draft?: boolean
        openInBrowser?: boolean
      }) => Promise<GitResult<GitCommitGroupPullRequestResult>>
      githubManagePr: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        pullRequestNumber: number
        lifecycle: GitPullRequestLifecycleAction
      }) => Promise<GitResult<GitPullRequestLifecycleResult>>
      githubPrReadiness: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
      }) => Promise<GitResult<GitPrReadiness>>
      githubCiStatus: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        pr?: string | number
        branch?: string
        commitSha?: string
        includeFailedLogs?: boolean
        maxRuns?: number
        maxFailedLogs?: number
        maxLogChars?: number
      }) => Promise<GitResult<GitCiStatusSummary>>
      githubSetWatchedPr: (payload: {
        chatId: string
        watchedPr: { workspacePath: string; owner: string; repo: string; prNumber: number } | null
      }) => Promise<{ ok: true } | { ok: false; error: string }>
      setChatGitWorkflow: (payload: {
        chatId: string
        gitWorkflow: { state: string; prNumber?: number; prUrl?: string } | null
      }) => Promise<{ ok: true } | { ok: false; error: string }>
      githubWatchPrNotifyAck: (payload: {
        chatId: string
        signature: string
        ok: boolean
        error?: string
      }) => Promise<{ ok: true }>
      onGitHubWatchPrNotify: (callback: (payload: WatchPrNotifyPayload) => void) => () => void
      onGitHubWatchPrProgress: (callback: (progress: WatchPollProgress) => void) => () => void
      createGithubPr: (payload: {
        workspacePath?: string
        repoPath?: string
        chatId?: string
        title?: string
        body?: string
        draft?: boolean
        openInBrowser?: boolean
      }) => Promise<{ ok: boolean; url?: string; error?: string; stderr?: string }>
      getClaudeAuthStatus: () => Promise<ProviderApiKeyStatus>
      storeClaudeApiKey: (key: string) => Promise<{
        stored: boolean
        encryptionAvailable: boolean
        error?: string
      }>
      clearClaudeApiKey: () => Promise<void>
      triggerClaudeLogin: () => Promise<{ ok: boolean; code?: number | null; error?: string }>
      getKimiAuthStatus: () => Promise<ProviderApiKeyStatus>
      storeKimiApiKey: (key: string) => Promise<{
        stored: boolean
        encryptionAvailable: boolean
        error?: string
      }>
      clearKimiApiKey: () => Promise<void>
      upgradeKimiCli: () => Promise<{ ok: boolean; error?: string }>
      getGeminiAuthStatus: () => Promise<GeminiAuthStatus>
      listGeminiAuthProfiles: () => Promise<GeminiAuthProfileSummary[]>
      saveGeminiAuthProfile: (profile: {
        id?: string
        label?: string
        kind: 'api-key' | 'vertex-ai' | 'google-oauth'
        apiKey?: string
        vertexProject?: string
        vertexLocation?: string
        makeDefault?: boolean
      }) => Promise<GeminiAuthProfileSummary>
      deleteGeminiAuthProfile: (profileId: string) => Promise<boolean>
      setDefaultGeminiAuthProfile: (
        profileId: string | null
      ) => Promise<GeminiAuthProfileSummary | null>
      startGeminiOAuthLogin: (input?: {
        id?: string
        profileId?: string
        label?: string
        makeDefault?: boolean
      }) => Promise<GeminiOAuthLoginStatus>
      getGeminiOAuthLoginStatus: (
        profileId?: string | null
      ) => Promise<GeminiOAuthLoginStatus | null>
      cancelGeminiOAuthLogin: (profileId?: string | null) => Promise<GeminiOAuthLoginStatus | null>
      getAgentMcpStatus: (provider: ProviderId) => Promise<any>
      listAgentThreads: (provider: ProviderId, params?: any) => Promise<any>
      'fork:get-capability': (provider: ProviderId) => Promise<any>
      forkAgentThread: (provider: ProviderId, threadId: string, params?: any) => Promise<any>
      rollbackAgentThread: (
        provider: ProviderId,
        threadId: string,
        numTurns?: number
      ) => Promise<any>
      startAgentReview: (provider: ProviderId, threadId: string, params?: any) => Promise<any>
      respondAgentApproval: (
        requestId: string,
        action: AgentApprovalAction,
        intentNote?: string
      ) => Promise<
        | boolean
        | {
            ok: boolean
            resolvedAction: AgentApprovalAction
            decisionSource: 'user' | 'system'
            reason?: string
            message?: string
          }
      >
      writeGeminiInput: (data: string) => Promise<boolean>
      getDiff: (
        workspace: string | { workspacePath?: string; repoPath?: string; chatId?: string }
      ) => Promise<{
        type: 'not_repo' | 'no_changes' | 'changes' | 'error'
        text?: string
        statusText?: string
        diffText?: string
        summaries?: any[]
      }>
      openWorkspacePopout: (
        input:
          | {
              kind: 'file-editor' | 'diff-studio' | 'workbench'
              workspacePath: string
              chatId?: string
              targetPath?: string
              targetView?: 'editor' | 'diff'
            }
          | {
              kind: 'chat'
              chatId: string
              workspacePath?: string
            }
      ) => Promise<{ ok: true }>
      dockSideChatPopout: (input: {
        chatId: string
        presentation?: 'split' | 'drawer'
        draft?: string
        scrollState?: ChatPopoutScrollState
        roundExpansion?: ChatPopoutRoundExpansionSnapshot
      }) => Promise<{ ok: true }>
      quitApp: () => Promise<boolean>
      listWorkspaceFiles: (workspace: string) => Promise<WorkspaceFileEntry[]>
      listWorkspaceFilesForEditor: (
        workspace: string,
        options?: WorkspaceFileListOptions
      ) => Promise<WorkspaceFileListResult>
      readWorkspaceFile: (workspace: string, path: string) => Promise<WorkspaceFileReadResult>
      writeWorkspaceFile: (
        workspace: string,
        path: string,
        content: string,
        baseEtag?: string | null
      ) => Promise<WorkspaceFileReadResult>
      deleteWorkspaceFile: (
        workspace: string,
        path: string,
        baseEtag?: string | null
      ) => Promise<{ path: string; changeSet?: WorkspaceChangeSet }>
      readOfficeDocument: (workspace: string, path: string) => Promise<OfficeDocumentReadResult>
      writeOfficeDocument: (
        workspace: string,
        path: string,
        model: OfficeDocumentModel,
        baseEtag?: string | null
      ) => Promise<OfficeDocumentReadResult>
      deleteOfficeDocument: (
        workspace: string,
        path: string,
        baseEtag?: string | null
      ) => Promise<{ path: string; changeSet?: WorkspaceChangeSet }>
      getOutlookStatus: () => Promise<OutlookConnectionStatus>
      startOutlookSignIn: (payload: {
        clientId: string
        tenant?: string
        scopeMode?: 'read' | 'write'
      }) => Promise<OutlookSignInStart>
      pollOutlookSignIn: () => Promise<OutlookSignInPoll>
      disconnectOutlook: () => Promise<OutlookConnectionStatus>
      importOfficeDocument: (
        workspacePath: string,
        filePath: string,
        contentBase64: string
      ) => Promise<OfficeDocumentReadResult>
      revealOfficeDocument: (target: {
        workspacePath?: string
        filePath?: string
        chatId?: string
        path?: string
      }) => Promise<{ ok: boolean }>
      openOfficeDocumentInDefaultApp: (target: {
        workspacePath?: string
        filePath?: string
        chatId?: string
        path?: string
      }) => Promise<{ ok: boolean; error?: string }>
      readExternalOfficeDocument: (
        chatId: string,
        path: string
      ) => Promise<OfficeDocumentReadResult>
      writeExternalOfficeDocument: (
        chatId: string,
        path: string,
        model: OfficeDocumentModel,
        baseEtag?: string | null
      ) => Promise<OfficeDocumentReadResult>
      captureSnapshot: (workspace: string) => Promise<any>
      computeRunDiff: (
        runId: string,
        preSnapshot: any,
        postSnapshot: any,
        changeContext?: any
      ) => Promise<any>
      getWorkspaceChangeSets: (filter?: WorkspaceChangeFilter) => Promise<WorkspaceChangeSet[]>
      getGeminiVersion: () => Promise<string>
      getGeminiCapabilities: (workspace?: string) => Promise<GeminiCapabilitiesState>
      getGeminiMcpBridgeStatus: () => Promise<GeminiMcpBridgeStatus>
      installGeminiMcpBridge: () => Promise<GeminiMcpBridgeStatus>
      setGeminiMcpBridgeEnabled: (enabled: boolean) => Promise<GeminiMcpBridgeStatus>
      runApprovedHostCommand: (requestId: string) => Promise<boolean>
      listGeminiSessions: () => Promise<GeminiSessionListResult>
      getHostWeather: () => Promise<HostWeatherState>
      /**
       * Host Arc 4.3a — Desktop Host snapshot projection.
       * Authoritative declaration of the `host-projection:snapshot` channel.
       * Failure is a VALUE (`ok: false`), never a thrown Error: an Error loses
       * its type crossing IPC. The renderer adapter converts it to a rejection
       * so an unreachable Host is reported, never rendered as an empty world.
       */
      hostProjectionSnapshot: () => Promise<
        { ok: true; snapshot: HostSnapshot } | { ok: false; error: string }
      >
      /** Ordered Host delta catch-up; full-resnapshot-required is a value. */
      hostProjectionDeltasSince: (
        position: HostCursorPosition
      ) => Promise<{ ok: true; result: HostDeltasSinceResult } | { ok: false; error: string }>
      /**
       * Host Arc 4.3b — submit a HostCommand over the same main-owned client.
       * Returns the initial receipt; pending must not be treated as success.
       * `approval.decide` is submitted here as a command name (TUI 4.2b parity).
       */
      hostProjectionCommandSubmit: (
        command: HostCommand
      ) => Promise<{ ok: true; receipt: HostCommandReceipt } | { ok: false; error: string }>
      /**
       * Host Arc 4.3b — durable receipt lookup by commandId.
       */
      hostProjectionReceiptLookup: (params: {
        commandId: string
      }) => Promise<{ ok: true; receipt: HostCommandReceipt } | { ok: false; error: string }>
      /** Visible lifecycle of Host inside the current TaskWraith process. */
      hostLifecycleStatus: () => Promise<HostLifecycleStatusResult>
      hostLifecycleSet: (request: HostLifecycleActionRequest) => Promise<HostLifecycleActionResult>
      onHostLifecycleChanged: (
        handler: (snapshot: HostLifecycleSnapshot) => void
      ) => () => void
      setAppearanceMode: (
        payload: { mode?: string; reduceTransparency?: boolean } | string
      ) => Promise<boolean>
      getNativeCapabilities: () => Promise<NativeCapabilitySnapshot>

      checkTrust: (workspacePath: string) => Promise<TrustStatusResult>

      trustWorkspace: (workspacePath: string) => Promise<TrustWriteResult>

      agenticYoloGet: () => Promise<{ enabled: boolean; enabledAt: string | null }>
      agenticYoloSet: (enabled: boolean) => Promise<{ enabled: boolean; enabledAt: string | null }>
      onAgenticYoloState: (
        handler: (state: { enabled: boolean; enabledAt: string | null }) => void
      ) => () => void
      trustedSessionGet: (scope: {
        chatId: string
        provider: ProviderId
        workspacePath?: string | null
        ensembleParticipantId?: string | null
        ensembleLaneId?: string | null
        runtimeProfileId?: string | null
      }) => Promise<{
        enabled: boolean
        grant?: {
          chatId: string
          provider: ProviderId
          workspacePath?: string | null
          ensembleParticipantId?: string | null
          ensembleLaneId?: string | null
          runtimeProfileId?: string | null
          grantedAt: string
        }
        error?: string
      }>
      trustedSessionSet: (
        scope: {
          chatId: string
          provider: ProviderId
          workspacePath?: string | null
          ensembleParticipantId?: string | null
          ensembleLaneId?: string | null
          runtimeProfileId?: string | null
        },
        enabled: boolean
      ) => Promise<{
        enabled: boolean
        grant?: {
          chatId: string
          provider: ProviderId
          workspacePath?: string | null
          ensembleParticipantId?: string | null
          ensembleLaneId?: string | null
          runtimeProfileId?: string | null
          grantedAt: string
        }
        error?: string
      }>
      canvas: {
        openWindow: (args: { url: string; originAllowlist?: string[]; chatId: string }) => Promise<
          | {
              ok: true
              canvasId: string
              url: string
              title: string
              viewport: { width: number; height: number }
            }
          | { ok: false; error: string }
        >
        openEmbedded: (args: {
          url: string
          originAllowlist?: string[]
          chatId: string
          presentation?: 'dock'
        }) => Promise<
          | {
              ok: true
              canvasId: string
              url: string
              title: string
              viewport: { width: number; height: number }
            }
          | { ok: false; error: string }
        >
        adoptEmbedded: (args: { chatId: string; canvasId: string }) => Promise<
          | {
              ok: true
              canvasId: string
              driver: string
              url: string
              title: string
              viewport: { width: number; height: number }
              status: string
              presentation: 'dock'
              isLoading?: boolean
              canGoBack?: boolean
              canGoForward?: boolean
            }
          | { ok: false; error: string }
        >
        openSketchWindow: (args: { chatId: string }) => Promise<
          | {
              ok: true
              canvasId: string
              url: string
              title: string
              viewport: { width: number; height: number }
            }
          | { ok: false; error: string }
        >
        openSketchEmbedded: (args: { chatId: string; presentation?: 'dock' }) => Promise<
          | {
              ok: true
              canvasId: string
              url: string
              title: string
              viewport: { width: number; height: number }
            }
          | { ok: false; error: string }
        >
        listForChat: (chatId: string) => Promise<unknown[]>
        /**
         * Structured chart document for a chat-owned chart canvas (TelemetryPane).
         * Null when missing / not a chart / not owned. No pixels.
         */
        chartDocument: (chatId: string, canvasId: string) => Promise<unknown | null>
        closeForChat: (chatId: string, canvasId: string) => Promise<void>
        clearBrowserProfile: () => Promise<
          { ok: true; closedSurfaceCount: number } | { ok: false; error: string }
        >
        navigateForChat: (
          chatId: string,
          canvasId: string,
          input: { url?: string; action?: 'back' | 'forward' | 'reload' | 'stop' }
        ) => Promise<
          | {
              ok: true
              url: string
              title: string
              isLoading: boolean
              canGoBack: boolean
              canGoForward: boolean
            }
          | { ok: false; error: string }
        >
        setBounds: (
          canvasId: string,
          rect: { x: number; y: number; width: number; height: number }
        ) => Promise<void>
        setVisible: (canvasId: string, visible: boolean) => Promise<void>
        close: (canvasId: string) => Promise<void>
        list: () => Promise<unknown[]>
        onEvent: (handler: (event: unknown) => void) => () => void
        onNavState: (handler: (payload: unknown) => void) => () => void
      }
      meshCanvas: {
        listForChat: (chatId: string) => Promise<unknown[]>
        view: (chatId: string, sceneId: string) => Promise<unknown | null>
        importUserModel: (chatId: string) => Promise<{ canceled: boolean; scene?: unknown }>
        importUserScenePackage: (chatId: string) => Promise<{ canceled: boolean; scene?: unknown }>
        closePresentation: (chatId: string, sceneId: string) => Promise<unknown>
        deleteScene: (chatId: string, sceneId: string) => Promise<unknown>
        onEvent: (handler: (event: unknown) => void) => () => void
      }
      simulatorCanvas: {
        status: () => Promise<{ ok: true; status: SimulatorCapabilityStatus }>
        claimControl: (chatId: string) => Promise<unknown>
        releaseControl: (chatId: string) => Promise<unknown>
        session: (chatId: string) => Promise<unknown>
        openApp: (chatId: string) => Promise<SimulatorHostActionResult>
        listDevices: () => Promise<{
          ok: boolean
          error?: string
          devices?: SimulatorDeviceInfo[]
          status?: SimulatorCapabilityStatus
        }>
        boot: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
        pickApp: (
          chatId: string
        ) => Promise<{ ok: boolean; canceled: boolean; appPath?: string; error?: string }>
        install: (
          chatId: string,
          udid: string,
          appPath: string
        ) => Promise<SimulatorHostActionResult>
        launch: (
          chatId: string,
          udid: string,
          bundleId: string
        ) => Promise<SimulatorHostActionResult>
        terminate: (
          chatId: string,
          udid: string,
          bundleId?: string
        ) => Promise<SimulatorHostActionResult>
        screenshot: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
        interactionStatus: (chatId: string) => Promise<SimulatorInteractionStatus>
        tap: (payload: SimulatorTapGesture) => Promise<SimulatorGestureResult>
        type: (payload: SimulatorTypeGesture) => Promise<SimulatorGestureResult>
        scroll: (payload: SimulatorScrollGesture) => Promise<SimulatorGestureResult>
        inspect: (chatId: string, udid: string) => Promise<SimulatorInspectResult>
        button: (
          chatId: string,
          udid: string,
          button: SimulatorHardwareButton
        ) => Promise<{ ok: boolean; error?: string }>
        rotate: (
          chatId: string,
          udid: string,
          direction: SimulatorRotateDirection
        ) => Promise<{ ok: boolean; error?: string }>
        clipboardPush: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
        clipboardPull: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
        onEvent: (handler: (event: unknown) => void) => () => void
      }
      simulatorControl: {
        status: () => Promise<SimulatorControlSetupStatus>
        setup: () => Promise<SimulatorControlSetupResult>
      }
      onAgentQuestionRequested: (
        handler: (request: {
          questionId: string
          appRunId: string
          appChatId: string
          provider?: string | null
          question: string
          options?: string[]
          context?: string
        }) => void
      ) => () => void
      onAgentQuestionCancelled: (
        handler: (info: { questionId: string; appChatId: string; reason: string }) => void
      ) => () => void
      answerAgentQuestion: (payload: {
        questionId: string
        answer: string
        isCustom?: boolean
        appChatId?: string
        appRunId?: string
        workspaceId?: string | null
      }) => Promise<{ ok: boolean; error?: string }>
      cancelAgentQuestion: (payload: {
        questionId: string
        reason?: string
        appChatId?: string
        appRunId?: string
        workspaceId?: string | null
      }) => Promise<{ ok: boolean; error?: string }>
      answerEnsemblePoll: (payload: {
        appChatId: string
        pollId: string
        choice: string
      }) => Promise<{ ok: boolean; error?: string }>
      threadMessageTargets: (fromChatId: string) => Promise<
        Array<{
          chatId: string
          title: string
          workspaceId: string | null
          crossWorkspace: boolean
        }>
      >
      threadMessageInbox: (chatId: string) => Promise<{
        summary: {
          toChatId: string
          pendingCount: number
          hasWakeRequest: boolean
          oldestPendingAt: number | null
          senders: string[]
        }
        pending: Array<{
          id: string
          fromChatId: string
          fromChatTitle: string
          origin: 'user' | 'agent'
          body: string
          requestedDelivery: 'queue' | 'wake'
          createdAt: number
          truncated?: boolean
        }>
      }>
      sendThreadMessage: (payload: {
        fromChatId: string
        toChatId: string
        message: string
        wake?: boolean
        idempotencyKey?: string
      }) => Promise<{ ok: boolean; outcome?: string; messageId?: string; error?: string }>
      openExternalOrPath: (href: string) => Promise<{ ok: boolean; error?: string }>
      getLicenseNoticeStatus: () => Promise<LicenseNoticeStatus>
      openLicenseNotice: (kind: LicenseNoticeKind) => Promise<OpenLicenseNoticeResult>
      revealPathInFinder: (path: string) => Promise<{ ok: boolean; error?: string }>
      openMediaAssetInStudio: (
        sha256: string,
        mimeType: string
      ) => Promise<{ ok: boolean; error?: string }>
      revealMediaAsset: (sha256: string, mimeType: string) => Promise<{ ok: boolean }>
      getMediaAssetPath: (sha256: string, mimeType: string) => Promise<string | null>
      saveMediaAssetAs: (
        sha256: string,
        mimeType: string,
        suggestedName: string
      ) => Promise<{ ok: boolean; canceled: boolean }>
      copyMediaAssetImage: (sha256: string, mimeType: string) => Promise<{ ok: boolean }>
      getFaviconForUrl: (url: string) => Promise<
        | {
            ok: true
            origin: string
            host: string
            iconUrl: string
            dataUrl: string
            contentType: string
            source: 'cache' | 'network'
            title?: string
          }
        | { ok: false; origin?: string; host?: string; blocked?: boolean; error: string }
      >
      openProviderLoginTerminal: (provider: ProviderId) => Promise<{
        ok: boolean
        error?: string
        scope?: 'user-owned-provider-setup'
        managedRunReady?: false
        notice?: string
      }>
      openProviderLogoutTerminal: (provider: ProviderId) => Promise<{
        ok: boolean
        error?: string
        scope?: 'user-owned-provider-setup'
        managedRunReady?: false
        notice?: string
      }>
      openProviderUpgradeTerminal: (provider: ProviderId) => Promise<{
        ok: boolean
        error?: string
        scope?: 'user-owned-provider-setup'
        managedRunReady?: false
        notice?: string
      }>
      /**
       * Catalog install commands (provider CLIs + Ollama model pulls): opens a
       * Terminal running the official command for this catalog row id. Main
       * re-resolves the command from the shared catalog — ids only cross IPC.
       */
      openInstallCommandTerminal: (commandId: string) => Promise<{
        ok: boolean
        error?: string
        command?: string
      }>
      /**
       * Optional host CLIs (today only `gh`). Installs when the binary is
       * absent and upgrades the resolved copy when it is present — the caller
       * does not choose, because only MAIN can see which one applies.
       */
      openHostToolInstallTerminal: (toolId: HostCliToolId) => Promise<{
        ok: boolean
        error?: string
        command?: string
        alreadyInstalled?: boolean
      }>
      hostToolStatus: (toolId: HostCliToolId) => Promise<{
        id: HostCliToolId
        available: boolean
        path?: string
      }>
      startPty: (workspacePath: string, sessionId?: string) => Promise<void>
      stopPty: (sessionId?: string) => Promise<void>
      ptyWrite: (data: string, sessionId?: string) => Promise<void>
      ptyResize: (cols: number, rows: number, sessionId?: string) => Promise<void>
      startGeminiSession: (
        workspace: string,
        model?: string,
        approvalMode?: string,
        sessionTrust?: boolean,
        cols?: number,
        rows?: number,
        resumeSessionId?: string | null,
        worktree?: GeminiWorktreeLaunchOption
      ) => Promise<void>
      stopGeminiSession: () => Promise<void>
      writeGeminiSession: (data: string) => Promise<void>
      resizeGeminiSession: (cols: number, rows: number) => Promise<void>
      discoverGeminiCommands: (workspace: string) => Promise<any>
      discoverGeminiMemory: (workspace: string) => Promise<any>
      getFileIconDataUrl: (path: string) => Promise<string | null>
      onPtyData: (callback: (data: string, sessionId?: string) => void) => () => void
      onPtyExit: (callback: (code: number | null, sessionId?: string) => void) => () => void
      removePtyListeners: () => void
      onGeminiSessionData: (callback: (data: string) => void) => void
      onGeminiSessionExit: (callback: (code: number | null) => void) => void
      removeGeminiSessionListeners: () => void

      // Bridge / iOS remote allowlist (Phase C4 admin surface)
      bridgeAllowlistList: () => Promise<RemoteWorkspaceEntry[]>
      bridgeAllowlistUpsert: (entry: {
        workspaceId: string
        path: string
        mode: 'read-only' | 'read-write'
        capabilities?: RemoteWorkspaceCapability[]
        expiresAt?: number
      }) => Promise<RemoteWorkspaceEntry>
      bridgeAllowlistRemove: (workspaceId: string) => Promise<boolean>
      bridgeAllowlistClear: () => Promise<boolean>
      updateSnapshot: () => Promise<UpdateStateSnapshot>
      checkForUpdates: () => Promise<UpdateStateSnapshot>
      downloadUpdate: () => Promise<UpdateStateSnapshot>
      downloadUpdateAndRestart: () => Promise<UpdateStateSnapshot>
      installUpdateOnQuit: () => Promise<UpdateStateSnapshot>
      installUpdateNow: () => Promise<UpdateStateSnapshot>
      changelogSnapshot: () => Promise<ProductChangelogSnapshot>
      markChangelogSeen: (version: string) => Promise<ProductChangelogSnapshot>
      onUpdateStatusChanged: (callback: (snapshot: UpdateStateSnapshot) => void) => () => void
      localServersSnapshot: () => Promise<LocalServersSnapshot>
      localServersRefresh: () => Promise<LocalServersSnapshot>
      localServersStop: (pid: number) => Promise<{ ok: boolean }>
      localServersStopAll: () => Promise<{ stopped: number }>
      onLocalServersChanged: (callback: (snapshot: LocalServersSnapshot) => void) => () => void
      launchTargetsSnapshot: (workspacePath: string) => Promise<LaunchTargetsSnapshot>
      launchAttemptsSnapshot: () => Promise<LaunchSnapshot>
      launchStart: (input: LaunchStartInput) => Promise<LaunchStartResult>
      launchStop: (input: LaunchStopInput) => Promise<LaunchStopResult>
      onLaunchAttemptsChanged: (callback: (snapshot: LaunchSnapshot) => void) => () => void
      bridgeNetworkingStatus: () => Promise<{
        lan: {
          enabled: boolean
          running: boolean
          settingEnabled: boolean
          effectiveEnabled: boolean
          envOverride: 'force-on' | 'force-off' | null
          status: 'running' | 'stopped'
          pid?: number | null
          startedAt?: string | null
          lastError?: string | null
          bonjourServiceType: string | null
          hostname: string
          localOnly?: boolean
          nativeCapabilities?: NativeCapabilitySnapshot
        }
        tailscale: {
          available: boolean
          cliPath?: string
          version?: string
          tailnetIPv4?: string
          tailnetIPv6?: string
          hostname?: string
          tailnetName?: string
          magicDNSEnabled?: boolean
          reason?: string
        }
      }>
      getIosRemoteConfig: () => Promise<{
        enabled: boolean
        relayUrl: string
        manualRelayUrl: string
        effectiveEnabled: boolean
        envOverride: 'force-on' | 'force-off' | null
        runtimeActive: boolean
        openAtLogin?: boolean
      }>
      setIosRemoteConfig: (config: {
        enabled?: boolean
        relayUrl?: string
        manualRelayUrl?: string
        openAtLogin?: boolean
      }) => Promise<{
        enabled: boolean
        relayUrl: string
        manualRelayUrl: string
        effectiveEnabled: boolean
        envOverride: 'force-on' | 'force-off' | null
        runtimeActive: boolean
        openAtLogin?: boolean
      }>
      iosRemoteTailscaleStatus: () => Promise<{
        tailscaleAvailable: boolean
        tailscaleReason: string | null
        dnsName: string | null
        suggestedUrl: string | null
        relayPort: number
        serveConfigured: boolean
        serveHttpsPort: number | null
        serveError: string | null
        relayUrlMatches: boolean
        manualRelayUrl: string | null
        manualRelayInput: string
        active: boolean
        directRelayUrl: string | null
        directAvailable: boolean
        cellularReady: boolean
        runtimeActive: boolean
        usingSavedRelayFallback?: boolean
      }>
      iosRemoteTailscaleEnable: () => Promise<{
        ok: boolean
        message?: string | null
        status?: Record<string, unknown>
        relayUrl?: string
        reachable?: boolean
      }>
      iosRemoteTailscaleTest: () => Promise<{
        ok: boolean
        message?: string | null
        relayUrl?: string
        reachable?: boolean
        status?: Record<string, unknown>
      }>
      iosRemoteTailscaleDisable: () => Promise<{
        ok: boolean
        message?: string | null
        status?: Record<string, unknown>
      }>
      iosRemoteTailscaleLink: (authKey: string) => Promise<{
        ok: boolean
        message?: string | null
        status?: Record<string, unknown>
      }>
      iosRemoteTailscaleOAuthSet: (input: {
        clientId: string
        clientSecret: string
      }) => Promise<{ ok: boolean; error?: string }>
      iosRemoteTailscaleOAuthClear: () => Promise<{ ok: boolean }>
      iosRemoteTailscaleOAuthStatus: () => Promise<{
        configured: boolean
        clientId: string | null
        encryptionAvailable: boolean
      }>
      setBridgeDaemonEnabled: (enabled: boolean) => Promise<{
        lan: {
          enabled: boolean
          running: boolean
          settingEnabled: boolean
          effectiveEnabled: boolean
          envOverride: 'force-on' | 'force-off' | null
          status: 'running' | 'stopped'
          pid?: number | null
          startedAt?: string | null
          lastError?: string | null
          bonjourServiceType: string | null
          hostname: string
          localOnly?: boolean
          nativeCapabilities?: NativeCapabilitySnapshot
        }
        tailscale: {
          available: boolean
          cliPath?: string
          version?: string
          tailnetIPv4?: string
          tailnetIPv6?: string
          hostname?: string
          tailnetName?: string
          magicDNSEnabled?: boolean
          reason?: string
        }
      }>
      bridgeFinalizePairing: (sessionID: string, userConfirmed: boolean) => Promise<unknown>
      onBridgePairingResponseReceived: (callback: (params: unknown) => void) => () => void

      /** Chat-scoped safe projection; opaque native-window material stays in main. */
      attachWindowPick: (chatId: string) => Promise<NativeWindowCoordinatorPickResult>
      attachWindowDetach: (
        chatId: string,
        generation: number
      ) => Promise<{ detached: boolean; status: NativeWindowCoordinatorRendererStatus }>
      attachWindowControlSession: (
        chatId: string,
        action: 'pause' | 'resume' | 'takeover' | 'stop'
      ) => Promise<NativeWindowCoordinatorRendererStatus>
      attachWindowStatus: (chatId: string) => Promise<NativeWindowCoordinatorRendererStatus>
      /** Resume-only, chat-scoped display metadata; no native identity fields. */
      stickyAppWatchGet: (chatId: string) => Promise<{ snapshot: StickyAppWatchSnapshot | null }>
      stickyAppWatchStash: (input: StickyAppWatchStashInput) => Promise<{ ok: boolean }>
      stickyAppWatchClear: (chatId: string) => Promise<{ ok: boolean }>
      onAttachedWindowChanged: (
        callback: (event: NativeWindowCoordinatorRendererEvent) => void
      ) => () => void
      // Begins a daemon-side pairing session. Returns the bootstrap
      // payload (PairingBootstrapPayload from the Swift daemon) so the
      // renderer can encode it as a QR for the iOS app, or surface it
      // as raw JSON for the "Paste JSON instead" fallback on iOS.
      bridgeBeginPairing: (
        displayName?: string,
        options?: { force?: boolean }
      ) => Promise<{
        ok: boolean
        bootstrap?: unknown // PairingBootstrapPayload shape; consumer passes through to QR/JSON
        error?: string
      }>
      bridgeListPairedDevices: () => Promise<
        Array<{
          iphoneIdentityPubKey: string
          pairId: string
          controllerDisplayName: string
          pairedAt: string
          connected: boolean
        }>
      >
      bridgeUnpairDevice: (iphoneIdentityPubKey: string) => Promise<{ ok: boolean; error?: string }>

      // Phase E1: APNs config surface for the Settings panel. The
      // `getApnsConfig` response NEVER includes decrypted key material
      // — main holds the cleartext via safeStorage and only sends
      // redacted status (configured flag, keyId, teamId, bundleId,
      // configuredAt, last test result, encryption availability,
      // paired-device count) to the renderer.
      getApnsConfig: () => Promise<{
        configured: boolean
        keyId?: string
        teamId?: string
        bundleId?: string
        defaultBundleId: string
        configuredAt?: string
        lastTestResult?: {
          at: string
          delivered: number
          failed: number
          error?: string
        }
        encryptionAvailable: boolean
        registeredDeviceCount: number
        pusherIsNoop: boolean
      }>
      selectApnsKeyFile: () => Promise<string | null>
      setApnsConfig: (input: {
        authKeyPath?: string
        keyId?: string
        teamId?: string
        bundleId?: string
      }) => Promise<{ ok: boolean; error?: string }>
      clearApnsConfig: () => Promise<{ ok: boolean }>
      testApnsPush: () => Promise<{
        ok: boolean
        at?: string
        delivered?: number
        failed?: number
        error?: string
      }>

      getSettings: () => Promise<AppSettings>
      updateSettings: (partial: Partial<AppSettings>) => Promise<void>
      'prompt-cache:get-policy': () => Promise<PromptCacheSettings>
      'prompt-cache:save-policy': (
        policy: PromptCacheSettings
      ) => Promise<{ ok: boolean; error?: string }>
      'prompt-cache:get-capabilities': () => Promise<PromptCacheCapability[]>
      'prompt-cache:get-diagnostics': () => Promise<unknown[]>
      upsertAgenticWorkspaceGrant: (
        provider: ProviderId,
        workspacePath: string,
        service: AgenticServiceId
      ) => Promise<AppSettings>
      removeAgenticWorkspaceGrant: (
        provider: AgenticWorkspaceGrantProviderId,
        workspacePath: string,
        service: AgenticServiceId
      ) => Promise<AppSettings>
      getRuntimeProfiles: (provider?: ProviderId) => Promise<RuntimeProfile[]>
      saveRuntimeProfile: (
        profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>,
        secretValues?: {
          env?: Record<string, string>
        }
      ) => Promise<RuntimeProfile>
      deleteRuntimeProfile: (id: string) => Promise<void>
      getExtensionSecretStatus: () => Promise<ExtensionSecretStatusSnapshot>
      setExtensionSecret: (
        ref: ExtensionSecretRef,
        value: string
      ) => Promise<ExtensionSecretMutationResult>
      clearExtensionSecret: (ref: ExtensionSecretRef) => Promise<ExtensionSecretMutationResult>
      getAntigravityGeminiApiSecretStatus: () => Promise<AntigravityGeminiApiSecretStatus>
      setAntigravityGeminiApiSecret: (
        apiKey: string
      ) => Promise<AntigravityGeminiApiSecretMutationResult>
      clearAntigravityGeminiApiSecret: () => Promise<AntigravityGeminiApiSecretMutationResult>
      getAntigravityGeminiApiDiscoveryOutcome: () => Promise<AntigravityGeminiApiDiscoveryOutcome | null>
      getPiKeyStatus: () => Promise<import('../main/pi/PiKeyStore').PiKeyStoreStatus>
      setPiUpstreamKey: (
        upstream: string,
        apiKey: string
      ) => Promise<import('../main/pi/PiKeyStore').PiKeyMutationResult>
      clearPiUpstreamKey: (
        upstream: string
      ) => Promise<import('../main/pi/PiKeyStore').PiKeyMutationResult>
      clearAllPiKeys: () => Promise<import('../main/pi/PiKeyStore').PiKeyMutationResult>
      getManagedPolicyStatus: () => Promise<Record<string, unknown> | null>
      getHandoffCards: (filter?: HandoffCardFilter) => Promise<HandoffCard[]>
      saveHandoffCard: (
        card: Partial<HandoffCard> &
          Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
      ) => Promise<HandoffCard>
      updateHandoffCard: (id: string, partial: Partial<HandoffCard>) => Promise<HandoffCard | null>
      deleteHandoffCard: (id: string) => Promise<void>
      getPluginCatalog: () => Promise<TaskWraithPluginCatalogSnapshot>
      getPluginContributions: () => Promise<TaskWraithPluginContributionSnapshot>
      getPluginActivation: () => Promise<TaskWraithPluginActivationSnapshot>
      getPluginSecretStatus: () => Promise<TaskWraithPluginSecretStatusSnapshot>
      setPluginSecret: (
        pluginId: string,
        secretId: string,
        value: string
      ) => Promise<TaskWraithPluginSecretMutationResult>
      clearPluginSecret: (
        pluginId: string,
        secretId: string
      ) => Promise<TaskWraithPluginSecretMutationResult>
      materializePluginMcpPreset: (
        pluginId: string,
        presetId: string
      ) => Promise<TaskWraithPluginMcpPresetMaterializationResult>
      installPlugin: (pluginId: string) => Promise<TaskWraithPluginCatalogSnapshot>
      setPluginEnabled: (
        pluginId: string,
        enabled: boolean
      ) => Promise<TaskWraithPluginCatalogSnapshot>
      updatePlugin: (pluginId: string) => Promise<TaskWraithPluginCatalogSnapshot>
      uninstallPlugin: (pluginId: string) => Promise<TaskWraithPluginCatalogSnapshot>
      listUserSkills: () => Promise<import('../shared/skills/SkillTypes').SkillRecord[]>
      listWorkspaceSkills: (payload: {
        workspacePath: string
        workspaceId?: string
      }) => Promise<import('../shared/skills/SkillTypes').SkillRecord[]>
      listEffectiveSkills: (payload: {
        workspacePath: string
        workspaceId?: string
      }) => Promise<import('../shared/skills/SkillTypes').EffectiveSkill[]>
      upsertSkill: (
        payload: import('../shared/skills/SkillTypes').UpsertSkillInput & {
          scope: import('../shared/skills/SkillTypes').SkillScope
          workspacePath?: string
          workspaceId?: string
        }
      ) => Promise<import('../shared/skills/SkillTypes').SkillRecord>
      deleteSkill: (payload: {
        scope: import('../shared/skills/SkillTypes').SkillScope
        id: string
        workspacePath?: string
      }) => Promise<{ ok: true; deleted: boolean }>
      setSkillEnabled: (payload: {
        scope: import('../shared/skills/SkillTypes').SkillScope
        id: string
        enabled: boolean
        workspacePath?: string
        workspaceId?: string
      }) => Promise<import('../shared/skills/SkillTypes').SkillRecord>
      revealSkillsRoot: (payload: {
        scope: import('../shared/skills/SkillTypes').SkillScope
        workspacePath?: string
      }) => Promise<{ ok: boolean; error?: string; path?: string }>
      getUserHooks: () => Promise<import('../shared/hooks/HookTypes').HooksConfigSnapshot>
      getWorkspaceHooks: (
        workspacePath: string
      ) => Promise<import('../shared/hooks/HookTypes').HooksConfigSnapshot>
      upsertHook: (
        request: import('../shared/hooks/HookTypes').UpsertHookRequest
      ) => Promise<import('../shared/hooks/HookTypes').HooksConfigSnapshot>
      deleteHook: (
        request: import('../shared/hooks/HookTypes').DeleteHookRequest
      ) => Promise<import('../shared/hooks/HookTypes').HooksConfigSnapshot>
      setHookEnabled: (
        request: import('../shared/hooks/HookTypes').SetHookEnabledRequest
      ) => Promise<import('../shared/hooks/HookTypes').HooksConfigSnapshot>
      revealHooksRoot: (payload: {
        scope: 'user' | 'workspace'
        workspacePath?: string
      }) => Promise<{ ok: boolean; error?: string; path?: string }>
      getGlobalInstructions: () => Promise<{
        content: string
        updatedAt: string | null
        sizeBytes: number
      }>
      setGlobalInstructions: (payload: { content: string }) => Promise<{
        content: string
        updatedAt: string | null
        sizeBytes: number
      }>
      resolveInstructionStatus: (payload: {
        workspacePath?: string
      }) => Promise<import('../shared/instructions/InstructionTypes').ResolvedInstructionContext>
      getWorkspaces: () => Promise<WorkspaceRecord[]>
      addOrUpdateWorkspace: (
        path: string,
        partial?: Partial<WorkspaceRecord>
      ) => Promise<WorkspaceRecord>
      removeWorkspace: (id: string) => Promise<void>
      getProjectsSnapshot: () => Promise<{
        projects: Project[]
        workProfiles: ProjectWorkProfile[]
        references: ProjectReference[]
        graphEdges: ProjectGraphEdge[]
        legacyImportMarker: ProjectLegacyImportMarker | null
      }>
      applyProjectOp: (op: ProjectOp) => Promise<ProjectRegistryMutationResult>
      setProjectHomeChat: (
        projectId: string,
        chatId: string | null
      ) => Promise<ProjectRegistryMutationResult>
      updateProjectWorkProfile: (
        projectId: string,
        patch: { brief?: string | null; preferredWorkspaceId?: string | null }
      ) => Promise<ProjectRegistryMutationResult>
      applyProjectReferenceOp: (op: ProjectReferenceOp) => Promise<ProjectRegistryMutationResult>
      applyProjectGraphEdgeOp: (op: ProjectGraphEdgeOp) => Promise<ProjectRegistryMutationResult>
      verifyProjectReference: (id: string) => Promise<ProjectRegistryMutationResult>
      pickProjectReferencePath: (mode: 'file' | 'folder') => Promise<string | null>
      importLegacyProjects: (rawJson: string | null) => Promise<ProjectLegacyImportResult>
      listProjectReferenceProposals: (projectId: string) => Promise<ProjectReferenceProposalView[]>
      reviewProjectReferenceProposal: (input: {
        projectId: string
        proposalId: string
        decision: 'approve' | 'reject'
      }) => Promise<{ created: boolean; referenceId?: string }>
      extractProjectReference: (input: {
        projectId: string
        referenceId: string
        chatId?: string
        consent: ProjectReferenceExtractConsent
      }) => Promise<
        | { ok: true; extract: ProjectReferenceExtract }
        | { ok: false; code: string; message: string; extract?: ProjectReferenceExtract }
      >
      getProjectReferenceExtract: (input: {
        projectId: string
        referenceId: string
      }) => Promise<ProjectReferenceExtract | null>
      revokeProjectReferenceExtract: (
        input: { extractId: string } | string
      ) => Promise<
        | { ok: true; extract: ProjectReferenceExtract }
        | { ok: false; code: string; message: string; extract?: ProjectReferenceExtract }
      >
      readProjectReferenceExtractText: (input: {
        extractId: string
        maxChars?: number
      }) => Promise<
        | { ok: true; text: string; truncated: boolean; charCount: number }
        | { ok: false; code: string; message: string }
      >
      generateProjectStudioDraft: (input: {
        projectId: string
        kind: ProjectStudioKind
        referenceIds: string[]
        title?: string
        chatId: string
        workspacePath: string
      }) => Promise<
        | { ok: true; artifact: ProjectStudioCompanionMeta }
        | { ok: false; code: string; message: string; referenceId?: string }
      >
      saveProjectStudioDraft: (input: {
        projectId: string
        draftId: string
        title?: string
      }) => Promise<
        | { ok: true; artifact: ProjectStudioCompanionMeta }
        | { ok: false; code: string; message: string; referenceId?: string }
      >
      discardProjectStudioDraft: (input: {
        projectId: string
        draftId: string
      }) => Promise<
        | { ok: true; artifact: ProjectStudioCompanionMeta }
        | { ok: false; code: string; message: string; referenceId?: string }
      >
      listProjectStudioArtifacts: (input: {
        projectId: string
        includeDiscarded?: boolean
      }) => Promise<
        | { ok: true; artifacts: ProjectStudioCompanionMeta[] }
        | { ok: false; code: string; message: string }
      >
      clearWorkspaces: () => Promise<void>
      getChats: (workspaceId?: string) => Promise<ChatRecord[]>
      getChatList: (workspaceId?: string) => Promise<ChatListItem[]>
      getPinnedMessages: (workspaceId?: string) => Promise<PinnedMessageGroup[]>
      getChat: (chatId: string) => Promise<ChatRecord | null>
      unarchiveChat: (
        chatId: string
      ) => Promise<
        { ok: true; chat: ChatRecord } | { ok: false; reason: 'not-found' | 'not-archived' }
      >
      exportArchivedChat: (input: { chatId: string; format: ArchivedChatExportFormat }) => Promise<{
        ok: boolean
        canceled?: boolean
        path?: string
        format?: ArchivedChatExportFormat
        messageCount?: number
        charCount?: number
        reason?: 'not-found' | 'not-archived' | 'invalid-request'
        error?: string
      }>
      createChat: (workspaceId: string, workspacePath: string) => Promise<ChatRecord>
      createGlobalChat: () => Promise<ChatRecord>
      createEnsembleChat: (args?: {
        workspaceId?: string
        workspacePath?: string
      }) => Promise<ChatRecord>
      postBlackboardEntry: (payload: {
        chatId: string
        key?: string
        value: string
        category?: string
        scope?: string
        ttlMinutes?: number
        imagePaths?: string[]
      }) => Promise<{ ok: true; entry: BlackboardEntry }>
      deleteBlackboardEntry: (payload: {
        chatId: string
        entryId: string
      }) => Promise<{ ok: true; removed: BlackboardEntry; remainingCount: number }>
      clearBlackboardEntries: (payload: { chatId: string }) => Promise<{
        ok: true
        removedCount: number
      }>
      runEnsembleRound: (payload: {
        chatId: string
        prompt: string
        scheduledTaskId?: string
        mode?: 'normal' | 'queue' | 'steer'
        concurrentMode?: boolean
        fanoutPolicy?: EnsembleFanoutPolicy
        imageAttachments?: ComposerImageAttachment[]
        discordContextSnapshots?: DiscordContextSnapshot[]
        externalPathGrants?: ExternalPathGrant[]
        /** Advisory exact target for a no-signal participant-chip gesture;
         * MAIN validates it against the canonical roster before dispatch. */
        dmTargetParticipantId?: string
        /** Exact participant selected through the composer @ picker. */
        exactPickerParticipantId?: string
        /** P1 F6 — Use-next Project reference selection for this round. */
        projectReferenceContextSelection?: ProjectReferenceContextSelection
      }) => Promise<{ status: string; roundId?: string }>
      steerQueuedEnsemblePrompt: (payload: {
        chatId: string
        index: number
        textPrefix?: string
        concurrentMode?: boolean
        fanoutPolicy?: EnsembleFanoutPolicy
      }) => Promise<{ status: string; roundId?: string; error?: string }>
      removeQueuedEnsemblePrompt: (payload: {
        chatId: string
        index: number
        textPrefix?: string
      }) => Promise<{
        ok: boolean
        prompt?: string
        queuedPrompts?: string[]
        imageAttachments?: Array<{ id?: string; path: string; name?: string }>
        dmTargetParticipantId?: string
        error?: string
      }>
      /** Consume a queued ensemble prompt into a user-authored blackboard
       * note (session scope) WITHOUT interrupting the live round. Queue
       * mutation matches Delete (textPrefix race-guard + restart recovery). */
      blackboardQueuedEnsemblePrompt: (payload: {
        chatId: string
        index: number
        textPrefix?: string
      }) => Promise<{ ok: boolean; error?: string }>
      cancelEnsembleRound: (chatId: string) => Promise<boolean>
      updateLiveEnsembleRoundConfig: (payload: {
        chatId: string
        orchestrationMode?: EnsembleOrchestrationMode
        fanoutPolicy?: EnsembleFanoutPolicy
        maxContinuationHops?: number
        previousMaxContinuationHops?: number
      }) => Promise<{
        ok: boolean
        orchestrationMode?: EnsembleOrchestrationMode
        fanoutPolicy?: EnsembleFanoutPolicy
        maxContinuationHops?: number
        activeRoundUpdated?: boolean
        error?: string
        message?: string
      }>
      applyEnsembleRosterPresetAtBoundary: (payload: {
        chatId: string
        plan: PendingEnsembleRosterPresetApply
      }) => Promise<
        | { ok: true; deferred: boolean; chat: ChatRecord; message: string }
        | { ok: false; error: 'invalid_config' | 'not_ensemble'; message: string }
      >
      requestEnsembleParticipantSeatChange: (payload: {
        chatId: string
        participantId: string
        participant: {
          provider?: string
          enabled?: boolean
          model?: string | null
          role?: string
          instructions?: string
          reasoningEffort?: string | null
          fastModeEnabled?: boolean
          thinkingEnabled?: boolean
          stageRole?: 'scout' | 'worker' | 'reviewer' | 'background' | null
          permissionPresetId?: string | null
          permissionOverrides?: PermissionOverrides | null
          serviceTier?: string | null
          runtimeProfileId?: string | null
          geminiAuthProfileId?: string | null
          linkedProviderSessionId?: string | null
          ollamaRunProfile?: string | null
        }
        reason?: string
      }) => Promise<{
        ok: boolean
        status?: 'applied' | 'queued'
        chat?: ChatRecord
        pendingParticipant?: EnsembleParticipant
        message: string
        participantId?: string
        roundId?: string
        error?: 'not_ensemble' | 'stale_target' | 'invalid_patch' | string
      }>
      requestEnsembleUserRosterMutation: (
        payload: EnsembleUserRosterMutationInput
      ) => Promise<EnsembleUserRosterMutationResult>
      skipEnsembleParticipant: (chatId: string) => Promise<boolean>
      skipEnsembleReadFanout: (chatId: string) => Promise<boolean>
      skipEnsembleFanoutLane: (chatId: string, laneId: string) => Promise<boolean>
      getLatestSessionCheckpoint: (chatId: string) => Promise<SessionCheckpointRecord | null>
      acceptSessionCheckpoint: (
        checkpointId: string
      ) => Promise<
        | { ok: true; checkpoint: SessionCheckpointRecord; resumePrompt: string }
        | { ok: false; error: string }
      >
      dismissSessionCheckpoint: (
        checkpointId: string
      ) => Promise<{ ok: true; checkpoint: SessionCheckpointRecord } | { ok: false; error: string }>
      wakeEnsembleParticipantNow: (wakeupId: string) => Promise<boolean>
      compactProviderContext: (payload: {
        chatId: string
        provider: string
        providerSessionId?: string
        participantId?: string
      }) => Promise<{ ok: boolean; error?: string }>
      cancelEnsembleParticipantWakeup: (
        wakeupId: string
      ) => Promise<{ ok: boolean; error?: string }>
      createSubThread: (args: {
        parentChatId: string
        provider: ProviderId
        delegationPrompt: string
        returnResultToParent: boolean
        workspaceId?: string
        workspacePath?: string
      }) => Promise<ChatRecord>
      getSubThreads: (parentChatId: string) => Promise<ChatRecord[]>
      createSideChat: (args: {
        parentChatId: string
        chatKind?: 'single' | 'ensemble'
        provider?: ProviderId
        title?: string
        originMessageId?: string
        originRunId?: string
        sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut'
      }) => Promise<ChatRecord>
      getSideChats: (parentChatId: string) => Promise<ChatRecord[]>
      setChatKind: (args: {
        chatId: string
        targetKind: ChatKind
        seedParticipant?: EnsembleParticipant
        canonicalProvider?: ProviderId
        canonicalProviderMetadata?: Record<string, unknown>
      }) => Promise<ChatRecord>
      rebindChatWorkspace: (
        args:
          | { chatId: string; scope: 'global'; deferIfBusy?: boolean }
          | {
              chatId: string
              scope: 'workspace'
              workspaceId: string
              workspacePath: string
              deferIfBusy?: boolean
            }
      ) => Promise<{ chat: ChatRecord; changed: boolean; deferred?: boolean }>
      listDiscordContextTargets: () => Promise<DiscordContextTargets>
      readDiscordContext: (selection: DiscordContextSelection) => Promise<DiscordContextSnapshot>
      humanCollaborationCreateShare: (input: {
        chatId: string
        mode?: HumanCollaborationMode
        inviteTtlMs?: number
      }) => Promise<
        CreateShareResult & {
          relayUrl: string
          relayUrls?: string[]
          relayWarning?: string
          hostIdentityPubKeyB64: string
        }
      >
      humanCollaborationInviteHealth: (chatId: string) => Promise<{
        chatAvailable: boolean
        shareEnabled: boolean
        bridgeEnabled: boolean
        bridgeRunning: boolean
        bridgeError?: string
        relayUrls: string[]
        tailscaleConfigured: boolean
        tailscaleSuggestedUrl?: string | null
        tailscaleReason?: string | null
      }>
      humanCollaborationCopyInvite: (input: { invite: string }) => Promise<{ ok: true }>
      humanCollaborationListShares: (chatId?: string) => Promise<HumanCollaborationShare[]>
      humanCollaborationConnectedChatIds: () => Promise<string[]>
      humanCollaborationRevokeShare: (shareId: string) => Promise<HumanCollaborationShare | null>
      humanCollaborationSetHostReview: (input: {
        shareId: string
        requiresHostApproval: boolean
      }) => Promise<HumanCollaborationShare | null>
      humanCollaborationSetFullHistory: (input: {
        shareId: string
        fullHistory: boolean
      }) => Promise<HumanCollaborationShare | null>
      humanCollaborationListPendingContributions: (
        chatId: string
      ) => Promise<ExternalContributionEntry[]>
      humanCollaborationApproveContribution: (
        entryId: string
      ) => Promise<ExternalContributionEntry | null>
      humanCollaborationDenyContribution: (input: {
        entryId: string
        reason?: string
      }) => Promise<ExternalContributionEntry | null>
      humanCollaborationRevokeParticipant: (input: {
        shareId: string
        collaboratorId: string
      }) => Promise<HumanCollaborationShare | null>
      humanCollaborationConsumeInvite: (input: {
        shareId: string
        inviteToken: string
        displayName: string
        publicKeyId: string
      }) => Promise<ConsumeInviteResult>
      humanCollaborationAppendComment: (input: {
        shareId: string
        chatId: string
        collaboratorId: string
        clientMessageId: string
        content: string
      }) => Promise<{ chat: ChatRecord; message: ChatRecord['messages'][number]; deduped: boolean }>
      humanCollaborationProjection: (input: {
        shareId: string
        chatId: string
        collaboratorId: string
      }) => Promise<HumanShareProjection>
      humanCollaborationRuntimeBeginAdmission: (
        input: HumanCollaborationBeginHandshakeInput
      ) => Promise<HumanCollaborationBeginHandshakeResult>
      humanCollaborationRuntimeConfirmSas: (
        input: HumanCollaborationConfirmSasInput
      ) => Promise<HumanCollaborationConfirmSasResult>
      humanCollaborationRuntimeSubscribeProjection: (
        input: HumanCollaborationSubscribeProjectionInput
      ) => Promise<HumanShareProjection>
      humanCollaborationRuntimeAppendComment: (
        input: HumanCollaborationAppendCommentInput
      ) => Promise<{ chat: ChatRecord; message: ChatRecord['messages'][number]; deduped: boolean }>
      humanCollaborationRuntimeReceiveFrame: (
        input: HumanCollaborationEncryptedFrame
      ) => Promise<unknown>
      humanCollaborationRuntimeDisconnect: (
        input: HumanCollaborationDisconnectInput
      ) => Promise<boolean>
      humanCollaborationPromoteComment: (input: {
        chatId: string
        messageId: string
      }) => Promise<{ chat: ChatRecord; draft: string }>
      humanCollaborationUpdateShareRules: (input: {
        shareId: string
        preset: string
      }) => Promise<unknown | null>
      humanCollaborationSessionStatus: () => Promise<
        Array<{
          chatId: string
          shareId: string
          collaboratorId: string
          displayName: string
          establishedAt: number
          mode: 'admission' | 'reconnect'
        }>
      >
      humanCollaborationAuditLog: (input?: { chatId?: string; limit?: number }) => Promise<
        Array<{
          id: string
          at: number
          kind: string
          chatId?: string
          shareId?: string
          collaboratorId?: string
          code?: string
          preview?: string
          contentHash?: string
          detail?: string
        }>
      >
      humanCollaborationCollaboratorJoin: (input: {
        shareId: string
        chatId: string
        inviteToken: string
        displayName: string
        mode: 'readOnly' | 'comments'
        relayUrl: string
        relayUrls?: string[]
        roomId: string
        hostIdentityPubKeyB64?: string
      }) => Promise<{ confirmCode: string; chatId: string; mode: 'readOnly' | 'comments' }>
      humanCollaborationCollaboratorConfirm: () => Promise<{
        sessionId: string
        collaboratorId: string
        displayName: string
      }>
      humanCollaborationCollaboratorLoadOlder: (input?: {
        beforeRowId?: string
      }) => Promise<{ ok: true }>
      humanCollaborationCollaboratorAppendComment: (input: {
        content: string
        clientMessageId?: string
        intent?: 'comment' | 'requestHostAction'
      }) => Promise<{ ok: true }>
      humanCollaborationCollaboratorLeave: () => Promise<boolean>
      humanCollaborationCollaboratorLastSession: () => Promise<{
        available: boolean
        chatId?: string
        displayName?: string
        mode?: 'readOnly' | 'comments'
        savedAt?: number
      }>
      humanCollaborationCollaboratorReconnect: () => Promise<{
        chatId: string
        mode: 'readOnly' | 'comments'
        displayName: string
      }>
      saveChat: (chat: ChatRecord) => Promise<ChatRecord>
      deleteChat: (chatId: string) => Promise<void>
      reapAbandonedChats: (renderer: {
        protectedChatIds?: string[]
        draftChatIds?: string[]
        keepChatId?: string
      }) => Promise<{ ok: boolean; reaped: string[] }>
      truncateChat: (chatId: string) => Promise<ChatRecord | null>
      clearChats: (workspaceId?: string) => Promise<void>
      recordUsage: (usage: Omit<UsageRecord, 'id' | 'timestamp'>) => Promise<void>
      getUsage: (workspaceId?: string, chatId?: string) => Promise<UsageRecord[]>
      getWorkspaceActivity: (
        workspacePath: string,
        dayCount?: number
      ) => Promise<WorkspaceActivitySnapshot>
      listWorkLocks: (query?: WorkLockProjectionQuery) => Promise<WorkLockProjectionSnapshot>
      forceReleaseRecoveryBlockedWorkLock: (
        request: WorkLockRecoveryRequest
      ) => Promise<WorkLockRecoveryResult>
      subscribeWorkLocks: (
        query: WorkLockProjectionQuery,
        callback: (update: WorkLockProjectionUpdate) => void
      ) => () => void
      getScheduledTasks: (workspaceId?: string) => Promise<ScheduledTask[]>
      syncEnsembleRosterPresets: (presets: unknown[]) => Promise<void>
      saveScheduledTask: (task: ScheduledTaskCreateInput) => Promise<ScheduledTask>
      updateScheduledTask: (
        id: string,
        partial: ScheduledTaskLifecycleUpdate
      ) => Promise<ScheduledTask | null>
      cancelScheduledTask: (id: string, reason?: string) => Promise<ScheduledTask | null>
      deleteScheduledTask: (id: string) => Promise<void>
      getWorkflowDefinitions: (workspaceId?: string) => Promise<WorkflowDefinition[]>
      saveWorkflowDefinition: (
        workflow: WorkflowDefinitionCreateInput
      ) => Promise<WorkflowDefinition>
      updateWorkflowDefinition: (
        id: string,
        partial: WorkflowDefinitionRendererUpdate
      ) => Promise<WorkflowDefinition | null>
      deleteWorkflowDefinition: (id: string) => Promise<void>
      getExecutionGraphDiagnostics: () => Promise<ExecutionGraphDiagnosticsSnapshot>
      listExecutionGraphRevisions: (
        workspaceId?: string
      ) => Promise<readonly ExecutionGraphRevision[]>
      getExecutionGraphRevision: (
        graphId: string,
        revision: number
      ) => Promise<ExecutionGraphRevision | null>
      getExecutionGraphLayout: (
        graphId: string,
        revision: number
      ) => Promise<ExecutionGraphLayout | null>
      listExecutionRuns: (
        filter?: ExecutionRunListFilter
      ) => Promise<readonly ExecutionRunProjection[]>
      getExecutionRun: (executionId: string) => Promise<ExecutionRunProjection | null>
      getExecutionRunEvents: (executionId: string) => Promise<readonly ExecutionRunEvent[]>
      appendExecutionStackStep: (
        command: ExecutionStackAppendCommand
      ) => Promise<ExecutionRunProjection>
      cancelExecutionRun: (
        executionId: string,
        reason?: string
      ) => Promise<ExecutionRunProjection | null>
      cancelExecutionRunStep: (
        command: ExecutionRunCancelStepCommand
      ) => Promise<ExecutionRunProjection>
      formalizeExecutionRun: (
        command: ExecutionRunFormalizeCommand
      ) => Promise<ExecutionGraphRevision>
      saveExecutionGraphLayout: (layout: ExecutionGraphLayout) => Promise<ExecutionGraphLayout>
      getWorkspaceBoards: (workspaceId?: string) => Promise<WorkspaceBoardDefinition[]>
      saveWorkspaceBoard: (
        board: Omit<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
          Partial<Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>
      ) => Promise<WorkspaceBoardDefinition>
      updateWorkspaceBoard: (
        id: string,
        partial: Partial<WorkspaceBoardDefinition>
      ) => Promise<WorkspaceBoardDefinition | null>
      deleteWorkspaceBoard: (id: string) => Promise<void>
      getWorkspaceBoardCards: (boardId?: string) => Promise<WorkspaceBoardCard[]>
      saveWorkspaceBoardCard: (
        card: Omit<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
          Partial<Pick<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>
      ) => Promise<WorkspaceBoardCard>
      updateWorkspaceBoardCard: (
        id: string,
        partial: Partial<WorkspaceBoardCard>
      ) => Promise<WorkspaceBoardCard | null>
      deleteWorkspaceBoardCard: (id: string) => Promise<void>
      getEvidencePacks: (workspaceId?: string) => Promise<EvidencePackRecord[]>
      saveEvidencePack: (pack: Partial<EvidencePackRecord>) => Promise<EvidencePackRecord>
      deleteEvidencePack: (id: string) => Promise<void>
      getCapabilityLedgerSnapshot: (workspaceId?: string) => Promise<CapabilityLedgerSnapshot>
      getRepoConventionIndexes: (workspaceId?: string) => Promise<RepoConventionIndexSnapshot[]>
      saveRepoConventionIndex: (
        snapshot: Partial<RepoConventionIndexSnapshot>
      ) => Promise<RepoConventionIndexSnapshot>
      runWorkflowNow: (id: string) => Promise<ScheduledTask | null>
      setWorkflowUnattendedElevation: (
        id: string,
        level: string
      ) => Promise<WorkflowDefinition | null>
      getWorkflowRunSummaries: (workflowId?: string) => Promise<WorkflowRunSummary[]>
      getWorkflowRunEvents: (filter?: WorkflowRunEventFilter) => Promise<WorkflowRunEvent[]>
      getAgentStatsSummaries: (agentIds: string[]) => Promise<PooledAgentStatsSummary[]>

      startAuditRun: (input: {
        mode?: AuditRunRecord['mode']
        chatId: string
        preferredProvider?: ProviderId
        workspacePath: string
        workspaceId?: string
      }) => Promise<AuditRunRecord>
      cancelAuditRun: (auditRunId: string) => Promise<{ ok: boolean }>
      getAuditRun: (auditRunId: string) => Promise<AuditRunRecord | null>
      getAuditRuns: (workspaceId?: string) => Promise<AuditRunRecord[]>
      getRunQueueJobs: (filter?: RunQueueJobFilter) => Promise<RunQueueJob[]>
      requestRunQueueJob: (
        job: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'>
      ) => Promise<RunQueueJob>
      leaseRunQueueJob: (request?: {
        runId?: string
        provider?: ProviderId
        statusReason?: string
      }) => Promise<RunQueueJob | null>
      promoteQueuedJobForSteer: (
        input: PromoteQueuedJobForSteerInput
      ) => Promise<PromoteQueuedJobForSteerResult>
      leasePromotedSteerJob: (
        input: LeasePromotedSteerInput
      ) => Promise<LeasePromotedSteerJobResult>
      fallbackPromotedSteerJob: (
        input: FallbackPromotedSteerInput
      ) => Promise<FallbackPromotedSteerJobResult>
      injectSteering: (
        input: LiveSteeringInjectionRequest
      ) => Promise<LiveSteeringInjectionResult>
      cancelSteering: (input: LiveSteeringCancelRequest) => Promise<LiveSteeringCancelResult>
      transitionRunQueueJob: (
        runIdOrId: string,
        status: RunQueueJob['status'],
        partial?: Pick<Partial<RunQueueJob>, 'statusReason' | 'lastError'>
      ) => Promise<RunQueueJob | null>
      getRunRecoveryRecords: (filter?: RunRecoveryFilter) => Promise<RunRecoveryRecord[]>
      getRunEvents: (filter?: RunEventFilter) => Promise<RunEventRecord[]>
      getRunEventReplay: (runId: string) => Promise<RunEventReplay>
      analyzeRun: (request: RunAnalystRequest) => Promise<RunAnalystSnapshot>
      summarizeCloseout: (request: CloseoutSummaryRequest) => Promise<CloseoutSummarySnapshot>
      proposeContinuation: (
        request: ContinuationProposalRequest
      ) => Promise<ContinuationProposalSnapshot>
      getApprovalLedger: (filter?: ApprovalLedgerFilter) => Promise<ApprovalLedgerRecord[]>
      recordApprovalElevationAck: (input: {
        provider: string
        workspacePath: string | null
        toMode: string
        tier: number
      }) => Promise<void>
      getMemoryProposalPacks: (workspaceId?: string | null) => Promise<MemoryProposalPack[]>
      getMemoryProposalPack: (packId: string) => Promise<MemoryProposalPack | null>
      updateMemoryProposal: (
        packId: string,
        proposalId: string,
        partial: Partial<MemoryProposal>
      ) => Promise<MemoryProposalPack | null>
      applyMemoryProposal: (
        packId: string,
        proposalId: string
      ) => Promise<{
        ok: boolean
        blocked?: string
        pack?: MemoryProposalPack
        conventionEntryId?: string
        skillId?: string
      }>
      runManualIntrospection: (input: {
        windowStart: string
        windowEnd: string
        workspaceId?: string
        workspacePath?: string
      }) => Promise<{
        pack: MemoryProposalPack
        evidenceCount: number
        proposalCount: number
      }>
      getIntrospectionSchedule: (workspaceId?: string | null) => Promise<{
        enabled: boolean
        workspaceId?: string | null
        lastRunAt?: string | null
        nextRunAt?: string | null
      }>
      updateIntrospectionSchedule: (partial: {
        enabled?: boolean
        workspaceId?: string | null
        lastRunAt?: string | null
        nextRunAt?: string | null
      }) => Promise<{
        enabled: boolean
        workspaceId?: string | null
        lastRunAt?: string | null
        nextRunAt?: string | null
      }>
      getProductOperationsStatus: () => Promise<ProductOperationsStatus>
      getProductCrashes: (filter?: ProductCrashFilter) => Promise<ProductCrashRecord[]>
      recordProductCrash: (input: ProductCrashInput) => Promise<ProductCrashRecord>
      exportProductDiagnostics: (path?: string) => Promise<ProductDiagnosticsExportResult>
      exportProductAuditBundle: (
        request?: ProductAuditBundleExportRequest
      ) => Promise<ProductAuditBundleExportResult>
      verifyProductAuditBundle: (
        request?: ProductAuditBundleVerificationRequest
      ) => Promise<ProductAuditBundleVerificationResult>
      purgeProductAuditRetention: (
        request?: AuditRetentionPurgeRequest
      ) => Promise<AuditRetentionPurgeResult>
      repairProductInstall: () => Promise<ProductOperationsStatus>
      getAppShellStats: () => Promise<AppShellStatsSnapshot>
      getAppVersion: () => Promise<string>
      submitBugReport: (payload: {
        title: string
        description: string
        expected: string
        severity: 'info' | 'minor' | 'major' | 'blocking'
        context: {
          timestamp: string
          version: string
          provider: string
          workspace: string
          shell: string
          surface?: string
          chatKind?: string
          settingsTab?: string
          inspectorTab?: string
          theme?: string
          promptBubble?: string
          ensemble?: string
        }
      }) => Promise<{ ok: boolean; path?: string; error?: string }>

      onGeminiOutput: (callback: (data: GeminiStreamPayload) => void) => () => void
      onGeminiError: (callback: (error: GeminiStreamPayload) => void) => () => void
      onGeminiExit: (callback: (code: GeminiStreamPayload | number | null) => void) => () => void
      onAgentOutput: (
        callback: (payload: {
          provider: ProviderId
          data: string
          appRunId?: string
          appChatId?: string
        }) => void
      ) => () => void
      onAgentError: (
        callback: (payload: {
          provider: ProviderId
          error: string
          appRunId?: string
          appChatId?: string
        }) => void
      ) => () => void
      onAgentExit: (
        callback: (payload: {
          provider: ProviderId
          code: number | null
          appRunId?: string
          appChatId?: string
        }) => void
      ) => () => void
      onRunQueueChanged: (callback: (jobs: RunQueueJob[]) => void) => () => void
      onRunEventsChanged: (
        callback: (payload: {
          runId: string
          chatId?: string
          workspaceId?: string
          sequence: number
        }) => void
      ) => () => void
      onExecutionGraphChanged: (
        callback: (notice: ExecutionGraphChangedNotice) => void
      ) => () => void
      onAgentApprovalRequest: (callback: (payload: AgentApprovalRequest) => void) => () => void
      onAgentApprovalTimeout: (
        callback: (payload: {
          approvalId: string
          appliedMs: number
          source: 'perKind' | 'mainAuthority' | 'providerDefault'
        }) => void
      ) => () => void
      onAgentApprovalResolved: (
        callback: (payload: {
          approvalId: string
          action?: string
          decisionSource?: string
          provider?: string
          threadId?: string
        }) => void
      ) => () => void
      onScheduledTasksChanged: (callback: (payload: ScheduledTask[]) => void) => () => void
      onEnsembleRosterPresetSaveRequested: (
        callback: (payload: { name: string; participants: unknown[] }) => void
      ) => () => void
      onEnsembleRosterPresetImportRequested: (
        callback: (payload: { requestId: string; json: string; source?: string }) => void
      ) => () => void
      sendEnsembleRosterPresetImportResult: (payload: {
        requestId: string
        ok: boolean
        importedCount?: number
        presetId?: string
        presetName?: string
        error?: string
      }) => void
      onEnsembleAgentPoolRegistrationRequested: (
        callback: (payload: { requestId: string; participant: unknown }) => void
      ) => () => void
      sendEnsembleAgentPoolRegistrationResult: (payload: {
        requestId: string
        ok: boolean
        pooledAgentId?: string
        pooledAgentIdentity?: unknown
        mode?: 'created' | 'coalesced' | 'updated'
        error?: string
      }) => void
      onEnsembleRosterPresetDeleteRequested: (callback: (presetId: string) => void) => () => void
      onWorkflowDefinitionsChanged: (
        callback: (payload: WorkflowDefinition[]) => void
      ) => () => void
      onWorkspaceBoardsChanged: (
        callback: (payload: {
          boards: WorkspaceBoardDefinition[]
          cards: WorkspaceBoardCard[]
        }) => void
      ) => () => void
      onEvidencePacksChanged: (
        callback: (payload: {
          packs: EvidencePackRecord[]
          ledger: CapabilityLedgerSnapshot
        }) => void
      ) => () => void
      onAuditRunChanged: (callback: (run: AuditRunRecord) => void) => () => void
      onUsageChanged: (callback: () => void) => () => void
      onExternalUsageUpdated: (callback: () => void) => () => void
      onWorkspaceActivityUpdated: (
        callback: (payload: { workspacePath: string; dayCount: number }) => void
      ) => () => void
      onChatUpdated: (callback: (delivery: ChatUpdateDelivery) => void) => () => void
      ackChatUpdated: (ack: ChatUpdateAck) => void
      /** Agent-set theme tokens changed in main; re-apply without a reload. */
      onAgentThemeTokensChanged: (callback: (tokens: Record<string, string>) => void) => () => void
      onProjectsChanged: (callback: (state: ProjectRegistryState) => void) => () => void
      onProjectReferenceProposalsChanged: (
        callback: (payload: { projectId: string }) => void
      ) => () => void
      onContextCompactionProgress: (
        callback: (event: ContextCompactionProgressEvent) => void
      ) => () => void
      onParticipantWorkingTelemetry: (
        callback: (event: ParticipantWorkingTelemetryEvent) => void
      ) => () => void
      onHumanCollaborationUpdated: (callback: (payload: { chatId: string }) => void) => () => void
      onHumanCollaborationActionRequest: (
        callback: (payload: { chatId: string; messageId: string; draft: string }) => void
      ) => () => void
      onHumanCollaborationRuntimeProjectionUpdate: (
        callback: (payload: { sessionId: string; projection: HumanShareProjection }) => void
      ) => () => void
      onHumanCollaborationRuntimeEncryptedFrame: (
        callback: (payload: { sessionId: string; frame: HumanCollaborationEncryptedFrame }) => void
      ) => () => void
      onHumanCollaborationAdmissionBegan: (
        callback: (payload: {
          handshakeId: string
          chatId: string
          shareId: string
          displayName: string
          confirmCode: string
          mode?: 'admission' | 'reconnect'
        }) => void
      ) => () => void
      onHumanCollaborationCollaboratorProjection: (
        callback: (payload: { projection: HumanShareProjection; sessionId: string }) => void
      ) => () => void
      onHumanCollaborationCollaboratorOlderPage: (
        callback: (payload: {
          sessionId: string
          beforeRowId?: string
          rows: unknown[]
          hasMore: boolean
          oldestRowId?: string
          throttled?: boolean
        }) => void
      ) => () => void
      onHumanCollaborationCollaboratorStatus: (
        callback: (payload: {
          connected?: boolean
          error?: string
          /** A refused contribution — NOT a connection failure. */
          contributionRejected?: { code: string; message: string; clientMessageId?: string }
        }) => void
      ) => () => void
      onRunTrustedMediaRefs: (
        callback: (payload: { appChatId: string; appRunId: string; mediaRefs: unknown[] }) => void
      ) => () => void
      onAppShellStatsChanged: (callback: (snapshot: AppShellStatsSnapshot) => void) => () => void
      onWorkspacePopoutRefresh: (
        callback: (payload: {
          workspacePath: string
          reason: string
          externalWriteAllowed?: boolean
        }) => void
      ) => () => void
      onWorkspacePopoutOpenFile: (
        callback: (payload: {
          workspacePath: string
          path: string
          view?: 'editor' | 'diff'
        }) => void
      ) => () => void
      onSideChatDockRequest: (
        callback: (payload: {
          chatId: string
          parentChatId: string
          presentation: 'split' | 'drawer'
          draft?: string
          scrollState?: ChatPopoutScrollState
          roundExpansion?: ChatPopoutRoundExpansionSnapshot
        }) => void
      ) => () => void
      onCreativeActionRequest: (
        callback: (payload: {
          requestId: string
          className: string
          details: {
            title: string
            description: string
            filePath?: string
            targetBundleId?: string
            payloadPreview?: string
          }
        }) => void
      ) => () => void
      decideCreativeAction: (
        requestId: string,
        approved: boolean,
        rememberForSession: boolean
      ) => void
      removeListeners: () => void
    }
  }
}
