import { useCallback, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  EMPTY_CHAT_MESSAGES,
  EMPTY_TRANSCRIPT_FILE_SUMMARIES,
  NOOP_AGENT_QUESTION_SUBMIT,
  NOOP_MESSAGE_ACTION,
  NOOP_PLAN_CHOICE_SUBMIT,
  NOOP_PROPOSED_PLAN_CUSTOM
} from '../../lib/stableEmpties'
import { buildSideChatComposerProps } from '../../lib/sideChatComposer'
import { activeEnsembleRoundForComposer } from '../../lib/chatBusyState'
import { resolveSlashParticipantForChat } from '../../lib/resolveSlashParticipant'
import { buildEnsembleProviderBlendStyle } from '../../lib/multiviewEnsembleComposer'
import { SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY } from '../../lib/sideChatLifecycle'
import {
  MAX_ROSTER_PRESET_PARTICIPANTS,
  materializeParticipantsFromPresetWithBossman
} from '../../lib/ensembleRosterPresets'
import { hydrateParticipantsWithPooledAgentIdentity } from '../../lib/ensembleAgentPool'
import {
  ensembleFanoutPolicyEnabled,
  normalizeEnsembleFanoutPolicy
} from '../../lib/ensembleFanoutPolicy'
import { isImageAttachmentPath } from '../../lib/imageAttachments'
import {
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_WORKSPACE_SIDEBAR_WIDTH,
  MAX_WORKSPACE_SIDEBAR_WIDTH
} from '../../lib/panelWidths'
import { getProviderLabel } from '../../lib/providerLabels'
import { isGlobalChat } from '../../lib/chatScope'
import { resolveMainPaneWorkspaceLabel } from '../../lib/mainPaneWorkspaceHeader'
import { RunRailPanel } from '../../components/RunRailPanel'
import { ProjectHomeHeader } from '../../components/ProjectHomeHeader'
import { DigitOdometer } from '../../components/DigitOdometer'
import { Sidebar } from '../../components/Sidebar'
import { ProviderBrandLogoIcon } from '../../components/icons/ProviderBrandLogo'
import { CollapsedSidebarCornerPill } from '../../components/CollapsedSidebarCornerPill'
import { WorkspaceBoardView } from '../../components/WorkspaceBoardView'
import { ProjectThreadGraphView } from '../../components/ProjectThreadGraphView'
import { Inspector, INSPECTOR_TAB_META } from '../../components/Inspector'
import { RightDockSurfaceSwitcher } from '../../components/RightDockSurfaceSwitcher'
import { MainPaneActionPill } from '../../components/MainPaneActionPill'
import { SideChatAuthorityReturnButton } from '../../components/SideChatAuthorityReturnButton'
import { buildWorkspaceStatsContext } from '../../components/workspaceStatsContext'
import { RightDockHome } from '../../components/RightDockHome'
import { SettingsPanel } from '../../components/SettingsPanel'
import { SettingsSidebar } from '../../components/SettingsSidebar'
import {
  AppleTerminalIcon,
  BackToParentIcon,
  ChatPopoutIcon,
  DockDrawerIcon,
  EndSideChatIcon,
  LinkCircleSymbolIcon,
  SidebarCornerIcon,
  SplitChatIcon,
  XSymbolIcon
} from '../../components/AppChromeSymbols'
import { PinnedMessagesPanel } from '../../components/PinnedMessagesPanel'
import {
  ChatMediaDockPanel,
  ChatMediaPreviewOverlay
} from '../../components/ChatMediaPanel'
import { FileEditorPanel } from '../../components/FileEditorPanel'
import { CanvasDockPanel } from '../../components/CanvasDockPanel'
import { AppDriveDockPanel } from '../../components/AppDriveDockPanel'
import { FanoutCandidatesPanel } from '../../components/FanoutCandidatesPanel'
import { ThreadMessageDockPanel } from '../../components/ThreadMessageDockPanel'
import { OfficeSuitePanel } from '../../components/office/OfficeSuitePanel'
import {
  isOfficeDocumentPath,
  officeWorkspaceRelativePath
} from '../../../../shared/office/officeFormats'
import { ProjectReferencesDockPanel } from '../../components/ProjectReferencesDockPanel'
import { WorkProjectReferencesEmptyShell } from '../../components/WorkProjectReferencesEmptyShell'
import { AgentIdentityIcon } from '../../components/icons/AgentIdentityIcon'
import type { RawLogEntry } from '../../lib/rawLogEntry'
import { launchPreviewActionTitle } from '../../lib/launchPreviewTargets'
import { EMPTY_AGENT_QUESTION_QUEUE } from '../../lib/agentQuestionQueue'
import {
  AgentAuraLayer,
  LivingWorkspaceLayer,
  RefractionFilterDefs,
  RunDataVizLayer,
  SkyFogFilterDefs,
  SkyWeatherVisual
} from '../../components/FxLayers'
import { WelcomeUsageDashboard } from '../../components/WelcomeUsageDashboard'
import { TranscriptPanel } from '../../components/TranscriptPanel'
import { SubThreadStatusTicker } from '../../components/SubThreadStatusTicker'
import { ThreadSearchBar } from '../../components/ThreadSearchBar'
import { AuditRunCard } from '../../components/AuditRunCard'
import { AuditRunNotice } from '../../components/AuditRunNotice'
import { MultiviewPaneGrid } from '../../components/MultiviewPaneGrid'
import { MediaPane } from '../../components/MediaPane'
import { CanvasPane } from '../../components/CanvasPane'
import { CanvasPaneLauncher } from '../../components/CanvasPaneLauncher'
import { Composer, type ComposerProps } from '../../components/Composer'
import { ExecutionMapView } from '../../components/ExecutionMapView'
import { WorkspaceBoardCreatorSheet } from '../../components/WorkspaceBoardCreatorSheet'
import { withSessionActivityLedger } from '../../lib/sessionActivityLedger'
import { getProjectReferenceContextSelection } from '../../lib/projectReferenceContextSelection'
import {
  buildUserEnsembleRosterPresetApplyPlan
} from '../../../../shared/ensembleRosterPresetApply'

import type { MainAppLayoutProps } from './MainAppLayout.types'

