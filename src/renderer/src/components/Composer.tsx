import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MAX_ACTIVE_GOAL_OBJECTIVE_CHARS,
  computeGoalRuntimeTiming
} from '../../../main/GoalState'
import {
  AgenticServiceId,
  AgenticWorkspaceGrant,
  ChatWorkflowMode,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../../../main/store/types'
import type { CodexModelOption } from '../lib/providerModelDefaults'
import { resolveWorkspaceDisplayName } from '../../../shared/workspaceDisplayName'
import type { HumanCollaborationShare } from '../../../main/collaboration/HumanCollaborationStore'
import type {
  HumanCollaborationInviteCopyResult,
  HumanCollaborationInviteHealth
} from '../lib/humanCollaborationInviteHealth'
import { AgentMentionMenu } from '../components/AgentMentionMenu'
import { ArrowUpSendIcon, ChatMediaIcon, ClaudeReturnSymbolIcon, ClockSymbolIcon, CommandSymbolIcon, FileMenuSelectionIcon, GitCommitSymbolIcon, GoalSymbolIcon, ModelSymbolIcon, PermissionSymbolIcon, PlusSymbolIcon, ReviewSymbolIcon, RunSymbolIcon, ScreenWatchSymbolIcon, StopSymbolIcon, TrustSymbolIcon, WorkflowGlyphIcon, XSymbolIcon } from '../components/AppChromeSymbols'
import { ContextMeterPopover } from './ContextMeterPopover'
import { CombinedModelPicker } from '../components/CombinedModelPicker'
import type { CombinedModelPickerModelOption, CombinedModelPickerReasoningOption } from '../components/CombinedModelPicker'
import { CombinedPermissionsPicker } from '../components/CombinedPermissionsPicker'
import type { PermissionOption } from '../components/CombinedPermissionsPicker'
import { ComposerHighlightOverlay } from '../components/ComposerHighlightOverlay'
import { ComposerLinkPreviewStrip } from '../components/ComposerLinkPreviewStrip'
import { ComposerPlusPicker } from '../components/ComposerPlusPicker'
import type { ComposerPlusPickerSection } from '../components/ComposerPlusPicker'
import { ComposerProviderPicker } from '../components/ComposerProviderPicker'
import { ComposerSlashMenu } from '../components/ComposerSlashMenu'
import { TrustedSessionConfirmSheet } from '../components/TrustedSessionConfirmSheet'
import { AnimatedDiffNumber } from '../components/AnimatedDiffNumber'
import { HumanCollaborationInviteComposerControl } from './HumanCollaborationInviteComposerControl'
import {
  ComposerTextareaContextMenu,
  useComposerTextareaContextMenu
} from '../components/ComposerTextareaContextMenu'
import { ComposerThreadTimecodeBar } from '../components/ComposerTimecodes'
import { ComposerWorkspaceSwitcher } from '../components/ComposerWorkspaceSwitcher'
import { CopyTranscriptButton } from '../components/CopyTranscriptButton'
import { EnsembleOrchestrationRow } from '../components/EnsembleOrchestrationRow'
import type {
  ContinuousHopsGoalStatus,
  ContinuousHopsRoundStatus
} from '../components/ContinuousHopsLimitChip'
import { EnsembleParticipantsAboveRow } from '../components/EnsembleParticipantsAboveRow'
import { EnsembleRosterPresetPicker } from '../components/EnsembleRosterPresetPicker'
import { ExternalPathAboveRow } from '../components/ExternalPathAboveRow'
import { ExternalPathGrantPromptCard } from '../components/ExternalPathGrantPromptCard'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { GhostCompanion } from '../components/FxLayers'
import { NotificationZone } from '../components/NotificationZone'
import { GitCommitControls } from '../components/GitCommitControls'
import { ComposerBranchWorktreePopover } from '../components/ComposerBranchWorktreePopover'
import { GitMergeBadge, GitSyncChip } from '../components/GitStatusChips'
import { GitHubSatelliteRow } from '../components/GitHubSatelliteRow'
import { LiveThreadTokenTally } from '../components/LiveThreadTokenTally'
import { MultiviewLayoutPicker } from '../components/MultiviewLayoutPicker'
import { CanvasComposerButton } from '../components/CanvasComposerButton'
import { PillButton } from './PillButton'
import { QueuedMessagesAboveRow } from '../components/QueuedMessagesAboveRow'
import { WelcomeHeatmaps } from '../components/WelcomeHeatmaps'
import { WorkflowComposeControls } from '../components/WorkflowComposeControls'
import { extractFirstEnsembleDmTarget, formatComposerPathMention, parseComposerMentionTrigger } from '../lib/ComposerMentionTrigger'
import { readPendingProviderChange } from '../../../main/providerChangeQueue'
import {
  hasSlashCommandPlaceholders,
  slashCommandDispatchPrefix,
  matchStandaloneSlashCommandToken,
  matchLeadingSlashCommand
} from '../lib/ComposerSlashCommands'
import type {
  ComposerSlashCommand,
  SlashCommandRunContext
} from '../lib/ComposerSlashCommands'
import { parseSideSlashCommand } from '../lib/SideSlashCommand'
import type { SideSlashCommand } from '../lib/SideSlashCommand'
import { lastRetryableEnsembleUserPrompt } from '../lib/ensembleRetryPrompt'
import { renderAgentApprovalPreview } from '../lib/agentApprovalPreview'
import { isNativeSubAgentPreferenceApproval } from '../lib/agentApprovalTypes'
import { decideApprovalElevation } from '../lib/approvalElevation'
import { formatScheduledRunTime } from '../lib/dateTimeFormat'
import { formatScheduledTaskCountdown } from '../lib/scheduledCountdown'
import { resolveEnsembleParticipantSeatMutationState } from '../lib/ensembleParticipantSeatLock'
import { buildParticipantToolGrantPatch, getParticipantToolGrantIds } from '../lib/ensembleParticipantToolGrants'
import {
  getDefaultEnsembleParticipantConfig,
  getEnsembleReasoningOptions,
  resolveEnsembleParticipantSettings
} from '../lib/ensembleProviderDefaults'
import {
  MAX_IMAGE_ATTACHMENTS,
  collectClipboardAttachmentPaths,
  collectDroppedAttachmentPaths,
  dataTransferHasFiles,
  hasAttachmentPromptContent,
  isPdfAttachmentPath
} from '../lib/imageAttachments'
import { ComposerImageThumb } from './ComposerImageThumb'
import { ComposerBlackboardButton } from './ComposerBlackboardButton'
import { ComposerEnsembleToggleButton } from './ComposerEnsembleToggleButton'
import { ComposerPlanImportCard } from './ComposerPlanImportCard'
import { ComposerPlanPopoverButton } from './ComposerPlanPopoverButton'
import {
  ComposerVoiceInputButton,
  ComposerVoiceWaveform,
  EMPTY_COMPOSER_VOICE_CAPTURE_STATE,
  appendComposerVoiceTranscript
} from './ComposerVoiceInput'
import type { ComposerVoiceCaptureState } from './ComposerVoiceInput'
import { shouldOfferPlanImport } from '../lib/planImport'
import { hasResolvedMention } from '../lib/mentionHighlight'
import { formatApprovalCountdown, resolveApprovalTimeoutMs } from '../lib/approvalTimeoutCountdown'
import { getProviderLabel } from '../lib/providerLabels'
import {
  CLAUDE_DEFAULT_MODELS,
  resolveClaudeDefaultReasoningEffort
} from '../lib/providerModelDefaults'
import {
  codexReasoningDisplayLabel,
  claudeReasoningDisplayLabel,
  grokReasoningDisplayLabel
} from '../lib/composerChipFormat'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_45_MODEL_ID,
  isCursorGrok45ModelId,
  isGrok45ReasoningModelId
} from '../../../shared/grok45Models'
import { composerGitActionUsesCommitIcon } from '../lib/composerGitActionIcon'
import { composerVoicePlacementForStyle } from '../lib/composerVoicePlacement'
import { composerPermissionOptions } from '../lib/planModeLabels'
import { WORKSPACE_POLICY_SERVICES } from '../lib/workspacePolicyServices'
import { createPortal } from 'react-dom'

/**
 * Composer — the chat composer, lifted verbatim from App.tsx's inline
 * `.composer-area` subtree (Slice A of the multiview composer-parity fix) so the
 * SAME component renders in every multiview pane instead of a hand-written clone.
 *
 * Slice A is a behavior-preserving move: every dependency is passed through from
 * App.tsx and the JSX body is unchanged. Props are typed `any` here as a
 * deliberate, temporary passthrough — a follow-up slice tightens them and lifts
 * the singleton refs/UI-state into the component so multiple instances are safe.
 */
export interface ComposerProps {
  prompt: string
  PLAN_IMPORT_CHIP_LABELS: any
  PLAN_IMPORT_RISK_LABELS: any
  PLAN_IMPORT_RUN_CONSTRAINT_LABELS: any
  acknowledgedElevationDefaults: any
  activeEnsembleConcurrentMode: any
  activeEnsembleFanoutPolicy: EnsembleFanoutPolicy
  activeEnsembleOrchestrationMode: any
  addImageAttachmentsToChat: (
    chatId: string | null | undefined,
    paths: string[]
  ) => void | Promise<void>
  agentModelsByProvider: Partial<Record<ProviderId, CodexModelOption[]>>
  agentStatusByProvider: any
  agenticServices: any
  agenticWorkspaceGrants: AgenticWorkspaceGrant[]
  appearance: any
  applyEnsemblePermissionsToAllParticipants: any
  applyEnsembleRosterPreset: any
  approvalMode: any
  approvalTimeouts: import('../../../main/store/types').AppSettings['approvalTimeouts']
  attachedWindow: any
  chatByIdRef: any
  claudeFastMode: any
  claudeReasoningEffort: any
  claudeReasoningOptions: any
  clearCurrentGoal: any
  clearExternalPathGrantPrompt: any
  clearImagePermissions: any
  clearPlanImportIfDraftChanged: any
  codexModels: CodexModelOption[]
  codexReasoningEffort: any
  codexReasoningOptions: any
  codexServiceTier: any
  grokReasoningEffort: any
  cursorReasoningEffort: any
  cursorFastMode: any
  composerAboveBarStackAuraClass: any
  composerAgentAuraClass: any
  composerAreaRef: any
  composerAriaLabel: any
  composerFileAttachments: any
  composerImageAttachments: any
  composerPlaceholder: any
  composerRunTimecodeStartedAt: any
  composerSlashCommands: ComposerSlashCommand[]
  composerTokenTally: any
  contextLabel: any
  contextMeter: any
  contextModelId: any
  contextUsedPercent: any
  /** Provider-native "compact now" for this chat's linked session (solo
   * chats, idle). Undefined hides the popover's compact button. */
  onCompactContext?: () => void
  /** Per-seat compaction for ensemble participant rows in the meter popover
   * (native claude/codex seats, round idle). */
  onCompactParticipant?: (participantId: string) => void
  compactableParticipantIds?: readonly string[]
  /** Live speaker participant id — its compaction icon is disabled. */
  speakingParticipantId?: string
  cumulativeRunBaseMs: any
  currentActiveGoal: any
  currentChat: any
  currentChatIdRef: any
  currentComposerChatId: any
  currentComposerMentionParticipants: any
  currentDiscordContextSelection: any
  currentEnsembleConcurrentMode: any
  currentEnsembleFanoutPolicy: EnsembleFanoutPolicy
  currentEnsembleContinuationHops: any
  currentEnsembleMaxContinuationHops: any
  currentEnsembleRoundStatus?: ContinuousHopsRoundStatus
  currentEnsembleActiveGoalStatus?: ContinuousHopsGoalStatus | null
  currentEnsembleOrchestrationMode: any
  currentGoalButtonTitle: any
  currentGoalModeLabel: any
  currentGoalStatus: any
  humanCollaborationInviteActive?: boolean
  humanCollaborationShare?: HumanCollaborationShare | null
  humanCollaborationInviteHealth?: HumanCollaborationInviteHealth | null
  humanCollaborationInviteBusy?: boolean
  humanCollaborationInviteLive?: boolean
  currentProvider: any
  currentProviderCapabilityWarning: any
  currentProviderLabel: any
  currentProviderModelOptions: any
  currentWorkspace: any
  currentWorkspacePath: any
  cursorProviderAvailable: any
  customModel: any
  diffActionMenuOpen: any
  displayCurrency: any
  dualComposerTelemetry: any
  effectiveSelectedParticipantId: any
  ensembleBlendStyle: any
  ensembleConcurrentLanesAvailable: any
  ensembleConcurrentWriteLanesAvailable: any
  ensembleEnabledParticipantsForCurrent: any
  ensembleOllamaContextWarning: any
  externalGitSnapshots: any
  onExternalGitSnapshotRefresh: any
  externalPrByPath: any
  externalPathGrantPrompt: any
  externalPathGrantPromptBusy: any
  externalPathGrants: any
  externalPathRepoMetadata: any
  externalWorkspaceGroups: any
  formatPlanImportCostEstimate: any
  formatPlanImportRunConstraintValue: any
  formatPlanImportTokenEstimate: any
  geminiTrustWriteBusy: any
  geminiTrustWriteError: any
  geminiWorkspaceTrustReady: any
  getCreatePrState: any
  getProviderModelOptions: any
  goalButtonRef: any
  goalControlDisabledReason?: string
  goalDraft: any
  goalEditing: any
  goalPopoverOpen: any
  goalPopoverPosition: any
  goalPopoverRef: any
  grokProviderAvailable: any
  handleAddKnownWorkspaceAsSecondary: any
  handleAddWorkspaceFolder: any
  handleAgentApprovalAction: any
  handleAttachWindow: any
  handleBridgeCommand: any
  handleCancel: any
  handleClearDiscordContext: any
  handleCopyCurrentTranscript: any
  handleCreateGithubPr: any
  handleDeleteQueuedMessage: any
  handleDetachWindow: any
  handleEditQueuedMessage: any
  handleGroundImportedPlanFiles: any
  handleNewGlobalChat: any
  handlePaletteCommand: any
  handlePermissionRetry: any
  handlePickImages: any
  handleProviderChange: any
  handleRemoveWorkspace: any
  handleRemoveExternalPathGrant: any
  handleRemoveExternalPathGrantsByPath: any
  handleRemoveImageAttachment: any
  handleReorderExternalPathGrants: any
  handleReorderQueuedMessages: any
  handleReviewCurrentDiff: any
  handleRun: any
  handleRunImportedPlan: any
  handleSelectExistingWorkspace: any
  handleSelectMultiviewLayout: any
  handleSelectParticipant: any
  handleSelectWorkspace: any
  handleSetAgenticWorkspaceGrant: any
  handleBlackboardQueuedMessage: any
  handleSteer: any
  handleSteerToQueuedMessage: any
  handleStopWorkSession: any
  handleToggleWelcomeEnsemble: any
  handleTrustWorkspaceClick: any
  imageAttachments: any
  intentNote: any
  interfaceStyle: any
  isAttachingWindow: any
  /** Monotonic external request to open slash commands. */
  openSlashCommandsRequestId: number
  isCurrentChatBusyForSteer: any
  isCurrentChatProviderLocked: any
  isCurrentChatRunning: any
  isCurrentChatLinkedChild: boolean
  isCurrentComposerLocked: any
  isCurrentEnsembleChat: any
  isCurrentEnsembleRoundRunning: any
  isCurrentGlobalChat: any
  isEnsembleModeEnabled: any
  isPreparingDiffReview: any
  isSteerBusyForCurrentChat: any
  isWelcomeChat: any
  isWorkflowChatWelcome: any
  isWorkflowComposeChat: any
  kimiThinkingEnabled: any
  lastNonCustomModelType: any
  liveRunOutputTokens: any
  markCurrentGoalBlocked: any
  markPersistentSessionRestartNeeded: any
  multiview: any
  onOllamaModelSelected?: (modelId: string, modelLabel?: string) => void
  onCopyHumanCollaborationInvite?: (options?: { allowLanOnly?: boolean }) =>
    | Promise<HumanCollaborationInviteCopyResult>
    | HumanCollaborationInviteCopyResult
    | void
  onCopyHumanCollaborationInviteText?: (invitePayload: string) => Promise<boolean> | boolean
  onStopHumanCollaborationSharing?: () => void
  onOpenHumanCollaborationRemoteSetup?: () => void
  onRefreshHumanCollaborationInviteHealth?: () =>
    | Promise<HumanCollaborationInviteHealth>
    | HumanCollaborationInviteHealth
    | void
  openDiscordContextPicker: any
  openGoalPopover: any
  openInspectorTab: any
  openPlanImportReview: any
  openSideChatFromSlashCommand: (sideCommand: SideSlashCommand) => boolean | void
  overestimatePercent: any
  patchEnsembleParticipantById: any
  pendingAgentApproval: any
  pendingApprovalQueueByChatId: any
  pendingPlanImport: any
  permissionRequestMessage: any
  permissionRequestPaths: any
  permissionRequestSource: any
  permissionRequestTitle: any
  persistExternalPathGrantPrompt: any
  persistentSessionNeedsRestart: any
  planImportExecutionEstimate: any
  planImportGroundingBusy: any
  planImportGroundingDisabledReason: any
  primaryGitSnapshot: any
  composerWorktreeSelection?: any
  onComposerWorktreeChange?: any
  primaryModifierLabel: any
  primaryPr: any
  primaryCi?: any
  onNotifyThreadOfCi?: (notice: any) => void
  providerRates: any
  queuedMessagesAboveRowEntries: any
  queuedRunQueueCount: any
  refreshWorkflowState: any
  rememberCurrentChatComposerSelection: any
  renderPlanImportFileGroundings: any
  renderPlanImportItems: any
  resumeAppWatchSnapshot: any
  runtimeProfileControl: any
  scheduleControls: any
  screenWatchUnavailableReason: any
  selectedComposerModelType: any
  selectedModelType: any
  selectedRuntimeProfileId?: string | null
  selectedParticipant: any
  sessionRestartReason: any
  sessionTrust: any
  sessionYoloMode: any
  setApprovalMode: any
  setChatPromptDraft: any
  setChats: any
  setClaudeFastMode: any
  setClaudeReasoningEffort: any
  setCodexReasoningEffort: any
  setCodexServiceTier: any
  setGrokReasoningEffort: any
  setCursorReasoningEffort: any
  setCursorFastMode: any
  setCurrentChat: any
  setCustomModel: any
  setDiffActionMenuOpen: any
  setGoalDraft: any
  setGoalEditing: any
  setGoalFromObjective: any
  setGoalPopoverOpen: any
  setIntentNote: any
  setKimiThinkingEnabled: any
  setLastNonCustomModelType: any
  setPendingElevation: any
  setPendingPlanImport: any
  setPlanImportPolicy: any
  setPrimaryGitSnapshot: any
  setRawLogs: any
  setSelectedModelType: any
  setSessionTrust: any
  setShowWorkSessionSheet: any
  setWorkflowDraft: any
  settings: any
  shouldShowGhostCompanion: any
  shouldShowWelcomeStandaloneHeatmaps: any
  showComposerChips: any
  steerIndicatorMessage: any
  syncPersistentModelSelection: any
  threadTokenTallyHasValue: any
  threadTokenTallyTooltip: any
  trustResult: any
  trustSelectValue: any
  updateCurrentEnsembleConcurrentMode: any
  updateCurrentEnsembleFanoutPolicy: (policy: EnsembleFanoutPolicy) => void
  updateCurrentEnsembleContextChars: any
  updateCurrentEnsembleMaxContinuationHops: any
  updateCurrentEnsembleOrchestrationMode: any
  updateCurrentGoalStatus: any
  updateSelectedParticipant: any
  visibleScheduledTasks: any
  welcomeCopy: any
  welcomeHeatmapSlots: any
  workflowDraft: any
  workflowForCurrentChat: any
  workflowMode?: ChatWorkflowMode
  workflowIntervalMinutes: any
  workspaceDiffStats: any
  workspaces: any
}

function ComposerPrimaryStack({
  enabled,
  children
}: {
  enabled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (!enabled) return <>{children}</>
  return <div className="composer-primary-stack">{children}</div>
}

const normalizeComposerWorkflowMode = (value: unknown): ChatWorkflowMode | null =>
  value === 'plan' || value === 'normal' ? value : null

function patchTouchesProviderOrModel(patch: Partial<EnsembleParticipant>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(patch, 'provider') ||
    Object.prototype.hasOwnProperty.call(patch, 'model')
  )
}

