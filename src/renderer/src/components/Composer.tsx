import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AGENTIC_SERVICE_LABELS } from '../../../shared/agenticServiceLabels'
import { trustedSessionRuntimeProfileForRequest } from '../../../shared/trustedSessionRuntimeProfile'
import { planTrustedSessionElevation } from '../lib/trustedSessionElevation'
import { createWindowDragSession } from '../lib/windowDragSession'
import {
  MAX_ACTIVE_GOAL_OBJECTIVE_CHARS,
  computeGoalRuntimeTiming
} from '../../../main/GoalState'
import type {
  AgenticWorkspaceGrant,
  ChatWorkflowMode,
  EnsembleFanoutIsolationPolicy,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../../../main/store/types'
import { resolveEnsembleFanoutIsolationPolicy } from '../../../shared/ensembleFanoutIsolation'
import type { CodexModelOption } from '../lib/providerModelDefaults'
import { resolveWorkspaceDisplayName } from '../../../shared/workspaceDisplayName'
import { collectTranscriptExportRounds } from '../../../shared/transcriptExportScope'
import { AgentMentionMenu } from '../components/AgentMentionMenu'
import { AppleTerminalIcon, ArrowUpSendIcon, ChatMediaIcon, ClaudeReturnSymbolIcon, ClockSymbolIcon, CommandSymbolIcon, FileMenuSelectionIcon, FolderSymbolIcon, GitCommitSymbolIcon, GoalSymbolIcon, ModelSymbolIcon, PermissionSymbolIcon, PlusSymbolIcon, ReviewSymbolIcon, RunSymbolIcon, ScreenWatchSymbolIcon, StopSymbolIcon, TrustSymbolIcon, WorkflowGlyphIcon, XSymbolIcon } from '../components/AppChromeSymbols'
import { ContextMeterPopover } from './ContextMeterPopover'
import { CombinedModelPicker } from '../components/CombinedModelPicker'
import type {
  CombinedModelPickerModelOption,
  CombinedModelPickerProviderGroup,
  CombinedModelPickerReasoningOption
} from '../components/CombinedModelPicker'
import { CombinedPermissionsPicker } from '../components/CombinedPermissionsPicker'
import type { PermissionOption } from '../components/CombinedPermissionsPicker'
import { buildParticipantReasoningSelectionPatch } from '../components/ParticipantPickerCluster'
import { ComposerHighlightOverlay } from '../components/ComposerHighlightOverlay'
import { useComposerSuggestion } from '../hooks/useComposerSuggestion'
import type { ComposerSuggestionModel } from '../lib/composerSuggestion'
import { buildComposerContinuationCheckpoint } from '../lib/composerContinuationCheckpoint'
import { failedLanesFromChat } from '../lib/composerSuggestionInputs'
import { ComposerLinkPreviewStrip } from '../components/ComposerLinkPreviewStrip'
import { ComposerPlusPicker } from '../components/ComposerPlusPicker'
import type { ComposerPlusPickerSection } from '../components/ComposerPlusPicker'
import {
  providerRunUnavailableReason,
  resolveProviderRows
} from '../components/ComposerProviderPicker'
import { ComposerSlashMenu } from '../components/ComposerSlashMenu'
import { TrustedSessionConfirmSheet } from '../components/TrustedSessionConfirmSheet'
import { WorkspaceDiffStatsButton } from '../components/WorkspaceDiffStatsButton'
import {
  ComposerTextareaContextMenu,
  useComposerTextareaContextMenu
} from '../components/ComposerTextareaContextMenu'
import { ComposerThreadTimecodeBar } from '../components/ComposerTimecodes'
import { ComposerWorkspaceSwitcher } from '../components/ComposerWorkspaceSwitcher'
import { CopyTranscriptButton } from '../components/CopyTranscriptButton'
import { downloadChatMarkdownTranscript } from '../lib/transcriptDownload'
import { EnsembleOrchestrationRow } from '../components/EnsembleOrchestrationRow'
import type {
  ContinuousHopsGoalStatus,
  ContinuousHopsRoundStatus
} from '../components/ContinuousHopsLimitChip'
import { EnsembleParticipantsAboveRow } from '../components/EnsembleParticipantsAboveRow'
import { EnsembleRosterPresetPicker } from '../components/EnsembleRosterPresetPicker'
import { ExternalPathAboveRow } from '../components/ExternalPathAboveRow'
import { ExternalPathGrantPromptCard } from '../components/ExternalPathGrantPromptCard'
import { GhostCompanion } from '../components/FxLayers'
import { NotificationZone } from '../components/NotificationZone'
import { GitCommitControls } from '../components/GitCommitControls'
import { ComposerBranchWorktreePopover } from '../components/ComposerBranchWorktreePopover'
import { GitMergeBadge, GitSyncChip } from '../components/GitStatusChips'
import { GitHubSatelliteRow } from '../components/GitHubSatelliteRow'
import { WorkspaceLockPill } from '../components/WorkspaceLockPill'
import { LiveThreadTokenTally } from '../components/LiveThreadTokenTally'
import { MultiviewLayoutPicker } from '../components/MultiviewLayoutPicker'
import { CanvasComposerButton } from '../components/CanvasComposerButton'
import { ComposerAboveRowsToggleButton } from '../components/ComposerAboveRowsToggleButton'
import { GoalPopoverMarkdown } from './GoalPopoverMarkdown'
import { PillButton } from './PillButton'
import { QueuedMessagesAboveRow } from '../components/QueuedMessagesAboveRow'
import type { ExecutionGraphProjection } from '../lib/executionGraphProjection'
import { staleTrustedSessionDemotionPatch } from '../lib/chatComposerSelection'
import { WelcomeHeatmaps } from '../components/WelcomeHeatmaps'
import { WelcomeProviderHighlight } from '../components/WelcomeProviderHighlight'
import { WorkflowComposeControls } from '../components/WorkflowComposeControls'
import {
  extractFirstEnsembleDmTarget,
  formatComposerPathMention,
  parseComposerMentionTrigger
} from '../lib/ComposerMentionTrigger'
import {
  exactComposerParticipantMentionTarget,
  formatComposerParticipantMention,
  rebaseComposerParticipantMentionSelections,
  type ComposerParticipantMentionSelection
} from '../lib/composerParticipantMentionSelection'
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
import { composerSurfaceOpenSignal } from '../lib/composerSurfaceRequest'
import type { ComposerSurfaceRequest } from '../lib/composerSurfaceRequest'
import {
  fastModeCapableModelIds,
  fastModeEnabledFor,
  nextFastModeToggle
} from '../lib/fastModeToggle'
import { resolveEnsembleParticipantRetryDispatch } from '../lib/ensembleRetryPrompt'
import { renderAgentApprovalPreview } from '../lib/agentApprovalPreview'
import { agentApprovalCancelPresentation } from '../lib/agentApprovalLifecycle'
import {
  agentApprovalDisplayTitle,
  agentApprovalEnsembleAttribution
} from '../lib/agentApprovalAttribution'
import { composedSeatRole, seatFromApprovalAttribution } from '../lib/transcriptSeat'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { isNativeSubAgentPreferenceApproval } from '../lib/agentApprovalTypes'
import { decideApprovalElevation } from '../lib/approvalElevation'
import { formatScheduledRunTime } from '../lib/dateTimeFormat'
import { formatScheduledTaskCountdown } from '../lib/scheduledCountdown'
import {
  buildCodexModelChangeParticipantPatch,
  buildProviderModelChangeParticipantPatch,
  buildSameProviderModelChangeParticipantPatch,
  getEnsembleReasoningOptions,
  resolveEnsembleParticipantSettings
} from '../lib/ensembleProviderDefaults'
import {
  MAX_IMAGE_ATTACHMENTS,
  collectClipboardAttachmentPaths,
  collectDroppedAttachmentPaths,
  dataTransferHasFiles,
  hasAttachmentPromptContent
} from '../lib/imageAttachments'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
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
import { TerminalPanel } from './TerminalPanel'
import { usePerChatState } from '../hooks/usePerChatState'
import { shouldOfferPlanImport } from '../lib/planImport'
import { hasResolvedMention } from '../lib/mentionHighlight'
import { hasComposerMarkdown } from '../lib/composerMarkdownHighlight'
import { planEmoticonAutoReplace } from '../lib/emoticonAutoReplace'
import { formatApprovalCountdown, resolveApprovalTimeoutMs } from '../lib/approvalTimeoutCountdown'
import { getProviderLabel } from '../lib/providerLabels'
import {
  CLAUDE_DEFAULT_MODELS,
  resolveClaudeDefaultReasoningEffort
} from '../lib/providerModelDefaults'
import {
  codexReasoningDisplayLabel,
  claudeReasoningDisplayLabel,
  grokReasoningDisplayLabel,
  shortModelName
} from '../lib/composerChipFormat'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import {
  antigravityEffortForModelId,
  antigravityVariantGroupForModel,
  groupAntigravityModelRows
} from '../../../shared/antigravityAgyModelGrouping'
import {
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_46_MODEL_ID,
  cursorGrokBaseModelId,
  isCursorGrokModelId,
  isGrokReasoningModelId
} from '../../../shared/grok45Models'

/** Matches `MUSE_DEFAULT_REASONING_EFFORT` in main muse/MuseCliArgs.ts. */
const MUSE_DEFAULT_REASONING_EFFORT = 'high'
import { composerGitActionUsesCommitIcon } from '../lib/composerGitActionIcon'
import { resolveComposerEffectiveWorkspacePath } from '../lib/composerWorktreeSelection'
import { resolveComposerGitActionBasePath } from '../lib/composerFocusedWorkspace'
import { composerVoicePlacementForStyle } from '../lib/composerVoicePlacement'
import { composerPermissionOptions } from '../lib/planModeLabels'
import { pathComparisonKey } from '../lib/pathDisplay'
import {
  MIN_WORKSPACE_TERMINAL_HEIGHT,
  MAX_WORKSPACE_TERMINAL_HEIGHT,
  clampWorkspaceTerminalHeight,
  getStoredWorkspaceTerminalHeight,
  setStoredWorkspaceTerminalHeight
} from '../lib/panelWidths'
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
  PLAN_IMPORT_RISK_LABELS: any
  acknowledgedElevationDefaults: any
  activeEnsembleConcurrentMode: any
  activeEnsembleFanoutPolicy: EnsembleFanoutPolicy
  activeEnsembleOrchestrationMode: any
  /** Run id whose live authoritative usage snapshot drives the footer tally. */
  activeRunId: string | null
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
  setActiveEnsembleRosterPresetId: (presetId: string | null) => void
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
  museReasoningEffort: any
  mistralReasoningEffort: any
  piReasoningEffort: any
  ollamaReasoningEffort: any
  cursorReasoningEffort: any
  cursorFastMode: any
  composerAboveBarStackAuraClass: any
  composerAgentAuraClass: any
  composerAreaRef: any
  /** Optional host bridge for focusing a secondary Composer after it mounts. */
  externalComposerTextareaRef?: { current: HTMLTextAreaElement | null }
  composerAriaLabel: any
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
  /** Explicit Project references selected for this chat's next solo send. */
  hasProjectReferenceContext?: boolean
  discordContextUnavailableReason?: string
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
  currentProvider: any
  configuredProviderSnapshot: {
    ready: boolean
    providerIds: readonly ProviderId[]
  }
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
  handleCollapseEnsembleToSolo: any
  handleCopyCurrentTranscript: any
  handleCreateGithubPr: any
  handleDeleteQueuedMessage: any
  handleDetachWindow: any
  handleEditQueuedMessage: any
  handleGroundImportedPlanFiles: any
  handleNewGlobalChat: any
  handlePaletteCommand: any
  handlePermissionRetry: any
  handlePickFolder: any
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
  handleSteer: any
  handleSteerToQueuedMessage: any
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
  /** App-global welcome notices belong to the focused pane. Resting Multiview
   * panes render the same Composer but suppress this singleton surface. */
  showWelcomeNotifications?: boolean
  isWorkflowChatWelcome: any
  isWorkflowComposeChat: any
  kimiFastMode: any
  kimiReasoningEffort: any
  kimiThinkingEnabled: any
  lastNonCustomModelType: any
  liveRunOutputTokens: any
  markCurrentGoalBlocked: any
  markPersistentSessionRestartNeeded: any
  multiview: any
  onOllamaModelSelected?: (modelId: string, modelLabel?: string) => void
  openDiscordContextPicker: any
  openGoalPopover: any
  openInspectorTab: any
  openWorkspaceCommitsInInspector?: (workspacePath?: string) => void
  openWorkspaceDiffInInspector: (workspacePath?: string) => void
  openPlanImportReview: any
  openSideChatFromSlashCommand: (sideCommand: SideSlashCommand) => boolean | void
  overestimatePercent: any
  patchEnsembleParticipantById: any
  pendingAgentApproval: any
  pendingApprovalQueueByChatId: any
  pendingPlanImport: any
  pendingWorkspaceRebind: any
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
  isWatchingPr?: boolean
  onToggleWatchPr?: (next: boolean) => void
  watchPrDisabledReason?: string
  watchPrStatusMessage?: string
  providerRates: any
  queuedMessagesAboveRowEntries: any
  executionStackProjection?: ExecutionGraphProjection | null
  executionHistory?: readonly {
    runId: string
    title: string
    statusLabel: string
    updatedAt?: string
  }[]
  onOpenExecutionMap?: (runId: string, stepId?: string) => void
  onAddToExecutionStack?: (runId: string) => void
  onSaveExecutionGraph?: (runId: string) => void
  onCancelExecutionStackStep?: (runId: string, activationId: string, stepId: string) => void
  queuedRunQueueCount: any
  refreshWorkflowState: any
  rememberCurrentChatComposerSelection: any
  renderPlanImportFileGroundings: any
  renderPlanImportItems: any
  resumeAppWatchSnapshot: any
  runtimeProfileControl: any
  scheduleControls: any
  /**
   * Slash-command request to open one of this composer's own surfaces
   * (`/terminal`, `/plan`, `/blackboard`, `/canvas`, bare `/multiview`).
   * Those surfaces hold private popover state that an App-level `run()`
   * closure cannot reach, so the command publishes a request instead.
   *
   * Only the MAIN composer receives a live object. Multiview panes and the
   * linked-chat composer get `null` and redirect through
   * `preserveSlashDraftForFocusedFlow` — a shared request would otherwise open
   * the popover in every mounted composer at once.
   */
  composerSurfaceRequest?: ComposerSurfaceRequest | null
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
  setMuseReasoningEffort: any
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
  setKimiFastMode: any
  setKimiReasoningEffort: any
  setMistralReasoningEffort: any
  setPiReasoningEffort: any
  setOllamaReasoningEffort: any
  setKimiThinkingEnabled: any
  setLastNonCustomModelType: any
  setPendingElevation: any
  setPendingPlanImport: any
  setPrimaryGitSnapshot: any
  setRawLogs: any
  setSelectedModelType: any
  setSessionTrust: any
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
  /** Main-owned authority controls stay visible-but-disabled in chat popouts. */
  trustedSessionMutationDisabledReason?: string
  workspaceTrustMutationDisabledReason?: string
  updateCurrentEnsembleConcurrentMode: any
  updateCurrentEnsembleFanoutPolicy: (policy: EnsembleFanoutPolicy) => void
  updateCurrentEnsembleFanoutIsolation: (isolation: EnsembleFanoutIsolationPolicy) => void
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
  /** Hide git/branch above-rows when this Composer has no scoped git state. */
  showWorkspaceGitAboveRows?: boolean
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

// UltraTask is a synthetic top-of-ladder token; it's selectable on every model
// except those explicitly flagged unsupported (e.g. Claude Haiku).
function ultraTaskSupportedForModel(
  modelOptions: readonly { id: string; ultraTaskSupported?: boolean }[] | undefined,
  modelId: string | undefined
): boolean {
  const model = modelOptions?.find((option) => option.id === modelId)
  return model?.ultraTaskSupported !== false
}

// Appending UltraTask to an EMPTY base ladder would make it the ladder's only
// enabled stop — which the picker renders as the model's locked default
// ("UltraTask" pinned on models with no reasoning at all). Seed empty ladders
// with an explicit Off bottom stop so UltraTask stays opt-in at the top of a
// movable two-stop ladder instead of becoming a fake default.
function withUltraTaskLadderBottom<
  T extends { value: string; label: string }
>(options: T[]): T[] {
  if (options.length > 0) return options
  return [{ value: 'off', label: 'Off' } as unknown as T, ...options]
}

/** Preserve an explicit model-level UltraTask exclusion while adapting the
 * live catalogue into generic picker rows. */
export function composerPickerUltraTaskSupportMetadata(
  model: Pick<CodexModelOption, 'ultraTaskSupported'>
): Pick<CombinedModelPickerModelOption, 'ultraTaskSupported'> {
  return model.ultraTaskSupported !== undefined
    ? { ultraTaskSupported: model.ultraTaskSupported }
    : {}
}

// Air kept between the composer's bottom edge and the terminal's top edge when
// the terminal is dragged tall. Covers `--workspace-terminal-bottom-gap` plus a
// little breathing room, so the two surfaces never touch, let alone overlap.
const WORKSPACE_TERMINAL_COMPOSER_CLEARANCE = 28
// …and the terminal never takes more than this share of the pane, so the
// transcript itself is never reduced to a sliver.
const WORKSPACE_TERMINAL_MAX_PANE_SHARE = 0.62

export function shouldRenderWelcomeNotifications(
  isWelcomeChat: boolean,
  showWelcomeNotifications = true
): boolean {
  return isWelcomeChat && showWelcomeNotifications
}

function ComposerInner(props: ComposerProps): React.JSX.Element {
  const {
    prompt,
    PLAN_IMPORT_RISK_LABELS,
    acknowledgedElevationDefaults,
    activeEnsembleFanoutPolicy,
    activeEnsembleOrchestrationMode,
    addImageAttachmentsToChat,
    agentModelsByProvider,
    appearance,
    applyEnsemblePermissionsToAllParticipants,
    applyEnsembleRosterPreset,
    setActiveEnsembleRosterPresetId,
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
    museReasoningEffort,
    ollamaReasoningEffort,
    cursorReasoningEffort,
    cursorFastMode,
    composerAboveBarStackAuraClass,
    composerAgentAuraClass,
    composerAreaRef,
    externalComposerTextareaRef,
    composerAriaLabel,
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
    discordContextUnavailableReason,
    currentEnsembleFanoutPolicy,
    currentEnsembleContinuationHops,
    currentEnsembleMaxContinuationHops,
    currentEnsembleRoundStatus,
    currentEnsembleActiveGoalStatus,
    currentEnsembleOrchestrationMode,
    currentGoalButtonTitle,
    currentGoalModeLabel,
    currentGoalStatus,
    currentProvider,
    configuredProviderSnapshot,
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
    handleCollapseEnsembleToSolo,
    handleCreateGithubPr,
    handleDeleteQueuedMessage,
    handleDetachWindow,
    handleEditQueuedMessage,
    handleGroundImportedPlanFiles,
    handleNewGlobalChat,
    handlePaletteCommand,
    handlePermissionRetry,
    handlePickFolder,
    handlePickImages,
    handleProviderChange,
    handleRemoveWorkspace,
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
    handleSteer,
    handleSteerToQueuedMessage,
    handleToggleWelcomeEnsemble,
    handleTrustWorkspaceClick,
    hasProjectReferenceContext = false,
    imageAttachments,
    intentNote,
    interfaceStyle,
    isAttachingWindow,
    openSlashCommandsRequestId,
    isCurrentChatBusyForSteer,
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
    showWelcomeNotifications = true,
    isWorkflowChatWelcome,
    isWorkflowComposeChat,
    kimiFastMode,
    kimiReasoningEffort,
    mistralReasoningEffort,
    piReasoningEffort,
    lastNonCustomModelType,
    liveRunOutputTokens,
    activeRunId,
    markCurrentGoalBlocked,
    markPersistentSessionRestartNeeded,
    multiview,
    onOllamaModelSelected,
    openDiscordContextPicker,
    openGoalPopover,
    openInspectorTab,
    openWorkspaceCommitsInInspector,
    openWorkspaceDiffInInspector,
    openPlanImportReview,
    openSideChatFromSlashCommand,
    overestimatePercent,
    patchEnsembleParticipantById,
    pendingAgentApproval,
    pendingApprovalQueueByChatId,
    pendingPlanImport,
    pendingWorkspaceRebind,
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
    isWatchingPr,
    onToggleWatchPr,
    watchPrDisabledReason,
    watchPrStatusMessage,
    providerRates,
    queuedMessagesAboveRowEntries,
    // executionStackProjection / executionHistory / stack handlers remain on
    // ComposerProps for App call-site stability but are intentionally unused:
    // Stack/Map belong to Work tab + Execution Map, not this above-row.
    queuedRunQueueCount,
    refreshWorkflowState,
    rememberCurrentChatComposerSelection,
    renderPlanImportFileGroundings,
    renderPlanImportItems,
    resumeAppWatchSnapshot,
    scheduleControls,
    composerSurfaceRequest,
    screenWatchUnavailableReason,
    selectedComposerModelType,
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
    setMuseReasoningEffort,
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
    setKimiFastMode,
    setKimiReasoningEffort,
    setMistralReasoningEffort,
    setPiReasoningEffort,
    setOllamaReasoningEffort,
    setKimiThinkingEnabled,
    setLastNonCustomModelType,
    setPendingElevation,
    setPendingPlanImport,
    setPrimaryGitSnapshot,
    setRawLogs,
    setSelectedModelType,
    setSessionTrust,
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
    trustedSessionMutationDisabledReason,
    workspaceTrustMutationDisabledReason,
    updateCurrentEnsembleFanoutPolicy,
    updateCurrentEnsembleFanoutIsolation,
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
    showWorkspaceGitAboveRows = true,
    workspaces
  } = props

  // Per-chat workspace terminal open state. Each pane's <Composer> owns its
  // own terminal toggle; the state is keyed by THIS composer's chatId so
  // multiview panes never share or clobber each other's shell.
  const [terminalOpenByChatId, setTerminalOpenForChat] = usePerChatState(false)
  const [pendingTerminalCommandByChatId, setPendingTerminalCommand] = usePerChatState<string | null>(null)
  const isTerminalOpen = Boolean(
    currentChat?.appChatId && terminalOpenByChatId[currentChat.appChatId]
  )
  // Prefer chat-resolved path so terminal / lock / git actions cannot target a
  // stale app-global primary after a thread switch.
  const composerGitActionBasePath = resolveComposerGitActionBasePath({
    currentWorkspacePath,
    currentWorkspace
  })
  const canShowTerminal = Boolean(composerGitActionBasePath && !isCurrentGlobalChat)

  // Callback for when terminal is ready to receive commands
  const handleTerminalReady = useCallback(() => {
    const chatId = currentChat?.appChatId
    const pendingCommand = chatId ? pendingTerminalCommandByChatId[chatId] : null
    if (pendingCommand && chatId) {
      window.api.ptyWrite(pendingCommand, chatId)
      setPendingTerminalCommand(chatId, null)
    }
  }, [currentChat?.appChatId, pendingTerminalCommandByChatId, setPendingTerminalCommand])

  // `/terminal` toggles this composer's own shell, exactly like the icon. The
  // terminal is the one icon-row surface whose state lives here rather than in
  // a child popover, so it consumes the request directly instead of via an
  // `openSignal` prop. Toggle (not force-open) so the command closes an open
  // shell too — that is what clicking the icon does.
  const terminalSurfaceSignal = composerSurfaceOpenSignal(composerSurfaceRequest, 'terminal')
  const terminalSurfaceChatId = currentChat?.appChatId
  useEffect(() => {
    if (!terminalSurfaceSignal || !canShowTerminal || !terminalSurfaceChatId) return
    setTerminalOpenForChat(terminalSurfaceChatId, (open: boolean) => !open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalSurfaceSignal])

  // Handle Run button clicks from code blocks
  useEffect(() => {
    if (!canShowTerminal || !composerGitActionBasePath || !currentChat?.appChatId) return
    const handler = (event: CustomEvent<{ command: string }>) => {
      // Open the terminal for this chat
      setTerminalOpenForChat(currentChat.appChatId, true)
      // Store the command to be sent when the terminal is ready
      setPendingTerminalCommand(currentChat.appChatId, event.detail.command)
    }
    window.addEventListener('runCodeBlockCommand', handler as EventListener)
    return () => {
      window.removeEventListener('runCodeBlockCommand', handler as EventListener)
    }
  }, [canShowTerminal, composerGitActionBasePath, currentChat?.appChatId, setTerminalOpenForChat, setPendingTerminalCommand])

  const [transcriptRoot, setTranscriptRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (transcriptRoot) return
    const findRoot = () => {
      const root = composerAreaRef?.current?.closest('.app-transcript')
      if (root instanceof HTMLElement) setTranscriptRoot(root)
    }
    findRoot()
    const raf = requestAnimationFrame(findRoot)
    return () => cancelAnimationFrame(raf)
  }, [composerAreaRef, transcriptRoot])

  // Only the composer that actually HAS the terminal open touches this class.
  //
  // `isTerminalOpen` is per-CHAT state, but `transcriptRoot` is a per-PANE
  // element that successive chats share. An instance whose chat has the
  // terminal closed used to run `classList.remove` outright, and it registered
  // a cleanup that removed the class unconditionally — so a closed-terminal
  // composer stripped the class a live one had set, and did it again on
  // unmount. Measured after creating a workspace chat with the terminal open:
  // the split was rendered and `--workspace-terminal-height` was written to the
  // pane (both gated on the same resolved root, so the root and open-state were
  // fine), yet `.workspace-terminal-open` matched ZERO elements. That silently
  // disables every rule keyed on the class, including the one that lifts the
  // composer clear of the terminal.
  //
  // Bailing out when closed is not a behaviour change for the OWNING instance:
  // flipping open→closed changes the dependency, which fires the cleanup below
  // and clears the class exactly as before.
  useEffect(() => {
    if (!transcriptRoot || !isTerminalOpen) return
    transcriptRoot.classList.add('workspace-terminal-open')
    return () => {
      transcriptRoot.classList.remove('workspace-terminal-open')
    }
  }, [isTerminalOpen, transcriptRoot])

  // Terminal pane height. The stored value is a global preference (like the
  // sidebar/inspector widths), but it is APPLIED per pane by writing the CSS
  // var onto this composer's own `.app-transcript` — so a multiview cell that
  // never opened its terminal keeps the stylesheet default.
  const [terminalHeight, setTerminalHeight] = useState(getStoredWorkspaceTerminalHeight)

  useEffect(() => {
    if (!transcriptRoot || !isTerminalOpen) return
    transcriptRoot.style.setProperty('--workspace-terminal-height', `${terminalHeight}px`)
    return () => {
      transcriptRoot.style.removeProperty('--workspace-terminal-height')
    }
  }, [isTerminalOpen, terminalHeight, transcriptRoot])

  useEffect(() => {
    setStoredWorkspaceTerminalHeight(terminalHeight)
  }, [terminalHeight])

  // The pane's top edge must never climb past the composer. Measured LIVE from
  // where the composer actually ends rather than derived from its height,
  // because the two layouts disagree: a docked chat re-offsets `.composer-area`
  // from the terminal height (`.workspace-terminal-open .composer-area`) so the
  // composer rises with the drag, while the welcome layout centres the composer
  // and it stays put. One geometric invariant covers both. The flat share of
  // the pane is the backstop for the reflowing case, so a rising composer can't
  // let the terminal swallow the transcript.
  const terminalHeightRange = (): { min: number; max: number } => {
    const paneHeight = transcriptRoot?.clientHeight ?? window.innerHeight
    const rootTop = transcriptRoot?.getBoundingClientRect().top ?? 0
    const composerArea = composerAreaRef?.current ?? null
    const composerBottomEdge = composerArea?.querySelector('.composer-surface') ?? composerArea
    const composerBottom = composerBottomEdge
      ? composerBottomEdge.getBoundingClientRect().bottom - rootTop
      : 0
    const ceiling = Math.min(
      Math.floor(paneHeight * WORKSPACE_TERMINAL_MAX_PANE_SHARE),
      Math.floor(paneHeight - composerBottom - WORKSPACE_TERMINAL_COMPOSER_CLEARANCE)
    )
    return {
      min: MIN_WORKSPACE_TERMINAL_HEIGHT,
      max: Math.max(MIN_WORKSPACE_TERMINAL_HEIGHT, Math.min(MAX_WORKSPACE_TERMINAL_HEIGHT, ceiling))
    }
  }

  const startTerminalResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!transcriptRoot) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = Math.max(
      MIN_WORKSPACE_TERMINAL_HEIGHT,
      Math.min(terminalHeightRange().max, terminalHeight)
    )
    let liveHeight = startHeight

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      // Re-measured per move, not frozen at drag start: in a docked chat the
      // composer rises as the pane grows, which lifts the ceiling with it.
      const { min, max } = terminalHeightRange()
      // The divider sits on the pane's TOP edge, so dragging up grows it.
      liveHeight = Math.max(min, Math.min(max, startHeight - (moveEvent.clientY - startY)))
      // Written straight to the CSS var for the duration of the drag: the var
      // is what the pane, the composer offset and the transcript reserve all
      // read, so this is a complete layout update — and it keeps a
      // mousemove-rate drag off this (very large) component's render path.
      // React state catches up once, on mouseup.
      transcriptRoot.style.setProperty('--workspace-terminal-height', `${liveHeight}px`)
    }

    document.body.classList.add('is-resizing-workspace-terminal')
    terminalResizeSessionRef.current.begin({
      onMove: handleMouseMove,
      onEnd: () => {
        document.body.classList.remove('is-resizing-workspace-terminal')
        setTerminalHeight(clampWorkspaceTerminalHeight(liveHeight))
      }
    })
  }

  const handleTerminalResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return

    event.preventDefault()
    const { min, max } = terminalHeightRange()
    const step = event.shiftKey ? 48 : 16
    let nextHeight = Math.max(min, Math.min(max, terminalHeight))

    if (event.key === 'ArrowUp') nextHeight += step
    if (event.key === 'ArrowDown') nextHeight -= step
    if (event.key === 'Home') nextHeight = min
    if (event.key === 'End') nextHeight = max

    setTerminalHeight(clampWorkspaceTerminalHeight(Math.max(min, Math.min(max, nextHeight))))
  }

  const pendingSoloProvider =
    !isCurrentEnsembleChat && currentChat
      ? readPendingProviderChange(currentChat)?.provider
      : undefined
  const currentProviderRunUnavailableReason = !isCurrentEnsembleChat
    ? providerRunUnavailableReason(
        pendingSoloProvider ?? currentProvider,
        configuredProviderSnapshot.providerIds
      )
    : null
  const hasSendablePromptContent =
    hasAttachmentPromptContent(prompt, imageAttachments) || hasProjectReferenceContext
  const [scheduledNowMs, setScheduledNowMs] = useState(() => Date.now())

  /**
   * Model the user highlighted in the picker and then closed out of
   * without committing to. Set by the picker's `onCloseWithHighlight`
   * (which compares against the model actually selected once the close
   * settles, so a real selection never lands here), and cleared on
   * send.
   */
  const [consideredModel, setConsideredModel] = useState<ComposerSuggestionModel | null>(null)

  /**
   * Failed seats in the last settled round. Derived from `currentChat`
   * rather than a new prop: the round state already rides along on the
   * chat record, so no App.tsx composer mount needs re-threading.
   * Memoised because the extraction walks the lane map and the seat
   * list, and this component re-renders on every keystroke.
   */
  const composerFailedLanes = useMemo(
    () => failedLanesFromChat(currentChat),
    [currentChat]
  )

  // A narrow, host-owned replacement checkpoint. It reads the active goal and
  // structured round state only — never transcript, tool output, telemetry,
  // participant prose, or Foundation Models summaries.
  const composerContinuationCheckpoint = useMemo(
    () => buildComposerContinuationCheckpoint(currentChat),
    [currentChat]
  )

  /** v1 prefill: template-driven ghost text into an EMPTY composer only. */
  const composerSuggestion = useComposerSuggestion({
    chatId: currentComposerChatId,
    draft: prompt,
    busy: Boolean(isCurrentChatRunning),
    hasPriorTurn: Boolean(
      currentChat?.messages?.some((message) => message.role === 'assistant')
    ),
    consideredModel,
    selectedModelKey: contextModelId ? `${currentProvider}:${contextModelId}` : null,
    failedLanes: composerFailedLanes,
    continuationCheckpoint: composerContinuationCheckpoint,
    requestContinuationProposal:
      settings?.composerContinuationAiEnabled === false
        ? undefined
        : window.api.proposeContinuation,
    uncommittedFileCount: primaryGitSnapshot?.counts?.changed ?? 0,
    branch: primaryGitSnapshot?.detached ? null : (primaryGitSnapshot?.branch ?? null)
  })
  const composerGhostText = composerSuggestion.ghostText
  const composerSuggestionTitle = composerSuggestion.explanation
    ? `${composerSuggestion.explanation} Press Tab to accept or Escape to dismiss.`
    : undefined

  const buildPickerModelOptions = (
    targetProvider: ProviderId,
    models: CodexModelOption[],
    includeCustom: boolean,
    selectedModelId?: string
  ): CombinedModelPickerModelOption[] => {
    if (targetProvider === 'antigravity') {
      // The agy catalogue lists one bare wire id per reasoning variant
      // (gemini-3.6-flash-high/-medium/-low) with labels equal to ids. Group
      // each family into ONE readable row; the reasoning slider swaps the
      // concrete variant, and the row id follows the selected variant so the
      // picker's own id === selectedModelId check works unchanged.
      return [
        ...groupAntigravityModelRows(models, selectedModelId),
        ...(includeCustom && !models.some((model) => model.id === 'custom')
          ? [{ id: 'custom', label: 'Custom…' }]
          : [])
      ]
    }
    return buildGenericPickerModelOptions(targetProvider, models, includeCustom)
  }
  const buildGenericPickerModelOptions = (
    targetProvider: ProviderId,
    models: CodexModelOption[],
    includeCustom: boolean
  ): CombinedModelPickerModelOption[] => [
    ...models.map((model) => {
      const retiresAtRaw = (model as { retiresAt?: unknown }).retiresAt
      const retiresAt = typeof retiresAtRaw === 'string' ? retiresAtRaw : undefined
      const disabledReason =
        typeof model.disabledReason === 'string' ? model.disabledReason : undefined
      return {
        id: model.id,
        label: model.label || model.id,
        ...(model.disabled ? { disabled: true } : {}),
        ...(disabledReason ? { disabledReason } : {}),
        ...(model.supportedReasoningEfforts
          ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
          : {}),
        ...(model.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: model.defaultReasoningEffort }
          : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
        ...(model.additionalSpeedTiers
          ? { additionalSpeedTiers: model.additionalSpeedTiers }
          : {}),
        ...composerPickerUltraTaskSupportMetadata(model),
        ...(retiresAt ? { retiresAt } : {})
      }
    }),
    ...(includeCustom &&
    targetProvider !== 'kimi' &&
    !models.some((model) => model.id === 'custom')
      ? [{ id: 'custom', label: 'Custom…' }]
      : [])
  ]
  /** Thin binding over the shared catalogue so the picker's per-row glyphs and
   * `/fast`'s availability gate read the same set. */
  const fastModeCapableModelIdsForProvider = (
    targetProvider: ProviderId,
    models: CodexModelOption[] = getProviderModelOptions(targetProvider)
  ): Set<string> => fastModeCapableModelIds(targetProvider, models)
  const buildUnifiedProviderModelGroups = (
    includeCustom: boolean,
    selectedModelId?: string
  ): CombinedModelPickerProviderGroup[] =>
    resolveProviderRows(
      grokProviderAvailable,
      cursorProviderAvailable,
      settings?.providerRunPauses,
      {
        snapshot: configuredProviderSnapshot,
        pendingFallbackProvider: currentProvider
      }
    ).map((row) => {
      const models: CodexModelOption[] = getProviderModelOptions(row.id)
      return {
        provider: row.id,
        label: row.label,
        modelOptions: buildPickerModelOptions(row.id, models, includeCustom, selectedModelId),
        fastModeCapableModelIds: fastModeCapableModelIdsForProvider(row.id, models),
        ...(row.pauseLabel ? { pauseLabel: row.pauseLabel } : {}),
        ...(row.rerouteLabel ? { rerouteLabel: row.rerouteLabel } : {})
      }
    })
  const reasoningOptionsForEffectiveModel = (
    targetProvider: ProviderId,
    modelId: string,
    models: CodexModelOption[]
  ): CombinedModelPickerReasoningOption[] => {
    const model = models.find((option) => option.id === modelId)
    let baseOptions: CombinedModelPickerReasoningOption[]
    if (
      (targetProvider === 'codex' || targetProvider === 'claude') &&
      model?.supportedReasoningEfforts
    ) {
      baseOptions = model.supportedReasoningEfforts.map((option) => {
        const rawValue = option.reasoningEffort.trim().toLowerCase()
        const value =
          rawValue === 'light'
            ? 'low'
            : rawValue === 'extra'
              ? 'xhigh'
              : rawValue === 'ultra'
                ? 'ultracode'
                : rawValue
        return {
          value,
          label:
            targetProvider === 'codex'
              ? codexReasoningDisplayLabel(value)
              : claudeReasoningDisplayLabel(value),
          ...(option.disabled ? { disabled: true } : {}),
          ...(option.disabledReason ? { disabledReason: option.disabledReason } : {})
        }
      })
    } else {
      // Several provider defaults are shared catalogue arrays. This helper
      // owns a derived ladder, so clone before appending UltraTask.
      baseOptions = [...getEnsembleReasoningOptions(targetProvider, modelId, model)]
    }
    // Inject UltraTask option for models that support it
    if (model?.ultraTaskSupported !== false) {
      baseOptions = withUltraTaskLadderBottom(baseOptions)
      if (!baseOptions.some((option) => option.value.toLowerCase() === 'ultratask')) {
        baseOptions.push({
          value: 'ultraTask',
          label: 'UltraTask'
        })
      }
    }
    return baseOptions
  }

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
        composerStyle={appearance.composerStyle}
        onSelectMode={(nextMode) => updateCurrentEnsembleOrchestrationMode(nextMode)}
        fanoutPolicy={currentEnsembleFanoutPolicy}
        writerFanoutPolicy={writerFanoutPolicy}
        onFanoutPolicyChange={updateCurrentEnsembleFanoutPolicy}
        fanoutIsolation={resolveEnsembleFanoutIsolationPolicy(currentChat.ensemble.fanoutIsolation)}
        onFanoutIsolationChange={updateCurrentEnsembleFanoutIsolation}
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
  const approvalCancelPresentation = agentApprovalCancelPresentation(pendingAgentApproval)
  const approvalEnsembleAttribution = agentApprovalEnsembleAttribution(
    pendingAgentApproval?.preview
  )
  // The card wears the requesting participant's accent (fan-out result-card
  // pattern): ensemble seats resolve their roster model so the ollama/Pi brand
  // overrides apply (a Pi seat serving DeepSeek wears DeepSeek blue); solo
  // chats fall back to the composer's own model. The hue only feeds display
  // tinting — attribution itself stays validator-derived.
  const approvalSeatModel = approvalEnsembleAttribution
    ? currentChat?.ensemble?.participants?.find(
        (participant: EnsembleParticipant) =>
          participant.id === approvalEnsembleAttribution.participantId
      )?.model
    : !currentChat?.ensemble && typeof customModel === 'string' && customModel
      ? customModel
      : undefined
  const approvalHueClass = pendingAgentApproval
    ? resolveProviderHueClass(pendingAgentApproval.provider, approvalSeatModel) ||
      pendingAgentApproval.provider
    : null
  const approvalSeatModelBadge =
    approvalEnsembleAttribution && pendingAgentApproval && approvalSeatModel
      ? shortModelName(pendingAgentApproval.provider, '', approvalSeatModel)
      : null
  // The seat element (close-out table / fan-out lane card / question card /
  // peer message) rather than a fifth chip vocabulary for the same question —
  // "which participant is this?". `seatFromApprovalAttribution` reads live
  // roster config on purpose; see its doc comment for why an approval is the
  // one case where that is right.
  const approvalSeat = seatFromApprovalAttribution({
    provider: pendingAgentApproval?.provider || '',
    attribution: approvalEnsembleAttribution,
    roster: currentChat?.ensemble
  })
  const approvalSeatRole = composedSeatRole(approvalSeat)
  const approvalDisplayTitle = pendingAgentApproval
    ? agentApprovalDisplayTitle(
        pendingAgentApproval.title,
        approvalEnsembleAttribution,
        getProviderLabel(pendingAgentApproval.provider)
      )
    : ''

  const confirmTrustedSessionForLane = async (): Promise<void> => {
    const approvalId = trustedSessionApprovalId
    // Decided by a pure planner so it is actually covered: the renderer has no
    // jsdom, and this sequence — grant, elevate the seat, accept the prompt
    // that opened the sheet — is precisely the seam that used to grant without
    // elevating, which reads to a user as the button doing nothing.
    // See lib/trustedSessionElevation.ts.
    const plan = planTrustedSessionElevation({
      disabledReason: trustedSessionMutationDisabledReason,
      chatId: currentChat?.appChatId,
      approvalId,
      approvalParticipantId:
        approvalId && pendingAgentApproval?.id === approvalId
          ? pendingAgentApproval.preview?.ensembleParticipant?.participantId
          : null,
      isEnsembleChat: isCurrentEnsembleChat,
      participantIds: (currentChat?.ensemble?.participants || []).map(
        (participant) => participant.id
      ),
      selectedParticipantId: selectedParticipant?.id
    })
    if (plan.kind !== 'elevate') {
      setTrustedSessionConfirmOpen(false)
      setTrustedSessionApprovalId(null)
      return
    }
    // Hoisted so the discriminant narrows inside the `find` closure.
    const elevationTarget = plan.target
    const targetParticipant =
      elevationTarget.scope === 'participant'
        ? (currentChat?.ensemble?.participants || []).find(
            (participant) => participant.id === elevationTarget.participantId
          ) || null
        : null
    const grantResult = await window.api.trustedSessionSet(
      {
        chatId: currentChat.appChatId,
        provider: targetParticipant?.provider || currentProvider,
        workspacePath: currentWorkspacePath || currentChat.workspacePath || null,
        ensembleParticipantId: targetParticipant?.id || null,
        runtimeProfileId: trustedSessionRuntimeProfileForRequest({
          targetIsParticipant: Boolean(targetParticipant),
          participantRuntimeProfileId: targetParticipant?.runtimeProfileId,
          selectedRuntimeProfileId
        })
      },
      true
    )
    if (!grantResult?.enabled) {
      window.alert(grantResult?.error || 'Full Access could not be started for this lane.')
      return
    }
    setTrustedSessionConfirmOpen(false)
    setTrustedSessionApprovalId(null)
    // The grant alone never silenced anything: it unlocks elevated capability,
    // while THIS is what raises the seat's posture and stops the prompts.
    if (plan.target.scope === 'participant') {
      // `via` keeps the original two write paths apart — a seat named by an
      // approval is patched by id, while the composer's own selection goes
      // through the helper that also rebinds the picker to that chip.
      if (plan.target.via === 'approval') {
        patchEnsembleParticipantById(plan.target.participantId, {
          permissionPresetId: 'full_access'
        })
      } else {
        updateSelectedParticipant({ permissionPresetId: 'full_access' })
      }
    } else {
      setApprovalMode('auto_edit')
      rememberCurrentChatComposerSelection({
        approvalMode: 'auto_edit',
        workflowMode: 'normal',
        permissionPresetId: 'full_access'
      })
    }
    if (plan.acceptApprovalId) {
      await handleAgentApprovalAction(plan.acceptApprovalId, 'accept')
    }
  }

  // Full Access grants are process-lifetime (main-memory only), but the
  // remembered solo selection persists `full_access` across relaunches. Without
  // this reconcile the picker keeps showing Full Access while
  // ComposerService silently downgrades every composed run to workspace_write.
  // Demote the remembered selection so the picker tells the truth; re-arming is
  // one click through the confirm sheet. Ensemble seats keep per-participant
  // presets and are downgraded main-side per lane (not reconciled here).
  const rememberedSoloPermissionPresetId =
    typeof currentChat?.providerMetadata?.permissionPresetId === 'string'
      ? currentChat.providerMetadata.permissionPresetId
      : undefined
  useEffect(() => {
    if (!currentChat?.appChatId || isCurrentEnsembleChat || isCurrentGlobalChat) return
    if (rememberedSoloPermissionPresetId !== 'full_access') return
    let cancelled = false
    void window.api
      .trustedSessionGet({
        chatId: currentChat.appChatId,
        provider: currentProvider,
        workspacePath: currentWorkspacePath || currentChat.workspacePath || null,
        ensembleParticipantId: null,
        runtimeProfileId: selectedRuntimeProfileId || null
      })
      .then((result) => {
        if (cancelled) return
        const patch = staleTrustedSessionDemotionPatch({
          rememberedPresetId: rememberedSoloPermissionPresetId,
          trustedSessionEnabled: result?.enabled === true
        })
        if (patch) {
          setApprovalMode(patch.approvalMode)
          rememberCurrentChatComposerSelection(patch)
        }
      })
      .catch(() => {
        // Leave the selection untouched if main cannot answer; compose-time
        // downgrade still keeps the run itself safe.
      })
    return () => {
      cancelled = true
    }
  }, [
    currentChat?.appChatId,
    rememberedSoloPermissionPresetId,
    isCurrentEnsembleChat,
    isCurrentGlobalChat,
    currentProvider,
    currentWorkspacePath,
    selectedRuntimeProfileId
  ])

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
  const bindComposerTextareaRef = React.useCallback(
    (node: HTMLTextAreaElement | null): void => {
      composerTextareaRef.current = node
      if (externalComposerTextareaRef) externalComposerTextareaRef.current = node
    },
    [externalComposerTextareaRef]
  )
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
  /**
   * 1.0.5 — one-shot revert for an emoticon → emoji auto-replace.
   * Set when a just-typed space converted `:-)` etc; Backspace with
   * the draft + caret still exactly at the post-conversion state
   * restores the literal emoticon instead of deleting the emoji
   * (autocorrect-style escape hatch — programmatic draft updates
   * reset the native undo stack, so Cmd+Z can't provide it).
   * Cleared by any other edit; chat-scoped via `chatId`.
   */
  const composerEmoticonRevertRef = useRef<{
    chatId: string
    revertValue: string
    revertCaret: number
    appliedValue: string
    appliedCaret: number
  } | null>(null)
  // Which trigger fired the popover. `'mention'` (`@`) → sub-agents
  // (normal chats) or participants (ensemble); `'file-mention'`
  // (`-@`) → workspace files + external grants.
  const [mentionTriggerKind, setMentionTriggerKind] = useState<'mention' | 'file-mention'>(
    'mention'
  )
  const mentionTriggerLengthRef = useRef<number>(1)
  // Picker selections keep an exact participant id outside the visible draft.
  // The draft itself stays plain `@Role` text rather than a hidden markdown
  // transport token, so the native textarea is always showing its real value.
  const pickerParticipantMentionsByChatIdRef = useRef<
    Map<string, ComposerParticipantMentionSelection[]>
  >(new Map())
  const pickerParticipantMentionDraftRef = useRef({
    chatId: currentComposerChatId,
    value: prompt
  })
  const rebasePickerParticipantMentions = (
    chatId: string,
    previousValue: string,
    nextValue: string
  ): ComposerParticipantMentionSelection[] => {
    const selections = pickerParticipantMentionsByChatIdRef.current.get(chatId) || []
    const rebased = rebaseComposerParticipantMentionSelections({
      previousValue,
      nextValue,
      selections
    })
    if (rebased.length > 0) {
      pickerParticipantMentionsByChatIdRef.current.set(chatId, rebased)
    } else {
      pickerParticipantMentionsByChatIdRef.current.delete(chatId)
    }
    pickerParticipantMentionDraftRef.current = { chatId, value: nextValue }
    return rebased
  }
  const exactPickerParticipantTarget = (value: string): string | undefined => {
    if (!currentComposerChatId) return undefined
    return exactComposerParticipantMentionTarget({
      value,
      selections: pickerParticipantMentionsByChatIdRef.current.get(currentComposerChatId) || []
    })
  }
  useEffect(() => {
    const previous = pickerParticipantMentionDraftRef.current
    if (previous.chatId === currentComposerChatId && previous.value !== prompt) {
      rebasePickerParticipantMentions(currentComposerChatId, previous.value, prompt)
      return
    }
    if (previous.chatId !== currentComposerChatId) {
      pickerParticipantMentionDraftRef.current = { chatId: currentComposerChatId, value: prompt }
    }
  }, [currentComposerChatId, prompt])
  const [isSendConfirming, setIsSendConfirming] = useState(false)
  const [isComposerDragOver, setIsComposerDragOver] = useState(false)
  const [areComposerAboveRowsMinimized, setAreComposerAboveRowsMinimized] = useState(false)
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
  // Terminal-divider drag. Held per instance so unmount can abandon a drag
  // that never got its mouseup — see the cleanup effect below.
  const terminalResizeSessionRef = useRef(createWindowDragSession(window))

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
  //
  // The terminal-divider drag has the same exposure with a worse failure mode:
  // its window listeners only detached on mouseup, so a pane unmounting
  // mid-drag left them attached forever, holding this component's closure.
  useEffect(() => {
    const terminalResizeSession = terminalResizeSessionRef.current
    return () => {
      if (sendConfirmationTimeoutRef.current) {
        window.clearTimeout(sendConfirmationTimeoutRef.current)
      }
      if (sendConfirmationRafRef.current) {
        window.cancelAnimationFrame(sendConfirmationRafRef.current)
      }
      terminalResizeSession.dispose()
      document.body.classList.remove('is-resizing-workspace-terminal')
    }
  }, [])

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
      if (!targetChatId) return
      const saved = await window.api.saveClipboardImageAttachment(targetChatId).catch(() => [])
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

  // Classic queue/steer above-row only. Execution Graph Stack / history live on
  // the Work tab and Execution Map — not in the Composer above-row strip.
  const canRenderComposerAboveRowStack = Boolean(
    queuedMessagesAboveRowEntries.length > 0 ||
      (!isCurrentGlobalChat &&
        currentWorkspace &&
        ((showWorkspaceGitAboveRows && !isWelcomeChat) || isCurrentEnsembleChat)) ||
      (isCurrentGlobalChat && isCurrentEnsembleChat)
  )
  const hasComposerAboveRows =
    canRenderComposerAboveRowStack &&
    ((showWorkspaceGitAboveRows && !isWelcomeChat && Boolean(currentWorkspace)) ||
      isCurrentEnsembleChat ||
      queuedMessagesAboveRowEntries.length > 0)
  const hasPersistentPrimaryWorkspaceAboveRow = Boolean(
    showWorkspaceGitAboveRows && !isWelcomeChat && currentWorkspace
  )
  const nativeNoAboveRowsClass =
    appearance.composerStyle === 'default' &&
    (!hasComposerAboveRows ||
      (areComposerAboveRowsMinimized && !hasPersistentPrimaryWorkspaceAboveRow))
      ? ' composer-surface--native-no-above-rows'
      : ''

  return (
          <div
            className={`composer-area interface-${interfaceStyle}${
              areComposerAboveRowsMinimized ? ' composer-area--above-rows-minimized' : ''
            }`}
            ref={composerAreaRef}
          >
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
                      <WelcomeProviderHighlight
                        provider={currentProvider}
                        modelId={contextModelId}
                      >
                        {currentWorkspace?.displayName ?? 'this workspace'}
                      </WelcomeProviderHighlight>
                    </h1>
                    <p>
                      Describe the recurring task. It captures the current provider and run
                      settings, then runs on the cadence you set below.
                    </p>
                  </>
                ) : (
                  <>
                    <h1>
                      <WelcomeProviderHighlight
                        provider={currentProvider}
                        modelId={contextModelId}
                      >
                        {workflowForCurrentChat?.name ?? 'Workflow'}
                      </WelcomeProviderHighlight>
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
                  <WelcomeProviderHighlight provider={currentProvider} modelId={contextModelId}>
                    {welcomeCopy.heading.workspaceName}
                  </WelcomeProviderHighlight>
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
              way to edit roster / orchestration mode.
              Now: workspace-bound chats keep their existing rules
              (the inner sections still gate on `!isWelcomeChat` so
              Create PR / file-changes / external-path rows don't
              render with empty data), AND global ensemble chats
              get in for the participants strip via the explicit
              second branch. */}
            {canRenderComposerAboveRowStack &&
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
                  appearance.composerStyle === 'cursor' ||
                  appearance.composerStyle === 'codex' ||
                  appearance.composerStyle === 'chatgpt'
                // Prefer chat-resolved currentWorkspacePath over a stale
                // currentWorkspace record so Branch/Commit/Create PR cannot
                // mutate the previously focused primary.
                const primaryGitActionBasePath = composerGitActionBasePath
                const primaryGitActionPath = resolveComposerEffectiveWorkspacePath(
                  primaryGitActionBasePath,
                  composerWorktreeSelection
                )
                // (The GitHub PR/CI satellite pill moved from its own row
                // above the composer into the pane-bottom timecode bar's
                // centre slot — see ComposerThreadTimecodeBar below.)
                const primaryWorkspaceAboveBar =
                  !isWelcomeChat && currentWorkspace && showWorkspaceGitAboveRows ? (
                    <div
                      className={`composer-above-bar style-unified composer-workspace-above-row composer-workspace-above-row--primary${
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
                            path: primaryGitActionBasePath || currentWorkspace.path,
                            repoRoot: primaryGitSnapshot?.repoRoot,
                            remoteUrl: primaryGitSnapshot?.remoteUrl
                          })}
                          {' · '}
                          <ComposerBranchWorktreePopover
                            workspacePath={primaryGitActionBasePath}
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
                      {primaryGitSnapshot && (
                        <GitSyncChip
                          snapshot={primaryGitSnapshot}
                          onOpenCommits={
                            openWorkspaceCommitsInInspector
                              ? () => openWorkspaceCommitsInInspector(primaryGitActionPath)
                              : undefined
                          }
                        />
                      )}
                      </div>
                      {workspaceDiffStats.filesChanged > 0 && (
                        <div className="composer-above-bar-pill composer-above-bar-pill--changes">
                        <WorkspaceDiffStatsButton
                          filesChanged={workspaceDiffStats.filesChanged}
                          additions={workspaceDiffStats.additions}
                          deletions={workspaceDiffStats.deletions}
                          onOpen={() => openWorkspaceDiffInInspector(primaryGitActionPath)}
                        />
                        </div>
                      )}
                      <div className="composer-above-bar-pill composer-above-bar-pill--action">
                      {(() => {
                        const hasReviewableDiff = workspaceDiffStats.filesChanged > 0
                        // 1.0.6-EW66-1d — primary workspace's PR state is now
                        // read from the per-path map keyed by its own path.
                        const primaryPrState = getCreatePrState(primaryGitActionPath)
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
                                  workspacePath={primaryGitActionPath}
                                  open={diffActionMenuOpen}
                                  hasReviewableDiff={hasReviewableDiff}
                                  onReviewChanges={() => {
                                    if (!primaryGitActionPath) {
                                      openInspectorTab('diff')
                                      return
                                    }
                                    void window.api.openWorkspacePopout({
                                      kind: 'diff-studio',
                                      workspacePath: primaryGitActionPath
                                    })
                                  }}
                                  onClose={() => setDiffActionMenuOpen(false)}
                                  onCreatePr={() =>
                                    void handleCreateGithubPr(primaryGitActionPath)
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
                          workspaceDisplayName={
                            workspaces.find(
                              (workspace) =>
                                workspace.path &&
                                pathComparisonKey(workspace.path) === pathComparisonKey(group.path)
                            )?.displayName
                          }
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
                          createPrState={getCreatePrState(
                            group.path,
                            group.representative.chatId
                          )}
                          onCreatePr={(grant) =>
                            handleCreateGithubPr(grant.path, grant.chatId)
                          }
                          onReviewChanges={() =>
                            void window.api.openWorkspacePopout({
                              kind: 'diff-studio',
                              workspacePath: group.path,
                              chatId: group.representative.chatId
                            })
                          }
                          onOpenDiffStudio={() => openWorkspaceDiffInInspector(group.path)}
                          onOpenCommits={
                            openWorkspaceCommitsInInspector
                              ? () => openWorkspaceCommitsInInspector(group.path)
                              : undefined
                          }
                          onSnapshotRefresh={(snapshot) =>
                            onExternalGitSnapshotRefresh?.(
                              group.path,
                              snapshot,
                              group.representative.chatId
                            )
                          }
                          composerStyle={appearance.composerStyle}
                          cursorLeadDetached={aboveRowsFloatAboveStack}
                        />
                      ))
                    : null

                return (
                  <>
                    {aboveRowsFloatAboveStack && primaryWorkspaceAboveBar}
                    {aboveRowsFloatAboveStack && externalWorkspaceAboveRows}
                    <div className={`composer-above-bar-stack ${composerAboveBarStackAuraClass}`}>
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
                    onActivePresetChange={setActiveEnsembleRosterPresetId}
                    variant="compact"
                    composerStyle={appearance.composerStyle}
                    secondRow={renderEnsembleOrchestrationRow()}
                  />
                )}
                {currentChat?.chatKind === 'ensemble' && (
                  <EnsembleParticipantsAboveRow
                    chat={currentChat}
                    participantProjection={currentComposerMentionParticipants}
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
                    onPatchParticipant={(participantId, patch) => {
                      patchEnsembleParticipantById(participantId, patch)
                    }}
                    onLiveRosterMutation={(mutation) => {
                      if (!currentChat) return
                      void window.api
                        .requestEnsembleUserRosterMutation({
                          chatId: currentChat.appChatId,
                          ...mutation
                        })
                        .then((result) => {
                          if (!result.ok) {
                            window.alert(result.message || 'Participant change failed.')
                            return
                          }
                          const updatedChat = result.chat
                          if (!updatedChat) return
                          chatByIdRef.current.set(updatedChat.appChatId, updatedChat)
                          setCurrentChat((prev) =>
                            prev?.appChatId === updatedChat.appChatId ? updatedChat : prev
                          )
                          setChats((prev) =>
                            prev.map((chat) =>
                              chat.appChatId === updatedChat.appChatId ? updatedChat : chat
                            )
                          )
                        })
                        .catch((error) => {
                          window.alert(
                            error instanceof Error
                              ? error.message
                              : 'Participant change failed.'
                          )
                        })
                    }}
                    onCollapseToSolo={handleCollapseEnsembleToSolo}
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
                    onRetryParticipant={(participantId) => {
                      if (!currentChat) return
                      // A live round is JOINED, not replaced: the retry steers
                      // and MAIN opens an additive User Fan-Out lane for the
                      // tagged seat. Only an idle chat gets a fresh DM round.
                      // See `resolveEnsembleParticipantRetryDispatch`.
                      const dispatch = resolveEnsembleParticipantRetryDispatch({
                        chat: currentChat,
                        participantId
                      })
                      if (dispatch.kind === 'none') {
                        setRawLogs((prev) => [...prev, { type: 'info', content: dispatch.reason }])
                        return
                      }
                      if (dispatch.kind === 'steer') {
                        void window.api.runEnsembleRound({
                          chatId: currentChat.appChatId,
                          prompt: dispatch.prompt,
                          mode: 'steer'
                        })
                        return
                      }
                      void window.api.runEnsembleRound({
                        chatId: currentChat.appChatId,
                        prompt: dispatch.prompt,
                        mode: 'normal',
                        concurrentMode: false,
                        fanoutPolicy: 'off',
                        dmTargetParticipantId: dispatch.dmTargetParticipantId
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
                    providerGroups={buildUnifiedProviderModelGroups(false)}
                  />
                )}
                {/*
                  Queued-messages above-row. Classic RunQueue + Steer for
                  follow-ups while a chat is busy. Execution Graph Stack /
                  Map are Work-tab surfaces and must not replace this strip.
                  See `QueuedMessagesAboveRow.tsx`.
                */}
                <QueuedMessagesAboveRow
                  chat={currentChat}
                  entries={queuedMessagesAboveRowEntries}
                  onEdit={handleEditQueuedMessage}
                  onDelete={handleDeleteQueuedMessage}
                  onSteer={handleSteerToQueuedMessage}
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
                  // 1.0.5 — Tier-A markdown highlighting joins mentions
                  // as an overlay activator. Markdown works in EVERY
                  // chat (solo included) — participants are only needed
                  // to mask mention labels out of the markdown scan.
                  // The gate stays "resolved construct present": a draft
                  // with neither mentions nor markdown keeps the plain
                  // opaque textarea and no overlay, exactly as before.
                  const composerRichActive =
                    composerHasMention ||
                    hasComposerMarkdown(prompt, currentComposerMentionParticipants)
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
                      {/*
                        Attachments stack at the TOP of the input container,
                        above the draft text. They used to sit on the OUTER
                        `.composer-surface` frame; in the capsule shells
                        (cursor / chatgpt / gemini) that frame is a transparent
                        vertical shell and the visible box IS this wrap, so the
                        thumbnails read as floating outside the composer
                        entirely. The wrap turns into a two-row grid only while
                        a tray is present (shard 03) — an empty composer keeps
                        every shell's existing flex/block capsule untouched.
                      */}
                      <ComposerAttachmentTray
                        attachments={imageAttachments}
                        discordContextSelection={currentDiscordContextSelection}
                        workspacePath={composerGitActionBasePath || currentWorkspace?.path}
                        onRemoveAttachment={handleRemoveImageAttachment}
                        onClearDiscordContext={handleClearDiscordContext}
                      />
                      {/* A ghost suggestion needs the overlay even with no
                          mention to highlight. Safe to mount without the
                          `has-mention-overlay` class in that case: a ghost is
                          only offered into an empty composer, so there is no
                          textarea text for the overlay to double-paint. */}
                      {(composerRichActive || Boolean(composerGhostText)) && (
                        <ComposerHighlightOverlay
                          value={prompt}
                          participants={currentComposerMentionParticipants}
                          textareaRef={composerTextareaRef}
                          syncEpoch={composerOverlaySyncEpoch}
                          ghostText={composerGhostText}
                          richText
                        />
                      )}
                      <textarea
                        className={`composer-textarea${composerRichActive ? ' has-mention-overlay' : ''}`}
                        ref={bindComposerTextareaRef}
                        value={prompt}
                        title={composerSuggestionTitle}
                        onContextMenu={composerContextMenu.handleContextMenu}
                        onPaste={(event) => {
                          void handleComposerPaste(event)
                        }}
                        onChange={(e) => {
                          const rawValue = e.target.value
                          const rawStart = e.target.selectionStart ?? rawValue.length
                          const rawEnd = e.target.selectionEnd ?? rawValue.length
                          let nextValue = rawValue
                          let nextStart = rawStart
                          let nextEnd = rawEnd
                          // 1.0.5 — emoticon → emoji auto-replace. Fires only
                          // on a plain typed space (never paste, IME
                          // composition, or programmatic edits) with a
                          // collapsed selection. The plan rewrites the draft
                          // BEFORE it enters the pipeline below, so the caret
                          // snapshot, mention rebase, draft store, and popover
                          // scan all see the final value exactly once — the
                          // replacement behaves like typing, nothing more.
                          const native = e.nativeEvent as unknown as {
                            inputType?: string
                            data?: string | null
                            isComposing?: boolean
                          }
                          composerEmoticonRevertRef.current = null
                          if (
                            native?.inputType === 'insertText' &&
                            native.data === ' ' &&
                            !native.isComposing &&
                            rawStart === rawEnd
                          ) {
                            const plan = planEmoticonAutoReplace(rawValue, rawStart)
                            if (plan) {
                              nextValue = plan.value
                              nextStart = plan.caret
                              nextEnd = plan.caret
                              composerEmoticonRevertRef.current = {
                                chatId: currentComposerChatId,
                                revertValue: rawValue,
                                revertCaret: rawStart,
                                appliedValue: plan.value,
                                appliedCaret: plan.caret
                              }
                            }
                          }
                          // 1.0.4-AQ3 — snapshot the caret position from
                          // the change event BEFORE React reconciles. The
                          // restoration layout effect below reads this ref
                          // and re-applies the caret after the className
                          // flip + overlay mount that can land mid-keystroke
                          // when an `@token` resolves (or when an emoticon
                          // auto-replace just rewrote the draft, which moves
                          // the caret left of where the raw keystroke put it).
                          composerSelectionRef.current = {
                            start: nextStart,
                            end: nextEnd
                          }
                          composerCaretRestoreEpochRef.current += 1
                          rebasePickerParticipantMentions(
                            currentComposerChatId,
                            prompt,
                            nextValue
                          )
                          setChatPromptDraft(currentComposerChatId, nextValue)
                          clearPlanImportIfDraftChanged(nextValue)
                          // Composer popover coordinator: scan the text before the
                          // caret for a leading `/<query>` token (start-of-line or
                          // after whitespace), then for an `@<query>` mention token.
                          // Whichever matches wins; the other is force-closed. Only
                          // one popover open at a time.
                          const caret = nextStart
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
                        // The ghost occupies the same empty-composer space the
                        // placeholder does; showing both stacks two greyed
                        // strings on top of each other.
                        placeholder={composerGhostText ? '' : composerPlaceholder}
                        aria-label={composerAriaLabel}
                        rows={1}
                        disabled={!currentChat || (!isCurrentGlobalChat && !currentWorkspace)}
                        onKeyDown={(e) => {
                          // Prefill keys, bound ONLY while a ghost is live so
                          // Tab keeps its normal focus-advance behaviour and
                          // Escape keeps reaching whatever else wants it the
                          // rest of the time. A ghost is only ever offered
                          // into an empty, idle composer, so neither key can
                          // be stolen from a popover or a running turn here.
                          if (composerGhostText && !e.nativeEvent.isComposing) {
                            if (
                              e.key === 'Tab' &&
                              !e.shiftKey &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              !e.altKey
                            ) {
                              const accepted = composerSuggestion.accept()
                              if (accepted) {
                                e.preventDefault()
                                // The ONLY point an unaccepted suggestion
                                // becomes real text. Everything upstream of
                                // this line keeps it in the overlay, out of
                                // the draft store.
                                setChatPromptDraft(currentComposerChatId, accepted)
                                return
                              }
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              composerSuggestion.dismiss()
                              return
                            }
                          }
                          // 1.0.5 — one-shot emoticon-revert: plain Backspace
                          // immediately after an auto-replace (draft + caret
                          // still exactly at the post-conversion state)
                          // restores the literal emoticon instead of deleting
                          // the emoji. Modified Backspace (word/line delete)
                          // keeps its native meaning.
                          const emoticonRevert = composerEmoticonRevertRef.current
                          if (
                            emoticonRevert &&
                            e.key === 'Backspace' &&
                            !e.metaKey &&
                            !e.ctrlKey &&
                            !e.altKey &&
                            !e.nativeEvent.isComposing &&
                            emoticonRevert.chatId === currentComposerChatId &&
                            prompt === emoticonRevert.appliedValue &&
                            e.currentTarget.selectionStart === emoticonRevert.appliedCaret &&
                            e.currentTarget.selectionEnd === emoticonRevert.appliedCaret
                          ) {
                            e.preventDefault()
                            composerEmoticonRevertRef.current = null
                            composerSelectionRef.current = {
                              start: emoticonRevert.revertCaret,
                              end: emoticonRevert.revertCaret
                            }
                            composerCaretRestoreEpochRef.current += 1
                            rebasePickerParticipantMentions(
                              currentComposerChatId,
                              prompt,
                              emoticonRevert.revertValue
                            )
                            setChatPromptDraft(currentComposerChatId, emoticonRevert.revertValue)
                            clearPlanImportIfDraftChanged(emoticonRevert.revertValue)
                            return
                          }
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            if (currentProviderRunUnavailableReason) return
                            if (tryHandleSideSlashSubmit()) {
                              return
                            }
                            if (tryHandleActionSlashSubmit()) {
                              return
                            }
                            if (tryHandleInlineGoalSlashSubmit()) {
                              return
                            }
                            // Solo live-steering lane: when a round is in flight,
                            // Return-key (no modifier) dispatches `handleSteer`
                            // instead of queuing/cancelling — this is the
                            // post-Phase-J3 path that replaces the removed
                            // composer Steer button. Mirrors the original
                            // button gates: handler present, draft non-empty,
                            // chat busy enough for steer, not already busy
                            // steering. Detached side chats omit `handleSteer`
                            // and fall through to `handleRun` below.
                            if (
                              settings?.midRunInputBehavior === 'steer' &&
                              isCurrentChatRunning &&
                              typeof handleSteer === 'function' &&
                              isCurrentChatBusyForSteer &&
                              prompt.trim() &&
                              !isSteerBusyForCurrentChat
                            ) {
                              e.preventDefault()
                              void handleSteer()
                              return
                            }
                            triggerSendConfirmation()
                            // DM target resolution order (first match wins):
                            //   1. A participant chosen from the visible
                            //      `@participant` picker (exact identity is
                            //      attached separately from its plain text).
                            //   2. A legacy `ensemble-dm://` prompt marker.
                            //   3. Legacy Cmd/Ctrl+Enter on a selected chip
                            //      (A2 from 1.0.3 — kept so muscle memory
                            //      still works).
                            // Plain Enter with no mention + no modifier
                            // dispatches the full round.
                            const dmFromPicker = isCurrentEnsembleChat
                              ? exactPickerParticipantTarget(prompt)
                              : undefined
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
                            composerSuggestion.observeSentDraft(prompt)
                            handleRun(
                              undefined,
                              undefined,
                              dmTarget || undefined,
                              undefined,
                              undefined,
                              dmFromPicker
                            )
                            pickerParticipantMentionsByChatIdRef.current.delete(
                              currentComposerChatId
                            )
                            // A picker glance is only about the turn it
                            // followed. Once a new message is away it's stale,
                            // so it must not resurface as a suggestion against
                            // whatever comes back next.
                            setConsideredModel(null)
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
                    rebasePickerParticipantMentions(currentComposerChatId, prompt, value)
                    setChatPromptDraft(currentComposerChatId, value)
                    clearPlanImportIfDraftChanged(value)
                  }}
                  isValueTargetCurrent={() =>
                    (currentChatIdRef.current || currentComposerChatId) === currentComposerChatId
                  }
                  onPasteClipboardAttachment={async () => {
                    const targetChatId = currentComposerChatId
                    if (!targetChatId) return false
                    const saved = await window.api
                      .saveClipboardImageAttachment(targetChatId)
                      .catch(() => [])
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
                  workspacePath={composerGitActionBasePath || currentWorkspace?.path}
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
                    let selectedParticipantMention: ComposerParticipantMentionSelection | null = null
                    const insertion = (() => {
                      if (mention.kind === 'agent' && mention.agentId) {
                        return `[@${mention.name}](agent://${mention.agentId}) `
                      }
                      if (mention.kind === 'participant' && mention.participantId) {
                        // Keep the textarea source plain and editable. Exact
                        // picker identity lives in the short-lived selection
                        // map below and is validated by MAIN at dispatch.
                        const text = formatComposerParticipantMention(mention.name)
                        selectedParticipantMention = {
                          participantId: mention.participantId,
                          start: before.length,
                          end: before.length + text.trimEnd().length,
                          text: text.trimEnd()
                        }
                        return text
                      }
                      return formatComposerPathMention(mention.path || mention.name)
                    })()
                    const next = `${before}${insertion}${afterQuery}`
                    const existingSelections = rebasePickerParticipantMentions(
                      currentComposerChatId,
                      prompt,
                      next
                    )
                    if (selectedParticipantMention) {
                      pickerParticipantMentionsByChatIdRef.current.set(currentComposerChatId, [
                        ...existingSelections,
                        selectedParticipantMention
                      ])
                    }
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
                  Turn/Continuous + provider + model +
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
                      externalWorkspaceGroups.length > 0 && (
                        <div className="composer-image-strip composer-external-grant-strip">
                          {externalWorkspaceGroups.map((group) => (
                            <div
                              key={group.path}
                              className={`composer-image-item external-grant access-${group.representative.access}`}
                            >
                              <PermissionSymbolIcon />
                              <span className="composer-image-name" title={group.path}>
                                {group.representative.access === 'write' ? 'Edit' : 'Read'}{' '}
                                {group.representative.kind}: {group.path}
                              </span>
                              <button
                                className="composer-image-remove"
                                type="button"
                                onClick={() => handleRemoveExternalPathGrantsByPath(group.path)}
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
                        error={externalPathGrantPrompt.error}
                        onGrant={() => void persistExternalPathGrantPrompt()}
                        onDismiss={() => clearExternalPathGrantPrompt()}
                        onRemoveMissingPath={(path) => {
                          handleRemoveExternalPathGrantsByPath(path)
                          clearExternalPathGrantPrompt()
                        }}
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
                    {pendingPlanImport && (
                      <ComposerPlanImportCard
                        pendingPlanImport={pendingPlanImport}
                        displayCurrency={displayCurrency}
                        overestimatePercent={overestimatePercent}
                        planImportExecutionEstimate={planImportExecutionEstimate}
                        planImportGroundingBusy={planImportGroundingBusy}
                        planImportGroundingDisabledReason={planImportGroundingDisabledReason}
                        PLAN_IMPORT_RISK_LABELS={PLAN_IMPORT_RISK_LABELS}
                        formatPlanImportCostEstimate={formatPlanImportCostEstimate}
                        formatPlanImportTokenEstimate={formatPlanImportTokenEstimate}
                        renderPlanImportFileGroundings={renderPlanImportFileGroundings}
                        renderPlanImportItems={renderPlanImportItems}
                        setPendingPlanImport={setPendingPlanImport}
                        handleGroundImportedPlanFiles={handleGroundImportedPlanFiles}
                        handleRunImportedPlan={handleRunImportedPlan}
                        handlePastePlanAsPrompt={() => {
                          setPendingPlanImport(null)
                          focusComposerTextarea()
                        }}
                      />
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
                                  label: 'Attachments',
                                  description: 'Add files or images',
                                  icon: <PlusSymbolIcon />,
                                  onSelect: handlePickImages
                                },
                                {
                                  id: 'folder-attachment',
                                  label: 'Folder',
                                  description: isCurrentGlobalChat
                                    ? 'Choose a workspace first'
                                    : 'Attach a folder reference',
                                  icon: <FolderSymbolIcon />,
                                  disabled: !currentChat || isCurrentGlobalChat,
                                  onSelect: handlePickFolder
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
                                    Boolean(screenWatchUnavailableReason) ||
                                    (!attachedWindow && isAttachingWindow),
                                  onSelect: attachedWindow ? handleDetachWindow : handleAttachWindow
                                },
                                {
                                  id: 'discord-context',
                                  label: 'Discord context',
                                  description: currentDiscordContextSelection
                                    ? `#${currentDiscordContextSelection.channelName || currentDiscordContextSelection.channelId} · last ${currentDiscordContextSelection.limit}`
                                    : discordContextUnavailableReason ||
                                      'Read recent channel messages',
                                  icon: <ChatMediaIcon />,
                                  active: Boolean(currentDiscordContextSelection),
                                  disabled:
                                    !currentChat ||
                                    Boolean(discordContextUnavailableReason) ||
                                    typeof openDiscordContextPicker !== 'function',
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
                                      disabled:
                                        workspaceActionDisabled ||
                                        typeof openInspectorTab !== 'function',
                                      onSelect: () => openInspectorTab('safety')
                                    },
                                    {
                                      id: 'diff',
                                      label: 'Diff Studio',
                                      description: `${currentProviderLabel} workspace changes`,
                                      icon: <FileMenuSelectionIcon />,
                                      disabled:
                                        workspaceActionDisabled ||
                                        typeof openInspectorTab !== 'function',
                                      onSelect: () => openInspectorTab('diff')
                                    },
                                    {
                                      id: 'capabilities',
                                      label: 'Models',
                                      description: `${currentProviderLabel} capability state`,
                                      icon: <ModelSymbolIcon />,
                                      disabled:
                                        workspaceActionDisabled ||
                                        typeof openInspectorTab !== 'function',
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
                                      disabled:
                                        workspaceActionDisabled || composerSlashCommands.length === 0,
                                      onSelect: () => openSlashCommandsMenu()
                                    },
                                    {
                                      id: 'review',
                                      label: isPreparingDiffReview
                                        ? 'Preparing review'
                                        : 'Review diff',
                                      description: 'Read-only plan-mode review',
                                      icon: <ReviewSymbolIcon />,
                                      disabled:
                                        workspaceActionDisabled ||
                                        isPreparingDiffReview ||
                                        typeof handleReviewCurrentDiff !== 'function',
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
                          const effectiveCustomModel =
                            typeof soloPendingProviderMetadata?.customModel === 'string'
                              ? soloPendingProviderMetadata.customModel
                              : customModel
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
                          const effectiveKimiThinking = true
                          const effectiveKimiReasoning =
                            ensembleResolved?.provider === 'kimi'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.kimiReasoningEffort === 'string'
                                ? soloPendingProviderMetadata.kimiReasoningEffort
                                : kimiReasoningEffort
                          const effectiveKimiFastMode =
                            ensembleResolved?.provider === 'kimi'
                              ? ensembleResolved.fastModeEnabled
                              : typeof soloPendingProviderMetadata?.kimiFastMode === 'boolean'
                                ? soloPendingProviderMetadata.kimiFastMode
                                : kimiFastMode
                          const effectiveGrokReasoning =
                            ensembleResolved?.provider === 'grok'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.grokReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.grokReasoningEffort
                                : grokReasoningEffort
                          const effectiveMuseReasoning =
                            ensembleResolved?.provider === 'muse'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.museReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.museReasoningEffort
                                : museReasoningEffort
                          const effectiveMistralReasoning =
                            ensembleResolved?.provider === 'mistral'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.mistralReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.mistralReasoningEffort
                                : mistralReasoningEffort
                          const effectivePiReasoning =
                            ensembleResolved?.provider === 'pi'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.piReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.piReasoningEffort
                                : piReasoningEffort
                          const effectiveOllamaReasoning =
                            ensembleResolved?.provider === 'ollama'
                              ? ensembleResolved.reasoningEffort
                              : typeof soloPendingProviderMetadata?.ollamaReasoningEffort ===
                                    'string'
                                ? soloPendingProviderMetadata.ollamaReasoningEffort
                                : ollamaReasoningEffort
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
                          const combinedModelOptions = buildPickerModelOptions(
                            effectiveProvider,
                            effectiveModelOptionsRaw,
                            !ensembleBinding,
                            effectiveSelectedModel
                          )
                          const unifiedProviderGroups =
                            buildUnifiedProviderModelGroups(!ensembleBinding, effectiveSelectedModel)

                          let combinedReasoningOptions: CombinedModelPickerReasoningOption[] = []
                          let combinedSelectedReasoning = ''
                          if (effectiveProvider === 'codex') {
                            // Ensemble binding resolves the per-model reasoning set
                            // from the selected model (so GPT-5.6 Sol keeps its Max
                            // + Ultra tiers), mirroring the Claude branch below;
                            // the chat-level path uses the live `codexReasoningOptions`.
                            combinedReasoningOptions =
                              ensembleBinding || soloPendingProviderChange
                              ? reasoningOptionsForEffectiveModel(
                                  'codex',
                                  effectiveSelectedModel,
                                  effectiveModelOptionsRaw
                                )
                              : codexReasoningOptions
                                  .filter((option) => option?.reasoningEffort)
                                  .map((option) => ({
                                    value: option.reasoningEffort,
                                    label: codexReasoningDisplayLabel(option.reasoningEffort)
                                  }))
                            combinedSelectedReasoning = effectiveCodexReasoning
                          } else if (effectiveProvider === 'claude') {
                            combinedReasoningOptions =
                              ensembleBinding || soloPendingProviderChange
                              ? reasoningOptionsForEffectiveModel(
                                  'claude',
                                  effectiveSelectedModel,
                                  effectiveModelOptionsRaw
                                )
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
                            combinedReasoningOptions = reasoningOptionsForEffectiveModel(
                              'kimi',
                              effectiveSelectedModel,
                              effectiveModelOptionsRaw
                            )
                            combinedSelectedReasoning = effectiveKimiReasoning
                          } else if (effectiveProvider === 'ollama') {
                            combinedReasoningOptions = reasoningOptionsForEffectiveModel(
                              'ollama',
                              effectiveSelectedModel,
                              effectiveModelOptionsRaw
                            )
                            combinedSelectedReasoning = combinedReasoningOptions.some(
                              (option) => option.value === effectiveOllamaReasoning
                            )
                              ? effectiveOllamaReasoning
                              : combinedReasoningOptions.filter((o) => o.value !== 'ultraTask').at(-1)?.value || combinedReasoningOptions[0]?.value || ''
                          } else if (
                            effectiveProvider === 'grok' &&
                            isGrokReasoningModelId(effectiveSelectedModel)
                          ) {
                            combinedReasoningOptions = [
                              { value: 'low', label: grokReasoningDisplayLabel('low') },
                              { value: 'medium', label: grokReasoningDisplayLabel('medium') },
                              { value: 'high', label: grokReasoningDisplayLabel('high') },
                              ...(effectiveSelectedModel === GROK_46_MODEL_ID
                                ? [
                                    {
                                      value: 'xhigh',
                                      label: grokReasoningDisplayLabel('xhigh')
                                    }
                                  ]
                                : [])
                            ]
                            combinedSelectedReasoning =
                              effectiveGrokReasoning || GROK_45_DEFAULT_REASONING_EFFORT
                          } else if (
                            effectiveProvider === 'cursor' &&
                            isCursorGrokModelId(effectiveSelectedModel)
                          ) {
                            combinedReasoningOptions = [
                              { value: 'low', label: grokReasoningDisplayLabel('low') },
                              { value: 'medium', label: grokReasoningDisplayLabel('medium') },
                              { value: 'high', label: grokReasoningDisplayLabel('high') },
                              ...(cursorGrokBaseModelId(effectiveSelectedModel) === GROK_46_MODEL_ID
                                ? [
                                    {
                                      value: 'xhigh',
                                      label: grokReasoningDisplayLabel('xhigh')
                                    }
                                  ]
                                : [])
                            ]
                            combinedSelectedReasoning =
                              effectiveCursorReasoning || GROK_45_DEFAULT_REASONING_EFFORT
                          } else if (effectiveProvider === 'antigravity') {
                            // Effort lives IN the concrete wire id
                            // (gemini-3.6-flash-high); the slider lists the
                            // family's present variants and selecting one
                            // swaps the selected model id (see
                            // handleCombinedReasoningChange). Suffix-less
                            // models (claude-sonnet-4-6) get no slider.
                            const variantGroup = antigravityVariantGroupForModel(
                              effectiveModelOptionsRaw,
                              effectiveSelectedModel
                            )
                            if (variantGroup) {
                              combinedReasoningOptions = variantGroup.variants.map((variant) => ({
                                value: variant.effort,
                                label:
                                  variant.effort.charAt(0).toUpperCase() + variant.effort.slice(1)
                              }))
                              // UltraTask maps onto the family's High variant:
                              // selecting it swaps the wire model id to the
                              // -high suffix (the highest real effort), then
                              // the UltraTask delegate-wave principle applies
                              // on top. See handleCombinedReasoningChange.
                              if (
                                combinedReasoningOptions.some(
                                  (option) => option.value === 'high'
                                ) &&
                                !combinedReasoningOptions.some(
                                  (option) => option.value === 'ultraTask'
                                )
                              ) {
                                combinedReasoningOptions = [
                                  ...combinedReasoningOptions,
                                  { value: 'ultraTask', label: 'UltraTask' }
                                ]
                              }
                              combinedSelectedReasoning =
                                antigravityEffortForModelId(effectiveSelectedModel) || ''
                              // UltraTask has no dedicated wire id on
                              // Antigravity: selecting it swaps to the family's
                              // -high variant and persists an explicit marker
                              // in chat metadata so presentation keeps showing
                              // UltraTask instead of elastic-snapping back to
                              // High on the next render/reload.
                              if (
                                currentChat?.providerMetadata?.antigravityUltraTaskSelected ===
                                  true &&
                                combinedSelectedReasoning === 'high' &&
                                combinedReasoningOptions.some(
                                  (option) => option.value === 'ultraTask'
                                )
                              ) {
                                combinedSelectedReasoning = 'ultraTask'
                              }
                            } else {
                              // Fixed-effort quota-bound hardcoded rows
                              // (gemini-3.1-pro-thinking, claude-sonnet-4-6,
                              // gpt-oss-120b-medium): no -high/-medium/-low
                              // variant family exists, but the model's own
                              // effort IS the family ceiling. Offer that as
                              // the base stop with UltraTask mapped onto it
                              // so these models aren't left off the ladder.
                              const antigravityFixedEffort =
                                antigravityEffortForModelId(effectiveSelectedModel)
                              if (
                                antigravityFixedEffort &&
                                ultraTaskSupportedForModel(
                                  effectiveModelOptionsRaw,
                                  effectiveSelectedModel
                                )
                              ) {
                                combinedReasoningOptions = [
                                  {
                                    value: antigravityFixedEffort,
                                    label:
                                      antigravityFixedEffort === 'on'
                                        ? 'Thinking'
                                        : antigravityFixedEffort.charAt(0).toUpperCase() +
                                          antigravityFixedEffort.slice(1)
                                  },
                                  { value: 'ultraTask', label: 'UltraTask' }
                                ]
                                // Selection lives in the wire id for
                                // Antigravity; a fixed-effort model is already
                                // at its ceiling, so UltraTask keeps the same
                                // id (see handleCombinedReasoningChange).
                                combinedSelectedReasoning = antigravityFixedEffort
                                // Persisted UltraTask marker: the fixed-effort
                                // model IS the family ceiling, so the wire id
                                // never changes — presentation reads the marker
                                // instead (see handleCombinedReasoningChange).
                                if (
                                  currentChat?.providerMetadata
                                    ?.antigravityUltraTaskSelected === true
                                ) {
                                  combinedSelectedReasoning = 'ultraTask'
                                }
                              }
                            }
                          } else if (
                            effectiveProvider === 'mistral' ||
                            effectiveProvider === 'pi'
                          ) {
                            // Mistral/Pi models that support configurable Thinking
                            // (Devstral Small, Mistral 3.5 Medium). Other rows stay
                            // option-free so the slider remains hidden.
                            combinedReasoningOptions = getEnsembleReasoningOptions(
                              effectiveProvider,
                              effectiveSelectedModel
                            )
                            // 'ultraTask' is a synthetic top-of-ladder token
                            // injected below; accept it here so a persisted
                            // UltraTask selection doesn't elastic-snap back to
                            // the first ladder stop (often Off/no-thinking).
                            const desiredMistralPiReasoning =
                              effectiveProvider === 'pi'
                                ? effectivePiReasoning
                                : effectiveMistralReasoning
                            const mistralPiUltraTaskVisible =
                              desiredMistralPiReasoning === 'ultraTask' &&
                              ultraTaskSupportedForModel(
                                effectiveModelOptionsRaw,
                                effectiveSelectedModel
                              )
                            combinedSelectedReasoning =
                              combinedReasoningOptions.some(
                                (option) => option.value === desiredMistralPiReasoning
                              ) || mistralPiUltraTaskVisible
                                ? desiredMistralPiReasoning
                                : combinedReasoningOptions[0]?.value ||
                                  ''
                          } else if (effectiveProvider === 'muse') {
                            // Muse Spark → minimal…ultra ladder (never none).
                            // Solo persists museReasoningEffort; default high
                            // matches MuseCliArgs MUSE_DEFAULT_REASONING_EFFORT.
                            combinedReasoningOptions = getEnsembleReasoningOptions(
                              'muse',
                              effectiveSelectedModel
                            )
                            combinedSelectedReasoning =
                              effectiveMuseReasoning || MUSE_DEFAULT_REASONING_EFFORT
                          }

                          // UltraTask rides the top of every provider's ladder
                          // whose effort values are real persisted tokens
                          // (Grok/Cursor clamp to xhigh/high outbound, Mistral/
                          // Pi/Muse to their max). Antigravity injects its own
                          // High-mapped option inside its branch above.
                          const ultraTaskSelectedModel = effectiveModelOptionsRaw?.find(
                            (model) => model.id === effectiveSelectedModel
                          )
                          // Inject even when the base ladder is empty (Mistral/Cursor
                          // models without thinking tiers) so UltraTask alone can be
                          // selected; only models explicitly flagged unsupported opt out.
                          if (
                            Array.isArray(combinedReasoningOptions) &&
                            ultraTaskSelectedModel?.ultraTaskSupported !== false &&
                            !combinedReasoningOptions.some((option) => option.value === 'ultraTask')
                          ) {
                            // Empty base ladder (Mistral/Cursor models without
                            // thinking tiers): seed an Off bottom stop so the
                            // injected UltraTask is opt-in, never the default.
                            combinedReasoningOptions = [
                              ...withUltraTaskLadderBottom(combinedReasoningOptions),
                              { value: 'ultraTask', label: 'UltraTask' }
                            ]
                          }

                          const handleCombinedModelChange = (nextModel: string) => {
                            if (effectiveProvider === 'ollama') {
                              onOllamaModelSelected?.(
                                nextModel,
                                combinedModelOptions.find((option) => option.id === nextModel)
                                  ?.label
                              )
                            }
                            if (ensembleBinding && selectedParticipant) {
                              // Seat edits carry reasoning (closest ladder) and
                              // Fast when the destination still supports them;
                              // permissions stay out of the patch.
                              const modelOption = getProviderModelOptions(effectiveProvider).find(
                                (model: CodexModelOption) => model.id === nextModel
                              )
                              updateSelectedParticipant(
                                buildSameProviderModelChangeParticipantPatch(
                                  selectedParticipant,
                                  nextModel,
                                  modelOption
                                )
                              )
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
                            if (effectiveProvider === 'antigravity') {
                              // Direct model picks resolve the effort from the
                              // wire id; drop any stale UltraTask presentation
                              // marker so it can't leak onto another family's
                              // -high model. (The reasoning-change handler
                              // re-persists it AFTER this call when UltraTask
                              // itself is what was picked.)
                              metadataPatch.antigravityUltraTaskSelected = false
                            }
                            if (effectiveProvider === 'codex') {
                              const modelOption = codexModels.find(
                                (model) => model.id === nextModel
                              )
                              const nextReasoning =
                                buildCodexModelChangeParticipantPatch(nextModel, modelOption)
                                  .reasoningEffort || ''
                              if (shouldUpdateLiveComposerState) {
                                setCodexReasoningEffort(nextReasoning)
                              }
                              metadataPatch.codexReasoningEffort = nextReasoning
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
                            if (effectiveProvider === 'kimi') {
                              const kimiModelOption = effectiveModelOptionsRaw.find(
                                (model) => model.id === nextModel
                              )
                              const nextReasoning =
                                kimiModelOption?.defaultReasoningEffort ||
                                kimiModelOption?.supportedReasoningEfforts?.find(
                                  (option) => !option.disabled
                                )?.reasoningEffort ||
                                'on'
                              if (shouldUpdateLiveComposerState) {
                                setKimiReasoningEffort(nextReasoning)
                                setKimiThinkingEnabled(true)
                              }
                              metadataPatch.kimiReasoningEffort = nextReasoning
                              metadataPatch.kimiThinkingEnabled = true
                              if (!kimiModelOption?.additionalSpeedTiers?.includes('fast')) {
                                if (shouldUpdateLiveComposerState) setKimiFastMode(false)
                                metadataPatch.kimiFastMode = false
                              }
                            }
                            if (effectiveProvider === 'ollama') {
                              const nextReasoning = getEnsembleReasoningOptions(
                                'ollama',
                                nextModel,
                                effectiveModelOptionsRaw.find((model) => model.id === nextModel)
                              ).at(-1)?.value || ''
                              if (shouldUpdateLiveComposerState) {
                                setOllamaReasoningEffort(nextReasoning)
                              }
                              metadataPatch.ollamaReasoningEffort = nextReasoning
                            }
                            if (effectiveProvider === 'mistral' || effectiveProvider === 'pi') {
                              const mistralModelOption = effectiveModelOptionsRaw.find(
                                (model: CodexModelOption) => model.id === nextModel
                              )
                              const reasoningOptions = getEnsembleReasoningOptions(
                                effectiveProvider,
                                nextModel
                              )
                              const nextReasoning =
                                (mistralModelOption?.defaultReasoningEffort &&
                                reasoningOptions.some(
                                  (option) => option.value === mistralModelOption.defaultReasoningEffort
                                )
                                  ? mistralModelOption.defaultReasoningEffort
                                  : reasoningOptions[0]?.value) || ''
                              if (shouldUpdateLiveComposerState) {
                                if (effectiveProvider === 'pi') {
                                  setPiReasoningEffort(nextReasoning)
                                } else {
                                  setMistralReasoningEffort(nextReasoning)
                                }
                              }
                              if (effectiveProvider === 'pi') {
                                metadataPatch.piReasoningEffort = nextReasoning
                              } else {
                                metadataPatch.mistralReasoningEffort = nextReasoning
                              }
                            }
                            if (effectiveProvider === 'grok') {
                              if (isGrokReasoningModelId(nextModel)) {
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
                              if (isCursorGrokModelId(nextModel)) {
                                if (shouldUpdateLiveComposerState) {
                                  setCursorReasoningEffort(GROK_45_DEFAULT_REASONING_EFFORT)
                                }
                                metadataPatch.cursorReasoningEffort =
                                  GROK_45_DEFAULT_REASONING_EFFORT
                              }
                              if (!isCursorGrokModelId(nextModel)) {
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

                          const handleCombinedProviderModelChange = (
                            nextProvider: ProviderId,
                            nextModel: string
                          ): void => {
                            if (nextProvider === effectiveProvider) {
                              handleCombinedModelChange(nextModel)
                              return
                            }
                            if (ensembleBinding && selectedParticipant) {
                              const nextModelMetadata = getProviderModelOptions(nextProvider).find(
                                (model: CodexModelOption) => model.id === nextModel
                              )
                              updateSelectedParticipant(
                                buildProviderModelChangeParticipantPatch(
                                  nextProvider,
                                  nextModel,
                                  nextModelMetadata,
                                  selectedParticipant
                                )
                              )
                              return
                            }
                            void handleProviderChange(nextProvider, nextModel)
                          }

                          /*
                           * Fast Mode toggle inside the picker. Replaces
                           * the standalone Codex-only speed `<select>`
                           * that previously sat next to the chip — same
                           * underlying state, just surfaced inside the
                           * Model+Reasoning popover so the user finds it
                           * where they're already adjusting reasoning.
                           */
                          /*
                           * Fast's mechanics differ per provider (Codex moves a
                           * service tier, Claude/Kimi a flag, Cursor a flag OR
                           * the model itself), and `/fast` drives the exact same
                           * toggle. `lib/fastModeToggle` owns those rules for
                           * both surfaces; what stays here is only how THIS
                           * surface applies the result — a bound ensemble seat
                           * vs. live composer state.
                           */
                          const fastModeSelection = {
                            provider: effectiveProvider,
                            selectedModel: effectiveSelectedModel,
                            codexServiceTier: effectiveCodexServiceTier,
                            claudeFastMode: effectiveClaudeFastMode,
                            kimiFastMode: effectiveKimiFastMode,
                            cursorFastMode: effectiveCursorFastMode
                          }
                          const fastModeCapableModelIdSet = fastModeCapableModelIds(
                            effectiveProvider,
                            effectiveModelOptionsRaw
                          )
                          const fastModeEnabledForProvider =
                            fastModeEnabledFor(fastModeSelection)
                          const fastModeDescriptor = nextFastModeToggle(fastModeSelection)
                          const handleToggleFastMode = fastModeDescriptor
                            ? () => {
                                if (fastModeDescriptor.kind === 'model') {
                                  handleCombinedModelChange(fastModeDescriptor.model)
                                  return
                                }
                                if (fastModeDescriptor.kind === 'codex-tier') {
                                  if (ensembleBinding) {
                                    updateSelectedParticipant({
                                      serviceTier: fastModeDescriptor.serviceTier,
                                      fastModeEnabled: fastModeDescriptor.fastModeEnabled
                                    })
                                    return
                                  }
                                  if (shouldUpdateLiveComposerState) {
                                    setCodexServiceTier(fastModeDescriptor.serviceTier)
                                  }
                                  rememberCurrentChatComposerSelection({
                                    codexServiceTier: fastModeDescriptor.serviceTier
                                  })
                                  return
                                }
                                const { fastModeEnabled, serviceTier } = fastModeDescriptor
                                if (ensembleBinding) {
                                  updateSelectedParticipant({
                                    fastModeEnabled,
                                    ...(serviceTier === undefined ? {} : { serviceTier })
                                  })
                                  return
                                }
                                if (fastModeDescriptor.provider === 'claude') {
                                  if (shouldUpdateLiveComposerState) setClaudeFastMode(fastModeEnabled)
                                  rememberCurrentChatComposerSelection({
                                    claudeFastMode: fastModeEnabled
                                  })
                                  return
                                }
                                if (fastModeDescriptor.provider === 'kimi') {
                                  if (shouldUpdateLiveComposerState) setKimiFastMode(fastModeEnabled)
                                  rememberCurrentChatComposerSelection({
                                    kimiFastMode: fastModeEnabled
                                  })
                                  return
                                }
                                if (shouldUpdateLiveComposerState) setCursorFastMode(fastModeEnabled)
                                rememberCurrentChatComposerSelection({
                                  cursorFastMode: fastModeEnabled
                                })
                              }
                            : undefined

                          const handleCombinedReasoningChange = (value: string) => {
                            if (ensembleBinding) {
                              updateSelectedParticipant(
                                buildParticipantReasoningSelectionPatch(
                                  ensembleBinding,
                                  effectiveSelectedModel,
                                  value,
                                  effectiveProvider === 'antigravity'
                                    ? effectiveModelOptionsRaw
                                    : []
                                )
                              )
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
                              if (shouldUpdateLiveComposerState) {
                                setKimiReasoningEffort(value)
                                setKimiThinkingEnabled(true)
                              }
                              rememberCurrentChatComposerSelection({
                                kimiReasoningEffort: value,
                                kimiThinkingEnabled: true
                              })
                            } else if (effectiveProvider === 'mistral' || effectiveProvider === 'pi') {
                              if (shouldUpdateLiveComposerState) {
                                if (effectiveProvider === 'pi') {
                                  setPiReasoningEffort(value)
                                } else {
                                  setMistralReasoningEffort(value)
                                }
                              }
                              rememberCurrentChatComposerSelection(
                                effectiveProvider === 'pi'
                                  ? { piReasoningEffort: value }
                                  : { mistralReasoningEffort: value }
                              )
                            } else if (effectiveProvider === 'ollama') {
                              if (shouldUpdateLiveComposerState) {
                                setOllamaReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                ollamaReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'grok') {
                              if (shouldUpdateLiveComposerState) {
                                setGrokReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                grokReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'muse') {
                              if (shouldUpdateLiveComposerState) {
                                setMuseReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                museReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'cursor') {
                              if (shouldUpdateLiveComposerState) {
                                setCursorReasoningEffort(value)
                              }
                              rememberCurrentChatComposerSelection({
                                cursorReasoningEffort: value
                              })
                            } else if (effectiveProvider === 'antigravity') {
                              // No separate effort state: the slider swaps
                              // which concrete variant id of the family is
                              // selected, so dispatch/persistence/pricing keep
                              // seeing real wire ids. UltraTask maps onto the
                              // family's High variant (its highest real
                              // effort); the UltraTask delegate-wave principle
                              // applies on top of that wire model.
                              const variantGroup = antigravityVariantGroupForModel(
                                effectiveModelOptionsRaw,
                                effectiveSelectedModel
                              )
                              const target = variantGroup?.variants.find(
                                (variant) =>
                                  variant.effort === (value === 'ultraTask' ? 'high' : value)
                              )
                              if (target && target.id !== effectiveSelectedModel) {
                                handleCombinedModelChange(target.id)
                              }
                              // UltraTask lives only in presentation: swap the
                              // wire id to -high above, then persist an explicit
                              // marker so the ladder keeps showing UltraTask
                              // instead of elastic-snapping back to High.
                              // Picking a real effort clears it.
                              rememberCurrentChatComposerSelection({
                                antigravityUltraTaskSelected: value === 'ultraTask'
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
                                  activeRunId={activeRunId}
                                  running={isCurrentChatRunning}
                                  messages={currentChat?.messages}
                                />
                              )}
                              <CombinedModelPicker
                                provider={effectiveProvider}
                                composerStyle={appearance.composerStyle}
                                modelOptions={combinedModelOptions}
                                selectedModelId={effectiveSelectedModel}
                                onSelectModel={handleCombinedModelChange}
                                providerGroups={unifiedProviderGroups}
                                onSelectProviderModel={handleCombinedProviderModelChange}
                                reasoningOptions={combinedReasoningOptions}
                                selectedReasoning={combinedSelectedReasoning}
                                onSelectReasoning={handleCombinedReasoningChange}
                                codexReasoningEffort={effectiveCodexReasoning}
                                claudeReasoningEffort={effectiveClaudeReasoning}
                                grokReasoningEffort={effectiveGrokReasoning}
                                museReasoningEffort={effectiveMuseReasoning}
                                cursorReasoningEffort={effectiveCursorReasoning}
                                kimiThinkingEnabled={effectiveKimiThinking}
                                kimiReasoningEffort={effectiveKimiReasoning}
                                fastModeCapableModelIds={fastModeCapableModelIdSet}
                                fastModeEnabled={fastModeEnabledForProvider}
                                onToggleFastMode={handleToggleFastMode}
                                disabled={false}
                                onCloseWithHighlight={(highlighted) => {
                                  // The picker reports the highlighted row on
                                  // every close. A committed selection lands
                                  // on that same row, so the two are told
                                  // apart here by outcome: if the row the user
                                  // was on IS now the active model, they chose
                                  // it and there's nothing to suggest.
                                  if (!highlighted) {
                                    setConsideredModel(null)
                                    return
                                  }
                                  const key = `${highlighted.provider}:${highlighted.option.id}`
                                  if (
                                    key === `${effectiveProvider}:${effectiveSelectedModel}` ||
                                    highlighted.option.disabled
                                  ) {
                                    setConsideredModel(null)
                                    return
                                  }
                                  setConsideredModel({
                                    label: highlighted.option.label,
                                    key
                                  })
                                }}
                              />
                              {!ensembleBinding &&
                                effectiveSelectedModel === 'custom' &&
                                effectiveProvider !== 'kimi' && (
                                  <span className="composer-inline-custom-model">
                                    <input
                                      className="composer-inline-input"
                                      type="text"
                                      value={effectiveCustomModel}
                                      onChange={(e) => {
                                        if (shouldUpdateLiveComposerState) {
                                          setCustomModel(e.target.value)
                                        }
                                        rememberCurrentChatComposerSelection({
                                          customModel: e.target.value
                                        })
                                        if (effectiveProvider === 'gemini') {
                                          markPersistentSessionRestartNeeded(
                                            'Gemini custom model changed. Restart the persistent session to apply the new model.'
                                          )
                                        }
                                      }}
                                      placeholder="Model ID"
                                      title={
                                        isCurrentComposerLocked
                                          ? 'Custom model for the next turn'
                                          : 'Custom model'
                                      }
                                      data-pending-next-turn={
                                        isCurrentComposerLocked ? 'true' : 'false'
                                      }
                                    />
                                    <button
                                      className="composer-inline-clear"
                                      type="button"
                                      onClick={() => {
                                        const fallbackModel =
                                          effectiveModelOptionsRaw.find(
                                            (option) =>
                                              option.id === lastNonCustomModelType &&
                                              !option.disabled
                                          )?.id ||
                                          effectiveModelOptionsRaw.find(
                                            (option) => !option.disabled
                                          )?.id
                                        if (shouldUpdateLiveComposerState) {
                                          setCustomModel('')
                                        }
                                        rememberCurrentChatComposerSelection({ customModel: '' })
                                        if (fallbackModel) {
                                          handleCombinedModelChange(fallbackModel)
                                        }
                                        if (effectiveProvider === 'gemini' && fallbackModel) {
                                          syncPersistentModelSelection(fallbackModel)
                                        }
                                      }}
                                      title={
                                        isCurrentComposerLocked
                                          ? 'Cancel custom model for the next turn'
                                          : 'Cancel custom model'
                                      }
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
                          // CombinedPermissionsPicker replaces the native
                          // <select> with the shared permission-mode chip.
                          //
                          // Slice F v2 (1.0.3) — when ensemble + a
                          // participant chip is selected, the picker
                          // reads/writes the participant's
                          // `permissionPresetId` instead of the chat's
                          // `approvalMode`. Participant edits remain
                          // capability-only; solo chat edits split Plan
                          // workflow from Read-only recon while both map to
                          // the provider's existing read-only capability.
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
                                  description:
                                    trustedSessionMutationDisabledReason ||
                                    'This chat/lane only; host-level tools when supported.',
                                  ...(trustedSessionMutationDisabledReason
                                    ? {
                                        disabled: true,
                                        disabledReason: trustedSessionMutationDisabledReason
                                      }
                                    : {}),
                                  danger: true
                                }
                              }
                              return option
                            })
                          const handlePermissionSelection = (nextPermissionMode: string): void => {
                            const nextPermissionPreset = selectionToPreset(nextPermissionMode)
                            if (nextPermissionPreset === 'full_access') {
                              if (trustedSessionMutationDisabledReason) return
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
                                updateSelectedParticipant({
                                  permissionPresetId: nextPermissionPreset
                                })
                              }
                              const participantElevation = decideApprovalElevation({
                                from: presetToApprovalMode(effectiveSelectedPermission),
                                to: presetToApprovalMode(nextPermissionPreset),
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
                                  runtimeProfileId: trustedSessionRuntimeProfileForRequest({
                                    targetIsParticipant: Boolean(ensembleBinding),
                                    participantRuntimeProfileId: ensembleBinding?.runtimeProfileId,
                                    selectedRuntimeProfileId
                                  })
                                },
                                false
                              )
                            }
                            if (ensembleBinding) {
                              updateSelectedParticipant({ permissionPresetId: 'workspace_write' })
                              return
                            }
                            setApprovalMode('auto_edit')
                            rememberCurrentChatComposerSelection({
                              approvalMode: 'auto_edit',
                              workflowMode: 'normal',
                              permissionPresetId: 'workspace_write'
                            })
                          }
                          // Permission mode stays editable while a solo run is live.
                          // Model/provider/prompt locks still use
                          // isCurrentComposerLocked elsewhere.
                          const pickerDisabled =
                            Boolean(
                              providerRunUnavailableReason(
                                effectiveProvider,
                                configuredProviderSnapshot.providerIds
                              )
                            ) ||
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
                              onApplyToAllParticipants={applyAllParticipants}
                              onStartTrustedSession={() => {
                                if (trustedSessionMutationDisabledReason) return
                                setTrustedSessionApprovalId(null)
                                setTrustedSessionConfirmOpen(true)
                              }}
                              onStopTrustedSession={stopTrustedSessionForPicker}
                              disabled={pickerDisabled}
                              disabledReason={
                                providerRunUnavailableReason(
                                  effectiveProvider,
                                  configuredProviderSnapshot.providerIds
                                ) || undefined
                              }
                            />
                          )
                        })()}
                        {voiceButtonLivesWithPermissions && (
                          <ComposerVoiceInputButton
                            composerStyle={appearance.composerStyle}
                            disabled={
                              !currentChat ||
                              (!isCurrentGlobalChat && !currentWorkspace)
                            }
                            onCaptureStateChange={setVoiceCaptureState}
                            onTranscript={handleVoiceTranscript}
                            provider={voicePickerProvider}
                          />
                        )}

                        {/* Legacy process-wide auto-approval indicator. New Full Access
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
                              disabled={
                                isCurrentComposerLocked ||
                                Boolean(workspaceTrustMutationDisabledReason)
                              }
                              title={workspaceTrustMutationDisabledReason || 'Workspace trust'}
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
                            activeRunId={activeRunId}
                            running={isCurrentChatRunning}
                            messages={currentChat?.messages}
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
                        {voiceButtonLivesInActionRow && (
                          <ComposerVoiceInputButton
                            composerStyle={appearance.composerStyle}
                            disabled={
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
                                !currentChat ||
                                (!isCurrentGlobalChat && !currentWorkspace)
                              }
                              onCaptureStateChange={setVoiceCaptureState}
                              onTranscript={handleVoiceTranscript}
                              provider={voicePickerProvider}
                            />
                          )}
                          {isCurrentChatRunning ? (
                            <>
                              {/*
                                Phase J3 (steer): the live-capable gesture. The
                                `handleSteer` handler is preserved and dispatched
                                from the Return-key path while a round runs (see
                                the Enter-handler steer branch above). The
                                dedicated Steer button was removed so the
                                destructive Stop control keeps its edge slot; the
                                queued-row Steer action (boundary-only) is
                                unaffected. Pinned by composerSteerButton.test.ts.
                                Detached side chats still omit the handler.
                              */}
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
                            </>
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
                                // the Enter handler above): picker identity
                                // remains separate from the visible plain
                                // @text; legacy markers and selected chips
                                // retain their existing behaviour.
                                const dmFromPicker = isCurrentEnsembleChat
                                  ? exactPickerParticipantTarget(prompt)
                                  : undefined
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
                                composerSuggestion.observeSentDraft(prompt)
                                handleRun(
                                  undefined,
                                  undefined,
                                  dmTarget || undefined,
                                  undefined,
                                  undefined,
                                  dmFromPicker
                                )
                                pickerParticipantMentionsByChatIdRef.current.delete(
                                  currentComposerChatId
                                )
                              }}
                              disabled={
                                !currentChat ||
                                (!isCurrentGlobalChat && !currentWorkspace) ||
                                !hasSendablePromptContent ||
                                Boolean(currentProviderRunUnavailableReason) ||
                                (currentProvider === 'gemini' && !geminiWorkspaceTrustReady)
                              }
                              title={
                                !currentChat
                                  ? 'Open or start a chat first'
                                  : !isCurrentGlobalChat && !currentWorkspace
                                    ? 'Pick a workspace folder first'
                                    : !hasSendablePromptContent
                                      ? 'Type a prompt, attach a file, or choose Project references first'
                                      : currentProviderRunUnavailableReason
                                        ? currentProviderRunUnavailableReason
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
                                appearance.composerStyle === 'chatgpt' ||
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
                    {currentProviderRunUnavailableReason && (
                      <div className="composer-inline-warning" role="status">
                        {currentProviderRunUnavailableReason}
                      </div>
                    )}
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
                        {composerGitActionBasePath &&
                          typeof window.api.trustWorkspace === 'function' && (
                            <button
                              type="button"
                              onClick={() => void handleTrustWorkspaceClick()}
                              disabled={
                                geminiTrustWriteBusy ||
                                isCurrentComposerLocked ||
                                Boolean(workspaceTrustMutationDisabledReason)
                              }
                              title={
                                workspaceTrustMutationDisabledReason ||
                                `Trust ${composerGitActionBasePath} for Gemini — writes ~/.gemini/trustedFolders.json`
                              }
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
                                cursor:
                                  geminiTrustWriteBusy || workspaceTrustMutationDisabledReason
                                    ? 'default'
                                    : 'pointer',
                                opacity:
                                  geminiTrustWriteBusy || workspaceTrustMutationDisabledReason
                                    ? 0.7
                                    : 1
                              }}
                            >
                              <TrustSymbolIcon />
                              {workspaceTrustMutationDisabledReason
                                ? 'Trust in main window'
                                : geminiTrustWriteBusy
                                  ? 'Trusting…'
                                  : 'Trust this folder'}
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
	                {canShowTerminal && (
	                  <button
	                    type="button"
	                    className={`composer-terminal-button composer-hint-pill${isTerminalOpen ? ' is-open' : ''}`}
	                    data-hint-label="Terminal"
	                    onClick={() => {
	                      if (!currentChat?.appChatId) return
	                      setTerminalOpenForChat(currentChat.appChatId, (open) => !open)
	                    }}
	                    title={isTerminalOpen ? 'Close workspace terminal' : 'Open workspace terminal'}
	                    aria-label={isTerminalOpen ? 'Close workspace terminal' : 'Open workspace terminal'}
	                    aria-pressed={isTerminalOpen}
	                  >
	                    <AppleTerminalIcon />
	                  </button>
	                )}
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
                            placeholder="Describe the objective and stopping condition (Markdown supported)"
	                            aria-label="Goal objective"
	                            rows={3}
	                            maxLength={MAX_ACTIVE_GOAL_OBJECTIVE_CHARS}
	                          />
	                          <div className="composer-goal-popover-actions">
	                            <PillButton
	                              size="compact"
	                              variant="primary"
	                              onClick={() => setGoalFromObjective(goalDraft)}
	                            >
	                              {currentActiveGoal ? 'Save' : 'Set goal'}
	                            </PillButton>
	                            <PillButton
	                              size="compact"
	                              variant="secondary"
	                              onClick={() => {
	                                setGoalEditing(false)
	                                setGoalDraft(currentActiveGoal?.objective || '')
	                                if (!currentActiveGoal) setGoalPopoverOpen(false)
	                              }}
	                            >
	                              Cancel
	                            </PillButton>
	                          </div>
	                        </>
	                      ) : (
	                        <>
	                          <div className={`composer-goal-status is-${currentActiveGoal.status}`}>
	                            {currentActiveGoal.status}
	                          </div>
                          <GoalPopoverMarkdown
                            className="composer-goal-objective"
                            content={currentActiveGoal.objective}
                          />
                          {currentActiveGoal.blockedReason && (
                            <GoalPopoverMarkdown
                              className="composer-goal-reason"
                              content={currentActiveGoal.blockedReason}
                            />
                          )}
	                          {goalRuntimeLabel && (
	                            <p className="composer-goal-runtime">{goalRuntimeLabel}</p>
	                          )}
	                          <div className="composer-goal-popover-actions">
	                            <PillButton
	                              size="compact"
	                              variant="secondary"
	                              onClick={() => {
	                                setGoalDraft(currentActiveGoal.objective)
	                                setGoalEditing(true)
	                              }}
	                            >
	                              Edit
	                            </PillButton>
	                            {currentActiveGoal.status === 'paused' ||
	                            currentActiveGoal.status === 'blocked' ? (
	                              <PillButton
	                                size="compact"
	                                variant="secondary"
	                                onClick={() => updateCurrentGoalStatus('active')}
	                              >
	                                Resume
	                              </PillButton>
	                            ) : currentActiveGoal.status !== 'completed' ? (
	                              <PillButton
	                                size="compact"
	                                variant="secondary"
	                                onClick={() => updateCurrentGoalStatus('paused')}
	                              >
	                                Pause
	                              </PillButton>
	                            ) : null}
	                            {currentActiveGoal.status !== 'blocked' &&
	                              currentActiveGoal.status !== 'completed' && (
	                                <PillButton
	                                  size="compact"
	                                  variant="secondary"
	                                  onClick={markCurrentGoalBlocked}
	                                >
	                                  Mark blocked
	                                </PillButton>
	                              )}
	                            {currentActiveGoal.status !== 'completed' && (
	                              <PillButton
	                                size="compact"
	                                variant="primary"
	                                onClick={() => updateCurrentGoalStatus('completed')}
	                              >
	                                Mark complete
	                              </PillButton>
	                            )}
	                            <PillButton
	                              size="compact"
	                              variant="danger"
	                              onClick={clearCurrentGoal}
	                            >
	                              Clear
	                            </PillButton>
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
	                  openSignal={composerSurfaceOpenSignal(composerSurfaceRequest, 'plan')}
	                />
	                {/* Blackboard quick-access — post a user note, review entries,
	                    or delete stale ones without opening the right dock. Seen-by
	                    stays in Notes. Ensemble-only: solo chats have no blackboard. */}
	                {isCurrentEnsembleChat && (
	                  <ComposerBlackboardButton
	                    chat={currentChat}
	                    provider={currentProvider}
	                    composerStyle={appearance.composerStyle}
	                    openSignal={composerSurfaceOpenSignal(composerSurfaceRequest, 'blackboard')}
	                  />
	                )}
	                <CopyTranscriptButton
	                  disabled={!currentChat || currentChat.archived || currentChat.messages.length === 0}
	                  resetKey={currentChat?.appChatId || null}
	                  composerStyle={appearance.composerStyle}
	                  getRounds={() => collectTranscriptExportRounds(currentChat)}
	                  onCopy={(scope) =>
	                    currentChat?.appChatId
	                      ? window.api.copyChatMarkdownTranscript(currentChat.appChatId, scope)
	                      : Promise.resolve({ ok: false as const, reason: 'empty' as const })
	                  }
	                  onCopyMessages={(scope) =>
	                    currentChat?.appChatId
	                      ? window.api.copyChatMessages(currentChat.appChatId, scope)
	                      : Promise.resolve({ ok: false as const, reason: 'empty' as const })
	                  }
	                  onDownload={(scope) =>
	                    downloadChatMarkdownTranscript(currentChat?.appChatId, scope)
	                  }
	                />
	                <MultiviewLayoutPicker
	                  layout={multiview.layout}
	                  onSelectLayout={handleSelectMultiviewLayout}
	                  provider={currentProvider}
	                  composerStyle={appearance.composerStyle}
	                  openSignal={composerSurfaceOpenSignal(composerSurfaceRequest, 'multiview')}
	                />
	                {/* Opens a standalone floating Canvas window (self-contained;
	                    SSRF-guarded openWindow + inline error in the button). */}
	                <CanvasComposerButton
	                  chatId={currentChat?.appChatId ?? null}
	                  composerStyle={appearance.composerStyle}
	                  openSignal={composerSurfaceOpenSignal(composerSurfaceRequest, 'canvas')}
	                />
	                <ComposerAboveRowsToggleButton
	                  minimized={areComposerAboveRowsMinimized}
	                  onToggle={setAreComposerAboveRowsMinimized}
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
                    pendingWorkspace={
                      pendingWorkspaceRebind?.scope === 'workspace'
                        ? workspaces.find(
                            (workspace) => workspace.id === pendingWorkspaceRebind.workspaceId
                          ) || {
                            id: pendingWorkspaceRebind.workspaceId,
                            path: pendingWorkspaceRebind.workspacePath,
                            displayName:
                              pendingWorkspaceRebind.workspacePath
                                .split(/[\\/]/)
                                .filter(Boolean)
                                .pop() || 'Workspace',
                            createdAt: 0,
                            lastOpenedAt: 0,
                            pinned: false
                          }
                        : null
                    }
                    onPickExisting={handleSelectExistingWorkspace}
                    /*
                        The composer switcher is the one surface allowed to
                        rebind the current chat onto a workspace added via the
                        native dialog — hence the explicit switch opt-in. Every
                        other add-workspace surface (sidebar `+`, Settings)
                        omits it and lands on a fresh thread instead
                        (resolveWorkspaceAddDialogIntent).
                      */
                    onAddNewWorkspace={() => handleSelectWorkspace({ intent: 'switch' })}
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
                    activeRunId={activeRunId}
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
                      {(task.status === 'pending' ||
                        task.status === 'due' ||
                        task.status === 'running') && (
                        <button
                          type="button"
                          className="scheduled-task-cancel"
                          title="Cancel scheduled task"
                          aria-label="Cancel scheduled task"
                          onClick={async () => {
                            await window.api.cancelScheduledTask(
                              task.id,
                              'Cancelled from scheduled task pill.'
                            )
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
            {/* Agent-approval OVERLAY — deliberately OUTSIDE `.composer-surface`.
              The surface clips (`overflow: hidden` is load-bearing for the native
              shell's full-bleed inner-module corners), so a card nested in the
              control-footer can only ever sit in flow between the textarea and
              the footer rows. Rendered as a `.composer-area` child instead, the
              card floats OVER the composer stack on the z-axis as the pending-
              approval interaction surface (geometry in `.composer-permission-
              card--overlay`); approval state, focus autoselect and the countdown
              are unchanged. Order: after the surface so tab order stays
              textarea → footer → approval actions. */}
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
                className={`composer-permission-card composer-permission-card--overlay provider-${pendingAgentApproval.provider}`}
                style={
                  {
                    // Fan-out result-card pattern: the card is self-contained in
                    // its participant's hue (brand overrides included) rather
                    // than inheriting whatever the surrounding shell is tinted.
                    '--approval-accent': `var(--provider-${approvalHueClass}-color, var(--warning))`
                  } as React.CSSProperties
                }
              >
                <div className="composer-permission-title">
                  <span id="composer-agent-approval-title">{approvalDisplayTitle}</span>
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
                {approvalEnsembleAttribution && (
                  <section
                    className="composer-permission-attribution"
                    aria-label="Ensemble permission request attribution"
                  >
                    <span className="composer-permission-attribution-label">Requested by</span>
                    {approvalSeat ? (
                      <>
                        {/* Role first, then the config chips, so the line reads
                          as one sentence — "Requested by #3 Scout2 ·
                          AntiGravity · Gemini 3.6 Flash · Accept Edits" — the
                          same order the fan-out lane card and the question card
                          use. Two things the old pill row could not say arrive
                          with it: the stage is now the glyph beside the role
                          (Boss/Captain outranking it, which the pills never
                          showed at all), and the permission chip states the
                          tier this seat is actually running under — the single
                          most relevant fact on an approval modal, and the one
                          field the pills omitted.

                          `seatAccentVar`, never re-derived: the hue resolves
                          from the HUMANISED model label, and any other
                          derivation drifts from the chips beside it on exactly
                          the Ollama and Pi seats. */}
                        {approvalSeatRole && (
                          <strong
                            className="composer-permission-attribution-role"
                            style={{ color: seatAccentVar(approvalSeat) }}
                            title={
                              [
                                participantRoleIconTitle(
                                  approvalSeat.authority,
                                  approvalSeat.stageRole
                                ),
                                approvalSeatRole
                              ]
                                .filter(Boolean)
                                .join(' · ') || undefined
                            }
                          >
                            <ParticipantRoleIcon
                              authority={approvalSeat.authority}
                              stageRole={approvalSeat.stageRole}
                              className="seat-role-icon"
                            />
                            {approvalSeatRole}
                          </strong>
                        )}
                        <SeatStateChips
                          seat={approvalSeat}
                          className="composer-permission-attribution-seat"
                        />
                      </>
                    ) : (
                      <>
                        {/* No model resolved — the participant was deleted
                          mid-flight, or never carried one. Keep the original
                          pills: an identity-shaped strip that names no model
                          says less than they do, and this is the same call the
                          fan-out card makes for its pre-snapshot rows. */}
                        <strong className="segmented-control-action segmented-control-action--compact segmented-control-action--primary composer-permission-attribution-chip">
                          @{approvalEnsembleAttribution.role}
                        </strong>
                        {approvalEnsembleAttribution.order ? (
                          <span
                            className="segmented-control-action segmented-control-action--compact composer-permission-attribution-chip composer-permission-attribution-order"
                            title={`Participant order ${approvalEnsembleAttribution.order}`}
                          >
                            #{approvalEnsembleAttribution.order}
                          </span>
                        ) : null}
                        <span className="segmented-control-action segmented-control-action--compact composer-permission-attribution-chip">
                          {getProviderLabel(pendingAgentApproval.provider)}
                        </span>
                        {approvalSeatModelBadge ? (
                          <span
                            className="segmented-control-action segmented-control-action--compact composer-permission-attribution-chip"
                            title={`Model: ${approvalSeatModelBadge}`}
                          >
                            {approvalSeatModelBadge}
                          </span>
                        ) : null}
                        {approvalEnsembleAttribution.stageRole ? (
                          <span className="segmented-control-action segmented-control-action--compact composer-permission-attribution-chip">
                            {approvalEnsembleAttribution.stageRole}
                          </span>
                        ) : null}
                      </>
                    )}
                  </section>
                )}
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
                  {((pendingAgentApproval.actions || []).includes('acceptForWorkspace') ||
                    (pendingAgentApproval.actions || ['acceptForSession']).includes(
                      'acceptForSession'
                    )) && (
                    <div
                      className="composer-permission-scope-actions"
                      role="group"
                      aria-label="Longer approval scopes"
                    >
                      {(pendingAgentApproval.actions || ['acceptForSession']).includes(
                        'acceptForSession'
                      ) && (
                        <PillButton
                          className="composer-permission-scope-action"
                          variant="secondary"
                          size="compact"
                          type="button"
                          title={
                            pendingAgentApproval.service
                              ? `Allow ${AGENTIC_SERVICE_LABELS[pendingAgentApproval.service]} for the rest of this app session. Restarting the app clears the grant.`
                              : 'Allow matching requests for the rest of this app session. Restarting the app clears the grant.'
                          }
                          onClick={() =>
                            void handleAgentApprovalAction(
                              pendingAgentApproval.id,
                              'acceptForSession'
                            )
                          }
                        >
                          {pendingAgentApproval.service
                            ? `Allow ${AGENTIC_SERVICE_LABELS[pendingAgentApproval.service]} for session`
                            : 'Allow for session'}
                        </PillButton>
                      )}
                      {(pendingAgentApproval.actions || []).includes(
                        'acceptForWorkspace'
                      ) && (
                        <PillButton
                          className="composer-permission-scope-action"
                          variant="secondary"
                          size="compact"
                          type="button"
                          title={
                            pendingAgentApproval.service
                              ? `Allow ${AGENTIC_SERVICE_LABELS[pendingAgentApproval.service]} for this workspace. The grant persists until revoked in Approvals & Grants.`
                              : 'Allow this kind of request for this workspace. The grant persists until revoked in Approvals & Grants.'
                          }
                          onClick={() =>
                            void handleAgentApprovalAction(
                              pendingAgentApproval.id,
                              'acceptForWorkspace'
                            )
                          }
                        >
                          {pendingAgentApproval.service
                            ? `Allow ${AGENTIC_SERVICE_LABELS[pendingAgentApproval.service]} in workspace`
                            : 'Allow in workspace'}
                        </PillButton>
                      )}
                    </div>
                  )}
                  {/* Full Access is lane-scoped: the current ensemble participant or solo
                    chat receives the signed full_access preset, then this request is
                    accepted once. It deliberately does not enable process-wide YOLO or
                    mint a hidden matching-service session grant via acceptForSession. */}
                  {!isNativeSubAgentPreferenceApproval(pendingAgentApproval) &&
                    pendingAgentApproval.preview?.requestOnly !== true &&
                    pendingAgentApproval.preview?.requiresExactDesktopReview !== true &&
                    !pendingAgentApproval.preview?.externalPathDetection && (
                      <PillButton
                        variant="ghost"
                        size="compact"
                        type="button"
                        disabled={Boolean(trustedSessionMutationDisabledReason)}
                        title={
                          trustedSessionMutationDisabledReason ||
                          'Raise only this chat or selected participant to Full Access, then approve this request once. Other lanes are unchanged.'
                        }
                        onClick={() => {
                          if (trustedSessionMutationDisabledReason) return
                          setTrustedSessionApprovalId(pendingAgentApproval.id)
                          setTrustedSessionConfirmOpen(true)
                        }}
                      >
                        {trustedSessionMutationDisabledReason
                          ? 'Full Access in main window'
                          : 'Start Full Access...'}
                      </PillButton>
                    )}
                  {(pendingAgentApproval.actions || ['decline']).includes('decline') && (
                    <PillButton
                      variant="danger"
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
                      variant="danger"
                      size="compact"
                      type="button"
                      title={
                        approvalCancelPresentation.title
                      }
                      onClick={() =>
                        void handleAgentApprovalAction(pendingAgentApproval.id, 'cancel')
                      }
                    >
                      {approvalCancelPresentation.label}
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
                center={
                  // GitHub PR/CI and workspace-edit satellites sit together
                  // between the Turn and Total-thread timecodes. The edit
                  // details panel is portaled from here so it cannot be clipped
                  // by the dense workspace rows above the composer.
                  currentWorkspace ? (
                    <div className="composer-thread-timecode-satellites">
                      {showWorkspaceGitAboveRows && (
                        <GitHubSatelliteRow
                          pr={primaryPr}
                          ci={primaryCi}
                          snapshot={primaryGitSnapshot}
                          onNotify={onNotifyThreadOfCi}
                          isWatching={isWatchingPr}
                          onToggleWatch={onToggleWatchPr}
                          watchDisabledReason={watchPrDisabledReason}
                          watchStatusMessage={watchPrStatusMessage}
                        />
                      )}
                      <WorkspaceLockPill
                        workspacePath={composerGitActionBasePath || currentWorkspace.path}
                        effectiveWorkspacePath={
                          composerWorktreeSelection?.effectiveWorkspacePath ||
                          composerGitActionBasePath ||
                          currentWorkspace.path
                        }
                      />
                    </div>
                  ) : undefined
                }
              />
            )}
            {shouldShowWelcomeStandaloneHeatmaps && (
              <WelcomeHeatmaps slots={welcomeHeatmapSlots} layout="single" />
            )}
            {shouldRenderWelcomeNotifications(isWelcomeChat, showWelcomeNotifications) && (
              <NotificationZone />
            )}
            {trustedSessionConfirmOpen && !trustedSessionMutationDisabledReason && (
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
            {isTerminalOpen &&
              transcriptRoot &&
              composerGitActionBasePath &&
              createPortal(
                <>
                  {/* Sits on the pane's top edge (it overlaps 2px into it) and
                      is the drag target for the terminal's height. Portaled
                      beside the pane because both are positioned against the
                      same `.app-transcript`. */}
                  <div
                    className="workspace-terminal-resize-divider"
                    role="separator"
                    tabIndex={0}
                    aria-orientation="horizontal"
                    aria-label="Resize workspace terminal"
                    aria-valuemin={MIN_WORKSPACE_TERMINAL_HEIGHT}
                    aria-valuemax={MAX_WORKSPACE_TERMINAL_HEIGHT}
                    aria-valuenow={terminalHeight}
                    onMouseDown={startTerminalResize}
                    onKeyDown={handleTerminalResizeKeyDown}
                    title="Resize workspace terminal"
                  />
                  <TerminalPanel
                    workspacePath={composerGitActionBasePath}
                    className="workspace-terminal-split"
                    variant="pane"
                    ptySessionId={currentChat?.appChatId}
                    onTerminalReady={handleTerminalReady}
                  />
                </>,
                transcriptRoot
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