export function MainAppLayout(props: MainAppLayoutProps): ReactNode {
  const {
  activateRightDockTab,
  activeDiff,
  activeRightDockTab,
  activeSidebarChatId,
  activeWorkProjectId,
  activeThreadSearchIndex,
  activeWorkspaceBoard,
  activeWorkspaceBoardCards,
  activeWorkspaceBoardId,
  activeWorkspaceBoardWorkspace,
  activeProjectGraphProjection,
  activeProjectGraphId,
  projectGraphEntries,
  onOpenProjectGraph,
  onBackFromProjectGraph,
  onOpenThreadFromProjectGraph,
  onAddProjectDependency,
  onRemoveProjectDependency,
  advancedFxIntensity,
  agentMcpStatusByProvider,
  agentStatusByProvider,
  agenticServices,
  agenticWorkspaceGrantCount,
  agenticWorkspaceGrants,
  appMainStyle,
  appTranscriptRef,
  appVersion,
  appearance,
  approvalMode,
  approvalTimeouts,
  auraProviderKey,
  autoFollowRef,
  markMainTranscriptProgrammaticScroll,
  getMainTranscriptUserScrollGestureLive,
  markSideTranscriptProgrammaticScroll,
  getSideTranscriptUserScrollGestureLive,
  autoResumeParentOnSubThreadCompletion,
  autoUpdateEnabled,
  auditBundleVerificationResult,
  beginManualMainTranscriptJump,
  beginManualSideTranscriptJump,
  canCreateSideChatFromCurrent,
  canOpenWorkspacePopout,
  capabilityLedgerSnapshot,
  chatByIdRef,
  chatContextNotice,
  chatContextTurns,
  chatPopoutParentChat,
  chatSplitRegionRef,
  chatSplitStyle,
  chats,
  claudeAuthStatus,
  claudeBinaryPath,
  claudeLoginState,
  closeRightDockPanel,
  closeThreadSearch,
  codexMcpStatus,
  codexModels,
  codexSandboxFallback,
  codexStatus,
  codexThreads,
  collaboratingChatIds,
  composerCtx,
  composerDraftChatIds,
  configuredProviderSnapshot,
  executionMapProjection,
  executionMapSelectedStepId,
  handleBackFromExecutionMap,
  handleSelectExecutionMapStep,
  handleOpenExecutionThread,
  handleSaveExecutionGraph,
  copiedId,
  copy,
  connectedCollaborationChatIds,
  currentAgentMcpStatus,
  currentAgentStatus,
  currentBlackboardEntries,
  currentChat,
  currentChatHumanCollaborationShare,
  currentChatIdRef,
  currentChatMediaRefs,
  chatMediaPromoteTarget,
  currentGeminiWorktree,
  currentPinnedMessages,
  currentPreviewMenuOpen,
  currentPreviewTargets,
  currentProvider,
  currentProviderCapabilities,
  currentProviderLabel,
  currentProviderModelOptions,
  currentRun,
  currentWorkspace,
  cursorProviderAvailable,
  deleteMessageFromChat,
  diffRefreshStatus,
  diffView,
  displayCurrency,
  displayFileChangeSummaries,
  dockChatPopoutWindow,
  dockPresence,
  dockTabDefs,
  effectiveInspectorWidth,
  effectiveIsThinking,
  exportProductDiagnostics,
  exportProductAuditBundle,
  verifyProductAuditBundle,
  externalPathGrants,
  fileChangeDisplayAdds,
  fileChangeDisplayDels,
  fileChangeShouldShowStats,
  fileChangeSummaryText,
  focusedPaneGhostEnabled,
  focusedPaneLivingWorkspaceEnabled,
  focusedPaneSkyEnabled,
  geminiCheckpointingEnabled,
  geminiMcpBridgeEnabled,
  geminiMcpBridgeStatus,
  geminiTerminalEndRef,
  geminiTerminalInput,
  geminiTerminalStatusLabel,
  geminiVersion,
  getDefaultModelForProvider,
  grokProviderAvailable,
  handleAddChatToWorkspaceBoard,
  handleAddLocalServerToWorkspaceBoard,
  handleAddPinnedMessageToWorkspaceBoard,
  handleActiveSidebarTabChange,
  handleAddRunQueueJobToWorkspaceBoard,
  handleAddTranscriptMessageToPrompt,
  handleAddWorkflowToWorkspaceBoard,
  handleAddWorkspaceBoardCard,
  handleAgentApprovalAction,
  handleAgentQuestionDismiss,
  handleAgentQuestionSubmit,
  handleArchiveHandoff,
  handleArchiveWorkspaceBoard,
  handleCancelAuditRun,
  handleCancelRunLane,
  handleCancelWorkflowExecution,
  handleClearClaudeApiKey,
  handleClearCodexUsageCredential,
  handleClearKimiApiKey,
  handleCopyCurrentHumanCollaborationInvite,
  handleCopyMessage,
  handleCreateHandoffFromLane,
  handleCreateHumanCollaborationShare,
  handleCreateWorkspaceBoard,
  handleDeleteAllChatHistory,
  handleDeleteChat,
  handleDeleteMessage,
  handleDeleteQueuedMessage,
  handleDeleteWorkflow,
  handleDeleteWorkspaceBoard,
  handleDeleteWorkspaceBoardCard,
  handleDismissAuditRun,
  handleDismissAuditRunNotice,
  handleDismissOnboardingHint,
  handleDispatchHandoff,
  handleDuplicateRunLane,
  handleDuplicateWorkspaceBoard,
  handleEditQueuedMessage,
  handleEditWorkflowInterval,
  handleRestoreWorkspaceBoard,
  handleEndCurrentLinkedMainChat,
  handleEndSidePanelChat,
  handleToggleSideChatAuthorityReturn,
  handleForkCodexThread,
  handleForkAgentThread,
  handleGeminiTerminalSubmit,
  handleImportCodexUsageCredential,
  handleJumpToLatest,
  handleManualUsageRefresh,
  handleMessageSelectionCandidate,
  handleNavigateToWorkspace,
  handleNewChat,
  handleNewDefaultGlobalChat,
  handleNewEnsemble,
  handleOpenChangelogSheet,
  handleOpenCockpitThread,
  handleOpenInMultiview,
  handleOpenLinkedChatInSidePanelById,
  handleOpenLinkedChatInSidePanelFromSidebar,
  handleOpenPinnedMessageFromSettings,
  handleOpenSideChatFromMessage,
  handleOpenSideChatFromRunResult,
  handleOpenPluginWorkflowTemplate,
  handleOpenProjectReferencesLibrary,
  workProjectHeader,
  handleOpenWorkflowCompose,
  handleOpenWorkspaceBoard,
  handlePersistRunAnalysis,
  handlePlanChoiceSubmit,
  handlePromoteCollaboratorComment,
  handleProposedPlanApprove,
  handleProposedPlanCustom,
  handleProposedPlanDismiss,
  handleRemoveAgenticWorkspaceGrant,
  handleRemoveWorkspace,
  handleRenameChat,
  handleRenameWorkspaceBoard,
  handleReorderQueuedMessages,
  handleResumeCodexThread,
  handleRetryRunLane,
  handleReturnToSideChatParent,
  handleRevokeHumanShare,
  handleRightPanelResizeKeyDown,
  handleRollbackCodexThread,
  handleRunWorkflowNow,
  handleSelectChat,
  handleSelectSideChatTypeOption,
  handleSelectWorkspace,
  handleSetSideAgenticWorkspaceGrant,
  handleSetWorkflowUnattended,
  handleSettingsChange,
  handleSideCancel,
  handleSideAgentApprovalAction,
  handleRemoveSideImageAttachment,
  handleSideChatChange,
  handleSideProviderChange,
  handleSideRun,
  handleSidebarPrimarySurfaceSelect,
  handleSidebarQuickUpdate,
  handleStartProjectHome,
  handleSelectedProjectChange,
  handleStartSharedChat,
  handleSteerToQueuedMessage,
  handleStopHumanCollaborationSharing,
  handleStoreClaudeApiKey,
  handleStoreKimiApiKey,
  handleToggleArchiveChat,
  handleTogglePinChat,
  handleSetChatHiddenFromMainList,
  handleClearChatGitWorkflow,
  activeChatSidebarIdentity,
  activeChatSidebarBranch,
  activeChatSidebarGitIndicators,
  handleTogglePinWorkspace,
  handleTogglePinWorkspaceBoard,
  handleToggleWorkflowEnabled,
  handleTriggerClaudeLogin,
  handleUpdateWorkspaceBoardCard,
  handleProviderLogin,
  handleUpgradeProviderCli,
  handleWorkspaceSidebarResizeKeyDown,
  handoffCards,
  hasCurrentHandoffDraft,
  hasWorkspaceContext,
  hideSideChatPane,
  hostWeather,
  humanCollaborationShares,
  inspectingRunId,
  installGeminiMcpBridge,
  isAdvancedFxActive,
  isChatExpanded,
  isChatMediaPanelOpen,
  isChatPopoutWindow,
  isCurrentEnsembleChat,
  isCurrentGlobalChat,
  isEnsembleModeEnabled,
  isFxEnabled,
  isLinkedChatPopout,
  isMultiviewSplit,
  isOldVersion,
  isPinnedMessagesPanelOpen,
  isProjectReferencesPanelOpen,
  isWorkRouteReferencesPinned,
  isSideChatProviderLocked,
  isSideChatRunning,
  isSideComposerLocked,
  isSideSplitOpen,
  isTerminalDockAvailable,
  isWelcomeChat,
  jumpToTranscriptMessage,
  kimiAuthStatus,
  kimiBinaryPath,
  logsEndRef,
  manualUsageRefreshInFlight,
  managedPolicyStatus,
  multiview,
  ollamaBaseUrl,
  ollamaDefaultModel,
  openChatPopoutWindow,
  openCurrentSideChatPresentation,
  openFileChangeInWorkbench,
  openLinkedChatAsMain,
  openMediaPane,
  openWorkspacePopoutWindow,
  overestimatePercent,
  pendingAgentApproval,
  pendingAgentApprovalByChatId,
  pendingAgentQuestions,
  pendingAgentQuestionsByChatId,
  pendingApprovalQueueByChatId,
  pendingPlanChoice,
  pendingProposedPlan,
  applyEnsemblePermissionsToAllParticipantsForChat,
  patchSideParticipantWithSeatGate,
  popOutLinkedChat,
  popoutMenuOpen,
  popoutMenuRef,
  previewChatMediaRef,
  productOperationsStatus,
  providerCapabilitiesByProvider,
  providerCliUpgradeState,
  providerRates,
  providerShellClass,
  queuedRunQueueCount,
  rawFilter,
  rawLogs,
  rawLogsEndRef,
  refractionEnabled,
  refreshCodexThreads,
  refreshDiff,
  refreshGeminiMcpBridgeStatus,
  refreshProductOperationsStatus,
  refreshProviderMetadata,
  dryRunAuditRetention,
  rememberSideChatComposerSelection,
  renderMultiviewPaneCell,
  renderPreviewLaunchError,
  renderPreviewTargetMenu,
  repairProductInstall,
  purgeAuditRetention,
  rightDockStyle,
  rightDockVisible,
  rightTab,
  roundFileChangeSummaries,
  runCompleteDurationText,
  runDiff,
  runFxStatus,
  runLanes,
  runPreviewTargetAction,
  runQueueJobs,
  runningChatIds,
  runningChatIdsArray,
  scheduledTasks,
  selectThreadSearchMatch,
  selectedSideChatTypeOption,
  sessionTrust,
  setChatMediaPanelOpenPreservingTranscript,
  setDiffView,
  setGeminiTerminalInput,
  setInspectingRunId,
  setJoinSharedChatOpen,
  setPopoutMenuOpen,
  setPreviewChatMediaRef,
  setPreviewMenuTarget,
  setRawFilter,
  setRightTab,
  setSessionTrust,
  setSettingsActiveTab,
  setShowBugReportSheet,
  setShowFirstLaunchSheet,
  setShowGeminiTerminal,
  setShowGhostCompanion,
  setShowSettings,
  setShowSkyVisualFx,
  setShowTerminal,
  setShowWorkspaceSidebar,
  setSubThreadCreatorParent,
  setThreadRawLogs,
  setThreadSearchActiveIndex,
  setThreadSearchQuery,
  settings,
  settingsActiveTab,
  settingsPinnedMessageGroups,
  shouldShowWelcomeUsageDashboard,
  showAgentAuraFx,
  showBugReportSheet,
  showChangelogSheet,
  showFileEditor,
  showOfficeSuite,
  isCanvasDockPanelOpen,
  isAppDriveDockPanelOpen,
  appDriveDockStatus,
  handleAppDrivePause,
  handleAppDriveResume,
  handleAppDriveTakeOver,
  handleAppDriveStop,
  isFanoutCandidatesPanelOpen,
  isThreadMessagePanelOpen,
  threadMessageInbox,
  onThreadMessageSent,
  officeOpenRequest,
  onOpenOfficeDocument,
  onRequestOfficeExternalAccess,
  showFirstLaunchSheet,
  showJumpToLatestPill,
  showOnboardingHint,
  showWorkspaceBoardCreatorSheet,
  showRunDataVizFx,
  showSettings,
  showTerminal,
  showWorkspaceSidebar,
  sideAutoFollowRef,
  sideChat,
  sideChatIsWelcome,
  sideChatSeedMessageId,
  sideChatTokenTally,
  sideChatTypePickerOptions,
  sideChatWelcomeThreadLabel,
  sideChatWelcomeWorkspaceLabel,
  sideClaudeReasoning,
  sideCodexReasoning,
  sideGrokReasoning,
  sideCursorReasoning,
  sideComposerModelOptions,
  sideComposerProvider,
  sideComposerReasoningOptions,
  sideComposerRunTimecodeStartedAt,
  sideComposerSelectedModel,
  sideComposerSelection,
  sideComposerTextareaRef,
  sideContextModelId,
  sideCumulativeRunBaseMs,
  sideDualComposerTelemetry,
  sideKimiThinking,
  sideImageAttachments,
  sideLiveRunOutputTokens,
  sideLogsEndRef,
  sidePanelAgentIdentity,
  sidePanelKindLabel,
  sidePanelLayoutClass,
  sidePanelParentChat,
  sidePanelRelation,
  sideChatAuthorityReturnEnabled,
  currentChatSideChatAuthorityReturnEnabled,
  sidePrompt,
  sideProvider,
  sideQueuedMessagesAboveRowEntries,
  sideRun,
  sideRunCompleteNotice,
  sideSelectedPermission,
  sideThinkingModelBadge,
  sideThinkingProvider,
  sideThinkingProviderClass,
  sideThinkingProviderLabel,
  sideThreadTokenTallyHasValue,
  sideTranscriptContentRef,
  sideExternalRestoreAnchorMessageId,
  sideTranscriptScrollRef,
  sideWorkspace,
  sidebarPresence,
  sidebarSearchFocusRequestId,
  startRightPanelResize,
  startWorkspaceSidebarResize,
  thinkingModelBadge,
  thinkingProvider,
  thinkingProviderClass,
  thinkingProviderLabel,
  threadSearchFocusRequestId,
  threadSearchMatches,
  threadSearchQuery,
  threadSearchShortcutHint,
  threadSearchVisible,
  toggleFeedbackMessageInChat,
  togglePinMessageInChat,
  toggleRightDockPanel,
  transcriptContentRef,
  mainExternalRestoreAnchorMessageId,
  transcriptJumpRequest,
  transcriptMessages,
  transcriptScrollRef,
  transcriptStyle,
  trustResult,
  unreadFromBottomCount,
  updateChannel,
  updatePinnedNotesForChat,
  updateStatus,
  usageInitialized,
  usageRecords,
  usageRefreshTick,
  usageSummary,
  visibleAuditRun,
  visibleAuditRunNotice,
  visibleGeminiTerminalLogs,
  visibleRunCompleteNotice,
  pluginWorkflowTemplates,
  welcomeDashboardCardEnabled,
  welcomeFitLevel,
  welcomeDashboardRegionRef,
  welcomeUsageDashboardData,
  workflowDefinitions,
  workspaceBoardApiReady,
  workspaceBoardCards,
  workspaceBoards,
  setWorkspaceBoardCreatorOpen,
  workspaceSearchShortcutHint,
  workspaceSidebarWidth,
  workspaces
  } = props
  const currentChatAppChatId = currentChat?.appChatId || null
  const refreshProviderAuthStatus = useCallback(
    async (provider: Parameters<typeof refreshProviderMetadata>[0]) => {
      if (provider === 'codex') {
        try {
          await window.api.getAgentStatus('codex', { refreshAuth: true })
        } catch (error) {
          console.warn('[provider sign-in] could not recycle Codex auth status:', error)
        }
      }
      await refreshProviderMetadata(provider, currentWorkspace?.path)
    },
    [currentWorkspace?.path, refreshProviderMetadata]
  )
  const handleTranscriptInspectRun = useCallback(
    (runId: string) => {
      setInspectingRunId(runId)
      activateRightDockTab('run')
    },
    [activateRightDockTab, setInspectingRunId]
  )
  const handleTranscriptAddMessageToPrompt = useCallback(
    (_messageId: string, content: string) => {
      if (!currentChatAppChatId) return
      handleAddTranscriptMessageToPrompt(currentChatAppChatId, content)
    },
    [currentChatAppChatId, handleAddTranscriptMessageToPrompt]
  )
  const handleTranscriptTogglePinMessage = useCallback(
    (messageId: string) => {
      togglePinMessageInChat(currentChat, messageId)
    },
    [currentChat, togglePinMessageInChat]
  )
  const handleTranscriptMessageFeedback = useCallback(
    (messageId: string, vote: 'up' | 'down', details?: unknown) => {
      toggleFeedbackMessageInChat(currentChat, messageId, vote, details)
    },
    [currentChat, toggleFeedbackMessageInChat]
  )
  const handleTranscriptPromoteCollaboratorComment = useCallback(
    (messageId: string) => {
      handlePromoteCollaboratorComment(currentChatAppChatId, messageId)
    },
    [currentChatAppChatId, handlePromoteCollaboratorComment]
  )
  const handleSideTranscriptInspectRun = useCallback(
    (runId: string) => {
      if (!sideChat) return
      void openLinkedChatAsMain(sideChat).then(() => {
        setInspectingRunId(runId)
        activateRightDockTab('run')
      })
    },
    [activateRightDockTab, openLinkedChatAsMain, setInspectingRunId, sideChat]
  )
  const handleSideTranscriptAddMessageToPrompt = useCallback(
    (_messageId: string, content: string) => {
      if (!sideChat) return
      handleAddTranscriptMessageToPrompt(sideChat.appChatId, content)
    },
    [handleAddTranscriptMessageToPrompt, sideChat]
  )
  const handleSideTranscriptDeleteMessage = useCallback(
    (messageId: string) => {
      deleteMessageFromChat(sideChat, messageId)
    },
    [deleteMessageFromChat, sideChat]
  )
  const handleSideTranscriptTogglePinMessage = useCallback(
    (messageId: string) => {
      togglePinMessageInChat(sideChat, messageId)
    },
    [sideChat, togglePinMessageInChat]
  )
  const handleSideTranscriptMessageFeedback = useCallback(
    (messageId: string, vote: 'up' | 'down', details?: unknown) => {
      toggleFeedbackMessageInChat(sideChat, messageId, vote, details)
    },
    [sideChat, toggleFeedbackMessageInChat]
  )
  const handleSideTranscriptPromoteCollaboratorComment = useCallback(
    (messageId: string) => {
      if (!sideChat) return
      handlePromoteCollaboratorComment(sideChat.appChatId, messageId)
    },
    [handlePromoteCollaboratorComment, sideChat]
  )

  const sidePaneRef = useRef<HTMLElement | null>(null)
  const sideComposerAreaRef = useRef<HTMLDivElement | null>(null)
  const sideGoalButtonRef = useRef<HTMLButtonElement | null>(null)
  const sideGoalPopoverRef = useRef<HTMLDivElement | null>(null)
  const sideComposerChatIdRef = useRef<string | null>(sideChat?.appChatId || null)
  sideComposerChatIdRef.current = sideChat?.appChatId || null

  // The focused composer has an App-owned ResizeObserver. The linked pane is a
  // simultaneous second surface, so measure it independently and reserve the
  // matching transcript/welcome clearance without mutating the parent's CSS
  // variables.
  useLayoutEffect(() => {
    if (activeRightDockTab !== 'chat') return
    const pane = sidePaneRef.current
    const composer = sideComposerAreaRef.current
    if (!pane || !composer || typeof ResizeObserver === 'undefined') return
    const syncHeight = (): void => {
      pane.style.setProperty(
        '--side-chat-composer-height',
        `${Math.ceil(composer.getBoundingClientRect().height)}px`
      )
    }
    syncHeight()
    const observer = new ResizeObserver(syncHeight)
    observer.observe(composer)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--side-chat-composer-height')
    }
  }, [activeRightDockTab, sideChat?.appChatId])

  const sideParticipants = sideChat?.ensemble?.participants || []
  const sideSelectedParticipant = resolveSlashParticipantForChat(sideChat)
  const sideEnabledParticipants = sideParticipants
    .filter((participant: any) => participant.enabled !== false)
    .sort((a: any, b: any) => a.order - b.order)
  const sideCurrentOrchestrationMode =
    sideChat?.ensemble?.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
  const sideActiveRound = activeEnsembleRoundForComposer(sideChat?.ensemble?.activeRound)
  const sideActiveOrchestrationMode =
    sideActiveRound?.orchestrationMode === 'continuous'
      ? 'continuous'
      : sideCurrentOrchestrationMode
  const sideCurrentFanoutPolicy = normalizeEnsembleFanoutPolicy(
    sideChat?.ensemble?.fanoutPolicy,
    sideChat?.ensemble?.concurrentModeEnabled
  )
  const sideActiveFanoutPolicy =
    sideActiveRound?.fanoutPolicy !== undefined || sideActiveRound?.concurrentMode !== undefined
      ? normalizeEnsembleFanoutPolicy(
          sideActiveRound?.fanoutPolicy,
          sideActiveRound?.concurrentMode
        )
      : sideCurrentFanoutPolicy
  const sideComposerAttachments = Array.isArray(sideImageAttachments)
    ? sideImageAttachments
    : []
  const sideComposerImageAttachments = sideComposerAttachments.filter((attachment: any) =>
    isImageAttachmentPath(attachment.path)
  )
  const sideComposerFileAttachments = sideComposerAttachments.filter(
    (attachment: any) => !isImageAttachmentPath(attachment.path)
  )
  const sideRawModelOptions = Array.isArray(sideComposerModelOptions)
    ? sideComposerModelOptions.filter((option: any) => option.id !== 'custom')
    : []
  const sideRawReasoningOptions = Array.isArray(sideComposerReasoningOptions)
    ? sideComposerReasoningOptions.map((option: any) => ({
        reasoningEffort: option.value,
        ...(option.disabled ? { disabled: true } : {}),
        ...(option.disabledReason ? { disabledReason: option.disabledReason } : {})
      }))
    : []

  const persistSideChat = (nextChat: any): void => {
    chatByIdRef.current.set(nextChat.appChatId, nextChat)
    if (nextChat.parentChatRelation === 'sideChat') {
      handleSideChatChange(nextChat)
    } else {
      composerCtx.setChats((current: any[]) =>
        current.map((chat: any) => (chat.appChatId === nextChat.appChatId ? nextChat : chat))
      )
    }
    void window.api.saveChat(nextChat)
  }
  const persistSideChatActivity = (nextChat: any): void => {
    if (!sideChat) return
    persistSideChat(withSessionActivityLedger(sideChat, nextChat))
  }
  const patchSideEnsemble = (patch: Record<string, unknown>): void => {
    if (!sideChat?.ensemble) return
    persistSideChatActivity({
      ...sideChat,
      ensemble: {
        ...sideChat.ensemble,
        ...patch,
        updatedAt: new Date().toISOString()
      },
      updatedAt: new Date().getTime()
    })
  }
  const patchSideParticipant = (
    participantId: string,
    patch: Record<string, unknown>
  ): void => {
    if (!sideChat?.ensemble) return
    const nextChat = patchSideParticipantWithSeatGate(sideChat, participantId, patch)
    if (!nextChat) return
    persistSideChat(nextChat)
  }
  const selectSideParticipant = (participantId: string): void => {
    if (!sideChat) return
    persistSideChat({
      ...sideChat,
      providerMetadata: {
        ...(sideChat.providerMetadata || {}),
        [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: participantId
      },
      updatedAt: new Date().getTime()
    })
  }
  const applySideRosterPreset = (preset: any): void => {
    if (!sideChat?.ensemble) return
    const materialized = materializeParticipantsFromPresetWithBossman(preset.participants)
    const participants = hydrateParticipantsWithPooledAgentIdentity(materialized.participants)
    const firstEnabled =
      participants.find((participant: any) => participant.enabled !== false) || participants[0]
    const fanoutPolicy = normalizeEnsembleFanoutPolicy(
      preset.fanoutPolicy,
      preset.concurrentModeEnabled
    )
    if (isSideChatRunning && firstEnabled) {
      const pendingPlan = buildUserEnsembleRosterPresetApplyPlan({
        preset,
        participants,
        bossmanParticipantId: materialized.bossmanParticipantId || firstEnabled.id,
        captainParticipantIds: materialized.captainParticipantIds,
        secondInCommandParticipantId: materialized.secondInCommandParticipantId,
        queuedAt: new Date().toISOString()
      })
      void window.api
        .applyEnsembleRosterPresetAtBoundary({
          chatId: sideChat.appChatId,
          plan: pendingPlan
        })
        .then((result) => {
          if (result.ok) {
            persistSideChat(result.chat)
          } else {
            window.alert(result.message)
          }
        })
        .catch((error) => {
          window.alert(error instanceof Error ? error.message : 'Roster preset apply failed.')
        })
      return
    }
    persistSideChatActivity({
      ...sideChat,
      providerMetadata: {
        ...(sideChat.providerMetadata || {}),
        ...(firstEnabled
          ? { [SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]: firstEnabled.id }
          : {})
      },
      ensemble: {
        ...sideChat.ensemble,
        activeRosterPresetId: preset.id,
        orchestrationMode: preset.orchestrationMode,
        maxParticipants: Math.min(
          MAX_ROSTER_PRESET_PARTICIPANTS,
          Math.max(preset.maxParticipants, participants.length, 2)
        ),
        ...(typeof preset.maxContinuationHops === 'number'
          ? { maxContinuationHops: preset.maxContinuationHops }
          : {}),
        fanoutPolicy,
        concurrentModeEnabled: ensembleFanoutPolicyEnabled(fanoutPolicy),
        ...(typeof preset.ensembleContextChars === 'number'
          ? { ensembleContextChars: preset.ensembleContextChars }
          : {}),
        participants,
        bossmanParticipantId: materialized.bossmanParticipantId,
        captainParticipantIds: materialized.captainParticipantIds,
        secondInCommandParticipantId: materialized.secondInCommandParticipantId,
        bossmanAutoApprovals: undefined,
        updatedAt: new Date().toISOString()
      },
      updatedAt: new Date().getTime()
    })
  }
  const applySidePermissionsToAllParticipants = (): void => {
    if (!sideChat?.ensemble || !sideSelectedParticipant) return
    applyEnsemblePermissionsToAllParticipantsForChat(
      sideChat.appChatId,
      sideSelectedParticipant.id
    )
  }
  const rebindSideChatWorkspace = (workspace: any): void => {
    if (!sideChat || !workspace) return
    persistSideChatActivity({
      ...sideChat,
      scope: 'workspace',
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      updatedAt: new Date().getTime()
    })
    void refreshProviderMetadata(sideComposerProvider, workspace.path)
  }
  const selectNewSideChatWorkspace = async (): Promise<void> => {
    const workspace = await window.api.selectWorkspace()
    if (workspace) rebindSideChatWorkspace(workspace)
  }
  const makeSideChatGlobal = (): void => {
    if (!sideChat) return
    const { workspaceId: _workspaceId, workspacePath: _workspacePath, ...rest } = sideChat
    persistSideChatActivity({ ...rest, scope: 'global', updatedAt: new Date().getTime() })
  }
  const noSideComposerAction = (): void => {}

  const sideComposerCtx = sideChat
    ? (buildSideChatComposerProps(composerCtx, {
        prompt: sidePrompt,
        currentChat: sideChat,
        currentChatIdRef: sideComposerChatIdRef,
        currentComposerChatId: sideChat.appChatId,
        currentComposerMentionParticipants: sideParticipants,
        currentProvider: sideComposerProvider,
        currentProviderLabel: getProviderLabel(sideComposerProvider),
        currentProviderModelOptions: sideRawModelOptions,
        currentProviderCapabilityWarning: null,
        composerSlashCommands: [],
        currentWorkspace: sideWorkspace,
        currentWorkspacePath: sideWorkspace?.path || sideChat.workspacePath,
        isCurrentGlobalChat: isGlobalChat(sideChat),
        isCurrentChatRunning: isSideChatRunning,
        isCurrentChatLinkedChild: true,
        isCurrentChatProviderLocked: isSideChatProviderLocked,
        isCurrentComposerLocked: isSideComposerLocked,
        isCurrentEnsembleChat: sideChat.chatKind === 'ensemble',
        isCurrentEnsembleRoundRunning:
          sideChat.chatKind === 'ensemble' && Boolean(sideActiveRound),
        // Preserve the side pane's purpose-built welcome heading; only the
        // composer shell is shared, so Composer must not add a second hero.
        isWelcomeChat: false,
        isWorkflowChatWelcome: false,
        isWorkflowComposeChat: false,
        shouldShowWelcomeStandaloneHeatmaps: false,
        welcomeHeatmapSlots: [],
        composerAreaRef: sideComposerAreaRef,
        externalComposerTextareaRef: sideComposerTextareaRef,
        composerAriaLabel: 'Linked chat prompt',
        composerPlaceholder:
          sideChat.chatKind === 'ensemble'
            ? 'Ask the side ensemble. @ to direct a participant.'
            : `Ask ${sidePanelKindLabel.toLowerCase()}`,
        composerAboveBarStackAuraClass: '',
        composerAgentAuraClass: '',
        selectedParticipant: sideSelectedParticipant,
        effectiveSelectedParticipantId: sideSelectedParticipant?.id || null,
        ensembleEnabledParticipantsForCurrent: sideEnabledParticipants,
        ensembleBlendStyle: buildEnsembleProviderBlendStyle(sideEnabledParticipants),
        currentEnsembleOrchestrationMode: sideCurrentOrchestrationMode,
        activeEnsembleOrchestrationMode: sideActiveOrchestrationMode,
        currentEnsembleFanoutPolicy: sideCurrentFanoutPolicy,
        activeEnsembleFanoutPolicy: sideActiveFanoutPolicy,
        currentEnsembleConcurrentMode: ensembleFanoutPolicyEnabled(sideCurrentFanoutPolicy),
        activeEnsembleConcurrentMode: ensembleFanoutPolicyEnabled(sideActiveFanoutPolicy),
        currentEnsembleContinuationHops: sideActiveRound?.continuationHops || 0,
        currentEnsembleMaxContinuationHops: sideChat.ensemble?.maxContinuationHops || 6,
        currentEnsembleRoundStatus: sideActiveRound?.status,
        currentEnsembleActiveGoalStatus: sideChat.activeGoal?.status || null,
        ensembleOllamaContextWarning: null,
        selectedModelType: sideComposerSelectedModel,
        selectedComposerModelType: sideComposerSelectedModel,
        lastNonCustomModelType:
          sideComposerSelectedModel === 'custom'
            ? getDefaultModelForProvider(sideComposerProvider)
            : sideComposerSelectedModel,
        customModel: sideComposerSelection?.customModel || '',
        selectedRuntimeProfileId: sideComposerSelection?.runtimeProfileId || null,
        codexReasoningEffort: sideCodexReasoning,
        codexReasoningOptions: sideRawReasoningOptions,
        claudeReasoningEffort: sideClaudeReasoning,
        claudeReasoningOptions: sideRawReasoningOptions,
        kimiFastMode: Boolean(sideComposerSelection?.kimiFastMode),
        kimiReasoningEffort: sideComposerSelection?.kimiReasoningEffort || 'on',
        kimiThinkingEnabled: sideKimiThinking,
        grokReasoningEffort: sideGrokReasoning,
        cursorReasoningEffort: sideCursorReasoning,
        cursorFastMode: Boolean(sideComposerSelection?.cursorFastMode),
        codexServiceTier: sideComposerSelection?.codexServiceTier || '',
        claudeFastMode: Boolean(sideComposerSelection?.claudeFastMode),
        approvalMode: sideComposerSelection?.approvalMode || 'default',
        workflowMode:
          sideComposerSelection?.workflowMode ||
          sideChat.workflowMode ||
          (sideComposerSelection?.approvalMode === 'plan' ? 'plan' : 'normal'),
        hasProjectReferenceContext: Boolean(
          getProjectReferenceContextSelection(sideChat.appChatId)?.referenceIds.length
        ),
        imageAttachments: sideComposerAttachments,
        composerImageAttachments: sideComposerImageAttachments,
        composerFileAttachments: sideComposerFileAttachments,
        currentActiveGoal: sideChat.activeGoal || null,
        currentGoalStatus: sideChat.activeGoal?.status || 'empty',
        currentGoalButtonTitle: sideChat.activeGoal
          ? `${sideChat.activeGoal.status}: ${sideChat.activeGoal.objective}`
          : 'Set active goal',
        goalControlDisabledReason: 'Open this linked chat as the main thread to manage its goal.',
        goalButtonRef: sideGoalButtonRef,
        goalPopoverRef: sideGoalPopoverRef,
        goalPopoverPosition: null,
        contextMeter: null,
        contextUsedPercent: 0,
        contextLabel: 'Linked chat context',
        onCompactContext: undefined,
        onCompactParticipant: undefined,
        compactableParticipantIds: undefined,
        speakingParticipantId: undefined,
        contextModelId: sideContextModelId,
        composerTokenTally: sideChatTokenTally,
        threadTokenTallyHasValue: sideThreadTokenTallyHasValue,
        threadTokenTallyTooltip: 'Linked chat token usage',
        liveRunOutputTokens: sideLiveRunOutputTokens,
        composerRunTimecodeStartedAt: sideComposerRunTimecodeStartedAt,
        cumulativeRunBaseMs: sideCumulativeRunBaseMs,
        dualComposerTelemetry: sideDualComposerTelemetry,
        workspaceDiffStats: { filesChanged: 0, additions: 0, deletions: 0 },
        showWorkspaceGitAboveRows: false,
        composerWorktreeSelection: null,
        onComposerWorktreeChange: undefined,
        diffActionMenuOpen: false,
        setDiffActionMenuOpen: noSideComposerAction,
        setPrimaryGitSnapshot: noSideComposerAction,
        handleCreateGithubPr: noSideComposerAction,
        getCreatePrState: () => ({ status: 'idle' }),
        onNotifyThreadOfCi: undefined,
        isWatchingPr: false,
        onToggleWatchPr: undefined,
        watchPrDisabledReason: undefined,
        watchPrStatusMessage: undefined,
        pendingAgentApproval:
          pendingAgentApprovalByChatId?.[sideChat.appChatId] || null,
        queuedMessagesAboveRowEntries: sideQueuedMessagesAboveRowEntries,
        queuedRunQueueCount: runQueueJobs.filter(
          (job: any) => job.chatId === sideChat.appChatId && job.status === 'queued'
        ).length,
        isCurrentChatBusyForSteer: isSideChatRunning,
        isSteerBusyForCurrentChat: false,
        steerIndicatorMessage: null,
        pendingPlanImport: null,
        visibleScheduledTasks: [],
        scheduleControls: null,
        runtimeProfileControl: null,
        currentDiscordContextSelection: null,
        externalPathGrants: [],
        externalPathRepoMetadata: {},
        externalGitSnapshots: {},
        externalPrByPath: {},
        externalWorkspaceGroups: [],
        primaryGitSnapshot: null,
        primaryPr: null,
        primaryCi: null,
        humanCollaborationInviteActive: false,
        humanCollaborationShare: null,
        humanCollaborationInviteHealth: null,
        humanCollaborationInviteBusy: false,
        humanCollaborationInviteLive: false,
        onCopyHumanCollaborationInvite: undefined,
        onCopyHumanCollaborationInviteText: undefined,
        onStopHumanCollaborationSharing: undefined,
        onOpenHumanCollaborationRemoteSetup: undefined,
        onRefreshHumanCollaborationInviteHealth: undefined,
        attachedWindow: null,
        isAttachingWindow: false,
        resumeAppWatchSnapshot: null,
        screenWatchUnavailableReason:
          'Open this linked chat as the main thread to attach an app window.',
        handleRun: handleSideRun,
        handleCancel: handleSideCancel,
        handleAgentApprovalAction: handleSideAgentApprovalAction,
        handleProviderChange: handleSideProviderChange,
        rememberCurrentChatComposerSelection: rememberSideChatComposerSelection,
        handlePickImages: async () => {
          const selected = await window.api.selectImageFiles()
          if (selected?.length) {
            await composerCtx.addImageAttachmentsToChat(sideChat.appChatId, selected)
          }
        },
        handleRemoveImageAttachment: handleRemoveSideImageAttachment,
        handleCopyCurrentTranscript: () =>
          window.api.copyChatMarkdownTranscript(sideChat.appChatId),
        handleSetAgenticWorkspaceGrant: (service: any, enabled: boolean) =>
          handleSetSideAgenticWorkspaceGrant(service, enabled),
        handleEditQueuedMessage: (entryId: string) =>
          handleEditQueuedMessage(entryId, sideChat),
        handleDeleteQueuedMessage: (entryId: string) =>
          handleDeleteQueuedMessage(entryId, sideChat),
        handleSteerToQueuedMessage: (entryId: string) =>
          handleSteerToQueuedMessage(entryId, sideChat),
        handleReorderQueuedMessages,
        handleSelectExistingWorkspace: rebindSideChatWorkspace,
        handleSelectWorkspace: selectNewSideChatWorkspace,
        handleNewGlobalChat: makeSideChatGlobal,
        handleAddKnownWorkspaceAsSecondary: undefined,
        handleAddWorkspaceFolder: undefined,
        handleRemoveExternalPathGrant: undefined,
        handleRemoveExternalPathGrantsByPath: undefined,
        handleReorderExternalPathGrants: undefined,
        handleReviewCurrentDiff: undefined,
        handleAttachWindow: noSideComposerAction,
        handleDetachWindow: noSideComposerAction,
        openDiscordContextPicker: undefined,
        openInspectorTab: undefined,
        isEnsembleModeEnabled: false,
        handleToggleWelcomeEnsemble: noSideComposerAction,
        handleCollapseEnsembleToSolo: noSideComposerAction,
        handleSelectMultiviewLayout: noSideComposerAction,
        handlePaletteCommand: () => false,
        openSideChatFromSlashCommand: () => {
          window.alert('Nested side chats are unavailable from a linked chat.')
          return false
        },
        setRawLogs: noSideComposerAction,
        clearImagePermissions: noSideComposerAction,
        clearPlanImportIfDraftChanged: noSideComposerAction,
        openPlanImportReview: noSideComposerAction,
        openGoalPopover: noSideComposerAction,
        setGoalPopoverOpen: noSideComposerAction,
        setGoalFromObjective: noSideComposerAction,
        updateCurrentGoalStatus: noSideComposerAction,
        markCurrentGoalBlocked: noSideComposerAction,
        clearCurrentGoal: noSideComposerAction,
        applyEnsembleRosterPreset: applySideRosterPreset,
        setActiveEnsembleRosterPresetId: (presetId: string | null) =>
          patchSideEnsemble({ activeRosterPresetId: presetId || undefined }),
        applyEnsemblePermissionsToAllParticipants: applySidePermissionsToAllParticipants,
        handleSelectParticipant: selectSideParticipant,
        updateSelectedParticipant: (patch: Record<string, unknown>) => {
          if (sideSelectedParticipant) patchSideParticipant(sideSelectedParticipant.id, patch)
        },
        patchEnsembleParticipantById: patchSideParticipant,
        updateCurrentEnsembleOrchestrationMode: (mode: string) =>
          patchSideEnsemble({ orchestrationMode: mode }),
        updateCurrentEnsembleFanoutPolicy: (policy: any) => {
          const normalized = normalizeEnsembleFanoutPolicy(policy)
          patchSideEnsemble({
            fanoutPolicy: normalized,
            concurrentModeEnabled: ensembleFanoutPolicyEnabled(normalized)
          })
        },
        updateCurrentEnsembleContextChars: (value: number) =>
          patchSideEnsemble({
            ensembleContextChars: Math.max(
              5_000,
              Math.min(256_000, Math.round(Number(value) || 0))
            )
          }),
        updateCurrentEnsembleMaxContinuationHops: (value: number) =>
          patchSideEnsemble({
            maxContinuationHops: Math.max(1, Math.min(1200, Math.round(Number(value) || 0)))
          }),
        setCurrentChat: (next: any) => {
          const updated = typeof next === 'function' ? next(sideChat) : next
          if (updated) persistSideChat(updated)
        },
        setSelectedModelType: noSideComposerAction,
        setLastNonCustomModelType: noSideComposerAction,
        setCustomModel: (value: string) =>
          rememberSideChatComposerSelection({ customModel: value }),
        setCodexReasoningEffort: noSideComposerAction,
        setClaudeReasoningEffort: noSideComposerAction,
        setKimiFastMode: noSideComposerAction,
        setKimiReasoningEffort: noSideComposerAction,
        setKimiThinkingEnabled: noSideComposerAction,
        setGrokReasoningEffort: noSideComposerAction,
        setCursorReasoningEffort: noSideComposerAction,
        setCursorFastMode: noSideComposerAction,
        setCodexServiceTier: noSideComposerAction,
        setClaudeFastMode: noSideComposerAction,
        setApprovalMode: noSideComposerAction,
        setSessionTrust: noSideComposerAction,
        sessionTrust: sideSelectedPermission === 'full_access',
        sessionYoloMode: { enabled: false },
        trustResult: null,
        trustSelectValue: 'untrusted',
        geminiWorkspaceTrustReady: true,
        geminiTrustWriteBusy: false,
        geminiTrustWriteError: null,
        persistentSessionNeedsRestart: false,
        sessionRestartReason: '',
        markPersistentSessionRestartNeeded: noSideComposerAction,
        handleTrustWorkspaceClick: noSideComposerAction,
        handleBridgeCommand: noSideComposerAction,
        syncPersistentModelSelection: noSideComposerAction,
        intentNote: '',
        setIntentNote: noSideComposerAction,
        openSlashCommandsRequestId: 0
      } satisfies Partial<ComposerProps>) as ComposerProps)
    : null

  const mainPaneWorkspaceLabel = resolveMainPaneWorkspaceLabel({
    chat: currentChat,
    isGlobalChat: isCurrentGlobalChat,
    workspaces,
    currentWorkspace,
    snapshotRepoRoot: composerCtx?.primaryGitSnapshot?.repoRoot,
    snapshotRemoteUrl: composerCtx?.primaryGitSnapshot?.remoteUrl
  })
  const mainPaneThreadTitle = currentChat?.title || mainPaneWorkspaceLabel || 'New chat'
  const mainPaneWorkspaceStats = buildWorkspaceStatsContext({
    chatId: currentChat?.appChatId,
    baseWorkspacePath: currentWorkspace?.path || currentChat?.workspacePath,
    worktreeSelection: composerCtx?.composerWorktreeSelection,
    snapshot: composerCtx?.primaryGitSnapshot,
    label: mainPaneWorkspaceLabel,
    isGlobalChat: isCurrentGlobalChat
  })
  const mainPaneProvider = isCurrentEnsembleChat
    ? 'ensemble'
    : currentChat?.provider || currentProvider

  // People (collaboration) controls. Defined ONCE and rendered on two surfaces,
  // because the two have opposite corner constraints:
  //   - Main window: in-flow inside .chat-corner-controls-left. It cannot go
  //     top-right, where it used to live — MainPaneActionPill
  //     (.chat-corner-controls-right, z-index 5) claims that corner and painted
  //     over this button, swallowing its clicks. Left-anchored needs no magic
  //     offset tracking the action pill's icon count.
  //   - Chat popout window: the left pill and the action pill are BOTH gated on
  //     !isChatPopoutWindow, so top-right is free there and nothing occludes it.
  //     This was in fact the only place the button worked before the move, so it
  //     must keep working — hence the floating wrapper rather than dropping it.
  const humanCollaborationControls =
    currentChat && !isWelcomeChat ? (
      <div className="human-collaboration-header">
        <button
          type="button"
          className="human-collaboration-people-btn"
          onClick={handleCreateHumanCollaborationShare}
          title={
            collaboratingChatIds.has(currentChat.appChatId)
              ? 'Create another collaborator invite'
              : 'Invite collaborators to this chat'
          }
        >
          People
          {collaboratingChatIds.has(currentChat.appChatId) && (
            <span className="human-collaboration-live-dot" aria-label="Shared" />
          )}
        </button>
        {currentChatHumanCollaborationShare && (
          <button
            type="button"
            className="human-collaboration-people-btn"
            onClick={handleCopyCurrentHumanCollaborationInvite}
            title="Copy a fresh collaborator invite"
          >
            Copy invite
          </button>
        )}
        {collaboratingChatIds.has(currentChat.appChatId) && (
          <button
            type="button"
            className="human-collaboration-people-btn human-collaboration-stop-btn"
            onClick={handleStopHumanCollaborationSharing}
            title="Stop sharing this chat and revoke all collaborators"
          >
            Stop sharing
          </button>
        )}
      </div>
    ) : null

  return (
      <div
        className={`app-main ${isChatExpanded ? 'chat-expanded' : ''} ${providerShellClass} ${
          isChatPopoutWindow ? 'chat-popout-main' : ''
        } ${isLinkedChatPopout ? 'chat-popout-linked-main' : ''} ${
          isSideSplitOpen ? 'side-chat-open' : ''
        } ${rightDockVisible ? 'right-dock-open' : ''}`}
        style={appMainStyle}
      >
        {sidebarPresence.mounted && !isChatPopoutWindow && (
          <>
            {/*
              Sidebar swap. In Settings full-app takeover layout
              (`showSettings === true`), the workspace `Sidebar`
              is replaced by `SettingsSidebar` — the latter carries
              the back-to-app button and the tab list. The resize
              handle stays so the main-pane width remains consistent
              when entering / leaving Settings.
            */}
            {showSettings ? (
              <SettingsSidebar
                activeTab={settingsActiveTab}
                onTabChange={setSettingsActiveTab}
                onBackToApp={() => setShowSettings(false)}
                appVersion={appVersion}
                animationClassName={sidebarPresence.className}
              />
            ) : (
              <Sidebar
                animationClassName={sidebarPresence.className}
                workspaces={workspaces}
                currentWorkspace={currentWorkspace}
                chats={chats}
                currentChat={currentChat}
                activeChatId={activeSidebarChatId}
                focusSearchRequestId={sidebarSearchFocusRequestId}
                searchShortcutHint={workspaceSearchShortcutHint}
                usageSummary={usageSummary}
                modelUsageApiSpend={{
                  providerRates,
                  currency: displayCurrency,
                  overestimatePercent,
                  view: settings?.modelUsagePanelView ?? 'plan',
                  onViewChange: (nextView) =>
                    handleSettingsChange({ modelUsagePanelView: nextView }),
                  refreshKey: usageRefreshTick,
                  onRefreshUsage: handleManualUsageRefresh,
                  refreshing: manualUsageRefreshInFlight,
                  antigravityMonthlyCapUsd:
                    settings?.antigravityGeminiApiMonthlySpendCapUsd ?? null
                }}
                runningChatIds={runningChatIdsArray}
                pluginWorkflowTemplates={pluginWorkflowTemplates}
                workflows={workflowDefinitions}
                workspaceBoards={workspaceBoardApiReady ? workspaceBoards : []}
                workspaceBoardCards={workspaceBoardApiReady ? workspaceBoardCards : []}
                activeWorkspaceBoardId={workspaceBoardApiReady ? activeWorkspaceBoardId : null}
                scheduledTasks={scheduledTasks}
                collaboratingChatIds={collaboratingChatIds}
                composerDraftChatIds={composerDraftChatIds}
                showOnboardingHint={showOnboardingHint}
                onDismissOnboardingHint={handleDismissOnboardingHint}
                onSelectWorkspace={handleNavigateToWorkspace}
                onRemoveWorkspace={handleRemoveWorkspace}
                onSelectWorkspaceDialog={handleSelectWorkspace}
                onNewChat={handleNewChat}
                onNewGlobalChat={handleNewDefaultGlobalChat}
                onNewEnsemble={handleNewEnsemble}
                ensembleModeEnabled={isEnsembleModeEnabled}
                onPrimarySurfaceSelect={handleSidebarPrimarySurfaceSelect}
                onActiveSidebarTabChange={handleActiveSidebarTabChange}
                onSelectChat={handleSelectChat}
                onStartProjectHome={handleStartProjectHome}
                onSelectedProjectChange={handleSelectedProjectChange}
                onOpenReferencesLibrary={handleOpenProjectReferencesLibrary}
                onOpenThreadGraph={(projectId) => onOpenProjectGraph({ id: projectId })}
                projectGraphEntries={projectGraphEntries}
                activeThreadGraphProjectId={activeProjectGraphId}
                onOpenChatInSidePanel={(chat, presentation) =>
                  void handleOpenLinkedChatInSidePanelFromSidebar(chat, presentation)
                }
                onOpenInMultiview={handleOpenInMultiview}
                onOpenSettings={() => setShowSettings(true)}
                updateSnapshot={updateStatus.snapshot}
                onQuickUpdate={handleSidebarQuickUpdate}
                onOpenChangelog={handleOpenChangelogSheet}
                appearanceQuickSettings={{
                  composerStyle: appearance.composerStyle,
                  themeAccentStyle: appearance.themeAccentStyle,
                  themeAppearance: appearance.themeAppearance,
                  toolIconAccent: appearance.toolIconAccent,
                  sidebarOpacity: appearance.sidebarOpacity,
                  mainPaneOpacity: appearance.mainPaneOpacity
                }}
                onAppearanceQuickChange={handleSettingsChange}
                canOpenWorkspacePopout={canOpenWorkspacePopout}
                onOpenWorkspacePopout={openWorkspacePopoutWindow}
                onQuitApp={() => {
                  void window.api.quitApp?.()
                }}
                onCreateSubThread={(parent) => setSubThreadCreatorParent(parent)}
                onTogglePinChat={handleTogglePinChat}
                onTogglePinWorkspace={handleTogglePinWorkspace}
                onSetChatHiddenFromMainList={handleSetChatHiddenFromMainList}
                onClearChatGitWorkflow={handleClearChatGitWorkflow}
                activeChatIdentityTicker={activeChatSidebarIdentity}
                activeChatIdentityBranch={activeChatSidebarBranch}
                activeChatIdentityGitIndicators={activeChatSidebarGitIndicators}
                onToggleArchiveChat={handleToggleArchiveChat}
                onDeleteChat={handleDeleteChat}
                onRenameChat={handleRenameChat}
                onCreateWorkflowFromPluginTemplate={handleOpenPluginWorkflowTemplate}
                onCreateWorkflow={handleOpenWorkflowCompose}
                onCreateWorkspaceBoard={workspaceBoardApiReady ? handleCreateWorkspaceBoard : undefined}
                onOpenWorkspaceBoard={workspaceBoardApiReady ? handleOpenWorkspaceBoard : undefined}
                onRenameWorkspaceBoard={workspaceBoardApiReady ? handleRenameWorkspaceBoard : undefined}
                onDuplicateWorkspaceBoard={workspaceBoardApiReady ? handleDuplicateWorkspaceBoard : undefined}
                onTogglePinWorkspaceBoard={workspaceBoardApiReady ? handleTogglePinWorkspaceBoard : undefined}
                onArchiveWorkspaceBoard={workspaceBoardApiReady ? handleArchiveWorkspaceBoard : undefined}
                onRestoreWorkspaceBoard={workspaceBoardApiReady ? handleRestoreWorkspaceBoard : undefined}
                onDeleteWorkspaceBoard={workspaceBoardApiReady ? handleDeleteWorkspaceBoard : undefined}
                onAddChatToWorkspaceBoard={
                  workspaceBoardApiReady ? handleAddChatToWorkspaceBoard : undefined
                }
                onAddWorkflowToWorkspaceBoard={
                  workspaceBoardApiReady ? handleAddWorkflowToWorkspaceBoard : undefined
                }
                onAddRunQueueJobToWorkspaceBoard={
                  workspaceBoardApiReady ? handleAddRunQueueJobToWorkspaceBoard : undefined
                }
                onAddLocalServerToWorkspaceBoard={
                  workspaceBoardApiReady ? handleAddLocalServerToWorkspaceBoard : undefined
                }
                onCreateSharedChat={handleStartSharedChat}
                onJoinSharedChat={() => setJoinSharedChatOpen(true)}
                onRunWorkflowNow={handleRunWorkflowNow}
                onToggleWorkflowEnabled={handleToggleWorkflowEnabled}
                onEditWorkflowInterval={handleEditWorkflowInterval}
                onCancelWorkflowExecution={handleCancelWorkflowExecution}
                onDeleteWorkflow={handleDeleteWorkflow}
                onSetWorkflowUnattended={handleSetWorkflowUnattended}
                onInspectRun={(runId, chatId) => {
                  // Navigate to the chat first (handleSelectChat fires via
                  // ActiveRunsSection.onSelectChat above), then open the
                  // Inspector. The chat-switch reset effect won't clobber
                  // this because it's gated on "does the new chat own this
                  // runId?" — see effect below.
                  if (chatId) {
                    const chat = chats.find((c) => c.appChatId === chatId)
                    if (chat) handleSelectChat(chat)
                  }
                  setInspectingRunId(runId)
                }}
                onOpenSettingsTab={(tab) => {
                  setSettingsActiveTab(tab)
                  setShowSettings(true)
                }}
                pendingAgentApprovalByChatId={pendingAgentApprovalByChatId}
                pendingApprovalQueueByChatId={pendingApprovalQueueByChatId}
                onRespondAgentApproval={handleAgentApprovalAction}
                pendingAgentQuestionsByChatId={pendingAgentQuestionsByChatId}
                onAnswerAgentQuestion={handleAgentQuestionSubmit}
                onDismissAgentQuestion={handleAgentQuestionDismiss}
                collaborationShares={humanCollaborationShares}
                onRevokeShare={handleRevokeHumanShare}
                hasConnectedCollaborator={connectedCollaborationChatIds.size > 0}
              />
            )}
            <div
              className={`workspace-sidebar-resize-handle${
                sidebarPresence.className ? ` ${sidebarPresence.className}` : ''
              }`}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize workspace sidebar"
              aria-valuemin={MIN_WORKSPACE_SIDEBAR_WIDTH}
              aria-valuemax={MAX_WORKSPACE_SIDEBAR_WIDTH}
              aria-valuenow={workspaceSidebarWidth}
              onMouseDown={startWorkspaceSidebarResize}
              onKeyDown={handleWorkspaceSidebarResizeKeyDown}
              title="Resize workspace sidebar"
            />
          </>
        )}

        {/*
          Settings full-app takeover pane. When `showSettings` is true,
          this sibling renders the SettingsPanel inline in the main pane
          slot — paired with the SettingsSidebar swap above. The
          adjacent `.app-transcript` element is hidden via the
          `transcript-hidden-for-settings` class (just `display: none`)
          so its ref stays valid and its state survives the round-trip
          back to the chat surface.
        */}
        {!isChatPopoutWindow && showSettings && (
          <div className="app-settings-pane" role="region" aria-label="Settings">
            <SettingsPanel
              layout="takeover"
              activeTab={settingsActiveTab}
              onTabChange={setSettingsActiveTab}
              mode={appearance.mode}
              visualEffectStyle={appearance.visualEffectStyle}
              themeAppearance={appearance.themeAppearance}
              themeCornerStyle={appearance.themeCornerStyle}
              themeAccentStyle={appearance.themeAccentStyle}
              toolIconAccent={appearance.toolIconAccent}
              diffStatColors={appearance.diffStatColors}
              appIconVariant={appearance.appIconVariant}
              userBubbleColor={appearance.userBubbleColor}
              promptSurfaceStyle={appearance.promptSurfaceStyle}
              fanoutLaneLayout={appearance.fanoutLaneLayout}
              composerStyle={appearance.composerStyle}
              configuredProviderSnapshot={configuredProviderSnapshot}
              transcriptFontFamily={appearance.transcriptFontFamily}
              composerFontFamily={appearance.composerFontFamily}
              persistedTranscriptFontFamily={settings?.transcriptFontFamily ?? ''}
              persistedComposerFontFamily={settings?.composerFontFamily ?? ''}
              onFontPreview={(partial) => appearance.applyPreview(partial)}
              keyCommandBindings={settings?.keyCommandBindings}
              reduceTransparency={appearance.reduceTransparency}
              reduceMotion={appearance.reduceMotion}
              compactDensity={appearance.compactDensity}
              liveActivityViewport={appearance.liveActivityViewport}
              sidebarOpacity={appearance.sidebarOpacity}
              mainPaneOpacity={appearance.mainPaneOpacity}
              geminiCheckpointingEnabled={geminiCheckpointingEnabled}
              chatContextTurns={chatContextTurns}
              currency={displayCurrency}
              currencyOverestimatePercent={overestimatePercent}
              showRunCompleteSummary={settings?.showRunCompleteSummary}
              closeoutAiSummaryEnabled={settings?.closeoutAiSummaryEnabled}
              composerContinuationAiEnabled={settings?.composerContinuationAiEnabled}
              hostAutoCompactEnabled={settings?.hostAutoCompactEnabled}
              ensembleCollapseOlderRounds={settings?.ensembleCollapseOlderRounds}
              dashboardStatPrefs={settings?.dashboardStatPrefs}
              welcomeHeatmapPrefs={settings?.welcomeHeatmapPrefs}
              providerRunPauses={settings?.providerRunPauses}
              kimiSanitiserEnabled={settings?.kimiSanitiserEnabled ?? false}
              kimiSanitiserCustomKeywords={settings?.kimiSanitiserCustomKeywords ?? ''}
              antigravityEnabled={settings?.antigravityEnabled ?? false}
              antigravityOptInAcceptedAt={settings?.antigravityOptInAcceptedAt ?? null}
              antigravityGeminiApiDisclosureAcceptedAt={
                settings?.antigravityGeminiApiDisclosureAcceptedAt ?? null
              }
              antigravityGeminiApiMonthlySpendCapUsd={
                settings?.antigravityGeminiApiMonthlySpendCapUsd ?? null
              }
              userName={settings?.userName ?? ''}
              claudeBinaryPath={claudeBinaryPath}
              kimiBinaryPath={kimiBinaryPath}
              cliPathDirectories={settings?.cliPathDirectories ?? []}
              ollamaBaseUrl={ollamaBaseUrl}
              ollamaDefaultModel={ollamaDefaultModel}
              auditOrchestration={settings?.auditOrchestration}
              agenticServices={agenticServices}
              nativeSubAgentRequests={settings?.nativeSubAgentRequests ?? 'ask'}
              autoResumeParentOnSubThreadCompletion={autoResumeParentOnSubThreadCompletion}
              agenticWorkspaceGrantCount={agenticWorkspaceGrantCount}
              agenticWorkspaceGrants={agenticWorkspaceGrants}
              activeProvider={currentProvider}
              providerCapabilities={currentProviderCapabilities}
              providerCapabilitiesByProvider={providerCapabilitiesByProvider}
              providerStatusByProvider={agentStatusByProvider}
              mcpStatusByProvider={{
                codex: codexMcpStatus,
                gemini: agentMcpStatusByProvider.gemini,
                claude: agentMcpStatusByProvider.claude,
                kimi: agentMcpStatusByProvider.kimi,
                cursor: agentMcpStatusByProvider.cursor,
                grok: agentMcpStatusByProvider.grok,
                ollama: agentMcpStatusByProvider.ollama,
                pi: agentMcpStatusByProvider.pi,
                mistral: agentMcpStatusByProvider.mistral
              }}
              userMcpServers={settings?.userMcpServers}
              geminiMcpBridgeEnabled={geminiMcpBridgeEnabled}
              codexSandboxFallback={codexSandboxFallback}
              funFxEnabled={appearance.funFxEnabled}
              funFxMode={appearance.funFxMode}
              advancedFx={appearance.advancedFx}
              autoUpdateEnabled={autoUpdateEnabled}
              updateChannel={updateChannel}
              approvalTimeouts={approvalTimeouts}
              auditRetention={settings?.auditRetention}
              auditBundleExportAvailability={{
                workspace: Boolean(currentWorkspace?.id || currentWorkspace?.path),
                chat: Boolean(currentChat?.appChatId),
                run: Boolean(currentRun?.runId)
              }}
              auditBundleVerificationResult={auditBundleVerificationResult}
              managedPolicyStatus={managedPolicyStatus}
              productOperationsStatus={productOperationsStatus}
              codexStatus={codexStatus}
              claudeAuthStatus={claudeAuthStatus}
              kimiAuthStatus={kimiAuthStatus}
              ollamaStatus={agentStatusByProvider.ollama}
              cursorProviderAvailable={cursorProviderAvailable}
              grokProviderAvailable={grokProviderAvailable}
              claudeLoginState={claudeLoginState}
              providerCliUpgradeState={providerCliUpgradeState}
              onImportCodexUsageCredential={() => void handleImportCodexUsageCredential()}
              onClearCodexUsageCredential={() => void handleClearCodexUsageCredential()}
              onTriggerClaudeLogin={() => void handleTriggerClaudeLogin()}
              onStoreClaudeApiKey={(key) => void handleStoreClaudeApiKey(key)}
              onClearClaudeApiKey={() => void handleClearClaudeApiKey()}
              onStoreKimiApiKey={(key) => void handleStoreKimiApiKey(key)}
              onClearKimiApiKey={() => void handleClearKimiApiKey()}
              onProviderUpgrade={(provider) => void handleUpgradeProviderCli(provider)}
              onProviderLogin={(provider) => {
                void handleProviderLogin(provider)
              }}
              onProviderLogout={(provider) => {
                void window.api.openProviderLogoutTerminal(provider).then((r) => {
                  if (!r?.ok) console.warn('[provider sign-out] could not open Terminal:', r?.error)
                })
              }}
              onRefreshProviderStatus={(provider) =>
                void refreshProviderAuthStatus(provider)
              }
              onRemoveAgenticWorkspaceGrant={(provider, workspacePath, service) =>
                void handleRemoveAgenticWorkspaceGrant(provider, workspacePath, service)
              }
              onInstallGeminiMcpBridge={() => void installGeminiMcpBridge()}
              onRefreshGeminiMcpBridgeStatus={() => void refreshGeminiMcpBridgeStatus()}
              onRefreshProviderMcpStatus={(provider) => void refreshProviderMetadata(provider)}
              onRefreshProductOperationsStatus={() => void refreshProductOperationsStatus()}
              onExportProductDiagnostics={() => void exportProductDiagnostics()}
              onExportProductAuditBundle={(scope) => void exportProductAuditBundle(scope)}
              onVerifyProductAuditBundle={() => void verifyProductAuditBundle()}
              onDryRunAuditRetention={() => void dryRunAuditRetention()}
              onPurgeAuditRetention={() => void purgeAuditRetention()}
              onRepairProductInstall={() => void repairProductInstall()}
              onDeleteAllChatHistory={() => handleDeleteAllChatHistory()}
              onChange={handleSettingsChange}
              onClose={() => setShowSettings(false)}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              onSelectWorkspace={handleNavigateToWorkspace}
              onSelectWorkspaceDialog={handleSelectWorkspace}
              onRemoveWorkspace={(workspaceId) => {
                // SettingsPanel's Workspaces tab passes a bare id; the
                // host `handleRemoveWorkspace` expects an event for its
                // sidebar use case (to call stopPropagation on the row
                // click). Synthesize a stub event so the call shape
                // matches.
                const stubEvent = {
                  preventDefault: () => {},
                  stopPropagation: () => {}
                } as unknown as React.MouseEvent<HTMLButtonElement>
                handleRemoveWorkspace(workspaceId, stubEvent)
              }}
              onTogglePinWorkspace={handleTogglePinWorkspace}
              usageSummary={usageSummary}
              usageRecords={usageRecords}
              pinnedMessageGroups={settingsPinnedMessageGroups}
              onOpenPinnedMessage={(chatId, messageId) =>
                void handleOpenPinnedMessageFromSettings(chatId, messageId)
              }
            />
          </div>
        )}

        {!isChatPopoutWindow && !showSettings && workspaceBoardApiReady && (
          <WorkspaceBoardCreatorSheet
            open={showWorkspaceBoardCreatorSheet}
            workspaces={workspaces}
            currentWorkspace={currentWorkspace}
            onCreate={handleCreateWorkspaceBoard}
            onDismiss={() => setWorkspaceBoardCreatorOpen(false)}
          />
        )}

        {!isChatPopoutWindow && !showSettings && workspaceBoardApiReady && activeWorkspaceBoard && (
          <WorkspaceBoardView
            board={activeWorkspaceBoard}
            workspace={activeWorkspaceBoardWorkspace}
            cards={activeWorkspaceBoardCards}
            chats={chats}
            workflows={workflowDefinitions}
            scheduledTasks={scheduledTasks}
            runQueueJobs={runQueueJobs}
            capabilityLedger={capabilityLedgerSnapshot}
            runningChatIds={runningChatIds}
            pendingApprovalsByChatId={pendingAgentApprovalByChatId}
            pendingApprovalQueueByChatId={pendingApprovalQueueByChatId}
            collaboratingChatIds={collaboratingChatIds}
            onAddCard={handleAddWorkspaceBoardCard}
            onUpdateCard={handleUpdateWorkspaceBoardCard}
            onDeleteCard={handleDeleteWorkspaceBoardCard}
            onOpenChat={(chat) => void handleSelectChat(chat)}
            onOpenWorkflow={(workflow) => {
              const workflowChat = chats.find((chat) => chat.appChatId === workflow.template.chatId)
              if (workflowChat) void handleSelectChat(workflowChat)
            }}
            onInspectRun={(runId) => {
              setInspectingRunId(runId)
            }}
          />
        )}

        {!isChatPopoutWindow && !showSettings && activeProjectGraphProjection && (
          <ProjectThreadGraphView
            projection={activeProjectGraphProjection}
            projectName={activeProjectGraphProjection.title}
            onBack={onBackFromProjectGraph}
            onOpenThread={onOpenThreadFromProjectGraph}
            onAddDependency={onAddProjectDependency}
            onRemoveDependency={onRemoveProjectDependency}
          />
        )}

        {isLinkedChatPopout && currentChat && (
          <div
            className="side-chat-floating-actions side-chat-popout-actions"
            role="toolbar"
            aria-label="Side chat actions"
          >
              {chatPopoutParentChat && (
                <button
                  type="button"
                  className="side-chat-action-btn"
                  onClick={() => void handleSelectChat(chatPopoutParentChat)}
                  title="Open the parent chat in this popout"
                  aria-label="Open parent chat"
                >
                  <BackToParentIcon />
                </button>
              )}
              <button
                type="button"
                className="side-chat-action-btn"
                onClick={() => dockChatPopoutWindow('split')}
                title="Dock this linked chat into the main pane split"
                aria-label="Dock as split"
              >
                <SplitChatIcon />
              </button>
              <button
                type="button"
                className="side-chat-action-btn"
                onClick={() => dockChatPopoutWindow('drawer')}
                title="Dock this linked chat into the side drawer"
                aria-label="Dock as drawer"
              >
                <DockDrawerIcon />
              </button>
              {currentChat.parentChatRelation === 'sideChat' && (
                <SideChatAuthorityReturnButton
                  enabled={currentChatSideChatAuthorityReturnEnabled}
                  onToggle={() => void handleToggleSideChatAuthorityReturn(currentChat.appChatId)}
                />
              )}
              {currentChat.parentChatRelation === 'sideChat' && (
                <button
                  type="button"
                  className="side-chat-action-btn danger"
                  onClick={() => void handleEndCurrentLinkedMainChat()}
                  title="End this isolated side chat, cancel queued work, and archive it"
                  aria-label="End side chat"
                >
                  <EndSideChatIcon />
                </button>
              )}
              <button
                type="button"
                className="side-chat-action-btn"
                onClick={() => window.close()}
                title="Close this side chat window"
                aria-label="Close side chat window"
              >
                <XSymbolIcon />
              </button>
          </div>
        )}

        <div
          ref={chatSplitRegionRef}
          className={`chat-split-region ${sidePanelLayoutClass} ${
            showSettings ||
            (workspaceBoardApiReady && Boolean(activeWorkspaceBoard)) ||
            Boolean(activeProjectGraphProjection)
              ? 'chat-split-hidden-for-settings'
              : ''
          }`}
          style={chatSplitStyle}
        >
          <div className="chat-split-main">
            {/* The fog/mist sky warp filter — defined ONCE for the whole region
              * (CSS references it by a fixed id, so it can't be per-instance).
              * Present whenever FX is on so any sky (focused or pane, single or
              * split) can reference it. */}
            {isFxEnabled && <SkyFogFilterDefs />}
            {/* Refractive "liquid glass" displacement filter — also defined ONCE
              * for the whole region (CSS references #tw-glass-refract by a fixed
              * id, so per-pane would collide on the dup-id rule). */}
            {refractionEnabled && <RefractionFilterDefs />}
            <MultiviewPaneGrid
              layout={multiview.layout}
              panes={multiview.panes}
              focusedPaneIndex={multiview.focusedPaneIndex}
              resolvePaneTitle={(paneIndex, pane) => {
                if (pane.mediaRef?.name) return pane.mediaRef.name
                if (pane.canvasId) return 'Canvas preview'
                if (pane.chatId) {
                  const chat =
                    chatByIdRef.current.get(pane.chatId) ||
                    chats.find((candidate) => candidate.appChatId === pane.chatId)
                  return chat?.title || `Pane ${paneIndex + 1}`
                }
                return 'Empty pane'
              }}
              onClosePane={(paneIndex) => {
                // Tear down the embedded canvas (if any) before the pane goes away.
                const canvasId = multiview.panes[paneIndex]?.canvasId
                if (canvasId) void window.api.canvas.close(canvasId)
                multiview.closePane(paneIndex)
              }}
              columnFractions={multiview.tracks.columns}
              rowFractions={multiview.tracks.rows}
              onResizeTrack={multiview.resizeTrack}
              onResetTracks={multiview.resetTrackSizes}
              renderEmptyCell={(emptyPaneIndex) => (
                <div className="multiview-empty-pane" data-pane-index={emptyPaneIndex}>
                  <span className="multiview-empty-pane-label">Select a chat for this pane</span>
                  <CanvasPaneLauncher
                    onOpen={(url) => {
                      if (!currentChatAppChatId) return
                      void window.api.canvas
                        .openEmbedded({ url, chatId: currentChatAppChatId })
                        .then((opened) => {
                          if (opened.ok) multiview.setPaneCanvas(emptyPaneIndex, opened.canvasId)
                        })
                        .catch(() => {})
                    }}
                  />
                </div>
              )}
              renderCanvasCell={(canvasId, paneIndex) => (
                <CanvasPane
                  canvasId={canvasId}
                  onClose={() => {
                    void window.api.canvas.close(canvasId)
                    multiview.setPaneCanvas(paneIndex, null)
                  }}
                />
              )}
              renderMediaCell={(mediaRef, paneIndex) => (
                <MediaPane
                  mediaRef={mediaRef}
                  onClose={() => multiview.setPaneMedia(paneIndex, null)}
                />
              )}
              renderViewerCell={renderMultiviewPaneCell}
              renderFocusedCell={() => {
                if (executionMapProjection) {
                  return (
                    <ExecutionMapView
                      projection={executionMapProjection}
                      selectedStepId={executionMapSelectedStepId}
                      onSelectStep={handleSelectExecutionMapStep}
                      onBack={handleBackFromExecutionMap}
                      onOpenThread={handleOpenExecutionThread}
                      onSaveGraph={handleSaveExecutionGraph}
                    />
                  )
                }
                return (
            <div
              ref={appTranscriptRef}
              className={`app-transcript provider-${currentProvider} ${isCurrentEnsembleChat ? 'chat-kind-ensemble' : ''} ${isCurrentGlobalChat ? 'chat-scope-global' : ''} ${isWelcomeChat ? 'welcome-mode' : ''} ${welcomeFitLevel >= 1 ? 'welcome-notification-hidden-by-fit' : ''} ${welcomeFitLevel >= 2 ? 'welcome-dashboard-hidden-by-fit' : ''} ${welcomeFitLevel >= 3 ? 'welcome-heatmaps-hidden-by-fit' : ''} ${isAdvancedFxActive ? `fx-labs-active fx-intensity-${advancedFxIntensity}` : ''} ${showSettings ? 'transcript-hidden-for-settings' : ''}`}
              style={transcriptStyle}
            >
          {workProjectHeader && !showSettings && (
            <ProjectHomeHeader
              {...workProjectHeader}
              onOpenLibrary={() =>
                handleOpenProjectReferencesLibrary(workProjectHeader.project.id)
              }
            />
          )}
          {chatContextNotice && (
            <div className="chat-context-application-pill" role="status">
              <span>{chatContextNotice.message}</span>
            </div>
          )}
          {!isChatPopoutWindow && (
            <div
              className={`chat-corner-controls chat-corner-controls-left${
                showWorkspaceSidebar ? '' : ' chat-corner-controls-workspace-hidden'
              }`}
            >
              <button
                className="chat-corner-btn"
                type="button"
                onClick={() => setShowWorkspaceSidebar((current) => !current)}
                title={`${showWorkspaceSidebar ? 'Hide' : 'Show'} workspace sidebar`}
                aria-label="Toggle workspace sidebar"
              >
                <SidebarCornerIcon direction="left" isOpen={showWorkspaceSidebar} />
              </button>
              <div className="chat-corner-thread-context">
                <ProviderBrandLogoIcon provider={mainPaneProvider} />
                <span className="chat-corner-thread-title" title={mainPaneThreadTitle}>
                  {mainPaneThreadTitle}
                </span>
                {mainPaneWorkspaceLabel && (
                  <span className="chat-corner-workspace-name" title={mainPaneWorkspaceLabel}>
                    {mainPaneWorkspaceLabel}
                  </span>
                )}
              </div>
              {/* Main-window surface — see humanCollaborationControls above for why
                  this is left-anchored and in-flow rather than its own top-right box. */}
              {humanCollaborationControls}
            </div>
          )}

          {/* Popout-window surface. The left pill above is !isChatPopoutWindow, so
              without this the button would VANISH in popouts — which is where it was
              the only working door before. Floating top-right is safe here precisely
              because MainPaneActionPill is also absent from popouts. */}
          {isChatPopoutWindow && humanCollaborationControls && (
            <div className="human-collaboration-header-floating">
              {humanCollaborationControls}
            </div>
          )}

          {/* Sidebar collapsed → the footer quick controls (Settings /
              Approvals / Shares / Devices) resurface as a bottom-left
              vertical glass pill, so collapsing the sidebar never costs
              access to pending approvals or device state. */}
          {!isChatPopoutWindow && !showWorkspaceSidebar && (
            <CollapsedSidebarCornerPill
              chats={chats}
              onSelectChat={handleSelectChat}
              quickSettings={{
                composerStyle: appearance.composerStyle,
                themeAccentStyle: appearance.themeAccentStyle,
                themeAppearance: appearance.themeAppearance,
                toolIconAccent: appearance.toolIconAccent,
                sidebarOpacity: appearance.sidebarOpacity,
                mainPaneOpacity: appearance.mainPaneOpacity
              }}
              onAppearanceQuickChange={handleSettingsChange}
              onOpenSettings={() => setShowSettings(true)}
              onOpenSettingsTab={(tab) => {
                setSettingsActiveTab(tab)
                setShowSettings(true)
              }}
              onOpenWorkspacePopout={openWorkspacePopoutWindow}
              canOpenWorkspacePopout={canOpenWorkspacePopout}
              onQuitApp={() => {
                void window.api.quitApp?.()
              }}
              pendingAgentApprovalByChatId={pendingAgentApprovalByChatId}
              pendingApprovalQueueByChatId={pendingApprovalQueueByChatId}
              onRespondAgentApproval={handleAgentApprovalAction}
              pendingAgentQuestionsByChatId={pendingAgentQuestionsByChatId}
              onAnswerAgentQuestion={handleAgentQuestionSubmit}
              onDismissAgentQuestion={handleAgentQuestionDismiss}
              collaborationShares={humanCollaborationShares}
              collaboratingChatIds={collaboratingChatIds}
              hasConnectedCollaborator={connectedCollaborationChatIds.size > 0}
              onRevokeShare={handleRevokeHumanShare}
            />
          )}

          {!isChatPopoutWindow && (
            <>
              <MainPaneActionPill
                fxEnabled={isFxEnabled}
                skyEnabled={focusedPaneSkyEnabled}
                ghostEnabled={focusedPaneGhostEnabled}
                weatherDescription={hostWeather?.description}
                onToggleSky={() => {
                  if (isMultiviewSplit) {
                    multiview.setPaneFxFlag(
                      multiview.focusedPaneIndex,
                      'sky',
                      !focusedPaneSkyEnabled
                    )
                  } else {
                    setShowSkyVisualFx((current) => !current)
                  }
                }}
                onToggleGhost={() => {
                  if (isMultiviewSplit) {
                    multiview.setPaneFxFlag(
                      multiview.focusedPaneIndex,
                      'ghost',
                      !focusedPaneGhostEnabled
                    )
                  } else {
                    setShowGhostCompanion((current) => !current)
                  }
                }}
                changelogOpen={showChangelogSheet}
                firstLaunchOpen={showFirstLaunchSheet}
                bugReportOpen={showBugReportSheet}
                onToggleChangelog={handleOpenChangelogSheet}
                onToggleFirstLaunch={() => setShowFirstLaunchSheet((current) => !current)}
                onToggleBugReport={() => setShowBugReportSheet((current) => !current)}
                workspaceStats={mainPaneWorkspaceStats}
                popoutMenuOpen={popoutMenuOpen}
                setPopoutMenuOpen={setPopoutMenuOpen}
                popoutMenuRef={popoutMenuRef}
                canOpenWorkspacePopout={Boolean(canOpenWorkspacePopout)}
                hasCurrentChat={Boolean(currentChat)}
                onOpenWorkbench={() => {
                  setPopoutMenuOpen(false)
                  openWorkspacePopoutWindow('workbench')
                }}
                onOpenDiffStudio={() => {
                  setPopoutMenuOpen(false)
                  openWorkspacePopoutWindow('diff-studio')
                }}
                onOpenFileEditor={() => {
                  setPopoutMenuOpen(false)
                  openWorkspacePopoutWindow('file-editor')
                }}
                onOpenChatPopout={() => {
                  setPopoutMenuOpen(false)
                  openChatPopoutWindow()
                }}
                runTitle={launchPreviewActionTitle(currentPreviewTargets, hasWorkspaceContext)}
                runMenuOpen={currentPreviewMenuOpen}
                runHasMenu={currentPreviewTargets.length > 1}
                runDisabled={currentPreviewTargets.length === 0}
                runMenu={
                  currentChat
                    ? renderPreviewTargetMenu(
                        currentPreviewTargets,
                        multiview.focusedPaneId,
                        currentChat.appChatId,
                        currentChat
                      )
                    : null
                }
                runError={renderPreviewLaunchError(currentChat?.appChatId)}
                onRun={() => {
                  if (!currentChat) return
                  if (currentPreviewTargets.length === 1) {
                    const target = currentPreviewTargets[0]
                    if (target) void runPreviewTargetAction(target, currentChat)
                    return
                  }
                  if (currentPreviewTargets.length > 1) {
                    const paneId = multiview.focusedPaneId
                    if (!paneId) return
                    setPreviewMenuTarget((current) =>
                      current?.paneId === paneId && current.chatId === currentChat.appChatId
                        ? null
                        : { paneId, chatId: currentChat.appChatId }
                    )
                  }
                }}
                homeOpen={activeRightDockTab === 'home'}
                onToggleHome={() => toggleRightDockPanel('home')}
              />
            </>
          )}

          {/*
            1.0.4 — "↓ N new messages" jump-to-latest pill (Slack/
            Discord/YouTube pattern). The 1.0.4 race-window fix
            (commit ce130ed) stopped auto-scroll from fighting the
            user mid-read, so the user could scroll up freely while
            messages were streaming — but they had no visible signal
            that new content was arriving below. The pill makes that
            *absence* of auto-scroll visible.

            Visibility, unread count, click handling, and `End`-key
            handling are owned by `useTranscriptScrollState` so the
            smooth-scroll, autoFollow re-engage, and count clear stay
            in lockstep regardless of entry point.
          */}
          {showJumpToLatestPill && (
            <button
              type="button"
              className={`transcript-jump-to-latest-pill provider-${currentProvider}`}
              onClick={handleJumpToLatest}
              aria-label={
                unreadFromBottomCount > 0
                  ? `Jump to latest — ${unreadFromBottomCount} new ${unreadFromBottomCount === 1 ? 'message' : 'messages'}`
                  : 'Jump to latest — response streaming below'
              }
              title={
                unreadFromBottomCount > 0
                  ? `Jump to latest (End)\n${unreadFromBottomCount} new ${unreadFromBottomCount === 1 ? 'message' : 'messages'}`
                  : 'Jump to latest (End)\nResponse streaming below'
              }
            >
              <span aria-hidden="true" className="transcript-jump-to-latest-arrow">
                ↓
              </span>
              <span className="transcript-jump-to-latest-text">
                {/* Streaming variant: text grows inside ONE bubble, so the
                    message-count unread number stays 0 — label the affordance
                    itself rather than showing "0 new messages". */}
                {unreadFromBottomCount > 0 ? (
                  <>
                    <DigitOdometer
                      value={unreadFromBottomCount}
                      ariaLabel={`${unreadFromBottomCount} new ${
                        unreadFromBottomCount === 1 ? 'message' : 'messages'
                      }`}
                      className="transcript-jump-to-latest-count"
                    />
                    <span aria-hidden>
                      {' '}
                      new {unreadFromBottomCount === 1 ? 'message' : 'messages'}
                    </span>
                  </>
                ) : (
                  'Jump to latest'
                )}
              </span>
            </button>
          )}

          <ChatMediaPreviewOverlay
            mediaRef={previewChatMediaRef}
            workspacePath={currentWorkspace?.path}
            onClose={() => setPreviewChatMediaRef(null)}
            onDetachToPane={openMediaPane}
          />

          {/* AMBIENT FX (sky weather + living workspace) — rendered INLINE in the
            * focused pane, gated by the FOCUSED pane's EFFECTIVE flags (its
            * per-pane override, else the global). In a SPLIT every OTHER pane
            * paints its own sky/living inline too (via ChatViewPane), so the FX
            * are per-pane and show at any opacity — no shared backdrop. In single
            * layout `focusedPaneIndex` is the only pane and there are no overrides,
            * so the focused effective flags collapse to the globals. Per-pane
            * living-workspace follows the (effective) sky toggle. The per-chat
            * AgentAuraLayer + RunDataVizLayer stay focused-inline (the aura is also
            * rendered per-pane by ChatViewPane — it's a per-CHAT provider signal). */}
          {focusedPaneLivingWorkspaceEnabled && (
            <LivingWorkspaceLayer weather={hostWeather} intensity={advancedFxIntensity} />
          )}
          {showAgentAuraFx && (
            <AgentAuraLayer
              provider={auraProviderKey}
              status={runFxStatus}
              intensity={advancedFxIntensity}
              hasHandoff={hasCurrentHandoffDraft}
            />
          )}
          {showRunDataVizFx && (
            <RunDataVizLayer
              provider={currentProvider}
              intensity={advancedFxIntensity}
              queueCount={queuedRunQueueCount}
              rawEventCount={rawLogs.length}
              approvalWaiting={Boolean(pendingAgentApproval)}
              status={runFxStatus}
            />
          )}
          {focusedPaneSkyEnabled && <SkyWeatherVisual weather={hostWeather} />}

          {currentProvider === 'gemini' && isOldVersion && (
            <div className="version-warning">
              <strong>Warning:</strong> Gemini CLI version ({geminiVersion}) appears to be older
              than 0.39.1. Headless workspace-trust behavior had recent security hardening. Please
              upgrade Gemini CLI before using this app on real repositories.
            </div>
          )}

          {visibleAuditRunNotice && (
            <AuditRunNotice
              title={visibleAuditRunNotice.title}
              message={visibleAuditRunNotice.message}
              onDismiss={handleDismissAuditRunNotice}
            />
          )}

          {visibleAuditRun && (
            <AuditRunCard
              run={visibleAuditRun}
              onCancel={handleCancelAuditRun}
              onDismiss={handleDismissAuditRun}
            />
          )}

          {/*
           * Keep a hard remount only at the welcome/transcript boundary.
           * Keying by chat id made every thread switch discard the
           * transcript virtualization state and remeasure from cold, which
           * was visible as a beachball/lag spike on large histories.
           */}
          <>
              {/*
                EnsembleParticipantStrip retired in 1.0.3 — its
                contents (per-participant status pills) merged into
                the new EnsembleParticipantsAboveRow that sits in
                the composer above-row stack, alongside the chip
                flyout that replaced the EnsembleSetupSheet modal.
              */}
              <ThreadSearchBar
                open={threadSearchVisible}
                query={threadSearchQuery}
                matchCount={threadSearchMatches.length}
                activeMatchNumber={
                  threadSearchMatches.length > 0 ? activeThreadSearchIndex + 1 : 0
                }
                shortcutHint={threadSearchShortcutHint}
                focusRequestId={threadSearchFocusRequestId}
                onQueryChange={(query) => {
                  setThreadSearchQuery(query)
                  setThreadSearchActiveIndex(0)
                }}
                onNext={() => selectThreadSearchMatch(activeThreadSearchIndex + 1)}
                onPrevious={() => selectThreadSearchMatch(activeThreadSearchIndex - 1)}
                onClose={closeThreadSearch}
              />
              <SubThreadStatusTicker
                currentChat={currentChat}
                chats={chats}
                runningChatIds={runningChatIdsArray}
                onOpenSubThread={handleOpenCockpitThread}
              />
              <TranscriptPanel
                key={isWelcomeChat ? 'welcome' : 'transcript'}
                scrollRef={transcriptScrollRef}
                contentRef={transcriptContentRef}
                externalRestoreAnchorMessageId={mainExternalRestoreAnchorMessageId}
                endRef={logsEndRef}
                messages={transcriptMessages}
                isWelcomeChat={isWelcomeChat}
                isThinking={effectiveIsThinking}
                pendingPlanChoice={pendingPlanChoice}
                pendingAgentQuestions={pendingAgentQuestions}
                onAgentQuestionSubmit={handleAgentQuestionSubmit}
                onAgentQuestionDismiss={handleAgentQuestionDismiss}
                runCompleteNotice={visibleRunCompleteNotice}
                runCompleteDurationText={runCompleteDurationText}
                currentChat={currentChat}
                isGlobal={isGlobalChat(currentChat)}
                currentRun={currentRun}
                currentWorkspacePath={currentWorkspace?.path}
                currentProviderLabel={currentProviderLabel}
                currentProvider={currentProvider}
                thinkingProviderLabel={thinkingProviderLabel}
                thinkingProvider={thinkingProvider}
                thinkingProviderClass={thinkingProviderClass}
                thinkingModelBadge={thinkingModelBadge}
                displayFileChangeSummaries={displayFileChangeSummaries}
                roundFileChangeSummaries={roundFileChangeSummaries}
                fileChangeSummaryText={fileChangeSummaryText}
                fileChangeShouldShowStats={fileChangeShouldShowStats}
                fileChangeDisplayAdds={fileChangeDisplayAdds}
                fileChangeDisplayDels={fileChangeDisplayDels}
                chats={chats}
                runningChatIds={runningChatIdsArray}
                onPlanChoiceSubmit={handlePlanChoiceSubmit}
                pendingProposedPlan={pendingProposedPlan}
                onProposedPlanApprove={handleProposedPlanApprove}
                onProposedPlanDismiss={handleProposedPlanDismiss}
                onProposedPlanCustom={handleProposedPlanCustom}
                onOpenSubThread={handleOpenCockpitThread}
                onOpenSubThreadInSidePanel={handleOpenLinkedChatInSidePanelById}
                onOpenFileChangeInWorkbench={openFileChangeInWorkbench}
                onInspectRun={handleTranscriptInspectRun}
                onOpenSideChatFromRun={
                  canCreateSideChatFromCurrent ? handleOpenSideChatFromRunResult : undefined
                }
                compactDensity={appearance.compactDensity}
                liveActivityViewport={appearance.liveActivityViewport}
                fanoutLaneLayout={appearance.fanoutLaneLayout}
                onCopyMessage={handleCopyMessage}
                onAddMessageToPrompt={
                  currentChatAppChatId ? handleTranscriptAddMessageToPrompt : undefined
                }
                onDeleteMessage={handleDeleteMessage}
                onTogglePinMessage={handleTranscriptTogglePinMessage}
                onMessageFeedback={handleTranscriptMessageFeedback}
                onPromoteCollaboratorComment={handleTranscriptPromoteCollaboratorComment}
                onMessageSelectionCandidate={
                  canCreateSideChatFromCurrent ? handleMessageSelectionCandidate : undefined
                }
                onPreviewImage={setPreviewChatMediaRef}
                onDetachToPane={openMediaPane}
                onOpenSideChatFromMessage={
                  canCreateSideChatFromCurrent ? handleOpenSideChatFromMessage : undefined
                }
                sideChatSeedMessageId={sideChatSeedMessageId}
                jumpToMessageRequest={
                  transcriptJumpRequest?.chatId === currentChat?.appChatId
                    ? transcriptJumpRequest
                    : null
                }
                onManualTranscriptJump={beginManualMainTranscriptJump}
                onJumpToLatest={handleJumpToLatest}
                copiedId={copiedId}
                copy={copy}
                autoFollowRef={autoFollowRef}
                getUserScrollGestureLive={getMainTranscriptUserScrollGestureLive}
                onProgrammaticScrollWrite={markMainTranscriptProgrammaticScroll}
                currency={displayCurrency}
                currencyOverestimatePercent={overestimatePercent}
                showRunCompleteSummary={settings?.showRunCompleteSummary}
                collapseOlderRounds={settings?.ensembleCollapseOlderRounds}
                providerRates={providerRates}
              />
          </>

          {shouldShowWelcomeUsageDashboard && welcomeDashboardCardEnabled && (
            <div className="welcome-usage-region welcome-usage-region-small" ref={welcomeDashboardRegionRef}>
              <WelcomeUsageDashboard
                data={welcomeUsageDashboardData}
                /*
                  1.0.5-EW49 — Thread the user's currency + EW34
                  overestimate bias + EW49 per-stat visibility map
                  into the dashboard so the Total cost chip
                  formats correctly and hidden chips drop from
                  the dense grid. The global reset timestamp is
                  applied earlier (passed to
                  buildWelcomeUsageDashboardData above).
                */
                displayCurrency={displayCurrency}
                overestimatePercent={overestimatePercent}
                dashboardStatVisibility={settings?.dashboardStatPrefs?.visibility}
                /*
                  1.0.5-EW51 — Workspaces tab on/off + max card
                  count. Both come from
                  AppSettings.dashboardStatPrefs.
                */
                workspacesTabEnabled={settings?.dashboardStatPrefs?.workspacesTabEnabled}
                workspacesShown={settings?.dashboardStatPrefs?.workspacesShown}
                /*
                  1.0.5-EW52 — Providers tab on/off + auto-cycle
                  cadence (seconds; 0 disables). Both come from
                  AppSettings.dashboardStatPrefs. The dashboard
                  rotates through enabled tabs only while a
                  welcome screen is mounted — the setInterval
                  lives inside <WelcomeUsageDashboard>, so it
                  unmounts automatically when the welcome region
                  disappears.
                */
                providersTabEnabled={settings?.dashboardStatPrefs?.providersTabEnabled}
                autoCycleSeconds={settings?.dashboardStatPrefs?.autoCycleSeconds}
              />
            </div>
          )}

          {/* Reserve the dashboard's fixed height during the first usage fetch
              so the greeting + composer below don't jump downward when the
              dashboard mounts a moment after launch. Only shown before the
              fetch resolves and only when the dashboard would plausibly
              render (welcome screen + card enabled). Collapses harmlessly for
              brand-new accounts that turn out to have no history. */}
          {isWelcomeChat && !isCurrentGlobalChat && welcomeDashboardCardEnabled && !usageInitialized && (
              <div
                className="welcome-usage-region welcome-usage-region-small welcome-usage-region-reserved"
                ref={welcomeDashboardRegionRef}
                aria-hidden
              />
            )}

          <Composer {...composerCtx} />
            </div>
                )
              }}
            />
          </div>

          {dockPresence.mounted && (
            <>
            <div
              className={`panel-resize-handle right-dock-resize-handle${
                dockPresence.className ? ` ${dockPresence.className}` : ''
              }`}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize right dock"
              aria-valuemin={MIN_RIGHT_PANEL_WIDTH}
              aria-valuemax={MAX_RIGHT_PANEL_WIDTH}
              aria-valuenow={effectiveInspectorWidth}
              onMouseDown={startRightPanelResize}
              onKeyDown={handleRightPanelResizeKeyDown}
              title="Resize right dock"
            />
            <aside
              className={`right-dock${dockPresence.className ? ` ${dockPresence.className}` : ''}`}
              style={rightDockStyle}
              aria-label="Right dock"
            >
              <RightDockSurfaceSwitcher
                tabs={dockTabDefs}
                activeTab={activeRightDockTab}
                onActivate={activateRightDockTab}
                inspectorTabs={INSPECTOR_TAB_META}
                activeInspectorTab={rightTab}
                onSelectInspectorTab={(id) => {
                  setRightTab(id as Parameters<typeof setRightTab>[0])
                  activateRightDockTab('inspector')
                }}
                onClose={() => {
                  if (activeRightDockTab === 'chat') hideSideChatPane()
                  else closeRightDockPanel(activeRightDockTab)
                }}
              />
              <div className="right-dock-body">
                {activeRightDockTab === 'home' && (
                  <RightDockHome
                    mediaCount={currentChatMediaRefs.length}
                    pinnedCount={currentPinnedMessages.length}
                    threadMessageCount={threadMessageInbox.summary.pendingCount}
                    hasCurrentChat={Boolean(currentChat)}
                    hasWorkspaceContext={hasWorkspaceContext}
                    onOpenSurface={(surface) => {
                      if (surface === 'chat') {
                        void openCurrentSideChatPresentation('split')
                        return
                      }
                      activateRightDockTab(surface)
                    }}
                    onOpenInspector={(destination) => {
                      setRightTab(destination)
                      activateRightDockTab('inspector')
                    }}
                  />
                )}

                {activeRightDockTab === 'chat' && sideChat && (
                  <div className="right-dock-side-chat">
              <aside
                ref={sidePaneRef}
                className={`side-chat-pane app-transcript provider-${sideProvider} ${
                  sideChat.chatKind === 'ensemble' ? 'chat-kind-ensemble' : ''
                } ${sidePanelAgentIdentity ? 'has-linked-agent-identity' : ''}`}
                style={
                  sidePanelAgentIdentity
                    ? ({ '--agent-rim': sidePanelAgentIdentity.accent } as CSSProperties)
                    : undefined
                }
              aria-label="Linked chat"
              >
            <div
              className="side-chat-floating-actions side-chat-pane-actions"
              role="toolbar"
              aria-label="Side chat actions"
            >
                {sidePanelParentChat && (
                  <button
                    type="button"
                    className="side-chat-action-btn"
                    onClick={handleReturnToSideChatParent}
                    title="Close this side view and return focus to the parent chat"
                    aria-label="Back to parent"
                  >
                    <BackToParentIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="side-chat-action-btn"
                  onClick={() => popOutLinkedChat(sideChat)}
                  title="Pop out this linked chat"
                  aria-label="Pop out linked chat"
                >
                  <ChatPopoutIcon />
                </button>
                <button
                  type="button"
                  className="side-chat-action-btn"
                  onClick={() => void openLinkedChatAsMain(sideChat)}
                  title="Open linked chat as the main thread"
                  aria-label="Open as main"
                >
                  <LinkCircleSymbolIcon />
                </button>
                {sidePanelRelation === 'sideChat' && (
                  <SideChatAuthorityReturnButton
                    enabled={sideChatAuthorityReturnEnabled}
                    onToggle={() => void handleToggleSideChatAuthorityReturn()}
                  />
                )}
                {sidePanelRelation === 'sideChat' && (
                  <button
                    type="button"
                    className="side-chat-action-btn danger"
                    onClick={() => void handleEndSidePanelChat()}
                    title="End this isolated side chat, cancel queued work, and archive it"
                    aria-label="End side chat"
                  >
                    <EndSideChatIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="side-chat-action-btn"
                  onClick={hideSideChatPane}
                  title="Close side view; linked chat keeps running"
                  aria-label="Close side view"
                >
                  <XSymbolIcon />
                </button>
            </div>
            {sideChatIsWelcome && (
              <div className="side-chat-welcome" aria-label="Linked chat welcome">
                <h2 className="side-chat-welcome-line">
                  <span>New</span>
                  {selectedSideChatTypeOption ? (
                    <details className="side-chat-type-picker">
                      <summary title="Choose side chat type">
                        {selectedSideChatTypeOption.agentIdentity && (
                          <AgentIdentityIcon
                            name={selectedSideChatTypeOption.agentIdentity.key}
                            color={selectedSideChatTypeOption.agentIdentity.accent}
                            size={18}
                            className="linked-chat-agent-identicon"
                            title={selectedSideChatTypeOption.agentIdentity.name}
                          />
                        )}
                        <span>{selectedSideChatTypeOption.label}</span>
                      </summary>
                      <div className="side-chat-type-picker-menu" role="listbox">
                        {sideChatTypePickerOptions.map((option) => {
                          const selected = option.id === selectedSideChatTypeOption.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              disabled={selected}
                              onClick={(event) => {
                                event.currentTarget.closest('details')?.removeAttribute('open')
                                handleSelectSideChatTypeOption(option)
                              }}
                            >
                              {option.agentIdentity && (
                                <AgentIdentityIcon
                                  name={option.agentIdentity.key}
                                  color={option.agentIdentity.accent}
                                  size={20}
                                  className="linked-chat-agent-identicon"
                                  title={option.agentIdentity.name}
                                />
                              )}
                              <span className="side-chat-type-picker-option-copy">
                                <strong>{option.label}</strong>
                                <small>{option.description}</small>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </details>
                  ) : (
                    <span className="side-chat-type-picker-static">Side Chat</span>
                  )}
                  <span>in</span>
                  <span className="side-chat-welcome-workspace" title={sideChatWelcomeWorkspaceLabel}>
                    {sideChatWelcomeWorkspaceLabel}
                  </span>
                  <span aria-hidden>:</span>
                  <span className="side-chat-welcome-thread" title={sideChatWelcomeThreadLabel}>
                    {sideChatWelcomeThreadLabel}
                  </span>
                </h2>
              </div>
            )}
            <SubThreadStatusTicker
              currentChat={sideChat}
              chats={chats}
              runningChatIds={runningChatIdsArray}
              onOpenSubThread={handleOpenCockpitThread}
            />
            <TranscriptPanel
              key={`side-${sideChat.appChatId}`}
              scrollRef={sideTranscriptScrollRef}
              contentRef={sideTranscriptContentRef}
              externalRestoreAnchorMessageId={sideExternalRestoreAnchorMessageId}
              endRef={sideLogsEndRef}
              messages={sideChat.messages || EMPTY_CHAT_MESSAGES}
              isWelcomeChat={sideChatIsWelcome}
              isThinking={isSideChatRunning}
              pendingPlanChoice={null}
              pendingAgentQuestions={
                pendingAgentQuestionsByChatId?.[sideChat.appChatId] || EMPTY_AGENT_QUESTION_QUEUE
              }
              onAgentQuestionSubmit={NOOP_AGENT_QUESTION_SUBMIT}
              onAgentQuestionDismiss={NOOP_MESSAGE_ACTION}
              runCompleteNotice={sideRunCompleteNotice}
              runCompleteDurationText={null}
              currentChat={sideChat}
              isGlobal={isGlobalChat(sideChat)}
              currentRun={sideRun}
              currentWorkspacePath={sideWorkspace?.path}
              currentProviderLabel={getProviderLabel(sideProvider)}
              currentProvider={sideProvider}
              thinkingProviderLabel={sideThinkingProviderLabel}
              thinkingProvider={sideThinkingProvider}
              thinkingProviderClass={sideThinkingProviderClass}
              thinkingModelBadge={sideThinkingModelBadge}
              displayFileChangeSummaries={EMPTY_TRANSCRIPT_FILE_SUMMARIES}
              fileChangeSummaryText=""
              fileChangeShouldShowStats={false}
              fileChangeDisplayAdds={0}
              fileChangeDisplayDels={0}
              chats={chats}
              runningChatIds={runningChatIdsArray}
              onPlanChoiceSubmit={NOOP_PLAN_CHOICE_SUBMIT}
              pendingProposedPlan={null}
              onProposedPlanApprove={NOOP_MESSAGE_ACTION}
              onProposedPlanDismiss={NOOP_MESSAGE_ACTION}
              onProposedPlanCustom={NOOP_PROPOSED_PLAN_CUSTOM}
              onOpenSubThread={handleOpenCockpitThread}
              onOpenSubThreadInSidePanel={handleOpenLinkedChatInSidePanelById}
              onInspectRun={handleSideTranscriptInspectRun}
              compactDensity={appearance.compactDensity}
              liveActivityViewport={appearance.liveActivityViewport}
              fanoutLaneLayout={appearance.fanoutLaneLayout}
              onCopyMessage={handleCopyMessage}
              onAddMessageToPrompt={handleSideTranscriptAddMessageToPrompt}
              onDeleteMessage={handleSideTranscriptDeleteMessage}
              onTogglePinMessage={handleSideTranscriptTogglePinMessage}
              onMessageFeedback={handleSideTranscriptMessageFeedback}
              onPromoteCollaboratorComment={handleSideTranscriptPromoteCollaboratorComment}
              onPreviewImage={setPreviewChatMediaRef}
              onDetachToPane={openMediaPane}
              jumpToMessageRequest={
                transcriptJumpRequest?.chatId === sideChat.appChatId ? transcriptJumpRequest : null
              }
              onManualTranscriptJump={beginManualSideTranscriptJump}
              onProgrammaticScrollWrite={markSideTranscriptProgrammaticScroll}
              getUserScrollGestureLive={getSideTranscriptUserScrollGestureLive}
              copiedId={copiedId}
              copy={copy}
              autoFollowRef={sideAutoFollowRef}
              currency={displayCurrency}
              currencyOverestimatePercent={overestimatePercent}
              showRunCompleteSummary={settings?.showRunCompleteSummary}
              collapseOlderRounds={settings?.ensembleCollapseOlderRounds}
              providerRates={providerRates}
            />
            {sideComposerCtx && <Composer {...sideComposerCtx} />}
              </aside>
                  </div>
                )}

                {activeRightDockTab === 'run' && (
                  <RunRailPanel
                    lanes={runLanes}
                    handoffCards={handoffCards}
                    chats={chats}
                    currentChat={currentChat}
                    currentRun={currentRun}
                    selectedRunId={inspectingRunId}
                    onSelectRun={setInspectingRunId}
                    onOpenThread={handleOpenCockpitThread}
                    onCancelRun={handleCancelRunLane}
                    onRetryRun={handleRetryRunLane}
                    onDuplicateRun={handleDuplicateRunLane}
                    onCreateHandoff={handleCreateHandoffFromLane}
                    onDispatchHandoff={handleDispatchHandoff}
                    onArchiveHandoff={handleArchiveHandoff}
                    onPersistAnalysis={handlePersistRunAnalysis}
                  />
                )}

                {activeRightDockTab === 'files' && showFileEditor && hasWorkspaceContext && (
                  <FileEditorPanel
                    workspacePath={currentWorkspace?.path}
                    width={appearance.inspectorWidth}
                    onOpenOfficeDocument={onOpenOfficeDocument}
                  />
                )}

                {activeRightDockTab === 'office' && showOfficeSuite && hasWorkspaceContext && (
                  <OfficeSuitePanel
                    workspacePath={currentWorkspace?.path}
                    width={appearance.inspectorWidth}
                    openRequest={officeOpenRequest}
                    chatId={currentChat?.appChatId}
                    onRequestExternalAccess={onRequestOfficeExternalAccess}
                  />
                )}

                {activeRightDockTab === 'appdrive' &&
                  isAppDriveDockPanelOpen &&
                  appDriveDockStatus && (
                    <AppDriveDockPanel
                      status={appDriveDockStatus}
                      onPause={handleAppDrivePause}
                      onResume={handleAppDriveResume}
                      onTakeOver={handleAppDriveTakeOver}
                      onStop={handleAppDriveStop}
                    />
                  )}

                {activeRightDockTab === 'canvas' && isCanvasDockPanelOpen && currentChat && (
                  <CanvasDockPanel chatId={currentChat.appChatId} />
                )}

                {activeRightDockTab === 'candidates' &&
                  isFanoutCandidatesPanelOpen &&
                  currentChat && (
                    <FanoutCandidatesPanel
                      key={currentChat.appChatId}
                      chatId={currentChat.appChatId}
                      workspacePath={currentWorkspace?.path}
                    />
                  )}

                {activeRightDockTab === 'peers' && isThreadMessagePanelOpen && currentChat && (
                  <ThreadMessageDockPanel
                    key={currentChat.appChatId}
                    chatId={currentChat.appChatId}
                    snapshot={threadMessageInbox}
                    onSent={onThreadMessageSent}
                  />
                )}

                {activeRightDockTab === 'media' && isChatMediaPanelOpen && (
                  <ChatMediaDockPanel
                    refs={currentChatMediaRefs}
                    workspacePath={currentWorkspace?.path}
                    onClose={() => setChatMediaPanelOpenPreservingTranscript(false)}
                    onPreviewImage={setPreviewChatMediaRef}
                    onDetachToPane={openMediaPane}
                    promoteToProjectLibrary={chatMediaPromoteTarget}
                  />
                )}

                {activeRightDockTab === 'references' && isProjectReferencesPanelOpen && (
                  activeWorkProjectId ? (
                    <ProjectReferencesDockPanel
                      key={activeWorkProjectId}
                      projectId={activeWorkProjectId}
                      chatId={currentChat?.appChatId}
                      workspacePath={currentWorkspace?.path}
                      showCloseButton={!isWorkRouteReferencesPinned}
                      onClose={() => closeRightDockPanel('references')}
                      resolveOfficeTarget={(locator) => {
                        // Reference locators are absolute. Inside the bound
                        // workspace they open by relative path; outside it
                        // they open through the chat's access grants.
                        if (!isOfficeDocumentPath(locator)) return null
                        const workspaceRoot = currentWorkspace?.path
                        const relative = workspaceRoot
                          ? officeWorkspaceRelativePath(workspaceRoot, locator)
                          : null
                        if (relative) return { path: relative, external: false }
                        return currentChat?.appChatId ? { path: locator, external: true } : null
                      }}
                      onOpenInOffice={onOpenOfficeDocument}
                    />
                  ) : (
                    <WorkProjectReferencesEmptyShell />
                  )
                )}

                {activeRightDockTab === 'pins' && isPinnedMessagesPanelOpen && (
                  <PinnedMessagesPanel
                    chat={currentChat}
                    blackboardEntries={currentBlackboardEntries}
                    messages={currentPinnedMessages}
                    notes={currentChat?.pinnedNotes || ''}
                    onNotesChange={(notes) =>
                      updatePinnedNotesForChat(currentChat?.appChatId, notes)
                    }
                    onCopyMessage={handleCopyMessage}
                    onJumpToMessage={(messageId) =>
                      jumpToTranscriptMessage(currentChat?.appChatId, messageId)
                    }
                    onUnpinMessage={(messageId) => togglePinMessageInChat(currentChat, messageId)}
                    onAddPinnedMessageToWorkspaceBoard={
                      workspaceBoardApiReady ? handleAddPinnedMessageToWorkspaceBoard : undefined
                    }
                  />
                )}

                {activeRightDockTab === 'terminal' && isTerminalDockAvailable && (
                  <div className="workspace-terminal-split right-dock-terminal" role="region" aria-label="Gemini terminal output">
                    <div className="gemini-terminal-header">
                      <div className="gemini-terminal-title">
                        <AppleTerminalIcon />
                        <span>Gemini Terminal</span>
                        <span className="gemini-terminal-status">{geminiTerminalStatusLabel}</span>
                      </div>
                      <div className="gemini-terminal-actions">
                        <button
                          type="button"
                          className="gemini-terminal-action"
                          onClick={() =>
                            setThreadRawLogs(currentChat?.appChatId || currentChatIdRef.current, [])
                          }
                          title="Clear Gemini terminal output"
                        >
                          Clear
                        </button>
                        <button
                          type="button"
                          className="gemini-terminal-action"
                          onClick={() => setShowGeminiTerminal(false)}
                          title="Close Gemini terminal"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    <div className="gemini-terminal-body">
                      {visibleGeminiTerminalLogs.length > 0 ? (
                        visibleGeminiTerminalLogs.map((entry, index) => (
                          <div
                            key={`${index}-${entry.type}`}
                            className={`gemini-terminal-line terminal-${entry.type}`}
                          >
                            <span className="gemini-terminal-prefix">{entry.type}</span>
                            <span className="gemini-terminal-text">{entry.content}</span>
                          </div>
                        ))
                      ) : (
                        <div className="gemini-terminal-empty">Awaiting Gemini terminal output.</div>
                      )}
                      <div ref={geminiTerminalEndRef} />
                    </div>
                    <form className="gemini-terminal-input-row" onSubmit={handleGeminiTerminalSubmit}>
                      <span className="gemini-terminal-prompt">$</span>
                      <input
                        value={geminiTerminalInput}
                        onChange={(event) => setGeminiTerminalInput(event.target.value)}
                        placeholder="Type input for the active Gemini run/session..."
                        spellCheck={false}
                      />
                      <button type="submit" disabled={!geminiTerminalInput.trim()}>
                        Send
                      </button>
                    </form>
                  </div>
                )}

                {activeRightDockTab === 'inspector' && appearance.showInspector && (
            <Inspector
              rightTab={rightTab}
              activeDiff={activeDiff}
              refreshDiff={refreshDiff}
              currentWorkspace={currentWorkspace}
              diffView={diffView}
              setDiffView={setDiffView}
              runDiff={runDiff}
              workspaceRunDiffByPath={currentRun?.runDiffByPath}
              diffRefreshStatus={diffRefreshStatus}
              rawLogs={rawLogs}
              rawFilter={rawFilter}
              setRawFilter={setRawFilter}
              setRawLogs={(logs) =>
                setThreadRawLogs(
                  currentChat?.appChatId || currentChatIdRef.current,
                  logs as RawLogEntry[]
                )
              }
              rawLogsEndRef={rawLogsEndRef}
              geminiVersion={geminiVersion}
              isOldVersion={isOldVersion}
              trustResult={trustResult}
              sessionTrust={sessionTrust}
              setSessionTrust={setSessionTrust}
              showTerminal={showTerminal}
              setShowTerminal={setShowTerminal}
              workspacePath={currentGeminiWorktree?.effectivePath || currentWorkspace?.path}
              provider={currentProvider}
              approvalMode={approvalMode}
              codexStatus={currentAgentStatus}
              codexModels={currentProvider === 'codex' ? codexModels : currentProviderModelOptions}
              codexMcpStatus={currentAgentMcpStatus}
              providerCapabilities={currentProviderCapabilities}
              providerCapabilitiesByProvider={providerCapabilitiesByProvider}
              codexThreads={codexThreads}
              externalPathGrants={externalPathGrants}
              geminiMcpBridgeEnabled={geminiMcpBridgeEnabled}
              geminiMcpBridgeStatus={geminiMcpBridgeStatus}
              onRefreshCodexThreads={refreshCodexThreads}
              onResumeCodexThread={handleResumeCodexThread}
              onForkCodexThread={handleForkCodexThread}
              onForkAgentThread={handleForkAgentThread}
              onRollbackCodexThread={handleRollbackCodexThread}
              onImportCodexUsageCredential={handleImportCodexUsageCredential}
              onClearCodexUsageCredential={handleClearCodexUsageCredential}
              onCodexLogin={() => {
                void window.api.openProviderLoginTerminal('codex').then((result) => {
                  if (!result?.ok) {
                    console.warn(
                      '[provider sign-in] could not open TaskWraith Codex sign-in:',
                      result?.error
                    )
                  }
                })
              }}
              onRefreshCodexStatus={() =>
                void refreshProviderAuthStatus('codex')
              }
              onInstallGeminiMcpBridge={() => void installGeminiMcpBridge()}
              onRefreshGeminiMcpBridgeStatus={() => void refreshGeminiMcpBridgeStatus()}
              currentChat={currentChat}
              chats={chats}
              runningChatIds={runningChatIdsArray}
              onOpenSubThread={handleOpenCockpitThread}
            />
                )}
              </div>
            </aside>
            </>
          )}
        </div>
      </div>
  )
}