function ComposerInner(props: ComposerProps): React.JSX.Element {
  const {
    prompt,
    PLAN_IMPORT_CHIP_LABELS,
    PLAN_IMPORT_RISK_LABELS,
    PLAN_IMPORT_RUN_CONSTRAINT_LABELS,
    acknowledgedElevationDefaults,
    activeEnsembleFanoutPolicy,
    activeEnsembleOrchestrationMode,
    addImageAttachmentsToChat,
    agentModelsByProvider,
    agenticServices,
    agenticWorkspaceGrants,
    appearance,
    applyEnsemblePermissionsToAllParticipants,
    applyEnsembleRosterPreset,
    approvalMode,
    approvalTimeouts,
    attachedWindow,
    chatByIdRef,
    claudeFastMode,
    claudeReasoningEffort,
    claudeReasoningOptions,
    clearCurrentGoal,
    clearExternalPathGrantPrompt,
    clearImagePermissions,
    clearPlanImportIfDraftChanged,
    codexModels,
    codexReasoningEffort,
    codexReasoningOptions,
    codexServiceTier,
    grokReasoningEffort,
    cursorReasoningEffort,
    cursorFastMode,
    composerAboveBarStackAuraClass,
    composerAgentAuraClass,
    composerAreaRef,
    composerAriaLabel,
    composerFileAttachments,
    composerImageAttachments,
    composerPlaceholder,
    composerRunTimecodeStartedAt,
    composerSlashCommands,
    composerTokenTally,
    contextLabel,
    contextMeter,
    onCompactContext,
    onCompactParticipant,
    compactableParticipantIds,
    speakingParticipantId,
    contextModelId,
    contextUsedPercent,
    cumulativeRunBaseMs,
    currentActiveGoal,
    currentChat,
    currentChatIdRef,
    currentComposerChatId,
    currentComposerMentionParticipants,
    currentDiscordContextSelection,
    currentEnsembleFanoutPolicy,
    currentEnsembleContinuationHops,
    currentEnsembleMaxContinuationHops,
    currentEnsembleRoundStatus,
    currentEnsembleActiveGoalStatus,
    currentEnsembleOrchestrationMode,
    currentGoalButtonTitle,
    currentGoalModeLabel,
    currentGoalStatus,
    humanCollaborationInviteActive,
    humanCollaborationShare,
    humanCollaborationInviteHealth,
    humanCollaborationInviteBusy,
    humanCollaborationInviteLive,
    currentProvider,
    currentProviderCapabilityWarning,
    currentProviderLabel,
    currentProviderModelOptions,
    currentWorkspace,
    currentWorkspacePath,
    cursorProviderAvailable,
    customModel,
    diffActionMenuOpen,
    displayCurrency,
    dualComposerTelemetry,
    effectiveSelectedParticipantId,
    ensembleBlendStyle,
    ensembleConcurrentLanesAvailable,
    ensembleConcurrentWriteLanesAvailable,
    ensembleEnabledParticipantsForCurrent,
    ensembleOllamaContextWarning,
    externalGitSnapshots,
    onExternalGitSnapshotRefresh,
    externalPrByPath,
    externalPathGrantPrompt,
    externalPathGrantPromptBusy,
    externalPathGrants,
    externalPathRepoMetadata,
    externalWorkspaceGroups,
    formatPlanImportCostEstimate,
    formatPlanImportRunConstraintValue,
    formatPlanImportTokenEstimate,
    geminiTrustWriteBusy,
    geminiTrustWriteError,
    geminiWorkspaceTrustReady,
    getCreatePrState,
    getProviderModelOptions,
    goalButtonRef,
    goalControlDisabledReason,
    goalDraft,
    goalEditing,
    goalPopoverOpen,
    goalPopoverPosition,
    goalPopoverRef,
    grokProviderAvailable,
    handleAddKnownWorkspaceAsSecondary,
    handleAddWorkspaceFolder,
    handleAgentApprovalAction,
    handleAttachWindow,
    handleBridgeCommand,
    handleCancel,
    handleClearDiscordContext,
    handleCopyCurrentTranscript,
    handleCreateGithubPr,
    handleDeleteQueuedMessage,
    handleDetachWindow,
    handleEditQueuedMessage,
    handleGroundImportedPlanFiles,
    handleNewGlobalChat,
    handlePaletteCommand,
    handlePermissionRetry,
    handlePickImages,
    handleProviderChange,
    handleRemoveWorkspace,
    handleRemoveExternalPathGrant,
    handleRemoveExternalPathGrantsByPath,
    handleRemoveImageAttachment,
    handleReorderExternalPathGrants,
    handleReorderQueuedMessages,
    handleReviewCurrentDiff,
    handleRun,
    handleRunImportedPlan,
    handleSelectExistingWorkspace,
    handleSelectMultiviewLayout,
    handleSelectParticipant,
    handleSelectWorkspace,
    handleSetAgenticWorkspaceGrant,
    handleBlackboardQueuedMessage,
    handleSteerToQueuedMessage,
    handleStopWorkSession,
    handleToggleWelcomeEnsemble,
    handleTrustWorkspaceClick,
    imageAttachments,
    intentNote,
    interfaceStyle,
    isAttachingWindow,
    openSlashCommandsRequestId,
    isCurrentChatProviderLocked,
    isCurrentChatRunning,
    isCurrentChatLinkedChild,
    isCurrentComposerLocked,
    isCurrentEnsembleChat,
    isCurrentEnsembleRoundRunning,
    isCurrentGlobalChat,
    isEnsembleModeEnabled,
    isPreparingDiffReview,
    isSteerBusyForCurrentChat,
    isWelcomeChat,
    isWorkflowChatWelcome,
    isWorkflowComposeChat,
    kimiThinkingEnabled,
    lastNonCustomModelType,
    liveRunOutputTokens,
    markCurrentGoalBlocked,
    markPersistentSessionRestartNeeded,
    multiview,
    onOllamaModelSelected,
    onCopyHumanCollaborationInvite,
    onCopyHumanCollaborationInviteText,
    onStopHumanCollaborationSharing,
    onOpenHumanCollaborationRemoteSetup,
    onRefreshHumanCollaborationInviteHealth,
    openDiscordContextPicker,
    openGoalPopover,
    openInspectorTab,
    openPlanImportReview,
    openSideChatFromSlashCommand,
    overestimatePercent,
    patchEnsembleParticipantById,
    pendingAgentApproval,
    pendingApprovalQueueByChatId,
    pendingPlanImport,
    permissionRequestMessage,
    permissionRequestPaths,
    permissionRequestSource,
    permissionRequestTitle,
    persistExternalPathGrantPrompt,
    persistentSessionNeedsRestart,
    planImportExecutionEstimate,
    planImportGroundingBusy,
    planImportGroundingDisabledReason,
    primaryGitSnapshot,
    composerWorktreeSelection,
    onComposerWorktreeChange,
    primaryModifierLabel,
    primaryPr,
    primaryCi,
    onNotifyThreadOfCi,
    providerRates,
    queuedMessagesAboveRowEntries,
    queuedRunQueueCount,
    refreshWorkflowState,
    rememberCurrentChatComposerSelection,
    renderPlanImportFileGroundings,
    renderPlanImportItems,
    resumeAppWatchSnapshot,
    scheduleControls,
    screenWatchUnavailableReason,
    selectedComposerModelType,
    selectedModelType,
    selectedRuntimeProfileId,
    selectedParticipant,
    sessionRestartReason,
    sessionTrust,
    sessionYoloMode,
    setApprovalMode,
    setChatPromptDraft,
    setChats,
    setClaudeFastMode,
    setClaudeReasoningEffort,
    setCodexReasoningEffort,
    setCodexServiceTier,
    setGrokReasoningEffort,
    setCursorReasoningEffort,
    setCursorFastMode,
    setCurrentChat,
    setCustomModel,
    setDiffActionMenuOpen,
    setGoalDraft,
    setGoalEditing,
    setGoalFromObjective,
    setGoalPopoverOpen,
    setIntentNote,
    setKimiThinkingEnabled,
    setLastNonCustomModelType,
    setPendingElevation,
    setPendingPlanImport,
    setPlanImportPolicy,
    setPrimaryGitSnapshot,
    setRawLogs,
    setSelectedModelType,
    setSessionTrust,
    setShowWorkSessionSheet,
    setWorkflowDraft,
    settings,
    shouldShowGhostCompanion,
    shouldShowWelcomeStandaloneHeatmaps,
    showComposerChips,
    steerIndicatorMessage,
    syncPersistentModelSelection,
    threadTokenTallyHasValue,
    threadTokenTallyTooltip,
    trustResult,
    trustSelectValue,
    updateCurrentEnsembleFanoutPolicy,
    updateCurrentEnsembleContextChars,
    updateCurrentEnsembleMaxContinuationHops,
    updateCurrentEnsembleOrchestrationMode,
    updateCurrentGoalStatus,
    updateSelectedParticipant,
    visibleScheduledTasks,
    welcomeCopy,
    welcomeHeatmapSlots,
    workflowDraft,
    workflowForCurrentChat,
    workflowMode,
    workflowIntervalMinutes,
    workspaceDiffStats,
    workspaces
  } = props
  const hasSendablePromptContent = hasAttachmentPromptContent(prompt, imageAttachments)
  const [scheduledNowMs, setScheduledNowMs] = useState(() => Date.now())
  const [seatChangeNoticeRoundKey, setSeatChangeNoticeRoundKey] = useState<string | null>(null)
  const [dismissedSeatChangeNoticeRoundKey, setDismissedSeatChangeNoticeRoundKey] = useState<
    string | null
  >(null)
  const activeSeatChangeNoticeRoundKey =
    isCurrentEnsembleChat &&
    isCurrentEnsembleRoundRunning &&
    currentChat?.appChatId &&
    currentChat.ensemble?.activeRound?.roundId
      ? `${currentChat.appChatId}:${currentChat.ensemble.activeRound.roundId}`
      : null
  const showSeatChangeNextRoundNotice =
    Boolean(activeSeatChangeNoticeRoundKey) &&
    seatChangeNoticeRoundKey === activeSeatChangeNoticeRoundKey &&
    dismissedSeatChangeNoticeRoundKey !== activeSeatChangeNoticeRoundKey
  const updateSelectedParticipantWithNotice = (patch: Partial<EnsembleParticipant>): void => {
    if (
      activeSeatChangeNoticeRoundKey &&
      dismissedSeatChangeNoticeRoundKey !== activeSeatChangeNoticeRoundKey &&
      patchTouchesProviderOrModel(patch)
    ) {
      setSeatChangeNoticeRoundKey(activeSeatChangeNoticeRoundKey)
    }
    updateSelectedParticipant(patch)
  }

  useEffect(() => {
    if (seatChangeNoticeRoundKey && seatChangeNoticeRoundKey !== activeSeatChangeNoticeRoundKey) {
      setSeatChangeNoticeRoundKey(null)
    }
  }, [activeSeatChangeNoticeRoundKey, seatChangeNoticeRoundKey])

  const hasVisibleScheduledCountdown =
    Array.isArray(visibleScheduledTasks) &&
    visibleScheduledTasks.some((task: any) => task?.status === 'pending' || task?.status === 'due')
  const writerFanoutPolicy: EnsembleFanoutPolicy = currentChat?.ensemble?.bossmanParticipantId
    ? 'locked_writers_with_boss'
    : 'locked_writers_user_preflight'
  const goalControlDisabled = !currentChat || Boolean(goalControlDisabledReason)
  const goalControlTitle = goalControlDisabledReason || currentGoalButtonTitle
  const hasGoalRuntimeTicker =
    goalPopoverOpen &&
    Boolean(currentActiveGoal?.runtimeLedger) &&
    currentActiveGoal?.status !== 'completed'
  const goalRuntimeLabel = formatGoalRuntimePopoverLabel(currentActiveGoal, scheduledNowMs)

  // Second row of the roster-presets above-row section — Orchestration /
  // Fan-Out / Shared History Budget / Turn Budget. These controls used to
  // crowd the composer's bottom action row (especially with Continuous
  // enabled); they now get a full row of their own. Built once here because
  // BOTH roster-preset picker call sites embed it via `secondRow` (the
  // ensemble welcome hero and the compact in-thread above-row) and the two
  // must never drift.
  const renderEnsembleOrchestrationRow = (): React.JSX.Element | null => {
    if (!isCurrentEnsembleChat || !currentChat?.ensemble) return null
    return (
      <EnsembleOrchestrationRow
        orchestrationMode={
          currentEnsembleOrchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
        }
        activeOrchestrationMode={
          activeEnsembleOrchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
        }
        activeFanoutPolicy={activeEnsembleFanoutPolicy}
        isRoundRunning={isCurrentEnsembleRoundRunning}
        workSessionActive={
          currentChat.ensemble.workSession?.status === 'active' ||
          currentChat.ensemble.workSession?.status === 'paused'
        }
        composerStyle={appearance.composerStyle}
        onSelectMode={(nextMode) => updateCurrentEnsembleOrchestrationMode(nextMode)}
        onOpenWorkSession={() => setShowWorkSessionSheet(true)}
        fanoutPolicy={currentEnsembleFanoutPolicy}
        writerFanoutPolicy={writerFanoutPolicy}
        onFanoutPolicyChange={updateCurrentEnsembleFanoutPolicy}
        concurrentLanesAvailable={ensembleConcurrentLanesAvailable}
        concurrentWriteLanesAvailable={ensembleConcurrentWriteLanesAvailable}
        bossmanAssigned={Boolean(currentChat.ensemble.bossmanParticipantId)}
        contextChars={currentChat.ensemble.ensembleContextChars}
        onContextCharsChange={updateCurrentEnsembleContextChars}
        ollamaContextWarning={ensembleOllamaContextWarning}
        continuationHops={currentEnsembleContinuationHops}
        maxContinuationHops={currentEnsembleMaxContinuationHops}
        roundStatus={currentEnsembleRoundStatus}
        activeGoalStatus={currentEnsembleActiveGoalStatus}
        onMaxContinuationHopsChange={updateCurrentEnsembleMaxContinuationHops}
      />
    )
  }

  useEffect(() => {
    if (!hasVisibleScheduledCountdown && !hasGoalRuntimeTicker) return
    const interval = window.setInterval(() => setScheduledNowMs(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [hasGoalRuntimeTicker, hasVisibleScheduledCountdown])

  const agentApprovalCardRef = useRef<HTMLDivElement | null>(null)
  const agentApprovalAppearedAtRef = useRef<number | null>(null)
  const [agentApprovalCountdownMs, setAgentApprovalCountdownMs] = useState<number | null>(null)
  const [trustedSessionConfirmOpen, setTrustedSessionConfirmOpen] = useState(false)
  const [trustedSessionApprovalId, setTrustedSessionApprovalId] = useState<string | null>(null)
  const agentApprovalTimeoutMs = pendingAgentApproval
    ? resolveApprovalTimeoutMs(pendingAgentApproval, approvalTimeouts)
    : null

  const confirmTrustedSessionForLane = async (): Promise<void> => {
    const approvalId = trustedSessionApprovalId
    const approvalParticipantId =
      approvalId && pendingAgentApproval?.id === approvalId
        ? pendingAgentApproval.preview?.ensembleParticipant?.participantId
        : null
    const approvalParticipant =
      approvalParticipantId && currentChat?.ensemble
        ? currentChat.ensemble.participants.find((participant) => participant.id === approvalParticipantId)
        : null
    const targetParticipant =
      approvalParticipant || (isCurrentEnsembleChat && selectedParticipant ? selectedParticipant : null)
    if (!currentChat?.appChatId) {
      setTrustedSessionConfirmOpen(false)
      setTrustedSessionApprovalId(null)
      return
    }
    const grantResult = await window.api.trustedSessionSet(
      {
        chatId: currentChat.appChatId,
        provider: targetParticipant?.provider || currentProvider,
        workspacePath: currentWorkspacePath || currentChat.workspacePath || null,
        ensembleParticipantId: targetParticipant?.id || null,
        runtimeProfileId:
          targetParticipant?.runtimeProfileId || selectedRuntimeProfileId || null
      },
      true
    )
    if (!grantResult?.enabled) {
      window.alert(grantResult?.error || 'Trusted Session could not be started for this lane.')
      return
    }
    setTrustedSessionConfirmOpen(false)
    setTrustedSessionApprovalId(null)
    if (approvalParticipantId && currentChat?.ensemble) {
      patchEnsembleParticipantById(approvalParticipantId, { permissionPresetId: 'full_access' })
    } else if (isCurrentEnsembleChat && selectedParticipant) {
      updateSelectedParticipantWithNotice({ permissionPresetId: 'full_access' })
    } else {
      setApprovalMode('auto_edit')
      rememberCurrentChatComposerSelection({
        approvalMode: 'auto_edit',
        workflowMode: 'normal',
        permissionPresetId: 'full_access'
      })
    }
    if (approvalId) {
      await handleAgentApprovalAction(approvalId, 'accept')
    }
  }

  useEffect(() => {
    if (!pendingAgentApproval) {
      agentApprovalAppearedAtRef.current = null
      setAgentApprovalCountdownMs(null)
      return
    }
    agentApprovalAppearedAtRef.current = Date.now()
    const focusTimer = window.setTimeout(() => {
      agentApprovalCardRef.current
        ?.querySelector<HTMLButtonElement>(
          '.composer-permission-actions .segmented-control-action--primary'
        )
        ?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [pendingAgentApproval?.id])

  useEffect(() => {
    if (!pendingAgentApproval || agentApprovalTimeoutMs == null) {
      setAgentApprovalCountdownMs(null)
      return
    }
    const appearedAt = agentApprovalAppearedAtRef.current ?? Date.now()
    const tick = (): void => {
      const remaining = appearedAt + agentApprovalTimeoutMs - Date.now()
      setAgentApprovalCountdownMs(Math.max(0, remaining))
    }
    tick()
    const interval = window.setInterval(tick, 1_000)
    return () => window.clearInterval(interval)
  }, [agentApprovalTimeoutMs, pendingAgentApproval?.id])

  // ---------------------------------------------------------------------------
  // Composer-local editor state (Slices B + C of the multiview composer-parity
  // fix).
  //
  // These were hoisted out of App.tsx and made component-local so multiple
  // <Composer> instances (one per multiview pane) own independent editor state
  // instead of clobbering a single shared App-level textarea ref / menu-open
  // booleans. Behavior-preserving for the focused composer (the only instance
  // today): each moved piece references the same external deps via props.
  //
  // Slice C — the SLASH cluster moved here too: composerTextareaRef + the
  // slash-menu state (slashMenuOpen / slashQuery / slashAnchorIndexRef) + the
  // slash dispatch/submit handlers (handleComposerSlash / tryHandleSideSlashSubmit
  // / tryHandleActionSlashSubmit) + the token helpers
  // (promptWithoutCurrentSlashToken / consumeSlashTokenFromPrompt). They all
  // operate on THIS composer's textarea + `currentComposerChatId` (written via
  // the setChatPromptDraft prop). App-level slash `run()` closures receive a
  // SlashCommandRunContext built here (see buildSlashRunContext below) instead
  // of reaching into App's single shared composer globals.
  // ---------------------------------------------------------------------------

  // Composer textarea ref. The live <textarea> element for THIS composer
  // instance. Used by the caret-restore layout effect, the mention/slash
  // popovers (anchor), the context menu, and the slash-token machinery.
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerContextMenu = useComposerTextareaContextMenu()
  // Slash-command picker state. Same shape as the mention menu — visibility
  // flag, current filter substring (what comes after the leading `/`), and an
  // anchor index pointing at the `/` we'll later replace on pick. Mutually
  // exclusive with mentionMenuOpen — only one popover at a time.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const slashAnchorIndexRef = useRef<number | null>(null)

  // Composer textarea @-mention popover state. AgentMentionMenu can insert
  // agent markdown mentions or plain path text at the caret.
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  // Caret position of the `@` (or `-` of `-@`) that opened the menu —
  // used to splice the picked mention back over the trigger.
  const mentionAnchorIndexRef = useRef<number | null>(null)
  /**
   * 1.0.4-AQ3 — composer textarea selection ref + epoch.
   *
   * Captures `{ start, end }` immediately on every `onChange` so a
   * post-commit layout effect can restore the caret if React's
   * controlled-input caret preservation didn't fire correctly. The
   * preservation glitches when the textarea's className flips
   * mid-keystroke — specifically when `composerHasMention` flips
   * `false → true` once an `@token` resolves, adding the
   * `has-mention-overlay` class AND mounting the
   * `ComposerHighlightOverlay` sibling in the same commit.
   */
  const composerSelectionRef = useRef<{ start: number; end: number } | null>(null)
  const composerCaretRestoreEpochRef = useRef(0)
  // Which trigger fired the popover. `'mention'` (`@`) → sub-agents
  // (normal chats) or participants (ensemble); `'file-mention'`
  // (`-@`) → workspace files + external grants.
  const [mentionTriggerKind, setMentionTriggerKind] = useState<'mention' | 'file-mention'>(
    'mention'
  )
  const mentionTriggerLengthRef = useRef<number>(1)
  const [isSendConfirming, setIsSendConfirming] = useState(false)
  const [isComposerDragOver, setIsComposerDragOver] = useState(false)
  const [voiceCaptureState, setVoiceCaptureState] = useState<ComposerVoiceCaptureState>(
    EMPTY_COMPOSER_VOICE_CAPTURE_STATE
  )
  const latestPromptRef = useRef(prompt)
  const latestComposerChatIdRef = useRef(currentComposerChatId)
  const voicePickerProvider: ProviderId =
    isCurrentEnsembleChat && selectedParticipant ? selectedParticipant.provider : currentProvider
  const voicePlacement = composerVoicePlacementForStyle(appearance.composerStyle)
  const voiceButtonLivesWithPermissions = voicePlacement === 'permissions'
  const voiceButtonLivesInActionRow = voicePlacement === 'action-row'
  const voiceButtonLivesInSendCluster = voicePlacement === 'send-cluster'
  const imageDragCounterRef = useRef(0)
  const sendConfirmationTimeoutRef = useRef<number | null>(null)
  const sendConfirmationRafRef = useRef<number | null>(null)

  useEffect(() => {
    latestPromptRef.current = prompt
  }, [prompt])

  useEffect(() => {
    latestComposerChatIdRef.current = currentComposerChatId
  }, [currentComposerChatId])

  const parseSlashTokenBeforeCaret = (
    text: string,
    caret: number
  ): { anchor: number; query: string } | null => {
    const safeCaret = Math.max(0, Math.min(caret, text.length))
    const before = text.slice(0, safeCaret)
    const slashMatch = before.match(/(?:^|\s)\/([\w-]*)$/)
    if (!slashMatch) return null
    const query = slashMatch[1] || ''
    return {
      anchor: safeCaret - query.length - 1,
      query
    }
  }

  /**
   * Open the slash command menu at the current textarea cursor.
   * Reuses an existing slash token immediately before the caret when present.
   * Otherwise inserts a fresh slash trigger at the caret without discarding
   * existing draft text. If the caret is adjacent to a word, insert a leading
   * space too so subsequent query typing still matches the slash-token parser.
   */
  const openSlashCommandsMenu = (): void => {
    const ta = composerTextareaRef.current
    const text = prompt
    const caret = ta?.selectionStart ?? text.length
    const safeCaret = Math.max(0, Math.min(caret, text.length))
    const token = parseSlashTokenBeforeCaret(text, safeCaret)
    const query = token ? token.query : ''
    const needsLeadingSpace = !token && safeCaret > 0 && !/\s/.test(text[safeCaret - 1])
    const insertedTrigger = needsLeadingSpace ? ' /' : '/'
    const anchor = token ? token.anchor : safeCaret + (needsLeadingSpace ? 1 : 0)

    if (!token) {
      setChatPromptDraft(
        currentComposerChatId,
        `${text.slice(0, safeCaret)}${insertedTrigger}${text.slice(safeCaret)}`
      )
    }

    slashAnchorIndexRef.current = anchor
    setSlashQuery(query)
    setSlashMenuOpen(true)
    if (mentionMenuOpen) {
      setMentionMenuOpen(false)
      setMentionQuery('')
      mentionAnchorIndexRef.current = null
    }
    requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current
      if (!textarea) return
      const nextCaret = anchor + 1 + query.length
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
    })
  }

  // 1.0.4-AQ3 — caret-restore layout effect. Snapshots the caret in
  // `onChange` (before React reconciles), then re-applies it post-commit
  // if it doesn't already match. Only runs when the textarea is focused
  // (otherwise we'd hijack the caret from other inputs that share renders).
  useLayoutEffect(() => {
    const ta = composerTextareaRef.current
    const stored = composerSelectionRef.current
    if (!ta || !stored) return
    // Only restore when the textarea is the active element. If
    // focus moved elsewhere (slash-picker click, mention popover,
    // send button), the snapshot is stale and we'd jump the caret
    // into a backgrounded input on next focus.
    if (typeof document !== 'undefined' && document.activeElement !== ta) return
    // Skip if React already preserved the caret correctly.
    if (ta.selectionStart === stored.start && ta.selectionEnd === stored.end) return
    try {
      ta.setSelectionRange(stored.start, stored.end)
    } catch {
      // Some browsers throw if the textarea is disabled/readonly
      // at the moment of restore. The user re-typed; they can
      // retry. Better than a thrown error breaking the round.
    }
  }, [prompt])

  useEffect(() => {
    if (openSlashCommandsRequestId <= 0) return
    openSlashCommandsMenu()
  }, [openSlashCommandsRequestId])

  const triggerSendConfirmation = () => {
    if (!currentChat || (!isCurrentGlobalChat && !currentWorkspace) || !hasSendablePromptContent) return
    if (sendConfirmationTimeoutRef.current) {
      window.clearTimeout(sendConfirmationTimeoutRef.current)
      sendConfirmationTimeoutRef.current = null
    }
    if (sendConfirmationRafRef.current) {
      window.cancelAnimationFrame(sendConfirmationRafRef.current)
      sendConfirmationRafRef.current = null
    }
    setIsSendConfirming(false)
    sendConfirmationRafRef.current = window.requestAnimationFrame(() => {
      sendConfirmationRafRef.current = null
      setIsSendConfirming(true)
      sendConfirmationTimeoutRef.current = window.setTimeout(() => {
        setIsSendConfirming(false)
        sendConfirmationTimeoutRef.current = null
      }, 620)
    })
  }

  // Clear the send-confirmation rAF/timer on unmount. A multiview pane can
  // unmount mid-animation (the focus-steal swaps the focused cell from
  // <ChatViewPane> to the inline render within the 620ms window), and
  // setIsSendConfirming must not fire on an unmounted <Composer> instance.
  useEffect(
    () => () => {
      if (sendConfirmationTimeoutRef.current) {
        window.clearTimeout(sendConfirmationTimeoutRef.current)
      }
      if (sendConfirmationRafRef.current) {
        window.cancelAnimationFrame(sendConfirmationRafRef.current)
      }
    },
    []
  )

  const handleComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    imageDragCounterRef.current += 1
    // Detect an incoming file drag from `.types` (readable in protected mode).
    // `.files`/paths aren't exposed until `drop`, so resolving paths here (the
    // old check) never lit the drop-zone highlight for real OS file drags.
    if (dataTransferHasFiles(event.dataTransfer)) {
      setIsComposerDragOver(true)
    }
  }

  const handleComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    imageDragCounterRef.current -= 1
    if (imageDragCounterRef.current <= 0) {
      setIsComposerDragOver(false)
      imageDragCounterRef.current = 0
    }
  }

  const handleComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    imageDragCounterRef.current = 0
    setIsComposerDragOver(false)

    const paths = collectDroppedAttachmentPaths(event.dataTransfer)
    if (paths.length === 0) {
      return
    }

    const targetChatId = currentComposerChatId
    if (!targetChatId) return
    void addImageAttachmentsToChat(targetChatId, paths)
    if (imageAttachments.length + paths.length > MAX_IMAGE_ATTACHMENTS) {
      setRawLogs((prev) => [
        ...prev,
        {
          type: 'info',
          content: `Attachment limit reached (${MAX_IMAGE_ATTACHMENTS}); oldest files were removed.`
        }
      ])
    }
  }

  const handleComposerPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const targetChatId = currentComposerChatId
    const pastedText = event.clipboardData?.getData('text/plain') || ''
    if (shouldOfferPlanImport(pastedText)) {
      const target = event.currentTarget
      const selectionStart = target.selectionStart ?? target.value.length
      const selectionEnd = target.selectionEnd ?? selectionStart
      const nextDraft = `${target.value.slice(0, selectionStart)}${pastedText}${target.value.slice(selectionEnd)}`
      openPlanImportReview(nextDraft, { silentUnsupported: true })
    }

    let paths = collectClipboardAttachmentPaths(event.clipboardData)
    if (paths.length === 0) {
      const hasImageItem = Array.from(event.clipboardData?.items || []).some((item) =>
        item.type.startsWith('image/')
      )
      if (!hasImageItem) {
        return
      }
      const saved = await window.api.saveClipboardImageAttachment()
      paths = saved || []
    }
    if (paths.length === 0) {
      return
    }
    event.preventDefault()
    if (!targetChatId) return
    void addImageAttachmentsToChat(targetChatId, paths)
    if (imageAttachments.length + paths.length > MAX_IMAGE_ATTACHMENTS) {
      setRawLogs((prev) => [
        ...prev,
        {
          type: 'info',
          content: `Attachment limit reached (${MAX_IMAGE_ATTACHMENTS}); oldest files were removed.`
        }
      ])
    }
  }

  // ---------------------------------------------------------------------------
  // Slash-command machinery (Slice C — moved verbatim from App.tsx).
  //
  // All of these operate on THIS composer's textarea ref + slash state +
  // `currentComposerChatId` (written via the setChatPromptDraft prop). The
  // only change from the App originals is `setPrompt(x)` →
  // `setChatPromptDraft(currentComposerChatId, x)`, which is equivalent for the
  // focused composer (currentChat === focused pane) and instance-correct per
  // pane. App-level action `run()` closures receive a SlashCommandRunContext
  // built by buildSlashRunContext() so they never touch App composer globals.
  // ---------------------------------------------------------------------------

  /**
   * Strip the slash token (`/<query>`) the user typed to open the picker
   * from the composer prompt, leaving the caret at the position where
   * the slash used to be. Used after a slash-command dispatches so the
   * picker's trigger character doesn't end up sent to the provider.
   */
  const promptWithoutCurrentSlashToken = (): string => {
    const anchor = slashAnchorIndexRef.current
    if (anchor === null) return prompt
    const tokenLength = 1 + slashQuery.length // `/` + query chars
    const before = prompt.slice(0, anchor)
    const after = prompt.slice(anchor + tokenLength)
    return `${before}${after}`
  }

  const consumeSlashTokenFromPrompt = (): void => {
    const anchor = slashAnchorIndexRef.current
    if (anchor === null) return
    const before = prompt.slice(0, anchor)
    const next = promptWithoutCurrentSlashToken()
    setChatPromptDraft(currentComposerChatId, next)
    requestAnimationFrame(() => {
      const ta = composerTextareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(before.length, before.length)
    })
  }

  /** Focus this composer's textarea, optionally placing the caret at `caret`
   * (defaults to leaving the current selection in place). */
  const focusComposerTextarea = (caret?: number): void => {
    requestAnimationFrame(() => {
      const ta = composerTextareaRef.current
      if (!ta) return
      ta.focus()
      if (caret !== undefined) {
        ta.setSelectionRange(caret, caret)
      }
    })
  }

  const handleVoiceTranscript = (transcript: string): void => {
    const baseDraft = latestPromptRef.current
    const targetChatId = latestComposerChatIdRef.current
    const nextDraft = appendComposerVoiceTranscript(baseDraft, transcript)
    if (nextDraft === baseDraft) return
    setChatPromptDraft(targetChatId, nextDraft)
    clearPlanImportIfDraftChanged(nextDraft)
    focusComposerTextarea(nextDraft.length)
  }

  /** Build the context handed to an action command's `run()`. Computed against
   * THIS composer's draft + slash state so App-level closures operate on the
   * invoking pane. */
  const buildSlashRunContext = (options?: {
    consumeSlashToken?: () => void
    dispatchSource?: SlashCommandRunContext['dispatchSource']
    onSetDraft?: () => void
    promptWithoutSlashToken?: string
  }): SlashCommandRunContext => ({
    rawPrompt: prompt,
    promptWithoutSlashToken: options?.promptWithoutSlashToken ?? promptWithoutCurrentSlashToken(),
    dispatchSource: options?.dispatchSource,
    consumeSlashToken: options?.consumeSlashToken ?? consumeSlashTokenFromPrompt,
    setDraft: (value: string) => {
      options?.onSetDraft?.()
      setChatPromptDraft(currentComposerChatId, value)
    },
    focusComposer: focusComposerTextarea
  })

  const tryHandleSideSlashSubmit = (): boolean => {
    const sideCommand = parseSideSlashCommand(prompt)
    if (!sideCommand) return false
    const shouldClearDraft = openSideChatFromSlashCommand(sideCommand) !== false
    if (shouldClearDraft) {
      setChatPromptDraft(currentComposerChatId, '')
    }
    setSlashMenuOpen(false)
    setSlashQuery('')
    slashAnchorIndexRef.current = null
    return true
  }

  /**
   * Slash-picker dispatch — discriminated by command `kind`. Reuses the
   * existing handlePaletteCommand for palette-passthrough kinds so the
   * dispatch shape doesn't fork. Strips the slash trigger token from
   * the prompt in every branch so the literal `/whatever` characters
   * never reach the provider.
   */
  const handleComposerSlash = (command: ComposerSlashCommand): void => {
    setSlashMenuOpen(false)
    setSlashQuery('')
    const dispatch = () => {
      switch (command.kind) {
        case 'palette-passthrough':
          if (
            command.paletteItem.source !== 'core' &&
            hasSlashCommandPlaceholders(command.command)
          ) {
            const prefix = slashCommandDispatchPrefix(command.command)
            const next = prefix ? `${prefix} ` : command.command
            setChatPromptDraft(currentComposerChatId, next)
            focusComposerTextarea(next.length)
            return
          }
          if (handlePaletteCommand(command.paletteItem) === false) {
            setChatPromptDraft(currentComposerChatId, prompt)
            focusComposerTextarea(prompt.length)
          }
          return
        case 'action':
          void command.run(buildSlashRunContext({ dispatchSource: 'picker' }))
          return
        case 'prompt-template':
          // Insert the template at the slash position; caller can keep
          // typing to fill in template-specific arguments.

          {
            const anchor = slashAnchorIndexRef.current ?? 0
            const tokenLength = 1 + slashQuery.length
            const before = prompt.slice(0, anchor)
            const after = prompt.slice(anchor + tokenLength)
            const next = `${before}${command.template}${after}`
            setChatPromptDraft(currentComposerChatId, next)
            const caretBase = before.length + (command.cursorOffset ?? command.template.length)
            requestAnimationFrame(() => {
              const ta = composerTextareaRef.current
              if (!ta) return
              ta.focus()
              ta.setSelectionRange(caretBase, caretBase)
            })
            slashAnchorIndexRef.current = null
          }
          return
        case 'insert':
          {
            const anchor = slashAnchorIndexRef.current ?? 0
            const tokenLength = 1 + slashQuery.length
            const before = prompt.slice(0, anchor)
            const after = prompt.slice(anchor + tokenLength)
            const next = `${before}${command.insertText}${after}`
            setChatPromptDraft(currentComposerChatId, next)
            const caretBase = before.length + command.insertText.length
            requestAnimationFrame(() => {
              const ta = composerTextareaRef.current
              if (!ta) return
              ta.focus()
              ta.setSelectionRange(caretBase, caretBase)
            })
            slashAnchorIndexRef.current = null
          }
          return
      }
    }
    // For dispatch kinds that consume the token themselves (insert /
    // template), skip the generic strip. For everything else (palette-
    // passthrough / action), strip the slash token first
    // so the next user prompt starts clean.
    if (command.kind !== 'insert' && command.kind !== 'prompt-template') {
      consumeSlashTokenFromPrompt()
    }
    dispatch()
    slashAnchorIndexRef.current = null
  }

  /**
   * Submit-time dispatch for registered slash commands. The slash MENU fires a
   * command on selection, but typing the full command and pressing Enter closes
   * the menu first. Without this, `/status`, `/audit quick`, or `/explain`
   * would go to the provider as normal chat text instead of invoking the
   * registered slash behavior.
   */
  const tryHandleActionSlashSubmit = (): boolean => {
    const match = matchLeadingSlashCommand(prompt, composerSlashCommands)
    if (!match) return false
    const command = match.command
    setSlashMenuOpen(false)
    setSlashQuery('')
    slashAnchorIndexRef.current = null
    if (command.kind === 'action') {
      let actionWroteDraft = false
      // run() reads the current prompt through SlashCommandRunContext. Clear the
      // literal slash command after dispatch unless the action deliberately wrote
      // a replacement draft (for example /import-plan or /compact scaffolds).
      void command.run(
        buildSlashRunContext({
          dispatchSource: 'submit',
          onSetDraft: () => {
            actionWroteDraft = true
          }
        })
      )
      if (!actionWroteDraft) {
        setChatPromptDraft(currentComposerChatId, '')
      }
      return true
    }
    if (command.kind === 'palette-passthrough') {
      const dispatchCommand =
        command.paletteItem.source !== 'core'
          ? slashCommandDispatchPrefix(command.command) || command.command
          : command.command
      const paletteItem =
        match.remainder && command.paletteItem.source !== 'core'
          ? {
              ...command.paletteItem,
              command: `${dispatchCommand} ${match.remainder}`
            }
          : dispatchCommand !== command.paletteItem.command
            ? { ...command.paletteItem, command: dispatchCommand }
            : command.paletteItem
      const shouldClearDraft = handlePaletteCommand(paletteItem) !== false
      if (shouldClearDraft) {
        setChatPromptDraft(currentComposerChatId, '')
      }
      return true
    }
    if (command.kind === 'prompt-template') {
      const next = match.remainder ? `${command.template}${match.remainder}` : command.template
      setChatPromptDraft(currentComposerChatId, next)
      const caretBase = command.cursorOffset ?? command.template.length
      requestAnimationFrame(() => {
        const ta = composerTextareaRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(caretBase, caretBase)
      })
      return true
    }
    return false
  }

  const tryHandleInlineGoalSlashSubmit = (): boolean => {
    const command = composerSlashCommands.find(
      (entry): entry is ComposerSlashCommand & { kind: 'action' } =>
        entry.kind === 'action' && entry.command.toLowerCase() === '/goal'
    )
    if (!command) return false
    const tokenMatch = matchStandaloneSlashCommandToken(prompt, command.command)
    if (!tokenMatch) return false
    setSlashMenuOpen(false)
    setSlashQuery('')
    slashAnchorIndexRef.current = null
    let actionWroteDraft = false
    const consumeSlashToken = (): void => {
      setChatPromptDraft(currentComposerChatId, tokenMatch.promptWithoutToken)
      focusComposerTextarea(tokenMatch.start)
    }
    void command.run(
      buildSlashRunContext({
        consumeSlashToken,
        dispatchSource: 'submit',
        promptWithoutSlashToken: tokenMatch.promptWithoutToken,
        onSetDraft: () => {
          actionWroteDraft = true
        }
      })
    )
    if (!actionWroteDraft) {
      setChatPromptDraft(currentComposerChatId, '')
    }
    return true
  }

  const canRenderComposerAboveRowStack = Boolean(
    (!isCurrentGlobalChat &&
      currentWorkspace &&
      (!isWelcomeChat || isCurrentEnsembleChat)) ||
      (isCurrentGlobalChat && isCurrentEnsembleChat)
  )
  const hasComposerAboveRows =
    canRenderComposerAboveRowStack &&
    ((!isWelcomeChat && Boolean(currentWorkspace)) ||
      isCurrentEnsembleChat ||
      queuedMessagesAboveRowEntries.length > 0)
  const nativeNoAboveRowsClass =
    appearance.composerStyle === 'default' && !hasComposerAboveRows
      ? ' composer-surface--native-no-above-rows'
      : ''

  return (
          <div className={`composer-area interface-${interfaceStyle}`} ref={composerAreaRef}>
            {shouldShowGhostCompanion && <GhostCompanion />}
            {/*
              Phase K-followup — Removed `provider-shell-status-row`.
              The row presented Native-session / Workspace-write /
              TaskWraith-approvals / TaskWraith-audit / Usage-metered as
              pill-shaped chips, but none were interactive. The visual
              language read like clickable buttons; in practice the
              row was pure decoration that crowded the composer. The
              still-useful pieces (workspace write mode, provider
              identity, usage state) are surfaced elsewhere — in the
              composer's runtime profile picker, in the sidebar's
              chat-tile metadata, and in the welcome dashboard.
              providerShellCapabilityChips computation kept for any
              future use but the row no longer mounts in any shell.
            */}
            <ComposerPrimaryStack enabled={isWelcomeChat}>
            {isWelcomeChat &&
              isCurrentEnsembleChat &&
              !isWorkflowChatWelcome &&
              (() => {
                /*
                Ensemble welcome hero (1.0.3 Slice F follow-up). Replaces
                the solo-provider "New Codex thread for ..." copy with
                an ensemble-aware heading + a chevron-arrow chain
                showing the orchestration order. Disabled participants
                are skipped — the chain reflects the speaking sequence,
                not the full roster. The user can still drag the chip
                strip below to reorder.

                Ensemble welcome is hierarchy + textarea + the editable chip
                strip in the composer above-row.

                1.0.3 polish — provider-theme-aware shell. The
                ordered-enabled participant list drives the orchestration
                chain and the shared `--ensemble-provider-1..4` blend
                variables. The title glow intentionally uses that blend
                too; ensemble chats should not inherit a single provider's
                theme from the chat-level fallback provider.
              */
                const orderedEnabled = ensembleEnabledParticipantsForCurrent
                const ensembleIsContinuous =
                  currentChat?.ensemble?.orchestrationMode === 'continuous'
                const ensembleContinuationLimit = currentChat?.ensemble?.maxContinuationHops || 6
                const shellClassName = [
                  'welcome-hero',
                  'welcome-hero-ensemble',
                  `welcome-ensemble-shell`,
                  `welcome-ensemble-shell-count-${Math.min(orderedEnabled.length, 4)}`
                ]
                  .filter(Boolean)
                  .join(' ')
                const workspaceNameClass = 'workspace-name-glow workspace-name-glow-ensemble'
                return (
                  <div className={shellClassName} style={ensembleBlendStyle}>
                    <h1>
                      {isCurrentGlobalChat ? (
                        <>
                          <span>New Ensemble chat in </span>
                          <strong className={workspaceNameClass}>General Chat</strong>
                          <span>.</span>
                        </>
                      ) : (
                        <>
                          <span>New Ensemble chat in </span>
                          <strong className={workspaceNameClass}>
                            {currentWorkspace?.displayName || 'TaskWraith'}
                          </strong>
                          <span> Workspace.</span>
                        </>
                      )}
                    </h1>
                    {orderedEnabled.length === 0 ? (
                      <p className="welcome-hero-ensemble-empty">
                        No providers enabled yet. Open any chip below to turn one back on, then
                        describe the task.
                      </p>
                    ) : (
                      <>
                        <p>
                          {orderedEnabled.length}{' '}
                          {orderedEnabled.length === 1 ? 'provider' : 'providers'} will work through
                          this in order.{' '}
                          {ensembleIsContinuous ? (
                            <>
                              Continuous mode lets them hand work back and forth with{' '}
                              <code>@mentions</code> or <code>ensemble_yield(target:&nbsp;…)</code>,
                              capped at {ensembleContinuationLimit} extra handoffs.
                            </>
                          ) : (
                            <>
                              Each speaks once unless you switch the chip strip to Continuous mode.
                            </>
                          )}
                        </p>
                        {/* The ordered-provider chip chain that used to sit here
                            was removed — the speaking order is already shown by the
                            composer chip strip below and its per-provider filter
                            icons, so the duplicate welcome-hero chain was redundant. */}
                      </>
                    )}
                  </div>
                )
              })()}
            {isWelcomeChat && isWorkflowChatWelcome && (
              <div className="welcome-hero welcome-hero-workflow">
                <div className="welcome-workflow-mark" aria-hidden>
                  <WorkflowGlyphIcon />
                </div>
                {isWorkflowComposeChat ? (
                  <>
                    <h1>
                      <span>New workflow in </span>
                      <strong className={`workspace-name-glow provider-${currentProvider}`}>
                        {currentWorkspace?.displayName ?? 'this workspace'}
                      </strong>
                    </h1>
                    <p>
                      Describe the recurring task. It captures the current provider and run
                      settings, then runs on the cadence you set below.
                    </p>
                  </>
                ) : (
                  <>
                    <h1>
                      <strong className={`workspace-name-glow provider-${currentProvider}`}>
                        {workflowForCurrentChat?.name ?? 'Workflow'}
                      </strong>
                    </h1>
                    <p>
                      {workflowIntervalMinutes != null
                        ? `Runs every ${workflowIntervalMinutes} minute${workflowIntervalMinutes === 1 ? '' : 's'} — runs will appear here.`
                        : 'Runs manually — use Run now from the Workflows sidebar; runs will appear here.'}
                    </p>
                  </>
                )}
              </div>
            )}
            {isWelcomeChat && !isCurrentEnsembleChat && !isWorkflowChatWelcome && (
              <div className="welcome-hero">
                <h1>
                  <span>{welcomeCopy.heading.beforeWorkspace}</span>
                  <strong className={`workspace-name-glow provider-${currentProvider}`}>
                    {welcomeCopy.heading.workspaceName}
                  </strong>
                  <span>{welcomeCopy.heading.afterWorkspace}</span>
                </h1>
                {welcomeCopy.subheading ? <p>{welcomeCopy.subheading}</p> : null}
              </div>
            )}
            {/*
                Composer-unification (Phase J1): one above-bar shape for
                every composerStyle. Previously codex-style had a file-count
                summary + Review-changes button; claude/default had branch +
                add/del + Create PR. Both branches collapsed into one row
                that shows whatever data is available. The bottom-row
                review icon is the canonical "review changes" entry point
                across all providers, so we drop the codex-style duplicate
                button and keep Create PR as the above-bar action.
              */}
            {/*
              Slice F follow-up (1.0.3) — the stack renders not only
              when there's diff/file/external-path context (the
              original `!isWelcomeChat` rule) but also whenever the
              chat is an ensemble, so the participant chip strip is
              visible BEFORE the user sends their first prompt.
              Configure-before-send is the entire point of the strip;
              hiding it on welcome state defeated the rework.
              Inner sections still gate on `!isWelcomeChat` so the
              files / Create PR / external-path rows don't render
              with empty data on a fresh ensemble chat.
            */}
            {/* 1.0.4-AQ5 — also let GLOBAL ensemble chats into this
              stack so the participant chip strip renders. Before:
              `!isCurrentGlobalChat && currentWorkspace && ...` blocked
              global ensemble chats entirely, leaving them with no
              way to edit roster / orchestration mode / Work Session.
              Now: workspace-bound chats keep their existing rules
              (the inner sections still gate on `!isWelcomeChat` so
              Create PR / file-changes / external-path rows don't
              render with empty data), AND global ensemble chats
              get in for the participants strip via the explicit
              second branch. */}
            {((!isCurrentGlobalChat &&
              currentWorkspace &&
              (!isWelcomeChat || isCurrentEnsembleChat)) ||
              (isCurrentGlobalChat && isCurrentEnsembleChat)) &&
              (() => {
                /* Cursor shell — Create-PR / git / files-changed row sits
                 * ABOVE the merged stack (roster / ensemble / queue), not
                 * as its first segment. Other shells keep the row inside
                 * the stack. */
                /* Shells that float the git / Create-PR + secondary-workspace
                   rows as detached pills ABOVE the merged stack, rather than as
                   its first segments. Codex joins Cursor here so the ensemble
                   merged-frame never flattens these two rows. */
                const aboveRowsFloatAboveStack =
                  appearance.composerStyle === 'cursor' || appearance.composerStyle === 'codex'
                // GitHub PR/CI/Merge satellite row — icon-only upstream status,
                // pinned at the top of the above-composer area. Renders null
                // unless there's a remote + PR/CI worth surfacing.
                const githubSatelliteRow =
                  !isWelcomeChat && currentWorkspace ? (
                    <GitHubSatelliteRow
                      pr={primaryPr}
                      ci={primaryCi}
                      snapshot={primaryGitSnapshot}
                      onNotify={onNotifyThreadOfCi}
                    />
                  ) : null
                const primaryWorkspaceAboveBar =
                  !isWelcomeChat && currentWorkspace ? (
                    <div
                      className={`composer-above-bar style-unified${
                        aboveRowsFloatAboveStack ? ' composer-above-bar--cursor-lead' : ''
                      }`}
                    >
                      {/*
                  `.composer-above-bar-pill` wrappers group the Create-PR
                  row into three Cursor-style pills (changes | git | action).
                  Default `display: contents` keeps other shells unchanged.
                */}
                      <div className="composer-above-bar-pill composer-above-bar-pill--git">
                      <span className="composer-above-bar-branch">
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <circle cx="4" cy="3.5" r="1.6" />
                          <circle cx="4" cy="12.5" r="1.6" />
                          <circle cx="12" cy="7" r="1.6" />
                          <path d="M4 5.1v5.8M5.6 7c2 0 4.8 0 4.8-1.5" />
                        </svg>
                        <span>
                          {resolveWorkspaceDisplayName({
                            displayName: currentWorkspace.displayName,
                            path: currentWorkspace.path,
                            repoRoot: primaryGitSnapshot?.repoRoot,
                            remoteUrl: primaryGitSnapshot?.remoteUrl
                          })}
                          {' · '}
                          <ComposerBranchWorktreePopover
                            workspacePath={currentWorkspace?.path}
                            gitSnapshot={primaryGitSnapshot}
                            fallbackBranch={currentWorkspace?.branch}
                            detached={primaryGitSnapshot?.detached ?? false}
                            composerStyle={appearance.composerStyle}
                            composerWorktreeSelection={composerWorktreeSelection}
                            onSnapshotRefresh={setPrimaryGitSnapshot}
                            onWorktreeSelectionChange={onComposerWorktreeChange}
                          />
                        </span>
                      </span>
                      {primaryGitSnapshot && <GitMergeBadge snapshot={primaryGitSnapshot} />}
                      {primaryGitSnapshot && <GitSyncChip snapshot={primaryGitSnapshot} />}
                      </div>
                      <div className="composer-above-bar-pill composer-above-bar-pill--changes">
                      <span className="composer-above-bar-files-cluster">
                        <span
                          className="composer-above-bar-files"
                          title={
                            workspaceDiffStats.filesChanged > 0
                              ? `${workspaceDiffStats.filesChanged} uncommitted ${workspaceDiffStats.filesChanged === 1 ? 'file' : 'files'} in the working tree`
                              : 'Working tree clean — nothing to commit'
                          }
                        >
                          <AnimatedDiffNumber value={workspaceDiffStats.filesChanged} strong />{' '}
                          {workspaceDiffStats.filesChanged === 1 ? 'file changed' : 'files changed'}
                        </span>
                        {(workspaceDiffStats.additions > 0 || workspaceDiffStats.deletions > 0) && (
                          <span className="composer-above-bar-stats">
                            <AnimatedDiffNumber
                              value={workspaceDiffStats.additions}
                              prefix="+"
                              className="composer-diff-add"
                            />
                            <AnimatedDiffNumber
                              value={workspaceDiffStats.deletions}
                              prefix="-"
                              className="composer-diff-del"
                            />
                          </span>
                        )}
                      </span>
                      </div>
                      <div className="composer-above-bar-pill composer-above-bar-pill--action">
                      {(() => {
                        const hasReviewableDiff = workspaceDiffStats.filesChanged > 0
                        // 1.0.6-EW66-1d — primary workspace's PR state is now
                        // read from the per-path map keyed by its own path.
                        const primaryPrState = getCreatePrState(currentWorkspace?.path)
                        // Phase Git-U1 — the trigger button keeps "Review
                        // changes" as the FIRST/primary action whenever there's
                        // a diff (the canonical safety entry point); it falls
                        // back to the PR label otherwise. The menu it opens is
                        // now the real user-driven GitCommitControls (status +
                        // review + stage/commit + gated PR) — no more agent
                        // prompt-injection for committing.
                        const createPrLabel =
                          primaryPrState.status === 'pending'
                            ? 'Creating…'
                            : primaryPrState.status === 'success'
                              ? 'PR opened'
                              : primaryPrState.status === 'error'
                                ? 'Retry PR'
                                : // Cursor shell relabels the idle git action to
                                  // "Commit" (matches the secondary workspace row).
                                  appearance.composerStyle === 'cursor'
                                  ? 'Commit'
                                  : 'Create PR'
                        // Phase Git-U5 — context-aware primary action: Review
                        // (working-tree changes) → Push (clean but unpushed) →
                        // Create PR (pushed). Mirrors the menu's
                        // Review → Commit → Push → PR flow so the headline names
                        // the real next git step (Codex/Claude-desktop style).
                        const needsPush = Boolean(
                          primaryGitSnapshot &&
                            !primaryGitSnapshot.detached &&
                            primaryGitSnapshot.branch &&
                            primaryGitSnapshot.remoteUrl &&
                            (!primaryGitSnapshot.upstream ||
                              (primaryGitSnapshot.ahead ?? 0) > 0)
                        )
                        const primaryLabel =
                          appearance.composerStyle === 'cursor' ||
                          appearance.composerStyle === 'claude'
                            ? createPrLabel
                            : hasReviewableDiff
                              ? 'Review changes'
                              : needsPush
                                ? primaryGitSnapshot && !primaryGitSnapshot.upstream
                                  ? 'Publish branch'
                                  : 'Push'
                                : createPrLabel
                        const useGitIconAction = composerGitActionUsesCommitIcon(
                          appearance.composerStyle
                        )
                        const actionClassName = `composer-above-bar-action ${useGitIconAction ? 'composer-above-bar-action--git-commit-icon' : ''} ${primaryPrState.status === 'pending' ? 'is-pending' : ''} ${primaryPrState.status === 'error' ? 'is-error' : ''} ${primaryPrState.status === 'success' ? 'is-success' : ''}`
                        const actionTitle =
                          primaryPrState.message ||
                          'Review, commit, push, or open a PR for the current workspace'
                        return (
                          <span className="composer-diff-action-menu-wrap">
                            <button
                              type="button"
                              className={actionClassName}
                              onClick={() => setDiffActionMenuOpen((open) => !open)}
                              disabled={primaryPrState.status === 'pending'}
                              aria-haspopup="menu"
                              aria-expanded={diffActionMenuOpen}
                              aria-label={
                                useGitIconAction
                                  ? `${primaryLabel}. ${actionTitle}`
                                  : undefined
                              }
                              title={actionTitle}
                            >
                              {useGitIconAction ? <GitCommitSymbolIcon /> : primaryLabel}
                            </button>
                            {diffActionMenuOpen && (
                              <div className="composer-diff-action-menu" role="menu">
                                <GitCommitControls
                                  workspacePath={currentWorkspace?.path}
                                  open={diffActionMenuOpen}
                                  hasReviewableDiff={hasReviewableDiff}
                                  onReviewChanges={() => {
                                    if (!currentWorkspace?.path) {
                                      openInspectorTab('diff')
                                      return
                                    }
                                    void window.api.openWorkspacePopout({
                                      kind: 'diff-studio',
                                      workspacePath: currentWorkspace.path
                                    })
                                  }}
                                  onClose={() => setDiffActionMenuOpen(false)}
                                  onCreatePr={() =>
                                    void handleCreateGithubPr(currentWorkspace?.path)
                                  }
                                  prState={primaryPrState}
                                  onSnapshot={setPrimaryGitSnapshot}
                                />
                              </div>
                            )}
                          </span>
                        )
                      })()}
                      </div>
                    </div>
                  ) : null

                const externalWorkspaceAboveRows =
                  !isWelcomeChat && currentWorkspace
                    ? externalWorkspaceGroups.map((group) => (
                        <ExternalPathAboveRow
                          key={group.path}
                          grant={group.representative}
                          providers={group.providers}
                          repoMetadata={externalPathRepoMetadata[group.representative.id] || null}
                          snapshot={externalGitSnapshots[group.path] ?? null}
                          pr={externalPrByPath?.[group.path] ?? null}
                          diffStats={(() => {
                            const snap = externalGitSnapshots[group.path]
                            return snap
                              ? {
                                  filesChanged: snap.counts?.changed ?? 0,
                                  additions: snap.lineStats?.additions ?? 0,
                                  deletions: snap.lineStats?.deletions ?? 0
                                }
                              : undefined
                          })()}
                          onRevoke={() => handleRemoveExternalPathGrantsByPath(group.path)}
                          createPrState={getCreatePrState(group.path)}
                          onCreatePr={() => handleCreateGithubPr(group.path)}
                          onReviewChanges={() =>
                            void window.api.openWorkspacePopout({
                              kind: 'diff-studio',
                              workspacePath: group.path
                            })
                          }
                          onSnapshotRefresh={(snapshot) =>
                            onExternalGitSnapshotRefresh?.(group.path, snapshot)
                          }
                          composerStyle={appearance.composerStyle}
                          cursorLeadDetached={aboveRowsFloatAboveStack}
                        />
                      ))
                    : null

                return (
                  <>
                    {aboveRowsFloatAboveStack && githubSatelliteRow}
                    {aboveRowsFloatAboveStack && primaryWorkspaceAboveBar}
                    {aboveRowsFloatAboveStack && externalWorkspaceAboveRows}
                    <div className={`composer-above-bar-stack ${composerAboveBarStackAuraClass}`}>
                      {!aboveRowsFloatAboveStack && githubSatelliteRow}
                      {!aboveRowsFloatAboveStack && primaryWorkspaceAboveBar}
                      {/* Slice 3 of the external-path-redesign arc. One stacked
                    row per external-path grant. Per-grant repo metadata
                    decides whether the row shows branch+repo-name or a
                    bare basename.

                    1.0.6-EW66-1d — repo rows now also get a per-path
                    commit/push/PR action menu matching the primary workspace
                    row. PR state is keyed by `grant.path`, so an ensemble's
                    several same-path grants share one repo's PR progress. */}
                      {!aboveRowsFloatAboveStack && externalWorkspaceAboveRows}
                {/*
                  Slice F (1.0.3) — ensemble participants live in the
                  composer above-row stack now. Sits below the unified
                  branch / files-changed / Create PR row and any
                  external-path rows, but stays above the composer
                  textarea so the diff/PR signals read first. Returns
                  null for non-ensemble chats so single-provider chats
                  don't see an empty cell.

                  Renders on welcome state too (no `!isWelcomeChat`
                  gate) so the user can configure participants BEFORE
                  the first prompt — configure-before-send is the
                  entire point of the strip.
                */}
                {/* Keep roster presets in the shared composer stack for every
                  ensemble state. Workflow welcome already used this hierarchy;
                  normal ensemble welcome used to render a standalone hero copy,
                  which left the controls visually detached from the chip row. */}
                {currentChat?.chatKind === 'ensemble' && (
                  <EnsembleRosterPresetPicker
                    ensemble={currentChat.ensemble}
                    disabled={isCurrentEnsembleRoundRunning}
                    onApplyPreset={applyEnsembleRosterPreset}
                    variant="compact"
                    composerStyle={appearance.composerStyle}
                    secondRow={renderEnsembleOrchestrationRow()}
                  />
                )}
                {currentChat?.chatKind === 'ensemble' && (
                  <EnsembleParticipantsAboveRow
                    chat={currentChat}
                    animateEntrance={isWorkflowComposeChat}
                    selectedParticipantId={effectiveSelectedParticipantId}
                    onSelectParticipant={handleSelectParticipant}
                    onChatChange={(updatedChat) => {
                      chatByIdRef.current.set(updatedChat.appChatId, updatedChat)
                      setCurrentChat((prev) =>
                        prev?.appChatId === updatedChat.appChatId ? updatedChat : prev
                      )
                      setChats((prev) =>
                        prev.map((c) => (c.appChatId === updatedChat.appChatId ? updatedChat : c))
                      )
                      void window.api.saveChat(updatedChat)
                    }}
                    onSkipActive={() => {
                      // Skip only the currently-speaking participant.
                      // The composer's existing Stop button (wired to
                      // `handleCancel` → `cancelEnsembleRound`) keeps
                      // its role as the full-round abort affordance.
                      if (!currentChat) return
                      void window.api.skipEnsembleParticipant(currentChat.appChatId)
                    }}
                    onSkipReadFanout={() => {
                      if (!currentChat) return
                      void window.api.skipEnsembleReadFanout(currentChat.appChatId)
                    }}
                    onStopWorkSession={() => void handleStopWorkSession()}
                    onRetryParticipant={(participantId) => {
                      // 1.0.4-AT7 — re-dispatch the named participant
                      // as a DM with the chat's last user prompt.
                      // The orchestrator already supports DM scoping
                      // (`runEnsembleRound({ dmTargetParticipantId })`)
                      // so this fires a brand-new round limited to
                      // the failed participant — they get one more
                      // try without rerunning the whole panel.
                      // Fall back to a quiet info log when there's
                      // no prior user prompt to retry against.
                      if (!currentChat) return
                      const retryPrompt = lastRetryableEnsembleUserPrompt(currentChat.messages)
                      if (!retryPrompt) {
                        setRawLogs((prev) => [
                          ...prev,
                          {
                            type: 'info',
                            content: 'Retry: no prior user prompt on this chat to re-dispatch with.'
                          }
                        ])
                        return
                      }
                      void window.api.runEnsembleRound({
                        chatId: currentChat.appChatId,
                        prompt: retryPrompt,
                        mode: 'normal',
                        concurrentMode: false,
                        fanoutPolicy: 'off',
                        dmTargetParticipantId: participantId
                      })
                    }}
                    onWakeNowParticipant={(wakeupId) => {
                      // 1.0.5-N7 — Fire the wakeup immediately. The
                      // orchestrator's handleWakeupFired path runs
                      // the same code the timer would; the participant
                      // resumes with the [Scheduled wakeup] prompt
                      // block as if the wake time had arrived.
                      void window.api.wakeEnsembleParticipantNow(wakeupId)
                    }}
                    onCancelWakeupParticipant={(wakeupId) => {
                      // 1.0.5-N7 — Cancel the pending wakeup. The
                      // participant exits sleeping state; the round
                      // continues with other participants. Falls
                      // back to a persisted-record cancel if there's
                      // no in-memory runtime (e.g. post-restart).
                      void window.api.cancelEnsembleParticipantWakeup(wakeupId)
                    }}
                    composerStyle={appearance.composerStyle}
                    grokAvailable={grokProviderAvailable}
                    cursorAvailable={cursorProviderAvailable}
                  />
                )}
                {/*
                  Queued-messages above-row. Renders the chat's pending
                  run-queue jobs as a stack of bubbles with per-row
                  Edit / Delete / Steer actions, drag-to-reorder, and
                  scroll past 5 entries. Returns null when empty so
                  it adds nothing to the stack for chats without
                  queued work. See `QueuedMessagesAboveRow.tsx`.
                */}
                <QueuedMessagesAboveRow
                  chat={currentChat}
                  entries={queuedMessagesAboveRowEntries}
                  onEdit={handleEditQueuedMessage}
                  onDelete={handleDeleteQueuedMessage}
                  onSteer={handleSteerToQueuedMessage}
                  onAddToBlackboard={handleBlackboardQueuedMessage}
                  onReorder={handleReorderQueuedMessages}
                />
                    </div>
                  </>
                )
              })()}
            <div
              className={`composer-surface ${isComposerDragOver ? 'is-drag-over' : ''} ${composerAgentAuraClass}${nativeNoAboveRowsClass}`}
              onDragEnter={handleComposerDragEnter}
              onDragOver={handleComposerDragOver}
              onDragLeave={handleComposerDragLeave}
              onDrop={handleComposerDrop}
            >
              {/* Refractive-glass lens — an aria-hidden, pointer-events:none layer
                * that carries the baked sheen + displacement warp. Always present
                * (cheap empty layer); its visibility + filter are gated purely in
                * CSS on :root[data-advanced-fx-refraction="true"], so it's inert
                * when refraction is off / Reduce Transparency is on. */}
              <div className="composer-refraction-lens" aria-hidden />
              {showComposerChips && (
                <div className="composer-chips">
                  {currentProvider === 'gemini' && persistentSessionNeedsRestart && (
                    <span className="composer-chip warning">{sessionRestartReason}</span>
                  )}
                  {/* The Ollama health chip + the Tier-4 parity capability
                    warning were removed from this row — the footer Ollama tier
                    picker (and its ⚠ ineffective state) now convey both. Other
                    providers' capability warnings still surface here. */}
                  {currentProviderCapabilityWarning &&
                    currentProviderCapabilityWarning.id !== 'ollama-provider-parity-not-granted' && (
                      <span
                        className="composer-chip warning"
                        title={currentProviderCapabilityWarning.message}
                      >
                        {currentProviderCapabilityWarning.title}
                      </span>
                    )}
                  {queuedRunQueueCount > 0 && (
                    <span
                      className="composer-chip"
                      title="Durable queued tasks are persisted by TaskWraith."
                    >
                      {queuedRunQueueCount} queued
                    </span>
                  )}
                </div>
              )}
              {/*
                Phase K-followup — Removed the informational "New X
                thread" + permission-mode chips from the top-toggles
                row. They were styled identically to the actual
                interactive controls (composer-picker-command) so the
                row read as four clickable buttons when really only
                two were actionable. The thread/session state is
                already visible in the sidebar's chat tile + active
                tab indicator; permission mode is set via the
                composer controls below. Schedule moved to the inline
                composer row as a first-class prompt modifier.
                Runtime-profile selection still resolves at dispatch; the
                composer intentionally hides the built-in local/global selector
                so it does not read like a day-to-day action chip.
              */}

              {(imageAttachments.length > 0 || currentDiscordContextSelection) && (
                <div
                  className="composer-image-strip composer-attachment-tray"
                  aria-label="Composer attachments and context"
                >
                  {composerImageAttachments.map((image) => (
                    <div
                      key={image.id}
                      className="composer-image-item composer-image-tile is-image"
                      title={image.path}
                      aria-label={`Image attachment ${image.name}`}
                    >
                      <ComposerImageThumb path={image.path} name={image.name} />
                      <button
                        className="composer-image-remove"
                        type="button"
                        onClick={() => handleRemoveImageAttachment(image.id)}
                        disabled={isCurrentComposerLocked}
                        title="Remove attachment"
                        aria-label={`Remove ${image.name}`}
                      >
                        <XSymbolIcon />
                      </button>
                    </div>
                  ))}
                  {composerFileAttachments.map((file) => {
                    const isPdf = isPdfAttachmentPath(file.path)
                    return (
                      <div
                        key={file.id}
                        className={`composer-image-item composer-file-card${isPdf ? ' is-pdf' : ''}`}
                        title={file.path}
                      >
                        <span className="composer-attachment-icon" title={file.name}>
                          {isPdf ? (
                            <ComposerImageThumb path={file.path} name={file.name} />
                          ) : (
                            <FileTypeIcon
                              path={file.path}
                              size={18}
                              className="composer-attachment-icon-inner"
                              workspacePath={currentWorkspace?.path}
                            />
                          )}
                        </span>
                        <span className="composer-image-name" title={file.path}>
                          {file.name}
                        </span>
                        <button
                          className="composer-image-remove"
                          type="button"
                          onClick={() => handleRemoveImageAttachment(file.id)}
                          disabled={isCurrentComposerLocked}
                          title="Remove attachment"
                          aria-label={`Remove ${file.name}`}
                        >
                          <XSymbolIcon />
                        </button>
                      </div>
                    )
                  })}
                  {currentDiscordContextSelection && (
                    <div
                      className="composer-image-item composer-file-card composer-discord-context-card"
                      title={`Discord #${currentDiscordContextSelection.channelName || currentDiscordContextSelection.channelId}`}
                    >
                      <span className="composer-discord-context-icon" aria-hidden>
                        #
                      </span>
                      <span
                        className="composer-image-name composer-discord-context-name"
                        title={`Discord #${currentDiscordContextSelection.channelName || currentDiscordContextSelection.channelId}`}
                      >
                        {`Discord #${currentDiscordContextSelection.channelName || currentDiscordContextSelection.channelId}`}
                      </span>
                      <span className="composer-discord-context-count">
                        {currentDiscordContextSelection.limit}
                      </span>
                      <button
                        className="composer-image-remove"
                        type="button"
                        onClick={handleClearDiscordContext}
                        disabled={isCurrentComposerLocked}
                        title="Remove Discord context"
                        aria-label="Remove Discord context"
                      >
                        <XSymbolIcon />
                      </button>
                    </div>
                  )}
                  {imageAttachments.length > 0 && (
                    <span className="composer-image-count">{`${imageAttachments.length}/${MAX_IMAGE_ATTACHMENTS}`}</span>
                  )}
                </div>
              )}

              {/*
                Console redesign — INNER MODULE. The textarea + the
                two bottom-control rows are the actual *input*, so they
                live on a normal theme-tone surface (`.composer-inner-
                module`) that stays perfectly readable. The OUTER
                `.composer-surface` is restyled (shard 07/03) into a
                translucent CONTRAST glass (light glass on dark themes,
                dark glass on light themes) that shows only as the FRAME
                around this module via the surface's existing padding;
                the provider rim carries onto BOTH rims. `.composer-
                chips` + `.composer-top-toggles` (+ attachment tray)
                stay above, as children of the outer frame.
                NOTE: `.composer-bottom-controls` keeps its `display:
                contents` (native shell) so its control-footer +
                telemetry rows remain *effective* children of the input
                container — now this inner module — exactly as the
                "two rows" contract (below) documents.
              */}
              <div className="composer-inner-module">
                {(() => {
                  // Gate the overlay activation: render the highlight
                  // layer only when the prompt contains at least one
                  // RESOLVED `@Token`. Without this, the textarea's
                  // `color: transparent` zeros out the text in shells
                  // where the overlay's font/padding drifts from the
                  // textarea (Claude / Codex / Kimi etc. each override
                  // base padding). the maintainer hit this on the ensemble
                  // welcome screen — text invisible in Claude shell,
                  // vertical sync issues in others.
                  // 1.0.4 — drop the `isCurrentEnsembleChat` precondition.
                  // `hasResolvedMention` already self-guards on
                  // `participants.length === 0`, so non-ensemble chats
                  // are excluded naturally. The extra gate caused a
                  // regression on the ensemble welcome screen where
                  // `chatKind === 'ensemble'` evaluated false during
                  // some welcome-surface render passes — leaving typed
                  // tags as plain white text instead of bold +
                  // provider-tinted (the maintainer's "tags not lighting up"
                  // report). Now: anywhere participants ARE configured
                  // and a mention resolves, the overlay activates.
                  const composerHasMention = hasResolvedMention(
                    prompt,
                    currentComposerMentionParticipants
                  )
                  // 1.0.4 — sync epoch for the overlay's auto-metric
                  // mirror. Any change in the inputs below can shift
                  // the textarea's computed font / padding / border,
                  // so we encode them into a single string the
                  // overlay watches as a useLayoutEffect dep. The
                  // ResizeObserver inside the overlay handles every
                  // size-changing variation that happens between
                  // these explicit triggers.
                  const composerOverlaySyncEpoch = `${appearance.composerStyle}|${appearance.themeAppearance}|${isWelcomeChat ? 'welcome' : 'active'}`
                  return (
                    <div
                      className={`composer-textarea-wrap${voiceCaptureState.isRecording ? ' is-voice-recording' : ''}`}
                    >
                      {composerHasMention && (
                        <ComposerHighlightOverlay
                          value={prompt}
                          participants={currentComposerMentionParticipants}
                          textareaRef={composerTextareaRef}
                          syncEpoch={composerOverlaySyncEpoch}
                        />
                      )}
                      <textarea
                        className={`composer-textarea${composerHasMention ? ' has-mention-overlay' : ''}`}
                        ref={composerTextareaRef}
                        value={prompt}
                        onContextMenu={composerContextMenu.handleContextMenu}
                        onPaste={(event) => {
                          void handleComposerPaste(event)
                        }}
                        onChange={(e) => {
                          const nextValue = e.target.value
                          // 1.0.4-AQ3 — snapshot the caret position from
                          // the change event BEFORE React reconciles. The
                          // restoration layout effect below reads this ref
                          // and re-applies the caret after the className
                          // flip + overlay mount that can land mid-keystroke
                          // when an `@token` resolves.
                          composerSelectionRef.current = {
                            start: e.target.selectionStart ?? nextValue.length,
                            end: e.target.selectionEnd ?? nextValue.length
                          }
                          composerCaretRestoreEpochRef.current += 1
                          setChatPromptDraft(currentComposerChatId, nextValue)
                          clearPlanImportIfDraftChanged(nextValue)
                          // Composer popover coordinator: scan the text before the
                          // caret for a leading `/<query>` token (start-of-line or
                          // after whitespace), then for an `@<query>` mention token.
                          // Whichever matches wins; the other is force-closed. Only
                          // one popover open at a time.
                          const caret = e.target.selectionStart ?? nextValue.length
                          const slashMatch = parseSlashTokenBeforeCaret(nextValue, caret)
                          const mentionTrigger = !slashMatch
                            ? parseComposerMentionTrigger(nextValue, caret)
                            : null
                          if (slashMatch) {
                            slashAnchorIndexRef.current = slashMatch.anchor
                            setSlashQuery(slashMatch.query)
                            setSlashMenuOpen(true)
                            if (mentionMenuOpen) {
                              setMentionMenuOpen(false)
                              setMentionQuery('')
                              mentionAnchorIndexRef.current = null
                            }
                          } else if (mentionTrigger) {
                            mentionAnchorIndexRef.current = mentionTrigger.anchorIndex
                            mentionTriggerLengthRef.current = mentionTrigger.triggerLength
                            setMentionTriggerKind(mentionTrigger.kind)
                            setMentionQuery(mentionTrigger.query)
                            setMentionMenuOpen(true)
                            if (slashMenuOpen) {
                              setSlashMenuOpen(false)
                              setSlashQuery('')
                              slashAnchorIndexRef.current = null
                            }
                          } else {
                            if (mentionMenuOpen) {
                              setMentionMenuOpen(false)
                              setMentionQuery('')
                              mentionAnchorIndexRef.current = null
                            }
                            if (slashMenuOpen) {
                              setSlashMenuOpen(false)
                              setSlashQuery('')
                              slashAnchorIndexRef.current = null
                            }
                          }
                        }}
                        placeholder={composerPlaceholder}
                        aria-label={composerAriaLabel}
                        rows={1}
                        disabled={!currentChat || (!isCurrentGlobalChat && !currentWorkspace)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            if (tryHandleSideSlashSubmit()) {
                              return
                            }
                            if (tryHandleActionSlashSubmit()) {
                              return
                            }
                            if (tryHandleInlineGoalSlashSubmit()) {
                              return
                            }
                            triggerSendConfirmation()
                            // DM target resolution order (first match wins):
                            //   1. An explicit `@participant` mention in the
                            //      prompt body (`ensemble-dm://` markdown link
                            //      inserted by the mention picker).
                            //   2. Legacy Cmd/Ctrl+Enter on a selected chip
                            //      (A2 from 1.0.3 — kept so muscle memory
                            //      still works).
                            // Plain Enter with no mention + no modifier
                            // dispatches the full round.
                            const dmFromMention = isCurrentEnsembleChat
                              ? extractFirstEnsembleDmTarget(
                                  prompt,
                                  currentChat?.ensemble?.participants
                                )
                              : null
                            const dmTarget =
                              dmFromMention ||
                              (isCurrentEnsembleChat &&
                              effectiveSelectedParticipantId &&
                              (e.metaKey || e.ctrlKey)
                                ? effectiveSelectedParticipantId
                                : undefined)
                            handleRun(undefined, undefined, dmTarget || undefined)
                          }
                        }}
                      />
                      {voiceCaptureState.isRecording && (
                        <ComposerVoiceWaveform
                          elapsedMs={voiceCaptureState.elapsedMs}
                          levels={voiceCaptureState.levels}
                          message={voiceCaptureState.message}
                        />
                      )}
                    </div>
                  )
                })()}
                <ComposerLinkPreviewStrip text={prompt} />
                <ComposerTextareaContextMenu
                  anchor={composerContextMenu.anchor}
                  spellcheckContext={composerContextMenu.spellcheckContext}
                  textareaRef={composerTextareaRef}
                  onValueChange={(value) => {
                    setChatPromptDraft(currentComposerChatId, value)
                    clearPlanImportIfDraftChanged(value)
                  }}
                  isValueTargetCurrent={() =>
                    (currentChatIdRef.current || currentComposerChatId) === currentComposerChatId
                  }
                  onPasteClipboardAttachment={async () => {
                    const targetChatId = currentComposerChatId
                    if (!targetChatId) return false
                    const saved = await window.api.saveClipboardImageAttachment()
                    const paths = saved || []
                    if (paths.length === 0) return false
                    if ((currentChatIdRef.current || targetChatId) !== targetChatId) return false
                    addImageAttachmentsToChat(targetChatId, paths)
                    if (imageAttachments.length + paths.length > MAX_IMAGE_ATTACHMENTS) {
                      setRawLogs((prev) => [
                        ...prev,
                        {
                          type: 'info',
                          content: `Attachment limit reached (${MAX_IMAGE_ATTACHMENTS}); oldest files were removed.`
                        }
                      ])
                    }
                    return true
                  }}
                  onOpenFromElectron={composerContextMenu.openContextMenu}
                  onClose={() => composerContextMenu.setAnchor(null)}
                />
                <ComposerSlashMenu
                  open={slashMenuOpen}
                  anchorRef={composerTextareaRef}
                  query={slashQuery}
                  commands={composerSlashCommands}
                  composerStyle={appearance.composerStyle}
                  onDismiss={() => {
                    setSlashMenuOpen(false)
                    setSlashQuery('')
                    slashAnchorIndexRef.current = null
                  }}
                  onPick={(command) => handleComposerSlash(command)}
                />
                <AgentMentionMenu
                  chat={currentChat || undefined}
                  provider={currentProvider}
                  composerStyle={appearance.composerStyle}
                  workspacePath={currentWorkspace?.path}
                  externalPathGrants={externalPathGrants}
                  /*
                    1.0.5-EW53 — Dropped `prompt={prompt}` from this
                    spread. The prop was never declared on
                    AgentMentionMenuProps (the destructure doesn't
                    pick it up), so the menu never read it — but
                    passing it down made every keystroke flow a
                    fresh string into JSX reconciliation. Once the
                    menu is wrapped in memo (TODO), removing the
                    unused prop keeps the prop diff clean.
                  */
                  open={mentionMenuOpen}
                  anchorRef={composerTextareaRef}
                  query={mentionQuery}
                  triggerKind={mentionTriggerKind}
                  ensembleParticipants={
                    isCurrentEnsembleChat ? currentChat?.ensemble?.participants : undefined
                  }
                  onDismiss={() => {
                    setMentionMenuOpen(false)
                    setMentionQuery('')
                    mentionAnchorIndexRef.current = null
                  }}
                  onPick={(mention) => {
                    const anchor = mentionAnchorIndexRef.current
                    if (anchor === null) {
                      setMentionMenuOpen(false)
                      setMentionQuery('')
                      return
                    }
                    // The trigger characters (`@` or `-@`) + the live
                    // query string need to be stripped — replace them
                    // wholesale with the chosen mention's insertion.
                    const triggerLen = mentionTriggerLengthRef.current
                    const before = prompt.slice(0, anchor)
                    const afterQuery = prompt.slice(anchor + triggerLen + mentionQuery.length)
                    const insertion = (() => {
                      if (mention.kind === 'agent' && mention.agentId) {
                        return `[@${mention.name}](agent://${mention.agentId}) `
                      }
                      if (mention.kind === 'participant' && mention.participantId) {
                        // Ensemble DM mention. Insert PLAIN `@Role`
                        // (no markdown link) so the composer textarea
                        // shows a clean readable token instead of the
                        // raw markdown URL. On send,
                        // `extractFirstEnsembleDmTarget` resolves the
                        // `@Role` against the chat's participants by
                        // role (case-insensitive) → provider name and
                        // produces the right `dmTargetParticipantId`.
                        // This also means free-typed `@Gemini` or
                        // `@Worker` works the same as a picker click.
                        return `@${mention.name} `
                      }
                      return formatComposerPathMention(mention.path || mention.name)
                    })()
                    const next = `${before}${insertion}${afterQuery}`
                    setChatPromptDraft(currentComposerChatId, next)
                    setMentionMenuOpen(false)
                    setMentionQuery('')
                    mentionAnchorIndexRef.current = null
                    // Restore caret after the inserted mention/path.
                    requestAnimationFrame(() => {
                      const ta = composerTextareaRef.current
                      if (!ta) return
                      const newCaret = before.length + insertion.length
                      ta.focus()
                      ta.setSelectionRange(newCaret, newCaret)
                    })
                  }}
                />
                {/*
                  1.0.6-EW68 — Two-container composer split (Obsidian +
                  Alabaster only). The control-footer (send row + Row A:
                  Turn/Continuous/Work-Session + provider + model +
                  approval) and the telemetry-row (Row B: timecode +
                  workspace + token tally) are wrapped here so those two
                  shells can render them as a SECOND lit rect below the
                  textarea rect. For the other nine shells this wrapper is
                  `display: contents`, so it vanishes from layout and the
                  two rows stay effective children of `.composer-surface`
                  exactly as before.
                */}
                <div className="composer-bottom-controls">
                  <div className="composer-control-footer">
                    {currentProvider === 'codex' &&
                      !isCurrentGlobalChat &&
                      externalPathGrants.length > 0 && (
                        <div className="composer-image-strip composer-external-grant-strip">
                          {externalPathGrants.map((grant) => (
                            <div
                              key={grant.id}
                              className={`composer-image-item external-grant access-${grant.access}`}
                            >
                              <PermissionSymbolIcon />
                              <span className="composer-image-name" title={grant.path}>
                                {grant.access === 'write' ? 'Edit' : 'Read'} {grant.kind}:{' '}
                                {grant.path}
                              </span>
                              <button
                                className="composer-image-remove"
                                type="button"
                                onClick={() => handleRemoveExternalPathGrant(grant.id)}
                                disabled={isCurrentComposerLocked}
                                title="Revoke external path grant"
                              >
                                <XSymbolIcon />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    {externalPathGrantPrompt && (
                      <ExternalPathGrantPromptCard
                        gaps={externalPathGrantPrompt.gaps}
                        trigger={externalPathGrantPrompt.trigger}
                        busy={externalPathGrantPromptBusy}
                        onGrant={() => void persistExternalPathGrantPrompt()}
                        onDismiss={() => clearExternalPathGrantPrompt()}
                      />
                    )}
                    {permissionRequestPaths.length > 0 && (
                      <div className="composer-permission-card">
                        <div className="composer-permission-title">
                          <span>{permissionRequestTitle}</span>
                          {permissionRequestSource && (
                            <span className="composer-permission-source">
                              {permissionRequestSource}
                            </span>
                          )}
                        </div>
                        {permissionRequestMessage && (
                          <div className="composer-permission-message">
                            {permissionRequestMessage}
                          </div>
                        )}
                        <div className="composer-permission-paths">
                          {permissionRequestPaths.map((path) => (
                            <span key={path} className="composer-permission-path">
                              {path}
                            </span>
                          ))}
                        </div>
                        <div className="composer-permission-actions">
                          <PillButton
                            variant="primary"
                            size="compact"
                            type="button"
                            onClick={handlePermissionRetry}
                          >
                            Add paths and rerun
                          </PillButton>
                          <PillButton
                            variant="ghost"
                            size="compact"
                            type="button"
                            onClick={clearImagePermissions}
                          >
                            Dismiss
                          </PillButton>
                        </div>
                      </div>
                    )}
                    {showSeatChangeNextRoundNotice && (
                      <div className="composer-permission-card composer-seat-change-notice" role="status">
                        <span className="composer-seat-change-notice-copy">
                          Provider/model changes during this round will apply to the next round.
                        </span>
                        <button
                          type="button"
                          className="composer-seat-change-notice-dismiss"
                          aria-label="Dismiss provider/model next-round notice"
                          title="Dismiss"
                          onClick={() => {
                            if (activeSeatChangeNoticeRoundKey) {
                              setDismissedSeatChangeNoticeRoundKey(activeSeatChangeNoticeRoundKey)
                            }
                            setSeatChangeNoticeRoundKey(null)
                          }}
                        >
                          <XSymbolIcon />
                        </button>
                      </div>
                    )}
                    {pendingPlanImport && (
                      <ComposerPlanImportCard
                        pendingPlanImport={pendingPlanImport}
                        disabled={isCurrentComposerLocked}
                        displayCurrency={displayCurrency}
                        overestimatePercent={overestimatePercent}
                        planImportExecutionEstimate={planImportExecutionEstimate}
                        planImportGroundingBusy={planImportGroundingBusy}
                        planImportGroundingDisabledReason={planImportGroundingDisabledReason}
                        PLAN_IMPORT_CHIP_LABELS={PLAN_IMPORT_CHIP_LABELS}
                        PLAN_IMPORT_RISK_LABELS={PLAN_IMPORT_RISK_LABELS}
                        PLAN_IMPORT_RUN_CONSTRAINT_LABELS={PLAN_IMPORT_RUN_CONSTRAINT_LABELS}
                        formatPlanImportCostEstimate={formatPlanImportCostEstimate}
                        formatPlanImportRunConstraintValue={formatPlanImportRunConstraintValue}
                        formatPlanImportTokenEstimate={formatPlanImportTokenEstimate}
                        renderPlanImportFileGroundings={renderPlanImportFileGroundings}
                        renderPlanImportItems={renderPlanImportItems}
                        setPendingPlanImport={setPendingPlanImport}
                        setPlanImportPolicy={setPlanImportPolicy}
                        handleGroundImportedPlanFiles={handleGroundImportedPlanFiles}
                        handleRunImportedPlan={handleRunImportedPlan}
                        handleRunRawPrompt={() => {
                          setPendingPlanImport(null)
                          handleRun()
                        }}
                      />
                    )}
                    {pendingAgentApproval && (
                      <div
                        ref={agentApprovalCardRef}
                        role="alertdialog"
                        aria-modal="false"
                        aria-labelledby="composer-agent-approval-title"
                        aria-describedby={
                          agentApprovalCountdownMs != null
                            ? 'composer-agent-approval-countdown'
                            : undefined
                        }
                        className={`composer-permission-card provider-${pendingAgentApproval.provider}`}
                      >
                        <div className="composer-permission-title">
                          <span id="composer-agent-approval-title">{pendingAgentApproval.title}</span>
                          <span className="composer-permission-source">
                            {getProviderLabel(pendingAgentApproval.provider)}
                            {/* 1.0.4-AK4 — surface the queue depth so the
                              user knows other approvals are waiting on
                              this same chat. Common case (single
                              approval at a time) shows nothing extra. */}
                            {(() => {
                              const queue = currentComposerChatId
                                ? pendingApprovalQueueByChatId[currentComposerChatId] || []
                                : []
                              if (queue.length === 0) return null
                              return (
                                <span
                                  className="composer-permission-queue-badge"
                                  title={`${queue.length} more approval${
                                    queue.length === 1 ? '' : 's'
                                  } queued behind this one — they appear in order as you respond.`}
                                >
                                  +{queue.length} more
                                </span>
                              )
                            })()}
                          </span>
                        </div>
                        {agentApprovalCountdownMs != null && (
                          <div
                            id="composer-agent-approval-countdown"
                            className="composer-permission-countdown"
                            role="status"
                            aria-live="polite"
                          >
                            Auto-denies in {formatApprovalCountdown(agentApprovalCountdownMs)}
                          </div>
                        )}
                        {pendingAgentApproval.body && (
                          <div className="composer-permission-message">
                            {pendingAgentApproval.body}
                          </div>
                        )}
                        {/* Slice 4 of the external-path-redesign arc.
                          When the runtime detector emits an external-path
                          approval, it stashes the detected path under
                          `preview.externalPathDetection`. Render it
                          prominently so the user knows WHICH path they're
                          granting before clicking the action button. */}
                        {pendingAgentApproval.preview?.externalPathDetection?.path && (
                          <div className="composer-permission-external-path">
                            <span className="composer-permission-external-path-label">Path</span>
                            <code className="composer-permission-external-path-value">
                              {pendingAgentApproval.preview.externalPathDetection.path}
                            </code>
                          </div>
                        )}
                        {renderAgentApprovalPreview(pendingAgentApproval.preview)}
                        {/* Order-4 — optional one-line intent note. Always
                          optional: it never blocks approve/deny. The text
                          is captured at click time in
                          `handleAgentApprovalAction` and persisted onto
                          the approval-ledger row's metadata as
                          `intentNote` (no schema migration). */}
                        <input
                          type="text"
                          className="composer-permission-note"
                          value={intentNote}
                          onChange={(e) => setIntentNote(e.target.value)}
                          placeholder="why? (optional)"
                          aria-label="Optional note explaining this approval decision"
                          maxLength={280}
                        />
                        <div className="composer-permission-actions">
                          {(pendingAgentApproval.actions || ['accept']).includes('accept') && (
                            <PillButton
                              variant="primary"
                              size="compact"
                              type="button"
                              title={
                                pendingAgentApproval.method === 'hostCommand/rerun'
                                  ? 'Rerun this request outside the current sandbox once. This does not grant future approvals.'
                                  : 'Allow only this approval request. Future similar requests will still ask.'
                              }
                              onClick={() =>
                                void handleAgentApprovalAction(pendingAgentApproval.id, 'accept')
                              }
                            >
                              {pendingAgentApproval.method === 'hostCommand/rerun'
                                ? 'Rerun outside sandbox'
                                : 'Allow once'}
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || []).includes('useProviderNative') && (
                            <PillButton
                              variant="primary"
                              size="compact"
                              type="button"
                              title="Use the provider CLI or SDK native approval flow for this request instead of TaskWraith handling it."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'useProviderNative'
                                )
                              }
                            >
                              Use Provider Native
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || []).includes('useTaskWraithSubthread') && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Move this work into a TaskWraith sub-thread so it can continue with isolated context and its own approval handling."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'useTaskWraithSubthread'
                                )
                              }
                            >
                              Use TaskWraith Sub-thread
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || []).includes('acceptForWorkspace') && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Allow this kind of request for this workspace. The grant persists until revoked in Approvals & Grants."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'acceptForWorkspace'
                                )
                              }
                            >
                              Allow in workspace
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || ['acceptForSession']).includes(
                            'acceptForSession'
                          ) && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Allow matching requests for the rest of this app session. Restarting the app clears the grant."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'acceptForSession'
                                )
                              }
                            >
                              Allow for session
                            </PillButton>
                          )}
                          {/* Trusted Session is lane-scoped: the current ensemble participant or solo
                            chat receives the signed full_access preset, then this request is
                            accepted once. It deliberately does not enable process-wide YOLO or
                            mint a hidden matching-service session grant via acceptForSession. */}
                          {!isNativeSubAgentPreferenceApproval(pendingAgentApproval) &&
                            pendingAgentApproval.preview?.requestOnly !== true &&
                            !pendingAgentApproval.preview?.externalPathDetection && (
                              <PillButton
                                variant="ghost"
                                size="compact"
                                type="button"
                                title="Raise only this chat or selected participant to Trusted Session, then approve this request once. Other lanes are unchanged."
                                onClick={() => {
                                  setTrustedSessionApprovalId(pendingAgentApproval.id)
                                  setTrustedSessionConfirmOpen(true)
                                }}
                              >
                                Start Trusted Session...
                              </PillButton>
                            )}
                          {(pendingAgentApproval.actions || ['decline']).includes('decline') && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Deny this request and let the current run continue or fail according to the provider."
                              onClick={() =>
                                void handleAgentApprovalAction(pendingAgentApproval.id, 'decline')
                              }
                            >
                              Deny
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || ['cancel']).includes('cancel') && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Cancel the run that is waiting on this approval."
                              onClick={() =>
                                void handleAgentApprovalAction(pendingAgentApproval.id, 'cancel')
                              }
                            >
                              Cancel run
                            </PillButton>
                          )}
                          {/* Slice 4 external-path actions — only render when
                            the runtime detector emitted the new action
                            triplet. The generic accept/decline buttons
                            above won't match those approvals' action list,
                            so only these three appear for external-path
                            prompts. */}
                          {(pendingAgentApproval.actions || []).includes(
                            'grantExternalPathRead'
                          ) && (
                            <PillButton
                              variant="primary"
                              size="compact"
                              type="button"
                              title="Grant read-only access to the detected external path for this request."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'grantExternalPathRead'
                                )
                              }
                            >
                              Grant read access
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || []).includes(
                            'grantExternalPathEdit'
                          ) && (
                            <PillButton
                              variant="primary"
                              size="compact"
                              type="button"
                              title="Grant edit access to the detected external path for this request."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'grantExternalPathEdit'
                                )
                              }
                            >
                              Grant edit access
                            </PillButton>
                          )}
                          {(pendingAgentApproval.actions || []).includes('declineExternalPath') && (
                            <PillButton
                              variant="ghost"
                              size="compact"
                              type="button"
                              title="Deny this external path request once. The agent may ask again if it still needs the path."
                              onClick={() =>
                                void handleAgentApprovalAction(
                                  pendingAgentApproval.id,
                                  'declineExternalPath'
                                )
                              }
                            >
                              Deny once
                            </PillButton>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="composer-inline-pickers">
                      <div className="composer-inline-pickers-left">
                        {(() => {
                          const workspaceActionDisabled = !currentWorkspace || !currentChat
                          const plusSections: ComposerPlusPickerSection[] = [
                            {
                              id: 'add',
                              title: 'Add',
                              items: [
                                {
                                  id: 'attachment',
                                  label: 'Attachment',
                                  description: 'Add files or images',
                                  icon: <PlusSymbolIcon />,
                                  disabled: isCurrentComposerLocked,
                                  onSelect: handlePickImages
                                },
                                {
                                  id: 'attached-window',
                                  label: attachedWindow ? 'Detach app' : 'Attach app',
                                  description: attachedWindow
                                    ? attachedWindow.streaming
                                      ? 'Stop live capture and detach'
                                      : 'Detach the picked window'
                                    : screenWatchUnavailableReason
                                      ? screenWatchUnavailableReason
                                      : 'Pick a running app window',
                                  icon: <CommandSymbolIcon />,
                                  disabled:
                                    isCurrentComposerLocked ||
                                    Boolean(screenWatchUnavailableReason) ||
                                    (!attachedWindow && isAttachingWindow),
                                  onSelect: attachedWindow ? handleDetachWindow : handleAttachWindow
                                },
                                {
                                  id: 'discord-context',
                                  label: 'Discord context',
                                  description: currentDiscordContextSelection
                                    ? `#${currentDiscordContextSelection.channelName || currentDiscordContextSelection.channelId} · last ${currentDiscordContextSelection.limit}`
                                    : 'Read recent channel messages',
                                  icon: <ChatMediaIcon />,
                                  active: Boolean(currentDiscordContextSelection),
                                  disabled: isCurrentComposerLocked || !currentChat,
                                  onSelect: openDiscordContextPicker
                                }
                              ]
                            },
                            {
                              id: 'workspace',
                              title: 'Workspace',
                              items: isCurrentGlobalChat
                                ? []
                                : [
                                    {
                                      id: 'safety',
                                      label: 'Status',
                                      description: `${currentProviderLabel} safety and setup`,
                                      icon: <TrustSymbolIcon />,
                                      disabled: workspaceActionDisabled,
                                      onSelect: () => openInspectorTab('safety')
                                    },
                                    {
                                      id: 'diff',
                                      label: 'Diff Studio',
                                      description: `${currentProviderLabel} workspace changes`,
                                      icon: <FileMenuSelectionIcon />,
                                      disabled: workspaceActionDisabled,
                                      onSelect: () => openInspectorTab('diff')
                                    },
                                    {
                                      id: 'capabilities',
                                      label: 'Models',
                                      description: `${currentProviderLabel} capability state`,
                                      icon: <ModelSymbolIcon />,
                                      disabled: workspaceActionDisabled,
                                      onSelect: () => openInspectorTab('capabilities')
                                    }
                                  ]
                            },
                            {
                              id: 'commands',
                              title: 'Commands',
                              items: isCurrentGlobalChat
                                ? []
                                : [
                                    {
                                      id: 'palette',
                                      label: 'Slash commands',
                                      description: `${currentProviderLabel} slash command menu`,
                                      icon: <CommandSymbolIcon />,
                                      active: slashMenuOpen,
                                      disabled: workspaceActionDisabled,
                                      onSelect: () => openSlashCommandsMenu()
                                    },
                                    {
                                      id: 'review',
                                      label: isPreparingDiffReview
                                        ? 'Preparing review'
                                        : 'Review diff',
                                      description: 'Read-only plan-mode review',
                                      icon: <ReviewSymbolIcon />,
                                      disabled: workspaceActionDisabled || isPreparingDiffReview,
                                      onSelect: () => void handleReviewCurrentDiff()
                                    }
                                  ]
                            }
                          ]
                          return (
                            <ComposerPlusPicker
                              provider={currentProvider}
                              composerStyle={appearance.composerStyle}
                              sections={plusSections}
                              disabled={isCurrentComposerLocked}
                              triggerIcon={<PlusSymbolIcon />}
                            />
                          )
                        })()}
                        {/* 1.0.4-AS3 — the old name-pill (Application × ) is gone;
                        the attached-window affordance now lives in the
                        composer telemetry row as a Screen Watch icon
                        button (see further down). Removing it from this
                        action-row position avoids visually competing with
                        the model picker / send button. */}
                        {/* Ensemble orchestration controls (mode picker /
                          fan-out toggle / shared-history budget / hop meter)
                          moved out of this action row — with Continuous
                          enabled they crowded the footer. They now live as
                          the labeled second row of the roster-presets
                          above-row section; see EnsembleOrchestrationRow.tsx
                          and `renderEnsembleOrchestrationRow` above. */}
                        {/* Provider picker. In solo chats this remains the
                          chat-level provider switch. In Ensemble chats it
                          retargets to the selected participant so users can
                          build same-provider panels without leaving the
                          composer. */}
                        {(() => {
                          const ensembleBinding =
                            isCurrentEnsembleChat && selectedParticipant
                              ? selectedParticipant
                              : null
                          const participantSeatMutation = ensembleBinding
                            ? resolveEnsembleParticipantSeatMutationState(
                                currentChat?.ensemble?.activeRound,
                                ensembleBinding.id
                              )
                            : null
                          const participantControlsLocked = Boolean(participantSeatMutation?.locked)
                          const soloPendingProviderChange =
                            !ensembleBinding && currentChat
                              ? readPendingProviderChange(currentChat)
                              : null
                          const pendingProviderModelId =
                            typeof soloPendingProviderChange?.providerMetadata?.selectedModelType ===
                            'string'
                              ? soloPendingProviderChange.providerMetadata.selectedModelType
                              : null
                          const pickerProvider =
                            ensembleBinding?.provider ||
                            soloPendingProviderChange?.provider ||
                            currentProvider
                          const handleComposerProviderChange = (provider: ProviderId): void => {
                            if (ensembleBinding) {
                              const defaults = getDefaultEnsembleParticipantConfig(provider)
                              updateSelectedParticipantWithNotice({
                                provider,
                                model: defaults.model,
                                runtimeProfileId: undefined,
                                geminiAuthProfileId: provider === 'gemini' ? null : undefined,
                                permissionPresetId: defaults.permissionPresetId,
                                reasoningEffort: defaults.reasoningEffort,
                                fastModeEnabled: defaults.fastModeEnabled,
                                thinkingEnabled: defaults.thinkingEnabled,
                                serviceTier: defaults.serviceTier,
                                linkedProviderSessionId: null
                              })
                              return
                            }
                            void handleProviderChange(provider)
                          }
                          // Rich popover provider picker (1.0.6-CRUX24).
                          // Replaces the old native <select> with the same
                          // body-portaled `composer-combined-picker-popover`
                          // pattern the model / permission / "+" pickers use.
                          // All prior behaviour is preserved verbatim:
                          //   - `pickerProvider` (chat-level OR the bound
                          //     ensemble participant's provider) drives the
                          //     trigger + the active checkmark,
                          //   - `handleComposerProviderChange` is the same
                          //     handler the <select>'s onChange called, so
                          //     the ensemble retarget vs solo provider-switch
                          //     side effects are unchanged,
                          //   - the disabled expression + the gated grok /
                          //     cursor visibility + the title text are passed
                          //     through identically,
                          //   - `shell-${composerStyle}` (inside the
                          //     component) makes the popover theme per shell
                          //     with no per-shell branches here.
                          return (
                            <ComposerProviderPicker
                              provider={pickerProvider}
                              composerStyle={appearance.composerStyle}
                              grokAvailable={grokProviderAvailable}
                              cursorAvailable={cursorProviderAvailable}
                              providerRunPauses={settings?.providerRunPauses}
                              onSelect={handleComposerProviderChange}
                              disabled={Boolean(ensembleBinding && participantControlsLocked)}
                              activeModelId={
                                ensembleBinding?.model ??
                                pendingProviderModelId ??
                                selectedComposerModelType
                              }
                              title={
                                participantControlsLocked
                                  ? participantSeatMutation?.message || 'Seat change applies at turn end'
                                  : ensembleBinding
                                    ? 'Selected participant provider'
                                    : soloPendingProviderChange || isCurrentChatProviderLocked
                                      ? 'Provider change applies at turn end'
                                      : isCurrentChatRunning
                                        ? 'Choose a provider to queue for turn end'
                                    : 'Provider'
                              }
                            />
                          )
                        })()}
                        {/* 1.0.5-AR12c — Workspace switcher previously
                         lived here in the top inline-pickers row but
                         crowded the approval / provider / model
                         controls on dense windows. Moved to the
                         composer's bottom telemetry row (below) where
                         it sits spaced between the timecode / Screen
                         Watch cluster on the left and the token tally
                         on the right. See the
                         `data-composer-control="workspace"` mount
                         inside `.composer-telemetry-row` below for
                         the new placement; the underlying
                         `ComposerWorkspaceSwitcher` component is
                         unchanged. */}
                        {(() => {
                          // CombinedModelPicker — replaces the per-provider
                          // native <select> chain that used to live here
                          // (Model + Codex reasoning + Codex speed + Kimi
                          // thinking + Claude reasoning) with one chip + a
                          // two-column popover (Model | Reasoning).
                          //
                          // Slice F v2 (1.0.3) — when this is an ensemble
                          // chat AND a participant chip is selected in the
                          // strip above the composer, this picker rebinds
                          // to that participant: it reads the participant's
                          // model / reasoning / fast-mode and writes via
                          // updateSelectedParticipant() instead of the
                          // chat-level rememberCurrentChatComposerSelection.
                          // `effective*` values below resolve to either the
                          // chat-level hooks (solo chat) or the participant
                          // (ensemble + selected chip).
                          const ensembleBinding =
                            isCurrentEnsembleChat && selectedParticipant
                              ? selectedParticipant
                              : null
                          // Resolve the participant's effective settings via the
                          // centralized helper so the per-provider fallbacks
                          // (`'medium'` reasoning, fast-mode→serviceTier inference,
                          // thinking off, etc.) live in one module. See
                          // `src/renderer/src/lib/ensembleProviderDefaults.ts`.
                          const ensembleResolved = ensembleBinding
                            ? resolveEnsembleParticipantSettings(ensembleBinding)
                            : null
                          const soloPendingProviderChange =
                            !ensembleBinding && currentChat
                              ? readPendingProviderChange(currentChat)
                              : null
                          const soloPendingProviderMetadata = soloPendingProviderChange?.providerMetadata
                          const effectiveProvider: ProviderId =
                            ensembleBinding?.provider ??
                            soloPendingProviderChange?.provider ??
                            currentProvider
                          const effectiveModelOptionsRaw = ensembleBinding
                            ? getProviderModelOptions(ensembleBinding.provider)
                            : effectiveProvider === currentProvider
                              ? currentProviderModelOptions
                              : getProviderModelOptions(effectiveProvider)
                          const pendingSelectedModel =
                            typeof soloPendingProviderMetadata?.selectedModelType === 'string'
                              ? soloPendingProviderMetadata.selectedModelType
                              : null
                          const hasValidPendingSelectedModel = Boolean(
                            pendingSelectedModel &&
                              (pendingSelectedModel === 'custom'
                                ? effectiveProvider !== 'kimi'
                                : effectiveModelOptionsRaw.some(
                                    (model) => model.id === pendingSelectedModel
                                  ))
                          )
                          const effectiveSelectedModel = ensembleResolved
                            ? ensembleResolved.model
                            : hasValidPendingSelectedModel
                              ? pendingSelectedModel!
                              : selectedComposerModelType
                          const effectiveCodexReasoning =
                            ensembleResolved?.provider === 'codex'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.codexReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.codexReasoningEffort
                                : codexReasoningEffort
                          const effectiveClaudeReasoning =
                            ensembleResolved?.provider === 'claude'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.claudeReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.claudeReasoningEffort
                                : claudeReasoningEffort
                          const effectiveKimiThinking =
                            ensembleResolved?.provider === 'kimi'
                              ? ensembleResolved.thinkingEnabled
                              : typeof soloPendingProviderMetadata?.kimiThinkingEnabled ===
                                    'boolean'
                                ? soloPendingProviderMetadata.kimiThinkingEnabled
                                : kimiThinkingEnabled
                          const effectiveGrokReasoning =
                            ensembleResolved?.provider === 'grok'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.grokReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.grokReasoningEffort
                                : grokReasoningEffort
                          const effectiveCursorReasoning =
                            ensembleResolved?.provider === 'cursor'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.cursorReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.cursorReasoningEffort
                                : cursorReasoningEffort
                          const effectiveCodexServiceTier =
                            ensembleResolved?.provider === 'codex'
                              ? ensembleResolved.serviceTier
                              : typeof soloPendingProviderMetadata?.codexServiceTier === 'string'
                                ? soloPendingProviderMetadata.codexServiceTier
                                : codexServiceTier
                          const effectiveClaudeFastMode =
                            ensembleResolved?.provider === 'claude'
                              ? ensembleResolved.fastModeEnabled
                              : typeof soloPendingProviderMetadata?.claudeFastMode === 'boolean'
                                ? soloPendingProviderMetadata.claudeFastMode
                                : claudeFastMode
                          const effectiveCursorFastMode =
                            ensembleResolved?.provider === 'cursor'
                              ? ensembleResolved.fastModeEnabled
                              : typeof soloPendingProviderMetadata?.cursorFastMode === 'boolean'
                                ? soloPendingProviderMetadata.cursorFastMode
                                : cursorFastMode
                          const shouldUpdateLiveComposerState =
                            !ensembleBinding &&
                            (!soloPendingProviderChange ||
                              soloPendingProviderChange.provider === currentProvider)
                          const shouldAppendCustomModelOption =
                            effectiveProvider !== 'kimi' &&
                            !effectiveModelOptionsRaw.some((model) => model.id === 'custom')

                          const combinedModelOptions: CombinedModelPickerModelOption[] = [
                            ...effectiveModelOptionsRaw.map((model) => {
                              // 1.0.7-mini — forward the optional retiresAt only
                              // when it's actually a string. Non-Codex provider
                              // model shapes don't carry the field; the cast
                              // narrows safely via the runtime typeof guard so
                              // bad data can't leak into the picker.
                              const retiresAtRaw = (model as { retiresAt?: unknown }).retiresAt
                              const retiresAt =
                                typeof retiresAtRaw === 'string' ? retiresAtRaw : undefined
                              const disabledReason =
                                typeof model.disabledReason === 'string'
                                  ? model.disabledReason
                                  : undefined
                              return {
                                id: model.id,
                                label: model.label || model.id,
                                ...(model.disabled ? { disabled: true } : {}),
                                ...(disabledReason ? { disabledReason } : {}),
                                ...(retiresAt ? { retiresAt } : {})
                              }
                            }),
                            ...(shouldAppendCustomModelOption
                              ? [{ id: 'custom', label: 'Custom…' }]
                              : [])
                          ]

                          let combinedReasoningOptions: CombinedModelPickerReasoningOption[] = []
                          let combinedSelectedReasoning = ''
                          if (effectiveProvider === 'codex') {
                            // Ensemble binding resolves the per-model reasoning set
                            // from the selected model (so GPT-5.6 Sol keeps its Max
                            // + Ultra tiers), mirroring the Claude branch below;
                            // the chat-level path uses the live `codexReasoningOptions`.
                            combinedReasoningOptions = ensembleBinding
                              ? getEnsembleReasoningOptions('codex', effectiveSelectedModel)
                              : codexReasoningOptions
                                  .filter((option) => option?.reasoningEffort)
                                  .map((option) => ({
                                    value: option.reasoningEffort,
                                    label: codexReasoningDisplayLabel(option.reasoningEffort)
                                  }))
                            combinedSelectedReasoning = effectiveCodexReasoning
                          } else if (effectiveProvider === 'claude') {
                            combinedReasoningOptions = ensembleBinding
                              ? getEnsembleReasoningOptions('claude', effectiveSelectedModel)
                              : claudeReasoningOptions
                                  .filter((option) => option?.reasoningEffort)
                                  .map((option) => ({
                                    value: option.reasoningEffort,
                                    label: claudeReasoningDisplayLabel(option.reasoningEffort),
                                    ...(option.disabled ? { disabled: true } : {}),
                                    ...(option.disabledReason
                                      ? { disabledReason: option.disabledReason }
                                      : {})
                                  }))
                            combinedSelectedReasoning = effectiveClaudeReasoning
                          } else if (effectiveProvider === 'kimi') {
                            combinedReasoningOptions = [
                              { value: 'on', label: 'Thinking on' },
                              { value: 'off', label: 'Thinking off' }
                            ]
                            combinedSelectedReasoning = effectiveKimiThinking ? 'on' : 'off'
                          } else if (
                            effectiveProvider === 'grok' &&
                            isGrok45ReasoningModelId(effectiveSelectedModel)
                          ) {
                            combinedReasoningOptions = [
                              { value: 'low', label: grokReasoningDisplayLabel('low') },
                              { value: 'medium', label: grokReasoningDisplayLabel('medium') },
                              { value: 'high', label: grokReasoningDisplayLabel('high') }
                            ]
                            combinedSelectedReasoning =
                              effectiveGrokReasoning || GROK_45_DEFAULT_REASONING_EFFORT
                          } else if (
                            effectiveProvider === 'cursor' &&
                            isCursorGrok45ModelId(effectiveSelectedModel)
                          ) {
                            combinedReasoningOptions = [
                              { value: 'low', label: grokReasoningDisplayLabel('low') },
                              { value: 'medium', label: grokReasoningDisplayLabel('medium') },
                              { value: 'high', label: grokReasoningDisplayLabel('high') }
                            ]
                            combinedSelectedReasoning =
                              effectiveCursorReasoning || GROK_45_DEFAULT_REASONING_EFFORT
                          }

                          const handleCombinedModelChange = (nextModel: string) => {
                            if (effectiveProvider === 'ollama') {
                              onOllamaModelSelected?.(
                                nextModel,
                                combinedModelOptions.find((option) => option.id === nextModel)
                                  ?.label
                              )
                            }
                            if (ensembleBinding) {
                              const patch: Partial<EnsembleParticipant> = { model: nextModel }
                              // Drop fast-mode if the new model can't support
                              // it, mirroring the chat-level handler below.
                              if (effectiveProvider === 'codex') {
                                const modelOption = codexModels.find((m) => m.id === nextModel)
                                if (modelOption?.defaultReasoningEffort) {
                                  patch.reasoningEffort = modelOption.defaultReasoningEffort
                                }
                                if (!modelOption?.additionalSpeedTiers?.includes('fast')) {
                                  patch.fastModeEnabled = false
                                  patch.serviceTier = ''
                                }
                              }
                              if (effectiveProvider === 'claude') {
                                const claudeModelOption = (
                                  agentModelsByProvider.claude || CLAUDE_DEFAULT_MODELS
                                ).find((m) => m.id === nextModel)
                                patch.reasoningEffort =
                                  resolveClaudeDefaultReasoningEffort(claudeModelOption)
                                if (!claudeModelOption?.additionalSpeedTiers?.includes('fast')) {
                                  patch.fastModeEnabled = false
                                }
                              }
                              if (effectiveProvider === 'grok') {
                                patch.reasoningEffort = isGrok45ReasoningModelId(nextModel)
                                  ? GROK_45_DEFAULT_REASONING_EFFORT
                                  : undefined
                              }
                              if (effectiveProvider === 'cursor') {
                                if (isCursorGrok45ModelId(nextModel)) {
                                  patch.reasoningEffort = GROK_45_DEFAULT_REASONING_EFFORT
                                } else {
                                  patch.reasoningEffort = undefined
                                }
                                if (!isCursorGrok45ModelId(nextModel) && nextModel !== 'composer-2.5-fast') {
                                  patch.fastModeEnabled = false
                                }
                              }
                              updateSelectedParticipantWithNotice(patch)
                              return
                            }
                            if (shouldUpdateLiveComposerState && nextModel !== 'custom') {
                              setLastNonCustomModelType(nextModel)
                            }
                            if (shouldUpdateLiveComposerState) {
                              setSelectedModelType(nextModel)
                            }
                            const metadataPatch: Record<string, unknown> = {
                              selectedModelType: nextModel
                            }
                            if (effectiveProvider === 'codex') {
                              const modelOption = codexModels.find(
                                (model) => model.id === nextModel
                              )
                              if (modelOption?.defaultReasoningEffort) {
                                if (shouldUpdateLiveComposerState) {
                                  setCodexReasoningEffort(modelOption.defaultReasoningEffort)
                                }
                                metadataPatch.codexReasoningEffort =
                                  modelOption.defaultReasoningEffort
                              }
                              if (!modelOption?.additionalSpeedTiers?.includes('fast')) {
                                if (shouldUpdateLiveComposerState) {
                                  setCodexServiceTier('')
                                }
                                metadataPatch.codexServiceTier = ''
                              }
                            }
                            if (effectiveProvider === 'claude') {
                              // Symmetric to Codex above: clear Fast when
                              // switching to a non-capable Claude model so
                              // the persisted flag doesn't outlive its
                              // applicability.
                              const claudeModelOption = (
                                agentModelsByProvider.claude || CLAUDE_DEFAULT_MODELS
                              ).find((model) => model.id === nextModel)
                              const nextReasoning =
                                resolveClaudeDefaultReasoningEffort(claudeModelOption)
                              if (shouldUpdateLiveComposerState) {
                                setClaudeReasoningEffort(nextReasoning)
                              }
                              metadataPatch.claudeReasoningEffort = nextReasoning
                              if (!claudeModelOption?.additionalSpeedTiers?.includes('fast')) {
                                if (shouldUpdateLiveComposerState) {
                                  setClaudeFastMode(false)
                                }
                                metadataPatch.claudeFastMode = false
                              }
                            }
                            if (effectiveProvider === 'grok') {
                              if (isGrok45ReasoningModelId(nextModel)) {
                                if (shouldUpdateLiveComposerState) {
                                  setGrokReasoningEffort(GROK_45_DEFAULT_REASONING_EFFORT)
                                }
                                metadataPatch.grokReasoningEffort =
                                  GROK_45_DEFAULT_REASONING_EFFORT
                              } else {
                                if (shouldUpdateLiveComposerState) {
                                  setGrokReasoningEffort('')
                                }
                                metadataPatch.grokReasoningEffort = ''
                              }
                            }
                            if (effectiveProvider === 'cursor') {
                              if (isCursorGrok45ModelId(nextModel)) {
                                if (shouldUpdateLiveComposerState) {
                                  setCursorReasoningEffort(GROK_45_DEFAULT_REASONING_EFFORT)
                                }
                                metadataPatch.cursorReasoningEffort =
                                  GROK_45_DEFAULT_REASONING_EFFORT
                              }
                              if (!isCursorGrok45ModelId(nextModel)) {
                                if (shouldUpdateLiveComposerState) {
                                  setCursorFastMode(nextModel === 'composer-2.5-fast')
                                  setCursorReasoningEffort('')
                                }
                                metadataPatch.cursorReasoningEffort = ''
                                metadataPatch.cursorFastMode = nextModel === 'composer-2.5-fast'
                              }
                            }
                            if (effectiveProvider === 'gemini' && shouldUpdateLiveComposerState) {
                              syncPersistentModelSelection(nextModel)
                            }
                            rememberCurrentChatComposerSelection(metadataPatch)
                          }

                          /*
                           * Fast Mode toggle inside the picker. Replaces
                           * the standalone Codex-only speed `<select>`
                           * that previously sat next to the chip — same
                           * underlying state, just surfaced inside the
                           * Model+Reasoning popover so the user finds it
                           * where they're already adjusting reasoning.
                           */
                          const fastModeCapableModelIds = (() => {
                            if (effectiveProvider === 'codex') {
                              return new Set(
                                codexModels
                                  .filter((model) => model.additionalSpeedTiers?.includes('fast'))
                                  .map((model) => model.id)
                              )
                            }
                            if (effectiveProvider === 'claude') {
                              return new Set(
                                (agentModelsByProvider.claude || CLAUDE_DEFAULT_MODELS)
                                  .filter((model) => model.additionalSpeedTiers?.includes('fast'))
                                  .map((model) => model.id)
                              )
                            }
                            if (effectiveProvider === 'cursor') {
                              return new Set([
                                'composer-2.5',
                                'composer-2.5-fast',
                                CURSOR_GROK_45_BASE_MODEL_ID
                              ])
                            }
                            if (effectiveProvider === 'grok') {
                              // Both Grok models are permanently Fast-mode, so
                              // both picker rows get the Fast ⚡ glyph. Grok
                              // passes no onToggleFastMode, so no toggle row
                              // renders (Fast isn't user-switchable here).
                              return new Set([GROK_45_MODEL_ID, 'grok-composer-2.5-fast'])
                            }
                            // Gemini + Kimi: no Fast tier — hide the toggle
                            // by passing an empty set (CombinedModelPicker
                            // skips rendering the row in that case).
                            return new Set<string>()
                          })()
                          const fastModeEnabledForProvider =
                            effectiveProvider === 'codex'
                              ? effectiveCodexServiceTier === 'fast'
                              : effectiveProvider === 'claude'
                                ? effectiveClaudeFastMode
                                : effectiveProvider === 'cursor'
                                  ? isCursorGrok45ModelId(effectiveSelectedModel)
                                    ? effectiveCursorFastMode
                                    : effectiveSelectedModel === 'composer-2.5-fast'
                                  : false
                          const handleToggleFastMode =
                            effectiveProvider === 'codex'
                              ? () => {
                                  const nextTier =
                                    effectiveCodexServiceTier === 'fast' ? '' : 'fast'
                                  if (ensembleBinding) {
                                    updateSelectedParticipantWithNotice({
                                      serviceTier: nextTier,
                                      fastModeEnabled: nextTier === 'fast'
                                    })
                                    return
                                  }
                                  if (shouldUpdateLiveComposerState) {
                                    setCodexServiceTier(nextTier)
                                  }
                                  rememberCurrentChatComposerSelection({
                                    codexServiceTier: nextTier
                                  })
                                }
                              : effectiveProvider === 'claude'
                                ? () => {
                                    const nextFast = !effectiveClaudeFastMode
                                    if (ensembleBinding) {
                                      updateSelectedParticipantWithNotice({ fastModeEnabled: nextFast })
                                      return
                                    }
                                    if (shouldUpdateLiveComposerState) {
                                      setClaudeFastMode(nextFast)
                                    }
                                    rememberCurrentChatComposerSelection({
                                      claudeFastMode: nextFast
                                    })
                                  }
                                : effectiveProvider === 'cursor'
                                  ? () => {
                                      if (isCursorGrok45ModelId(effectiveSelectedModel)) {
                                        const nextFast = !effectiveCursorFastMode
                                        if (ensembleBinding) {
                                          updateSelectedParticipantWithNotice({
                                            fastModeEnabled: nextFast
                                          })
                                          return
                                        }
                                        if (shouldUpdateLiveComposerState) {
                                          setCursorFastMode(nextFast)
                                        }
                                        rememberCurrentChatComposerSelection({
                                          cursorFastMode: nextFast
                                        })
                                        return
                                      }
                                      const nextModel =
                                        effectiveSelectedModel === 'composer-2.5-fast'
                                          ? 'composer-2.5'
                                          : 'composer-2.5-fast'
                                      handleCombinedModelChange(nextModel)
                                    }
                                  : undefined

                          const handleCombinedReasoningChange = (value: string) => {
                            if (ensembleBinding) {
                              if (ensembleBinding.provider === 'kimi') {
                                updateSelectedParticipantWithNotice({ thinkingEnabled: value !== 'off' })
                              } else {
                                updateSelectedParticipantWithNotice({ reasoningEffort: value })
                              }
                              return
                            }
                            if (effectiveProvider === 'codex') {
                              if (shouldUpdateLiveComposerState) {
                                setCodexReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                codexReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'claude') {
                              if (shouldUpdateLiveComposerState) {
                                setClaudeReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                claudeReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'kimi') {
                              const enabled = value !== 'off'
                              if (shouldUpdateLiveComposerState) {
                                setKimiThinkingEnabled(enabled)
                              }
                              rememberCurrentChatComposerSelection({
                                kimiThinkingEnabled: enabled
                              })
                            } else if (effectiveProvider === 'grok') {
                              if (shouldUpdateLiveComposerState) {
                                setGrokReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                grokReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'cursor') {
                              if (shouldUpdateLiveComposerState) {
                                setCursorReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                cursorReasoningEffort: value
                              })
                            }
                          }

                          return (
                            <>
                              {appearance.composerStyle === 'codex' && (
                                <ContextMeterPopover
                                  meter={contextMeter}
                                  percent={contextUsedPercent}
                                  label={contextLabel}
                                  provider={currentProvider}
                                  composerStyle={appearance.composerStyle}
                                  onCompactContext={onCompactContext}
                                  onCompactParticipant={onCompactParticipant}
                                  compactableParticipantIds={compactableParticipantIds}
                                  speakingParticipantId={speakingParticipantId}
                                />
                              )}
                              <CombinedModelPicker
                                provider={effectiveProvider}
                                composerStyle={appearance.composerStyle}
                                modelOptions={combinedModelOptions}
                                selectedModelId={effectiveSelectedModel}
                                onSelectModel={handleCombinedModelChange}
                                reasoningOptions={combinedReasoningOptions}
                                selectedReasoning={combinedSelectedReasoning}
                                onSelectReasoning={handleCombinedReasoningChange}
                                codexReasoningEffort={effectiveCodexReasoning}
                                claudeReasoningEffort={effectiveClaudeReasoning}
                                grokReasoningEffort={effectiveGrokReasoning}
                                cursorReasoningEffort={effectiveCursorReasoning}
                                kimiThinkingEnabled={effectiveKimiThinking}
                                fastModeCapableModelIds={fastModeCapableModelIds}
                                fastModeEnabled={fastModeEnabledForProvider}
                                onToggleFastMode={handleToggleFastMode}
                                disabled={false}
                              />
                              {!ensembleBinding &&
                                selectedModelType === 'custom' &&
                                currentProvider !== 'kimi' && (
                                  <span className="composer-inline-custom-model">
                                    <input
                                      className="composer-inline-input"
                                      type="text"
                                      value={customModel}
                                      onChange={(e) => {
                                        setCustomModel(e.target.value)
                                        rememberCurrentChatComposerSelection({
                                          customModel: e.target.value
                                        })
                                        if (currentProvider === 'gemini') {
                                          markPersistentSessionRestartNeeded(
                                            'Gemini custom model changed. Restart the persistent session to apply the new model.'
                                          )
                                        }
                                      }}
                                      placeholder="Model ID"
                                      disabled={isCurrentComposerLocked}
                                    />
                                    <button
                                      className="composer-inline-clear"
                                      type="button"
                                      onClick={() => {
                                        setCustomModel('')
                                        setSelectedModelType(lastNonCustomModelType)
                                        rememberCurrentChatComposerSelection({
                                          customModel: '',
                                          selectedModelType: lastNonCustomModelType
                                        })
                                        if (currentProvider === 'gemini') {
                                          syncPersistentModelSelection(lastNonCustomModelType)
                                        }
                                      }}
                                      disabled={isCurrentComposerLocked}
                                      title="Cancel custom model"
                                      aria-label="Cancel custom model"
                                    >
                                      <XSymbolIcon />
                                    </button>
                                  </span>
                                )}
                            </>
                          )
                        })()}

                        {/*
                        Codex speed-tier `<select>` removed — Fast mode
                        now lives inside CombinedModelPicker as a toggle
                        beneath the Reasoning column, gated by each
                        model's `additionalSpeedTiers`. Same underlying
                        `codexServiceTier` state, surfaced in the same
                        popover the user already opens to tweak
                        reasoning effort.
                      */}

                        {(() => {
                          // CombinedPermissionsPicker — replaces the
                          // native <select> permission picker AND
                          // absorbs the old "Tool Grants" pill from the
                          // above-bar. Single chip, two-column popover
                          // (Permissions | Tool Grants).
                          //
                          // Slice F v2 (1.0.3) — when ensemble + a
                          // participant chip is selected, the picker
                          // reads/writes the participant's
                          // `permissionPresetId` instead of the chat's
                          // `approvalMode`. Participant edits remain
                          // capability-only; solo chat edits split Plan
                          // workflow from Read-only recon while both map to
                          // the provider's existing read-only capability.
                          // Slice A3 — in Ensemble Mode, Tool Grants are
                          // participant-scoped overrides. Solo chats keep
                          // using provider+workspace grants.
                          const ensembleBinding =
                            isCurrentEnsembleChat && selectedParticipant
                              ? selectedParticipant
                              : null
                          const effectiveProvider: ProviderId =
                            ensembleBinding?.provider ?? currentProvider
                          const presetForSelection = (
                            preset: string | undefined
                          ): PermissionPresetId => {
                            if (preset === 'plan') return 'plan'
                            if (preset === 'read_only') return 'read_only'
                            if (preset === 'workspace_write') return 'workspace_write'
                            if (preset === 'full_access') return 'full_access'
                            return 'default'
                          }
                          const selectionToPreset = (value: string): PermissionPresetId => {
                            if (value === 'plan') return 'plan'
                            if (value === 'read_only') return 'read_only'
                            if (value === 'workspace_write') return 'workspace_write'
                            if (value === 'full_access') return 'full_access'
                            return 'default'
                          }
                          const presetToApprovalMode = (preset: PermissionPresetId): string =>
                            preset === 'plan' || preset === 'read_only'
                              ? 'plan'
                              : preset === 'workspace_write' || preset === 'full_access'
                                ? 'auto_edit'
                                : 'default'
                          const effectiveWorkflowMode =
                            normalizeComposerWorkflowMode(workflowMode) ||
                            normalizeComposerWorkflowMode(
                              currentChat?.providerMetadata?.workflowMode
                            ) ||
                            normalizeComposerWorkflowMode(currentChat?.workflowMode) ||
                            'normal'
                          const effectiveSelectedPermission = ensembleBinding
                            ? presetForSelection(ensembleBinding.permissionPresetId)
                            : presetForSelection(
                                typeof currentChat?.providerMetadata?.permissionPresetId === 'string'
                                  ? currentChat.providerMetadata.permissionPresetId
                                  : approvalMode === 'plan'
                                    ? effectiveWorkflowMode === 'plan'
                                      ? 'plan'
                                      : 'read_only'
                                    : approvalMode === 'auto_edit'
                                      ? 'workspace_write'
                                      : 'default'
                              )
                          // Solo AND ensemble share one option list (single source
                          // of truth). Values are real PermissionPresetIds so
                          // workspace_write and full_access stay distinct when
                          // persisted and signed for the selected lane.
                          const permissionPickerOptions: PermissionOption[] =
                            composerPermissionOptions().map((option) => {
                              if (option.value === 'workspace_write') {
                                return {
                                  ...option,
                                  description: 'Workspace files; no per-action edit prompts.'
                                }
                              }
                              if (option.value === 'full_access') {
                                return {
                                  ...option,
                                  description: 'This chat/lane only; host-level tools when supported.',
                                  danger: true
                                }
                              }
                              return option
                            })
                          const normalizedWorkspacePath = (currentWorkspace?.path || '').replace(
                            /\/+$/,
                            ''
                          )
                          const enabledGrantIds = ensembleBinding
                            ? getParticipantToolGrantIds(ensembleBinding)
                            : new Set(
                                agenticWorkspaceGrants
                                  .filter((grant) => {
                                    if (
                                      !grant ||
                                      grant.provider !== effectiveProvider ||
                                      !grant.workspacePath
                                    )
                                      return false
                                    return (
                                      grant.workspacePath.replace(/\/+$/, '') ===
                                      normalizedWorkspacePath
                                    )
                                  })
                                  .map((grant) => grant.service)
                              )
                          // Hide the Tool-Grants column when there's no
                          // workspace path to scope grants to (global
                          // chats or pre-workspace state).
                          const grantServicesForPicker =
                            currentWorkspace && !isCurrentGlobalChat
                              ? WORKSPACE_POLICY_SERVICES
                              : []
                          const handlePermissionSelection = (nextPermissionMode: string): void => {
                            const nextPermissionPreset = selectionToPreset(nextPermissionMode)
                            if (nextPermissionPreset === 'full_access') {
                              setTrustedSessionApprovalId(null)
                              setTrustedSessionConfirmOpen(true)
                              return
                            }
                            if (ensembleBinding) {
                              // Participant raises pass through the same two-tier
                              // elevation failsafe as solo chats. `from` derives
                              // from the participant's own preset (not the
                              // chat-level approvalMode); full_access never
                              // reaches here — it's intercepted above into the
                              // TrustedSessionConfirmSheet.
                              const applyParticipantSelection = (): void => {
                                updateSelectedParticipantWithNotice({
                                  permissionPresetId: nextPermissionPreset
                                })
                              }
                              const participantElevation = decideApprovalElevation({
                                from: presetToApprovalMode(effectiveSelectedPermission),
                                to: presetToApprovalMode(nextPermissionPreset),
                                provider: effectiveProvider,
                                workspacePath: currentWorkspacePath,
                                acknowledgedDefault: acknowledgedElevationDefaults
                              })
                              if (!participantElevation) {
                                applyParticipantSelection()
                                return
                              }
                              setPendingElevation({
                                tier: participantElevation.tier,
                                provider: effectiveProvider,
                                workspaceLabel: currentWorkspace?.displayName ?? null,
                                ackKey: participantElevation.ackKey,
                                persistAck: participantElevation.persistAckOnConfirm,
                                toMode: presetToApprovalMode(nextPermissionPreset),
                                permissionPresetId: nextPermissionPreset,
                                apply: applyParticipantSelection
                              })
                              return
                            }
                            const nextApprovalMode = presetToApprovalMode(nextPermissionPreset)
                            const nextWorkflowMode: ChatWorkflowMode =
                              nextPermissionPreset === 'plan' ? 'plan' : 'normal'
                            // The actual mode change, deferred so an
                            // elevation warning can gate it (see below).
                            const applyMainSelection = (): void => {
                              setApprovalMode(nextApprovalMode)
                              rememberCurrentChatComposerSelection({
                                approvalMode: nextApprovalMode,
                                workflowMode: nextWorkflowMode,
                                permissionPresetId: nextPermissionPreset
                              })
                              if (
                                currentProvider === 'gemini' &&
                                nextApprovalMode !== approvalMode
                              ) {
                                markPersistentSessionRestartNeeded(
                                  'Gemini approval mode changed. Restart the persistent session to apply the correct tool permissions.'
                                )
                              }
                            }
                            const elevation = decideApprovalElevation({
                              from: approvalMode,
                              to: nextApprovalMode,
                              provider: effectiveProvider,
                              workspacePath: currentWorkspacePath,
                              acknowledgedDefault: acknowledgedElevationDefaults
                            })
                            if (!elevation) {
                              applyMainSelection()
                              return
                            }
                            setPendingElevation({
                              tier: elevation.tier,
                              provider: effectiveProvider,
                              workspaceLabel: currentWorkspace?.displayName ?? null,
                              ackKey: elevation.ackKey,
                              persistAck: elevation.persistAckOnConfirm,
                              toMode: nextApprovalMode,
                              permissionPresetId: nextPermissionPreset,
                              apply: applyMainSelection
                            })
                          }
                          const handleToggleGrantForPicker = (
                            service: AgenticServiceId,
                            enabled: boolean
                          ): void => {
                            if (ensembleBinding) {
                              updateSelectedParticipantWithNotice(
                                buildParticipantToolGrantPatch(ensembleBinding, service, enabled)
                              )
                              return
                            }
                            void handleSetAgenticWorkspaceGrant(service, enabled, effectiveProvider)
                          }
                          const applyAllParticipants =
                            ensembleBinding &&
                            effectiveSelectedPermission !== 'full_access' &&
                            (currentChat?.ensemble?.participants.length || 0) > 1
                              ? applyEnsemblePermissionsToAllParticipants
                              : undefined
                          const stopTrustedSessionForPicker = (): void => {
                            if (currentChat?.appChatId) {
                              void window.api.trustedSessionSet(
                                {
                                  chatId: currentChat.appChatId,
                                  provider: effectiveProvider,
                                  workspacePath:
                                    currentWorkspacePath || currentChat.workspacePath || null,
                                  ensembleParticipantId: ensembleBinding?.id || null,
                                  runtimeProfileId:
                                    ensembleBinding?.runtimeProfileId ||
                                    selectedRuntimeProfileId ||
                                    null
                                },
                                false
                              )
                            }
                            if (ensembleBinding) {
                              updateSelectedParticipantWithNotice({ permissionPresetId: 'workspace_write' })
                              return
                            }
                            setApprovalMode('auto_edit')
                            rememberCurrentChatComposerSelection({
                              approvalMode: 'auto_edit',
                              workflowMode: 'normal',
                              permissionPresetId: 'workspace_write'
                            })
                          }
                          const pickerDisabled =
                            isCurrentComposerLocked ||
                            (effectiveProvider === 'gemini' && !geminiWorkspaceTrustReady)
                          // Tier retirement (2026-07): Ollama uses the SAME standard
                          // permission-role picker as every provider — no more
                          // Ollama-only tier/run-profile picker (the tier ladder is gone).
                          return (
                            <CombinedPermissionsPicker
                              provider={effectiveProvider}
                              composerStyle={appearance.composerStyle}
                              permissionOptions={permissionPickerOptions}
                              selectedPermission={effectiveSelectedPermission}
                              onSelectPermission={handlePermissionSelection}
                              grantServices={grantServicesForPicker}
                              enabledGrantIds={enabledGrantIds}
                              agenticServices={agenticServices}
                              onToggleGrant={handleToggleGrantForPicker}
                              grantScopeLabel={ensembleBinding ? 'participant' : 'workspace'}
                              onApplyToAllParticipants={applyAllParticipants}
                              onStartTrustedSession={() => {
                                setTrustedSessionApprovalId(null)
                                setTrustedSessionConfirmOpen(true)
                              }}
                              onStopTrustedSession={stopTrustedSessionForPicker}
                              disabled={pickerDisabled}
                            />
                          )
                        })()}
                        {voiceButtonLivesWithPermissions && (
                          <ComposerVoiceInputButton
                            composerStyle={appearance.composerStyle}
                            disabled={
                              isCurrentComposerLocked ||
                              !currentChat ||
                              (!isCurrentGlobalChat && !currentWorkspace)
                            }
                            onCaptureStateChange={setVoiceCaptureState}
                            onTranscript={handleVoiceTranscript}
                            provider={voicePickerProvider}
                          />
                        )}

                        {/* Legacy process-wide auto-approval indicator. New Trusted Session
                          elevation is lane-scoped and does not enable this switch, but
                          the stop chip remains visible if an older/remote path turned it on. */}
                        {sessionYoloMode.enabled && (
                          <button
                            type="button"
                            className="composer-yolo-chip"
                            data-composer-control="permission"
                            onClick={async () => {
                              try {
                                await window.api.agenticYoloSet(false)
                              } catch (error) {
                                console.error('Failed to disable YOLO session mode', error)
                              }
                            }}
                            title="Legacy global auto-approval is active across this TaskWraith session. Click to stop."
                            aria-label="Global auto-approval active. Click to turn it off."
                          >
                            <span className="composer-yolo-chip-icon" aria-hidden>
                              ⚠
                            </span>
                            <span className="composer-yolo-chip-label">Global auto-approval</span>
                          </button>
                        )}
                        {currentProvider === 'gemini' && !isCurrentGlobalChat && (
                          <label className="composer-picker-label" title="Workspace trust">
                            <TrustSymbolIcon />
                            <select
                              className="composer-inline-picker"
                              aria-label="Workspace trust"
                              value={trustSelectValue}
                              onChange={(e) => {
                                const nextValue = e.target.value
                                if (
                                  nextValue === 'trusted' &&
                                  !sessionTrust &&
                                  trustResult?.status !== 'trusted' &&
                                  trustResult?.status !== 'inherited'
                                ) {
                                  setSessionTrust(true)
                                  void handleBridgeCommand('/permissions trust')
                                } else if (nextValue === 'untrusted') {
                                  setSessionTrust(false)
                                  markPersistentSessionRestartNeeded(
                                    'Gemini workspace trust changed. Restart the persistent session to apply the trust setting.'
                                  )
                                }
                              }}
                              disabled={isCurrentComposerLocked}
                              title="Workspace trust"
                            >
                              <option value="trusted">Trusted</option>
                              <option value="untrusted">Untrusted</option>
                            </select>
                          </label>
                        )}
                      </div>
                      <div className="composer-inline-actions">
                        {appearance.composerStyle !== 'codex' && (
                          <ContextMeterPopover
                            meter={contextMeter}
                            percent={contextUsedPercent}
                            label={contextLabel}
                            provider={currentProvider}
                            composerStyle={appearance.composerStyle}
                            onCompactContext={onCompactContext}
                            onCompactParticipant={onCompactParticipant}
                            compactableParticipantIds={compactableParticipantIds}
                            speakingParticipantId={speakingParticipantId}
                          />
                        )}
                        {steerIndicatorMessage && (
                          <span
                            className="composer-steer-indicator"
                            role="status"
                            aria-live="polite"
                          >
                            <span className="composer-steer-indicator-dot" aria-hidden />
                            <span>{steerIndicatorMessage}</span>
                          </span>
                        )}
                        <HumanCollaborationInviteComposerControl
                          active={Boolean(humanCollaborationInviteActive)}
                          disabled={isCurrentComposerLocked}
                          share={humanCollaborationShare}
                          health={humanCollaborationInviteHealth}
                          busy={humanCollaborationInviteBusy}
                          live={humanCollaborationInviteLive}
                          onCopyInvite={onCopyHumanCollaborationInvite}
                          onCopyInviteText={onCopyHumanCollaborationInviteText}
                          onStopSharing={onStopHumanCollaborationSharing}
                          onOpenRemoteSetup={onOpenHumanCollaborationRemoteSetup}
                          onRefreshHealth={onRefreshHumanCollaborationInviteHealth}
                        />
                        {voiceButtonLivesInActionRow && (
                          <ComposerVoiceInputButton
                            composerStyle={appearance.composerStyle}
                            disabled={
                              isCurrentComposerLocked ||
                              !currentChat ||
                              (!isCurrentGlobalChat && !currentWorkspace)
                            }
                            onCaptureStateChange={setVoiceCaptureState}
                            onTranscript={handleVoiceTranscript}
                            provider={voicePickerProvider}
                          />
                        )}
                        {/*
                        1.0.6-EW70 — the run/stop buttons are
                        wrapped in `.composer-send-cluster` (display:contents
                        by default, so the nine other shells are unchanged).
                        Obsidian/Alabaster lift this cluster up into the
                        textarea rect's bottom-right corner. Codex moves the
                        ContextWheel beside the model picker; the remaining
                        shells keep it here at the right of the control row.
                      */}
                        <span className="composer-send-cluster">
                          {voiceButtonLivesInSendCluster && (
                            <ComposerVoiceInputButton
                              composerStyle={appearance.composerStyle}
                              disabled={
                                isCurrentComposerLocked ||
                                !currentChat ||
                                (!isCurrentGlobalChat && !currentWorkspace)
                              }
                              onCaptureStateChange={setVoiceCaptureState}
                              onTranscript={handleVoiceTranscript}
                              provider={voicePickerProvider}
                            />
                          )}
                          {isCurrentChatRunning ? (
                            <button
                              className="composer-action-btn stop-btn"
                              onClick={handleCancel}
                              title="Stop run"
                              aria-label="Stop run"
                              type="button"
                              disabled={isSteerBusyForCurrentChat}
                            >
                              <StopSymbolIcon />
                            </button>
                          ) : (
                            <button
                              className={`composer-action-btn run-btn ${isSendConfirming ? 'send-confirming' : ''}`}
                              onClick={(event) => {
                                if (tryHandleSideSlashSubmit()) {
                                  return
                                }
                                if (tryHandleActionSlashSubmit()) {
                                  return
                                }
                                if (tryHandleInlineGoalSlashSubmit()) {
                                  return
                                }
                                triggerSendConfirmation()
                                // DM target resolution (same precedence as
                                // the Enter handler above): explicit
                                // `@participant` mention wins; falls back
                                // to legacy Cmd/Ctrl-click on a selected
                                // chip; plain click = full round.
                                const dmFromMention = isCurrentEnsembleChat
                                  ? extractFirstEnsembleDmTarget(
                                      prompt,
                                      currentChat?.ensemble?.participants
                                    )
                                  : null
                                const dmTarget =
                                  dmFromMention ||
                                  (isCurrentEnsembleChat &&
                                  effectiveSelectedParticipantId &&
                                  (event.metaKey || event.ctrlKey)
                                    ? effectiveSelectedParticipantId
                                    : undefined)
                                handleRun(undefined, undefined, dmTarget || undefined)
                              }}
                              disabled={
                                !currentChat ||
                                (!isCurrentGlobalChat && !currentWorkspace) ||
                                !hasSendablePromptContent ||
                                (currentProvider === 'gemini' && !geminiWorkspaceTrustReady)
                              }
                              title={
                                !currentChat
                                  ? 'Open or start a chat first'
                                  : !isCurrentGlobalChat && !currentWorkspace
                                    ? 'Pick a workspace folder first'
                                    : !hasSendablePromptContent
                                      ? 'Type a prompt or attach a file first'
                                      : currentProvider === 'gemini' && !geminiWorkspaceTrustReady
                                          ? 'Trust this workspace for Gemini first'
                                          : isCurrentEnsembleChat && effectiveSelectedParticipantId
                                          ? `Run full ensemble round  ·  ${primaryModifierLabel} click = DM the selected chip`
                                          : 'Run'
                              }
                              aria-label="Run prompt"
                              aria-keyshortcuts="Enter Meta+Enter Control+Enter"
                              type="button"
                            >
                              {appearance.composerStyle === 'claude' ? (
                                <ClaudeReturnSymbolIcon />
                              ) : appearance.composerStyle === 'codex' ||
                                appearance.composerStyle === 'gemini' ||
                                appearance.composerStyle === 'cursor' ||
                                appearance.composerStyle === 'grok' ||
                                appearance.composerStyle === 'kimi' ? (
                                <ArrowUpSendIcon />
                              ) : (
                                <RunSymbolIcon />
                              )}
                            </button>
                          )}
                        </span>
                      </div>
                    </div>
                    {currentProvider === 'gemini' && !geminiWorkspaceTrustReady && (
                      <div
                        className="composer-inline-warning"
                        style={{
                          fontSize: 'var(--font-size-xs)',
                          color: 'var(--warning)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          flexWrap: 'wrap'
                        }}
                      >
                        <span>
                          Workspace trust is not established.
                          {geminiTrustWriteError ? ` ${geminiTrustWriteError}` : ''}
                        </span>
                        {currentWorkspace?.path &&
                          typeof window.api.trustWorkspace === 'function' && (
                            <button
                              type="button"
                              onClick={() => void handleTrustWorkspaceClick()}
                              disabled={geminiTrustWriteBusy || isCurrentComposerLocked}
                              title={`Trust ${currentWorkspace.path} for Gemini — writes ~/.gemini/trustedFolders.json`}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                                padding: '3px 9px',
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 600,
                                color: 'var(--text-primary)',
                                background: 'color-mix(in srgb, var(--warning) 18%, transparent)',
                                border:
                                  '1px solid color-mix(in srgb, var(--warning) 45%, transparent)',
                                borderRadius: '6px',
                                cursor: geminiTrustWriteBusy ? 'default' : 'pointer',
                                opacity: geminiTrustWriteBusy ? 0.7 : 1
                              }}
                            >
                              <TrustSymbolIcon />
                              {geminiTrustWriteBusy ? 'Trusting…' : 'Trust this folder'}
                            </button>
                          )}
                        <span style={{ opacity: 0.75 }}>or enable session trust above.</span>
                      </div>
                    )}
                  </div>
                  {/* 1.0.6-EW68 — close .composer-bottom-controls */}
                </div>
              </div>
              {/* Console redesign — close .composer-inner-module (the readable input/controls surface) */}
              <div
                className="composer-telemetry-row"
                data-has-token-tally={threadTokenTallyHasValue ? 'true' : 'false'}
              >
                {/* Timecode relocated to the pane-bottom bar. The row is split
                    into left zone (workspace) / centre cluster (icons) / right
                    zone (token tally); the three are placed left/centre/right
                    via flex `order` in CSS (not DOM order), so the cluster stays
                    pane-centred regardless of the side widths. */}
                <div className="composer-telemetry-cluster">
                <ComposerEnsembleToggleButton
                  enabled={isCurrentEnsembleChat}
                  visible={Boolean(
                    currentChat &&
                      !isCurrentChatLinkedChild &&
                      (isEnsembleModeEnabled || isCurrentEnsembleChat)
                  )}
                  onToggle={handleToggleWelcomeEnsemble}
                  composerStyle={appearance.composerStyle}
                  disabled={isCurrentChatRunning}
                  title={
                    isCurrentChatRunning
                      ? 'Finish the current turn first to change chat mode.'
                      : isCurrentEnsembleChat
                        ? 'Ensemble on'
                        : 'Ensemble off'
                  }
                />
                {/* 1.0.4-AS3 — Screen Watch (Appwatch/Appshots) button.
                    Pre-AS3 the attached-window UX was an inline pill in the
                    action row that took ~120px and showed the app name +
                    title + close glyph. the maintainer asked for a single themed
                    SVG icon button here in the telemetry row instead,
                    with the picker behind a click rather than a visible
                    name pill. Click toggles attach/detach; the tooltip
                    surfaces the attached app name; a small pulse dot
                    signals an active SCStream (kept the at-a-glance
                    "live capture" cue from the old pill). */}
                <button
                  type="button"
                  className={`composer-screen-watch-button composer-hint-pill${attachedWindow ? ' is-attached' : ''}${attachedWindow?.streaming ? ' is-streaming' : ''}${!attachedWindow && resumeAppWatchSnapshot ? ' is-resumable' : ''}`}
                  data-hint-label="Screen Watch"
                  onClick={() => {
                    if (screenWatchUnavailableReason) return
                    // M11 — both "attach fresh" and "resume" route through the
                    // picker (macOS requires a gesture to re-grant a window);
                    // handleAttachWindow clears the stash on success.
                    if (attachedWindow) void handleDetachWindow()
                    else void handleAttachWindow()
                  }}
                  title={
                    attachedWindow
                      ? attachedWindow.streaming
                        ? `Watching ${attachedWindow.windowMeta.applicationName || 'window'} · live capture · click to detach`
                        : `Watching ${attachedWindow.windowMeta.applicationName || 'window'}${attachedWindow.windowMeta.title ? ` — ${attachedWindow.windowMeta.title}` : ''} · click to detach`
                      : resumeAppWatchSnapshot
                        ? `Resume watching ${resumeAppWatchSnapshot.windowMeta.applicationName || 'window'}${resumeAppWatchSnapshot.windowMeta.title ? ` — ${resumeAppWatchSnapshot.windowMeta.title}` : ''} · click to re-pick`
                        : screenWatchUnavailableReason
                          ? screenWatchUnavailableReason
                          : 'Screen Watch — click to pick a window for the AI to see'
                  }
                  aria-label={
                    attachedWindow
                      ? `Detach ${attachedWindow.windowMeta.applicationName || 'window'}`
                      : resumeAppWatchSnapshot
                        ? `Resume watching ${resumeAppWatchSnapshot.windowMeta.applicationName || 'window'}`
                        : screenWatchUnavailableReason
                          ? 'Screen Watch unavailable'
                          : 'Open Screen Watch picker'
                  }
                  disabled={Boolean(screenWatchUnavailableReason)}
                  data-streaming={attachedWindow?.streaming ? 'true' : 'false'}
                  data-resumable={!attachedWindow && resumeAppWatchSnapshot ? 'true' : 'false'}
                >
                  <ScreenWatchSymbolIcon />
	                  {attachedWindow?.streaming && (
	                    <span className="composer-screen-watch-button-dot" aria-hidden="true" />
	                  )}
	                  {!attachedWindow && resumeAppWatchSnapshot && (
	                    <span
	                      className="composer-screen-watch-button-dot composer-screen-watch-button-dot--resume"
	                      aria-hidden="true"
	                    />
	                  )}
	                </button>
	                <span className="composer-goal-control-wrap">
	                  <button
	                    ref={goalButtonRef}
	                    type="button"
	                    className={`composer-goal-button composer-hint-pill is-${currentGoalStatus}${goalPopoverOpen ? ' is-open' : ''}`}
                    data-hint-label="Goal"
		                    onClick={() => {
		                      if (goalControlDisabled) return
		                      if (goalPopoverOpen) {
		                        setGoalPopoverOpen(false)
		                        return
		                      }
		                      openGoalPopover(false)
		                    }}
		                    title={goalControlTitle}
		                    aria-haspopup="dialog"
		                    aria-expanded={goalPopoverOpen}
		                    aria-label={
		                      goalControlDisabledReason ||
		                      (currentActiveGoal
		                        ? `Manage active goal: ${currentActiveGoal.objective}`
		                        : 'Set active goal')
		                    }
		                    disabled={goalControlDisabled}
		                    data-goal-status={currentGoalStatus}
		                  >
	                    <GoalSymbolIcon />
	                    {(currentActiveGoal?.status === 'active' ||
	                      currentActiveGoal?.status === 'paused' ||
	                      currentActiveGoal?.status === 'blocked') && (
	                      <span className="composer-goal-button-dot" aria-hidden="true" />
	                    )}
	                    {currentActiveGoal?.status === 'completed' && (
	                      <span className="composer-goal-button-check" aria-hidden="true">
	                        ✓
	                      </span>
	                    )}
	                  </button>
                    {scheduleControls}
	                  {goalPopoverOpen && currentChat && typeof document !== 'undefined' && createPortal(
	                    <div
	                      ref={goalPopoverRef}
	                      className={`composer-goal-popover shell-${appearance.composerStyle}`}
	                      style={{
	                        left: goalPopoverPosition ? `${goalPopoverPosition.left}px` : '0px',
	                        top: goalPopoverPosition ? `${goalPopoverPosition.top}px` : '0px',
	                        width: goalPopoverPosition ? `${goalPopoverPosition.width}px` : undefined,
	                        visibility: goalPopoverPosition ? 'visible' : 'hidden'
	                      }}
	                      role="dialog"
	                      aria-label="Active goal"
	                    >
	                      <div className="composer-goal-popover-header">
	                        <span className="composer-goal-popover-title">
	                          {currentActiveGoal ? 'Active goal' : 'Set goal'}
	                        </span>
	                        <span className="composer-goal-mode-chip">{currentGoalModeLabel}</span>
	                      </div>
	                      {!currentActiveGoal || goalEditing ? (
	                        <>
	                          <textarea
	                            className="composer-goal-textarea"
	                            value={goalDraft}
	                            onChange={(event) => setGoalDraft(event.target.value)}
	                            placeholder="Describe the objective and stopping condition"
	                            aria-label="Goal objective"
	                            rows={3}
	                            maxLength={MAX_ACTIVE_GOAL_OBJECTIVE_CHARS}
	                          />
	                          <div className="composer-goal-popover-actions">
	                            <button
	                              type="button"
	                              className="composer-goal-action primary"
	                              onClick={() => setGoalFromObjective(goalDraft)}
	                            >
	                              {currentActiveGoal ? 'Save' : 'Set goal'}
	                            </button>
	                            <button
	                              type="button"
	                              className="composer-goal-action"
	                              onClick={() => {
	                                setGoalEditing(false)
	                                setGoalDraft(currentActiveGoal?.objective || '')
	                                if (!currentActiveGoal) setGoalPopoverOpen(false)
	                              }}
	                            >
	                              Cancel
	                            </button>
	                          </div>
	                        </>
	                      ) : (
	                        <>
	                          <div className={`composer-goal-status is-${currentActiveGoal.status}`}>
	                            {currentActiveGoal.status}
	                          </div>
	                          <p className="composer-goal-objective">{currentActiveGoal.objective}</p>
	                          {currentActiveGoal.blockedReason && (
	                            <p className="composer-goal-reason">
	                              {currentActiveGoal.blockedReason}
	                            </p>
	                          )}
	                          {goalRuntimeLabel && (
	                            <p className="composer-goal-runtime">{goalRuntimeLabel}</p>
	                          )}
	                          <div className="composer-goal-popover-actions">
	                            <button
	                              type="button"
	                              className="composer-goal-action"
	                              onClick={() => {
	                                setGoalDraft(currentActiveGoal.objective)
	                                setGoalEditing(true)
	                              }}
	                            >
	                              Edit
	                            </button>
	                            {currentActiveGoal.status === 'paused' ||
	                            currentActiveGoal.status === 'blocked' ? (
	                              <button
	                                type="button"
	                                className="composer-goal-action"
	                                onClick={() => updateCurrentGoalStatus('active')}
	                              >
	                                Resume
	                              </button>
	                            ) : currentActiveGoal.status !== 'completed' ? (
	                              <button
	                                type="button"
	                                className="composer-goal-action"
	                                onClick={() => updateCurrentGoalStatus('paused')}
	                              >
	                                Pause
	                              </button>
	                            ) : null}
	                            {currentActiveGoal.status !== 'blocked' &&
	                              currentActiveGoal.status !== 'completed' && (
	                                <button
	                                  type="button"
	                                  className="composer-goal-action"
	                                  onClick={markCurrentGoalBlocked}
	                                >
	                                  Mark blocked
	                                </button>
	                              )}
	                            {currentActiveGoal.status !== 'completed' && (
	                              <button
	                                type="button"
	                                className="composer-goal-action primary"
	                                onClick={() => updateCurrentGoalStatus('completed')}
	                              >
	                                Mark complete
	                              </button>
	                            )}
	                            <button
	                              type="button"
	                              className="composer-goal-action danger"
	                              onClick={clearCurrentGoal}
	                            >
	                              Clear
	                            </button>
	                          </div>
	                        </>
	                      )}
	                    </div>,
	                    document.body
	                  )}
	                </span>
	                <ComposerPlanPopoverButton
	                  key={currentChat?.appChatId || 'composer-plan'}
	                  chat={currentChat}
	                  composerStyle={appearance.composerStyle}
	                />
	                {/* Blackboard quick-access — a read-only glance at the ensemble
	                    Blackboard (the full post/delete surface stays in the
	                    right-dock Notes pane). Ensemble-only: solo chats have no
	                    blackboard. */}
	                {isCurrentEnsembleChat && (
	                  <ComposerBlackboardButton
	                    chat={currentChat}
	                    provider={currentProvider}
	                    composerStyle={appearance.composerStyle}
	                  />
	                )}
	                <CopyTranscriptButton
	                  disabled={!currentChat || currentChat.archived || currentChat.messages.length === 0}
	                  resetKey={currentChat?.appChatId || null}
	                  composerStyle={appearance.composerStyle}
	                  onCopy={handleCopyCurrentTranscript}
	                />
	                <MultiviewLayoutPicker
	                  layout={multiview.layout}
	                  onSelectLayout={handleSelectMultiviewLayout}
	                  provider={currentProvider}
	                  composerStyle={appearance.composerStyle}
	                />
	                {/* Opens a standalone floating Canvas window (self-contained;
	                    SSRF-guarded openWindow + inline error in the button). */}
	                <CanvasComposerButton
	                  chatId={currentChat?.appChatId ?? null}
	                  composerStyle={appearance.composerStyle}
	                />
	                </div>
                <div className="composer-telemetry-side composer-telemetry-side--left">
                {/* Workspace switcher — LEFT zone of the telemetry row (the
                    timecode's old spot). Hidden in global chats. Placed on the
                    left via the zone's flex `order` in CSS. */}
                {!isCurrentGlobalChat && (
                  <ComposerWorkspaceSwitcher
                    workspaces={workspaces}
                    currentWorkspace={currentWorkspace}
                    onPickExisting={handleSelectExistingWorkspace}
                    onAddNewWorkspace={handleSelectWorkspace}
                    onSelectNoWorkspace={handleNewGlobalChat}
                    /*
                        1.0.6-EW66 — multi-workspace manager. The
                        additional-workspace grants + their repo
                        metadata drive the "Current workspaces" list;
                        reorder / remove / add-folder are only wired
                        when the chat has a saved record to attach
                        grants to (welcome-state chats get the picker
                        without those affordances).
                      */
                    additionalGrants={externalPathGrants}
                    repoMetadata={externalPathRepoMetadata}
                    composerStyle={appearance.composerStyle}
                    onReorderWorkspaces={
                      currentChat?.appChatId ? handleReorderExternalPathGrants : undefined
                    }
                    onRemoveWorkspacePath={
                      currentChat?.appChatId ? handleRemoveExternalPathGrantsByPath : undefined
                    }
                    onRemoveWorkspace={handleRemoveWorkspace}
                    onAddFolder={currentChat?.appChatId ? handleAddWorkspaceFolder : undefined}
                    onAddKnownWorkspace={
                      currentChat?.appChatId ? handleAddKnownWorkspaceAsSecondary : undefined
                    }
                  />
                )}
                </div>
                <div className="composer-telemetry-side composer-telemetry-side--right">
                {threadTokenTallyHasValue && (
                  <LiveThreadTokenTally
                    baseTally={composerTokenTally}
                    currency={displayCurrency}
                    dualCostAndRam={dualComposerTelemetry}
                    model={contextModelId}
                    overestimatePercent={overestimatePercent}
                    provider={currentProvider}
                    providerRates={providerRates}
                    running={isCurrentChatRunning}
                    liveOutputTokens={liveRunOutputTokens}
                    title={threadTokenTallyTooltip}
                  />
                )}
                </div>
              </div>
              {/*
                Composer-unification (Phase J1): removed the codex-style
                decorative footer chip strip. It mirrored info already in
                the top-toggles row (workspace), the above-bar (branch),
                and the provider picker (provider). Codex's visual brand
                persists via the surface's colour, border, and glow tokens.
              */}
              {/* Claude composer: previously rendered a satellite "footer" row below
               * the textarea with workspace + provider + branch chips. Removed —
               * native Claude doesn't have one, and the chips now live inline in
               * the composer's action row (workspace info is in the above-bar's
               * branch indicator, and the Provider picker sits in the gap between
               * `+` and the model picker via the data-composer-control="provider"
               * marker, unhidden in claude mode by main.css). */}
              {visibleScheduledTasks.length > 0 && (
                <div className="scheduled-task-strip">
                  {visibleScheduledTasks.map((task) => (
                    <div key={task.id} className={`scheduled-task-pill status-${task.status}`}>
                      <ClockSymbolIcon />
                      <span className="scheduled-task-copy" title={task.prompt}>
                        {getProviderLabel(task.provider)} · {formatScheduledRunTime(task.runAt)}
                      </span>
                      <span className="scheduled-task-countdown">
                        {formatScheduledTaskCountdown(task, scheduledNowMs)}
                      </span>
                      <span className="scheduled-task-status">{task.status}</span>
                      {(task.status === 'pending' || task.status === 'due') && (
                        <button
                          type="button"
                          className="scheduled-task-cancel"
                          title="Cancel scheduled task"
                          aria-label="Cancel scheduled task"
                          onClick={async () => {
                            await window.api.updateScheduledTask(task.id, { status: 'cancelled' })
                            await refreshWorkflowState(currentWorkspace?.id)
                          }}
                        >
                          <XSymbolIcon />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {isWelcomeChat && isWorkflowComposeChat && workflowDraft && (
              <WorkflowComposeControls
                cadence={workflowDraft.cadence}
                onCadenceChange={(cadence) =>
                  setWorkflowDraft((prev) => (prev ? { ...prev, cadence } : prev))
                }
                intervalMinutes={workflowDraft.intervalMinutes}
                onIntervalMinutesChange={(intervalMinutes) =>
                  setWorkflowDraft((prev) => (prev ? { ...prev, intervalMinutes } : prev))
                }
                maxRunsPerDay={workflowDraft.maxRunsPerDay}
                onMaxRunsPerDayChange={(maxRunsPerDay) =>
                  setWorkflowDraft((prev) => (prev ? { ...prev, maxRunsPerDay } : prev))
                }
                unattendedLevel={workflowDraft.unattendedLevel ?? 'safe'}
                onUnattendedLevelChange={(unattendedLevel) =>
                  setWorkflowDraft((prev) => (prev ? { ...prev, unattendedLevel } : prev))
                }
              />
            )}
            </ComposerPrimaryStack>
            {/* Pane-bottom timecode bar — the unpacked timecode picker, glued
                under the composer as its own centred row (Turn on the left,
                total thread wall time on the right). Last child of .composer-area
                so its height folds into --composer-reserved-height. Skipped on
                the welcome screen, where the composer floats mid-pane. */}
            {!isWelcomeChat && (
              <ComposerThreadTimecodeBar
                running={isCurrentChatRunning}
                startedAt={composerRunTimecodeStartedAt}
                cumulativeBaseMs={cumulativeRunBaseMs}
              />
            )}
            {shouldShowWelcomeStandaloneHeatmaps && (
              <WelcomeHeatmaps slots={welcomeHeatmapSlots} layout="single" />
            )}
            {isWelcomeChat && <NotificationZone />}
            {trustedSessionConfirmOpen && (
              <TrustedSessionConfirmSheet
                subjectLabel={
                  trustedSessionApprovalId &&
                  pendingAgentApproval?.id === trustedSessionApprovalId &&
                  pendingAgentApproval.preview?.ensembleParticipant?.role
                    ? pendingAgentApproval.preview.ensembleParticipant.role
                    : isCurrentEnsembleChat && selectedParticipant
                      ? selectedParticipant.role || getProviderLabel(selectedParticipant.provider)
                      : getProviderLabel(currentProvider)
                }
                onCancel={() => {
                  setTrustedSessionConfirmOpen(false)
                  setTrustedSessionApprovalId(null)
                }}
                onConfirm={() => {
                  void confirmTrustedSessionForLane()
                }}
              />
            )}
          </div>
  )
}

function formatGoalRuntimePopoverLabel(goal: any, nowMs: number): string | null {
  if (!goal?.runtimeLedger) return null
  const now = Number.isFinite(nowMs) ? new Date(nowMs) : new Date()
  const timing = computeGoalRuntimeTiming(goal.runtimeLedger, now)
  const parts = [
    `wall ${formatGoalRuntimeDuration(timing.wallMs)}`,
    timing.activeMs > 0 ? `active ${formatGoalRuntimeDuration(timing.activeMs)}` : '',
    timing.blockedMs > 0 ? `blocked ${formatGoalRuntimeDuration(timing.blockedMs)}` : '',
    timing.pausedMs > 0 ? `paused ${formatGoalRuntimeDuration(timing.pausedMs)}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? `Goal runtime · ${parts.join(' · ')}` : null
}

function formatGoalRuntimeDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

/**
 * Slice H — `React.memo` boundary. `Composer` receives ~290 spread props
 * (`<Composer {...composerProps} />`), so the default shallow comparator bails
 * only when EVERY prop value is referentially equal frame-to-frame. App.tsx
 * makes that achievable by (a) stabilising all callback props through a
 * ref-backed handler bag and (b) memoising both the focused `composerCtx` and
 * each pane's composer ctx so their field values stay referentially stable when
 * their real inputs are unchanged. The named export `Composer` + `ComposerProps`
 * type are preserved so every existing import + SSR test keeps working.
 */
export const Composer = memo(ComposerInner)
