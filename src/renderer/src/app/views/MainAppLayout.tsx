import type { CSSProperties, ReactNode } from 'react'
import { EMPTY_CHAT_MESSAGES } from '../../lib/stableEmpties'
import { isRetiredProvider } from '../../../../shared/retiredProviders'
import { handleSideChatComposerKeyDown } from '../../lib/sideChatComposer'
import {
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_WORKSPACE_SIDEBAR_WIDTH,
  MAX_WORKSPACE_SIDEBAR_WIDTH
} from '../../lib/panelWidths'
import { getProviderLabel } from '../../lib/providerLabels'
import { isGlobalChat } from '../../lib/chatScope'
import { getSideChatMode } from '../../lib/sideChatLifecycle'
import { RunRailPanel } from '../../components/RunRailPanel'
import { decideApprovalElevation } from '../../lib/approvalElevation'
import { Sidebar } from '../../components/Sidebar'
import { WorkspaceBoardView } from '../../components/WorkspaceBoardView'
import { Inspector } from '../../components/Inspector'
import { SettingsPanel } from '../../components/SettingsPanel'
import { SettingsSidebar } from '../../components/SettingsSidebar'
import {
  ArrowUpSendIcon,
  AppleTerminalIcon,
  BackToParentIcon,
  ChatMediaIcon,
  ChatPopoutIcon,
  ClaudeReturnSymbolIcon,
  DockDrawerIcon,
  EndSideChatIcon,
  ExclamationShieldIcon,
  FileMenuSelectionIcon,
  GhostCompanionIcon,
  InfoCircleIcon,
  LinkCircleSymbolIcon,
  PinnedMessagesIcon,
  PreviewSymbolIcon,
  QuestionCircleIcon,
  QueueSymbolIcon,
  RunRailSymbolIcon,
  RunSymbolIcon,
  SidebarCornerIcon,
  SkyWeatherIcon,
  SplitChatIcon,
  StopSymbolIcon,
  XSymbolIcon
} from '../../components/AppChromeSymbols'
import { PinnedMessagesPanel } from '../../components/PinnedMessagesPanel'
import {
  ChatMediaDockPanel,
  ChatMediaPreviewOverlay
} from '../../components/ChatMediaPanel'
import { FileEditorPanel } from '../../components/FileEditorPanel'
import { QueuedMessagesAboveRow } from '../../components/QueuedMessagesAboveRow'
import { ComposerLinkPreviewStrip } from '../../components/ComposerLinkPreviewStrip'
import { ComposerHighlightOverlay } from '../../components/ComposerHighlightOverlay'
import { AgentIdentityIcon } from '../../components/icons/AgentIdentityIcon'
import { CombinedModelPicker } from '../../components/CombinedModelPicker'
import { CombinedPermissionsPicker } from '../../components/CombinedPermissionsPicker'
import { ComposerProviderPicker } from '../../components/ComposerProviderPicker'
import { ComposerTextareaContextMenu } from '../../components/ComposerTextareaContextMenu'
import { EnsembleParticipantsAboveRow } from '../../components/EnsembleParticipantsAboveRow'
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
import { CanvasComposerButton } from '../../components/CanvasComposerButton'
import { ComposerCumulativeTimecode, ComposerRunTimecode } from '../../components/ComposerTimecodes'
import { ComposerPlanPopoverButton } from '../../components/ComposerPlanPopoverButton'
import { CopyTranscriptButton } from '../../components/CopyTranscriptButton'
import { LiveThreadTokenTally } from '../../components/LiveThreadTokenTally'
import { WelcomeUsageDashboard } from '../../components/WelcomeUsageDashboard'
import { TranscriptPanel } from '../../components/TranscriptPanel'
import { ThreadSearchBar } from '../../components/ThreadSearchBar'
import { AuditRunCard } from '../../components/AuditRunCard'
import { AuditRunNotice } from '../../components/AuditRunNotice'
import { MultiviewPaneGrid } from '../../components/MultiviewPaneGrid'
import { MediaPane } from '../../components/MediaPane'
import { CanvasPane } from '../../components/CanvasPane'
import { CanvasPaneLauncher } from '../../components/CanvasPaneLauncher'
import { Composer } from '../../components/Composer'

import type { MainAppLayoutProps } from './MainAppLayout.types'

export function MainAppLayout(props: MainAppLayoutProps): ReactNode {
  const {
  acknowledgedElevationDefaults,
  activateRightDockTab,
  activeDiff,
  activeRightDockTab,
  activeSidebarChatId,
  activeThreadSearchIndex,
  activeWorkspaceBoard,
  activeWorkspaceBoardCards,
  activeWorkspaceBoardId,
  activeWorkspaceBoardWorkspace,
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
  autoResumeParentOnSubThreadCompletion,
  autoUpdateEnabled,
  beginManualMainTranscriptJump,
  beginManualSideTranscriptJump,
  canCreateSideChatFromCurrent,
  canOpenWorkspacePopout,
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
  currentGeminiWorktree,
  currentGuestParticipant,
  currentGuestParticipantChatId,
  currentPinnedMessages,
  currentPreviewMenuOpen,
  currentPreviewTargets,
  currentProvider,
  currentProviderCapabilities,
  currentProviderLabel,
  currentProviderModelOptions,
  currentRun,
  currentWorkspace,
  currentWorkspacePath,
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
  ensembleEnabledParticipantsForCurrent,
  exportProductDiagnostics,
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
  guestComposerProvider,
  guestThinkingModelBadge,
  guestThinkingOllamaBrand,
  handleAddChatToWorkspaceBoard,
  handleAddLocalServerToWorkspaceBoard,
  handleAddPinnedMessageToWorkspaceBoard,
  handleAddRunQueueJobToWorkspaceBoard,
  handleAddWorkflowToWorkspaceBoard,
  handleAddWorkspaceBoardCard,
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
  handleEndCurrentLinkedMainChat,
  handleEndSidePanelChat,
  handleForkCodexThread,
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
  handleOpenSideChatFromLatestRunResult,
  handleOpenSideChatFromMessage,
  handleOpenSideChatFromRunResult,
  handleOpenSideChatFromSelectedMessage,
  handleOpenSideChatFromSummary,
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
  handleSideModelChange,
  handleSideChatChange,
  handleSideProviderChange,
  handleSideReasoningChange,
  handleSideRun,
  handleSideToggleFastMode,
  handleSidebarQuickUpdate,
  handleStartSharedChat,
  handleSteerToQueuedMessage,
  handleStopHumanCollaborationSharing,
  handleStoreClaudeApiKey,
  handleStoreKimiApiKey,
  handleToggleArchiveChat,
  handleTogglePinChat,
  handleTogglePinWorkspace,
  handleTogglePinWorkspaceBoard,
  handleToggleWorkflowEnabled,
  handleTriggerClaudeLogin,
  handleUpdateWorkspaceBoardCard,
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
  interfaceStyle,
  isAdvancedFxActive,
  isChatExpanded,
  isChatMediaPanelOpen,
  isChatPopoutWindow,
  isCurrentEnsembleChat,
  isCurrentGlobalChat,
  isCurrentGuestParticipantRunning,
  isEnsembleModeEnabled,
  isFxEnabled,
  isLinkedChatPopout,
  isMultiviewSplit,
  isOldVersion,
  isPinnedMessagesPanelOpen,
  isSideChatProviderLocked,
  isSideChatRunning,
  isSideComposerLocked,
  isSideSplitOpen,
  isTerminalDockAvailable,
  isWelcomeChat,
  jumpToTranscriptMessage,
  kimiAuthStatus,
  kimiBinaryPath,
  latestSideChatRunResultSeed,
  logsEndRef,
  manualUsageRefreshInFlight,
  multiview,
  ollamaBaseUrl,
  ollamaDefaultModel,
  ollamaDefaultRunProfile,
  ollamaRunProfiles,
  ollamaToolControlTier,
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
  pendingQueuedAppRunIds,
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
  queuedRunStatusByAppRunId,
  rawFilter,
  rawLogs,
  rawLogsEndRef,
  refractionEnabled,
  refreshCodexThreads,
  refreshDiff,
  refreshGeminiMcpBridgeStatus,
  refreshProductOperationsStatus,
  refreshProviderMetadata,
  rememberSideChatComposerSelection,
  renderMultiviewPaneCell,
  renderPreviewLaunchError,
  renderPreviewTargetMenu,
  repairProductInstall,
  rightDockStyle,
  rightDockVisible,
  rightTab,
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
  selectedParticipant,
  selectedSideChatSeedMessage,
  selectedSideChatTypeOption,
  sessionTrust,
  setChatMediaPanelOpenPreservingTranscript,
  setChatPromptDraft,
  setDiffView,
  setGeminiTerminalInput,
  setInspectingRunId,
  setIsPinnedMessagesPanelOpen,
  setJoinSharedChatOpen,
  setPendingElevation,
  setPopoutMenuOpen,
  setPreviewChatMediaRef,
  setPreviewMenuTarget,
  setRawFilter,
  setRightDockTab,
  setRightTab,
  setSessionTrust,
  setSettingsActiveTab,
  setShowBugReportSheet,
  setShowCockpit,
  setShowFileEditor,
  setShowFirstLaunchSheet,
  setShowGeminiTerminal,
  setShowGhostCompanion,
  setShowSettings,
  setShowSkyVisualFx,
  setShowTerminal,
  setShowWorkspaceSidebar,
  setSideChatMenuOpen,
  setSubThreadCreatorParent,
  setThreadRawLogs,
  setThreadSearchActiveIndex,
  setThreadSearchQuery,
  setWelcomeUsageTab,
  settings,
  settingsActiveTab,
  settingsPinnedMessageGroups,
  shouldShowWelcomeUsageDashboard,
  showAgentAuraFx,
  showBugReportSheet,
  showChangelogSheet,
  showCockpit,
  showFileEditor,
  showFirstLaunchSheet,
  showGeminiTerminal,
  showJumpToLatestPill,
  showOnboardingHint,
  showRunDataVizFx,
  showSettings,
  showTerminal,
  showWorkspaceSidebar,
  sideAutoFollowRef,
  sideCanRun,
  sideChat,
  sideChatIsWelcome,
  sideChatMenuOpen,
  sideChatMenuRef,
  sideChatSeedMessageId,
  sideChatStatusLabel,
  sideChatSummarySeed,
  sideChatTokenTally,
  sideChatTypePickerOptions,
  sideChatWelcomeThreadLabel,
  sideChatWelcomeWorkspaceLabel,
  sideClaudeReasoning,
  sideCodexReasoning,
  sideComposerContextMenu,
  sideComposerHasMention,
  sideComposerModelOptions,
  sideComposerProvider,
  sideComposerReasoningOptions,
  sideComposerRunTimecodeStartedAt,
  sideComposerSelectedModel,
  sideComposerSelectedReasoning,
  sideComposerSelection,
  sideComposerTextareaRef,
  sideContextModelId,
  sideCumulativeRunBaseMs,
  sideDualComposerTelemetry,
  sideEnabledGrantIds,
  sideFastModeCapableModelIds,
  sideFastModeEnabled,
  sideGrantServices,
  sideKimiThinking,
  sideLiveRunOutputTokens,
  sideLogsEndRef,
  sidePanelAgentIdentity,
  sidePanelKindLabel,
  sidePanelLayoutClass,
  sidePanelParentChat,
  sidePanelRelation,
  sidePermissionOptions,
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
  togglePinMessageInChat,
  transcriptContentRef,
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
  welcomeDashboardCardEnabled,
  welcomeDashboardHiddenByFit,
  welcomeDashboardRegionRef,
  welcomeUsageDashboardData,
  welcomeUsageTab,
  workflowDefinitions,
  workspaceAddPointerActive,
  workspaceBoardApiReady,
  workspaceBoardCards,
  workspaceBoards,
  workspaceSearchShortcutHint,
  workspaceSidebarWidth,
  workspaces
  } = props

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
                  refreshing: manualUsageRefreshInFlight
                }}
                runningChatIds={runningChatIdsArray}
                workflows={workflowDefinitions}
                workspaceBoards={workspaceBoardApiReady ? workspaceBoards : []}
                workspaceBoardCards={workspaceBoardApiReady ? workspaceBoardCards : []}
                activeWorkspaceBoardId={workspaceBoardApiReady ? activeWorkspaceBoardId : null}
                scheduledTasks={scheduledTasks}
                collaboratingChatIds={collaboratingChatIds}
                showOnboardingHint={showOnboardingHint}
                onDismissOnboardingHint={handleDismissOnboardingHint}
                workspaceAddPointerActive={workspaceAddPointerActive}
                onSelectWorkspace={handleNavigateToWorkspace}
                onRemoveWorkspace={handleRemoveWorkspace}
                onSelectWorkspaceDialog={handleSelectWorkspace}
                onNewChat={handleNewChat}
                onNewGlobalChat={handleNewDefaultGlobalChat}
                onNewEnsemble={handleNewEnsemble}
                ensembleModeEnabled={isEnsembleModeEnabled}
                onSelectChat={handleSelectChat}
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
                  toolIconAccent: appearance.toolIconAccent
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
                onToggleArchiveChat={handleToggleArchiveChat}
                onDeleteChat={handleDeleteChat}
                onRenameChat={handleRenameChat}
                onCreateWorkflow={handleOpenWorkflowCompose}
                onCreateWorkspaceBoard={workspaceBoardApiReady ? handleCreateWorkspaceBoard : undefined}
                onOpenWorkspaceBoard={workspaceBoardApiReady ? handleOpenWorkspaceBoard : undefined}
                onRenameWorkspaceBoard={workspaceBoardApiReady ? handleRenameWorkspaceBoard : undefined}
                onDuplicateWorkspaceBoard={workspaceBoardApiReady ? handleDuplicateWorkspaceBoard : undefined}
                onTogglePinWorkspaceBoard={workspaceBoardApiReady ? handleTogglePinWorkspaceBoard : undefined}
                onArchiveWorkspaceBoard={workspaceBoardApiReady ? handleArchiveWorkspaceBoard : undefined}
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
              appIconVariant={appearance.appIconVariant}
              userBubbleColor={appearance.userBubbleColor}
              promptSurfaceStyle={appearance.promptSurfaceStyle}
              composerStyle={appearance.composerStyle}
              transcriptFontFamily={appearance.transcriptFontFamily}
              composerFontFamily={appearance.composerFontFamily}
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
              ensembleCollapseOlderRounds={settings?.ensembleCollapseOlderRounds}
              dashboardStatPrefs={settings?.dashboardStatPrefs}
              welcomeHeatmapPrefs={settings?.welcomeHeatmapPrefs}
              providerRunPauses={settings?.providerRunPauses}
              kimiSanitiserEnabled={settings?.kimiSanitiserEnabled ?? false}
              kimiSanitiserCustomKeywords={settings?.kimiSanitiserCustomKeywords ?? ''}
              userName={settings?.userName ?? ''}
              claudeBinaryPath={claudeBinaryPath}
              kimiBinaryPath={kimiBinaryPath}
              ollamaBaseUrl={ollamaBaseUrl}
              ollamaDefaultModel={ollamaDefaultModel}
              ollamaToolControlTier={ollamaToolControlTier}
              ollamaDefaultRunProfile={ollamaDefaultRunProfile}
              ollamaRunProfiles={ollamaRunProfiles}
              ollamaProviderParityAcknowledgedAt={settings?.ollamaProviderParityAcknowledgedAt}
              ollamaProviderParityWorkspaceGrants={
                settings?.ollamaProviderParityWorkspaceGrants
              }
              auditOrchestration={settings?.auditOrchestration}
              agenticServices={agenticServices}
              nativeSubAgentRequests={settings?.nativeSubAgentRequests ?? 'ask'}
              autoResumeParentOnSubThreadCompletion={autoResumeParentOnSubThreadCompletion}
              agenticWorkspaceGrantCount={agenticWorkspaceGrantCount}
              agenticWorkspaceGrants={agenticWorkspaceGrants}
              activeProvider={currentProvider}
              providerCapabilities={currentProviderCapabilities}
              providerCapabilitiesByProvider={providerCapabilitiesByProvider}
              mcpStatusByProvider={{
                codex: codexMcpStatus,
                gemini: agentMcpStatusByProvider.gemini,
                claude: agentMcpStatusByProvider.claude,
                kimi: agentMcpStatusByProvider.kimi,
                ollama: agentMcpStatusByProvider.ollama
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
                void window.api.openProviderLoginTerminal(provider).then((r) => {
                  if (!r?.ok) console.warn('[provider sign-in] could not open Terminal:', r?.error)
                })
              }}
              onProviderLogout={(provider) => {
                void window.api.openProviderLogoutTerminal(provider).then((r) => {
                  if (!r?.ok) console.warn('[provider sign-out] could not open Terminal:', r?.error)
                })
              }}
              onRemoveAgenticWorkspaceGrant={(provider, workspacePath, service) =>
                void handleRemoveAgenticWorkspaceGrant(provider, workspacePath, service)
              }
              onInstallGeminiMcpBridge={() => void installGeminiMcpBridge()}
              onRefreshGeminiMcpBridgeStatus={() => void refreshGeminiMcpBridgeStatus()}
              onRefreshProviderMcpStatus={(provider) => void refreshProviderMetadata(provider)}
              onRefreshProductOperationsStatus={() => void refreshProductOperationsStatus()}
              onExportProductDiagnostics={() => void exportProductDiagnostics()}
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

        {!isChatPopoutWindow && !showSettings && workspaceBoardApiReady && activeWorkspaceBoardId && (
          <WorkspaceBoardView
            board={activeWorkspaceBoard}
            workspace={activeWorkspaceBoardWorkspace}
            cards={activeWorkspaceBoardCards}
            chats={chats}
            workflows={workflowDefinitions}
            scheduledTasks={scheduledTasks}
            runQueueJobs={runQueueJobs}
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
                <button
                  type="button"
                  className="side-chat-action-btn danger"
                  onClick={() => void handleEndCurrentLinkedMainChat()}
                  title={
                    getSideChatMode(currentChat) === 'guestParticipant'
                      ? 'Remove this guest participant from the parent chat'
                      : 'End this isolated side chat, cancel queued work, and archive it'
                  }
                  aria-label={
                    getSideChatMode(currentChat) === 'guestParticipant'
                      ? 'Remove guest participant'
                      : 'End side chat'
                  }
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
            showSettings || (workspaceBoardApiReady && activeWorkspaceBoardId)
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
                      void window.api.canvas
                        .openEmbedded({ url })
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
              renderFocusedCell={() => (
            <div
              ref={appTranscriptRef}
              className={`app-transcript provider-${currentProvider} interface-${interfaceStyle} ${isCurrentEnsembleChat ? 'chat-kind-ensemble' : ''} ${isCurrentGlobalChat ? 'chat-scope-global' : ''} ${isWelcomeChat ? 'welcome-mode' : ''} ${welcomeDashboardHiddenByFit ? 'welcome-dashboard-hidden-by-fit' : ''} ${isAdvancedFxActive ? `fx-labs-active fx-intensity-${advancedFxIntensity}` : ''} ${showSettings ? 'transcript-hidden-for-settings' : ''}`}
              style={transcriptStyle}
            >
          {chatContextNotice && (
            <div className="chat-context-application-pill" role="status">
              <span>{chatContextNotice.message}</span>
            </div>
          )}
          {!isChatPopoutWindow && (
            <div className="chat-corner-controls chat-corner-controls-left">
              <button
                className="chat-corner-btn"
                type="button"
                onClick={() => setShowWorkspaceSidebar((current) => !current)}
                title={`${showWorkspaceSidebar ? 'Hide' : 'Show'} workspace sidebar`}
                aria-label="Toggle workspace sidebar"
              >
                <SidebarCornerIcon direction="left" isOpen={showWorkspaceSidebar} />
              </button>
              <span
                className="chat-corner-thread-title"
                title={currentChat?.title || currentWorkspace?.displayName || 'New chat'}
              >
                {currentChat?.title || currentWorkspace?.displayName || 'New chat'}
              </span>
            </div>
          )}

          {!isChatPopoutWindow && (
            <div className="chat-corner-controls chat-corner-controls-right">
            <button
              className={`chat-corner-btn ${focusedPaneSkyEnabled ? 'active' : ''}`}
              type="button"
              onClick={() => {
                // Single: toggle the persisted global. Split: toggle THIS (focused)
                // pane's override to the negation of its current effective value
                // (so the first click flips visibly even when no override exists).
                if (isMultiviewSplit) {
                  multiview.setPaneFxFlag(multiview.focusedPaneIndex, 'sky', !focusedPaneSkyEnabled)
                } else {
                  setShowSkyVisualFx((current) => !current)
                }
              }}
              title={`${focusedPaneSkyEnabled ? 'Hide' : isFxEnabled ? 'Show' : 'Enable Epic FX'} sky weather effects${hostWeather?.description ? ` · ${hostWeather.description}` : ''}`}
              aria-label="Toggle sky weather effects"
              aria-pressed={focusedPaneSkyEnabled}
              disabled={!isFxEnabled}
            >
              <SkyWeatherIcon />
            </button>
            <button
              className={`chat-corner-btn ${focusedPaneGhostEnabled ? 'active' : ''}`}
              type="button"
              onClick={() => {
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
              title={`${focusedPaneGhostEnabled ? 'Hide' : isFxEnabled ? 'Show' : 'Enable Epic FX'} ghost companion`}
              aria-label="Toggle ghost companion"
              aria-pressed={focusedPaneGhostEnabled}
              disabled={!isFxEnabled}
            >
              <GhostCompanionIcon />
            </button>
            <button
              className={`chat-corner-btn chat-corner-btn-changelog ${showChangelogSheet ? 'active' : ''}`}
              type="button"
              onClick={handleOpenChangelogSheet}
              title={showChangelogSheet ? 'Hide changelog sheet' : 'Open changelog sheet'}
              aria-label="Toggle changelog sheet"
              aria-pressed={showChangelogSheet}
            >
              <InfoCircleIcon />
            </button>
            <button
              className={`chat-corner-btn ${showFirstLaunchSheet ? 'active' : ''}`}
              type="button"
              onClick={() => setShowFirstLaunchSheet((current) => !current)}
              title={showFirstLaunchSheet ? 'Hide onboarding sheet' : 'Open onboarding sheet'}
              aria-label="Toggle onboarding sheet"
              aria-pressed={showFirstLaunchSheet}
            >
              <QuestionCircleIcon />
            </button>
            <button
              className={`chat-corner-btn chat-corner-btn-bug-report ${showBugReportSheet ? 'active' : ''}`}
              type="button"
              onClick={() => setShowBugReportSheet((current) => !current)}
              title="Report a bug or issue"
              aria-label="Report a bug or issue"
              aria-pressed={showBugReportSheet}
            >
              <ExclamationShieldIcon />
            </button>
            <div className="chat-popout-menu-wrap" ref={popoutMenuRef}>
              <button
                className={`chat-corner-btn ${popoutMenuOpen ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setSideChatMenuOpen(false)
                  setPopoutMenuOpen((open) => !open)
                }}
                title="Open popout tools"
                aria-label="Open popout tools"
                aria-haspopup="menu"
                aria-expanded={popoutMenuOpen}
                disabled={!canOpenWorkspacePopout && !currentChat}
              >
                <ChatPopoutIcon />
              </button>
              {popoutMenuOpen && (
                <div
                  className="side-chat-layout-menu chat-popout-menu"
                  role="menu"
                  aria-label="Popout tools"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPopoutMenuOpen(false)
                      openWorkspacePopoutWindow('workbench')
                    }}
                    disabled={!canOpenWorkspacePopout}
                  >
                    <span>Workbench</span>
                    <small>Open files and diffs together</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPopoutMenuOpen(false)
                      openWorkspacePopoutWindow('diff-studio')
                    }}
                    disabled={!canOpenWorkspacePopout}
                  >
                    <span>Diff Studio</span>
                    <small>Open workspace diff tools</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPopoutMenuOpen(false)
                      openWorkspacePopoutWindow('file-editor')
                    }}
                    disabled={!canOpenWorkspacePopout}
                  >
                    <span>File Editor</span>
                    <small>Open workspace files</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPopoutMenuOpen(false)
                      openChatPopoutWindow()
                    }}
                    disabled={!currentChat}
                  >
                    <span>Pop-Out Chat</span>
                    <small>Open this thread in a separate window</small>
                  </button>
                </div>
              )}
            </div>
            <div className="side-chat-menu-wrap" ref={sideChatMenuRef}>
              <button
                className={`chat-corner-btn side-chat-primary-btn ${isSideSplitOpen ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setSideChatMenuOpen(false)
                  if (isSideSplitOpen) {
                    hideSideChatPane()
                    return
                  }
                  void openCurrentSideChatPresentation('split')
                }}
                title={isSideSplitOpen ? 'Hide linked chat pane' : 'Open isolated side chat'}
                aria-label={isSideSplitOpen ? 'Hide linked chat pane' : 'Open isolated side chat'}
                disabled={!currentChat}
              >
                <SplitChatIcon />
              </button>
              <button
                className={`chat-corner-btn side-chat-menu-trigger ${sideChatMenuOpen ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setPopoutMenuOpen(false)
                  setSideChatMenuOpen((open) => !open)
                }}
                title="Choose linked chat"
                aria-label="Choose linked chat"
                aria-haspopup="menu"
                aria-expanded={sideChatMenuOpen}
                disabled={!currentChat}
              >
                <span className="side-chat-menu-chevron" aria-hidden>
                  ▾
                </span>
              </button>
              {sideChatMenuOpen && (
                <div className="side-chat-layout-menu" role="menu" aria-label="Linked chat options">
                  <div className="side-chat-layout-menu-section" role="presentation">
                    Isolated side chat
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openCurrentSideChatPresentation('split', 'singleProvider')}
                  >
                    <span>Open isolated side split</span>
                    <small>Separate sidecar with a copied parent snapshot</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openCurrentSideChatPresentation('drawer', 'singleProvider')}
                  >
                    <span>Open isolated side drawer</span>
                    <small>Right overlay sidecar</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openCurrentSideChatPresentation('popout')}
                  >
                    <span>Pop out linked chat</span>
                    <small>Separate window for the current linked chat</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void openCurrentSideChatPresentation('main')}
                  >
                    <span>Open linked chat as main</span>
                    <small>Navigate to linked chat</small>
                  </button>
                  {!isCurrentEnsembleChat && currentGuestParticipantChatId && (
                    <>
                      <div className="side-chat-layout-menu-section" role="presentation">
                        Guest
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          handleOpenLinkedChatInSidePanelById(currentGuestParticipantChatId)
                        }
                      >
                        <span>Open current guest</span>
                        <small>Attached peer on the parent transcript</small>
                      </button>
                    </>
                  )}
                  {canCreateSideChatFromCurrent && currentChat && (
                    <>
                      <div className="side-chat-layout-menu-section" role="presentation">
                        Sub-thread
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSideChatMenuOpen(false)
                          setSubThreadCreatorParent(currentChat)
                        }}
                      >
                        <span>Delegate sub-thread</span>
                        <small>New child agent with a delegated prompt</small>
                      </button>
                    </>
                  )}
                  {isCurrentEnsembleChat && (
                    <>
                      <div className="side-chat-layout-menu-section" role="presentation">
                        Ensemble shape
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          void openCurrentSideChatPresentation('split', 'ensembleClone')
                        }
                      >
                        <span>Side ensemble clone</span>
                        <small>Same participants</small>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          void openCurrentSideChatPresentation('split', 'singleProvider')
                        }
                      >
                        <span>Isolated participant side chat</span>
                        <small>
                          {selectedParticipant
                            ? selectedParticipant.role ||
                              getProviderLabel(selectedParticipant.provider)
                            : 'Selected provider'}
                        </small>
                      </button>
                      {ensembleEnabledParticipantsForCurrent.map((participant) => {
                        const participantLabel =
                          participant.role || getProviderLabel(participant.provider)
                        return (
                          <button
                            key={`side-chat-participant-${participant.id}`}
                            type="button"
                            role="menuitem"
                            onClick={() =>
                              void openCurrentSideChatPresentation(
                                'split',
                                'singleProvider',
                                participant
                              )
                            }
                          >
                            <span>Open {participantLabel} isolated side chat</span>
                            <small>{getProviderLabel(participant.provider)}</small>
                          </button>
                        )
                      })}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void openCurrentSideChatPresentation('split', 'fanOut')}
                      >
                        <span>Fan-out side chat</span>
                        <small>Participants answer in parallel</small>
                      </button>
                    </>
                  )}
                  <div className="side-chat-layout-menu-section" role="presentation">
                    Start from context
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleOpenSideChatFromSelectedMessage}
                    disabled={!canCreateSideChatFromCurrent || !selectedSideChatSeedMessage}
                  >
                    <span>Open from selected message</span>
                    <small>
                      {selectedSideChatSeedMessage
                        ? `${selectedSideChatSeedMessage.role} message`
                        : 'Hover or focus a message'}
                    </small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleOpenSideChatFromLatestRunResult}
                    disabled={!canCreateSideChatFromCurrent || !latestSideChatRunResultSeed}
                  >
                    <span>Open from latest run result</span>
                    <small>{latestSideChatRunResultSeed?.label || 'No completed run yet'}</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleOpenSideChatFromSummary}
                    disabled={!canCreateSideChatFromCurrent || !sideChatSummarySeed}
                  >
                    <span>Open from summary</span>
                    <small>{sideChatSummarySeed?.label || 'No summary yet'}</small>
                  </button>
                </div>
              )}
            </div>
            <div className="side-chat-menu-wrap pane-preview-menu-wrap" data-preview-menu-root="true">
              <button
                className={`chat-corner-btn ${currentPreviewMenuOpen ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  if (!currentChat) return
                  setSideChatMenuOpen(false)
                  setPopoutMenuOpen(false)
                  if (currentPreviewTargets.length === 1) {
                    const target = currentPreviewTargets[0]
                    if (target) void runPreviewTargetAction(target, currentChat)
                    return
                  }
                  if (currentPreviewTargets.length > 1) {
                    const paneId = multiview.focusedPaneId
                    const chatId = currentChat.appChatId
                    if (!paneId) return
                    setPreviewMenuTarget((current) =>
                      current?.paneId === paneId && current.chatId === chatId
                        ? null
                        : { paneId, chatId }
                    )
                  }
                }}
                title={launchPreviewActionTitle(currentPreviewTargets, hasWorkspaceContext)}
                aria-label="Open preview"
                aria-haspopup={currentPreviewTargets.length > 1 ? 'menu' : undefined}
                aria-expanded={currentPreviewTargets.length > 1 ? currentPreviewMenuOpen : undefined}
                aria-pressed={currentPreviewMenuOpen}
                disabled={currentPreviewTargets.length === 0}
              >
                <PreviewSymbolIcon />
              </button>
              {currentChat &&
                renderPreviewTargetMenu(
                  currentPreviewTargets,
                  multiview.focusedPaneId,
                  currentChat.appChatId,
                  currentChat
                )}
              {renderPreviewLaunchError(currentChat?.appChatId)}
            </div>
            <button
              className={`chat-corner-btn ${showCockpit ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setShowCockpit((open) => !open)
                setRightDockTab('run')
              }}
              title={showCockpit ? 'Hide Run rail' : 'Open Run rail'}
              aria-label="Toggle Run rail"
              aria-pressed={showCockpit}
            >
              <RunRailSymbolIcon />
            </button>
            <button
              className={`chat-corner-btn ${isChatMediaPanelOpen ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setChatMediaPanelOpenPreservingTranscript((open) => !open)
                setRightDockTab('media')
              }}
              title="Show chat uploads and paths"
              aria-label="Show chat uploads and paths"
              aria-pressed={isChatMediaPanelOpen}
            >
              <ChatMediaIcon />
              {currentChatMediaRefs.length > 0 && (
                <span className="chat-corner-count">
                  {currentChatMediaRefs.length > 99 ? '99+' : currentChatMediaRefs.length}
                </span>
              )}
            </button>
            <button
              className={`chat-corner-btn ${isPinnedMessagesPanelOpen ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setIsPinnedMessagesPanelOpen((open) => !open)
                setRightDockTab('pins')
              }}
              title={
                isPinnedMessagesPanelOpen
                  ? 'Hide notes and pinned messages'
                  : 'Show notes and pinned messages'
              }
              aria-label="Toggle notes and pinned messages"
              aria-pressed={isPinnedMessagesPanelOpen}
              disabled={!currentChat}
            >
              <PinnedMessagesIcon />
              {currentPinnedMessages.length > 0 && (
                <span className="chat-corner-count">
                  {currentPinnedMessages.length > 99 ? '99+' : currentPinnedMessages.length}
                </span>
              )}
            </button>
            {currentProvider === 'gemini' && !isRetiredProvider(currentProvider) && hasWorkspaceContext && (
              <button
                className={`chat-corner-btn ${showGeminiTerminal ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setShowGeminiTerminal((current) => !current)
                  setRightDockTab('terminal')
                }}
                title={`${showGeminiTerminal ? 'Hide' : 'Show'} Gemini terminal`}
                aria-label="Toggle Gemini terminal"
                aria-pressed={showGeminiTerminal}
              >
                <AppleTerminalIcon />
              </button>
            )}
            <button
              className={`chat-corner-btn ${showFileEditor ? 'active' : ''}`}
              type="button"
              onClick={() => {
                if (!hasWorkspaceContext) return
                const nextShowFileEditor = !showFileEditor
                setShowFileEditor(nextShowFileEditor)
                setRightDockTab('files')
              }}
              title={`${showFileEditor ? 'Hide' : 'Show'} file editor`}
              aria-label="Toggle file editor"
              aria-pressed={showFileEditor}
              disabled={!hasWorkspaceContext}
            >
              <FileMenuSelectionIcon />
            </button>
            {/* Pop-out buttons (file editor ↗ / Diff Studio Δ / pop-out chat)
              live in the top-center pill now — see chat-corner-controls-center. */}
              <button
                className="chat-corner-btn"
                type="button"
                onClick={() => {
                  const nextShowInspector = !appearance.showInspector
                  appearance.update({ showInspector: nextShowInspector })
                  setRightDockTab('inspector')
                }}
                title={`${appearance.showInspector ? 'Hide' : 'Show'} inspector`}
                aria-label="Toggle inspector"
                aria-pressed={appearance.showInspector}
              >
                <SidebarCornerIcon direction="right" isOpen={appearance.showInspector} />
              </button>
            </div>
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
                {unreadFromBottomCount > 0
                  ? `${unreadFromBottomCount} new ${unreadFromBottomCount === 1 ? 'message' : 'messages'}`
                  : 'Jump to latest'}
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
              {currentChat && !isWelcomeChat && (
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
                      style={{ marginInlineStart: 6 }}
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
                      style={{
                        marginInlineStart: 6,
                        borderColor:
                          'color-mix(in srgb, var(--danger, #e54d4d) 44%, var(--panel-border))',
                        color: 'color-mix(in srgb, var(--danger, #e54d4d) 88%, var(--text-primary))'
                      }}
                    >
                      Stop sharing
                    </button>
                  )}
                </div>
              )}
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
              <TranscriptPanel
                key={isWelcomeChat ? 'welcome' : 'transcript'}
                scrollRef={transcriptScrollRef}
                contentRef={transcriptContentRef}
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
                queuedRunStatusByAppRunId={queuedRunStatusByAppRunId}
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
                guestThinkingProviderLabel={
                  currentGuestParticipant && isCurrentGuestParticipantRunning
                    ? `Guest · ${guestThinkingOllamaBrand?.providerLabel || getProviderLabel(guestComposerProvider)}`
                    : null
                }
                guestThinkingProvider={
                  currentGuestParticipant && isCurrentGuestParticipantRunning
                    ? guestComposerProvider
                    : null
                }
                guestThinkingProviderClass={
                  currentGuestParticipant && isCurrentGuestParticipantRunning
                    ? guestThinkingOllamaBrand?.providerClass || guestComposerProvider
                    : null
                }
                guestThinkingModelBadge={
                  currentGuestParticipant && isCurrentGuestParticipantRunning
                    ? guestThinkingModelBadge
                    : null
                }
                displayFileChangeSummaries={displayFileChangeSummaries}
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
                onInspectRun={(runId) => {
                  setInspectingRunId(runId)
                  setShowCockpit(true)
                  setRightDockTab('run')
                }}
                onOpenSideChatFromRun={
                  canCreateSideChatFromCurrent ? handleOpenSideChatFromRunResult : undefined
                }
                compactDensity={appearance.compactDensity}
                liveActivityViewport={appearance.liveActivityViewport}
                pendingQueuedAppRunIds={pendingQueuedAppRunIds}
                onCopyMessage={handleCopyMessage}
                onDeleteMessage={handleDeleteMessage}
                onTogglePinMessage={(messageId) => togglePinMessageInChat(currentChat, messageId)}
                onPromoteCollaboratorComment={(messageId) =>
                  handlePromoteCollaboratorComment(currentChat?.appChatId, messageId)
                }
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
                tab={welcomeUsageTab}
                onTabChange={setWelcomeUsageTab}
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
              )}
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
              <div className="right-dock-tabs" role="tablist" aria-label="Right dock tabs">
                {dockTabDefs.map((tab) => {
                  const isActive = activeRightDockTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      className={`right-dock-tab right-dock-tab--icon ${isActive ? 'active' : ''}`}
                      aria-selected={isActive}
                      aria-label={tab.label}
                      title={
                        tab.enabled
                          ? tab.label
                          : tab.id === 'chat'
                            ? 'Open a side chat from a message first'
                            : tab.id === 'files'
                              ? 'Files need a bound workspace'
                              : tab.id === 'pins'
                                ? 'Open a chat first'
                                : tab.label
                      }
                      disabled={!tab.enabled}
                      onClick={() => activateRightDockTab(tab.id)}
                    >
                      <span className="right-dock-tab-icon" aria-hidden>
                        {tab.icon}
                      </span>
                      {typeof tab.badge === 'number' && tab.badge > 0 && (
                        <span className="right-dock-tab-count">
                          {tab.badge > 99 ? '99+' : tab.badge}
                        </span>
                      )}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="right-dock-close"
                  onClick={() => {
                    if (activeRightDockTab === 'chat') hideSideChatPane()
                    else closeRightDockPanel(activeRightDockTab)
                  }}
                  title="Close active dock tab"
                  aria-label="Close active dock tab"
                >
                  <XSymbolIcon />
                </button>
              </div>
              <div className="right-dock-body">
                {activeRightDockTab === 'chat' && sideChat && (
                  <div className="right-dock-side-chat">
              <aside
                className={`side-chat-pane app-transcript provider-${sideProvider} interface-${interfaceStyle} ${
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
                  <button
                    type="button"
                    className="side-chat-action-btn danger"
                    onClick={() => void handleEndSidePanelChat()}
                    title={
                      getSideChatMode(sideChat) === 'guestParticipant'
                        ? 'Remove this guest participant from the parent chat'
                        : 'End this isolated side chat, cancel queued work, and archive it'
                    }
                    aria-label={
                      getSideChatMode(sideChat) === 'guestParticipant'
                        ? 'Remove guest participant'
                        : 'End side chat'
                    }
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
            <TranscriptPanel
              key={`side-${sideChat.appChatId}`}
              scrollRef={sideTranscriptScrollRef}
              contentRef={sideTranscriptContentRef}
              endRef={sideLogsEndRef}
              messages={sideChat.messages || EMPTY_CHAT_MESSAGES}
              isWelcomeChat={sideChatIsWelcome}
              isThinking={isSideChatRunning}
              pendingPlanChoice={null}
              pendingAgentQuestions={
                pendingAgentQuestionsByChatId[sideChat.appChatId] || EMPTY_AGENT_QUESTION_QUEUE
              }
              onAgentQuestionSubmit={() => {}}
              onAgentQuestionDismiss={() => {}}
              runCompleteNotice={sideRunCompleteNotice}
              runCompleteDurationText={null}
              queuedRunStatusByAppRunId={queuedRunStatusByAppRunId}
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
              displayFileChangeSummaries={[]}
              fileChangeSummaryText=""
              fileChangeShouldShowStats={false}
              fileChangeDisplayAdds={0}
              fileChangeDisplayDels={0}
              chats={chats}
              runningChatIds={runningChatIdsArray}
              onPlanChoiceSubmit={() => {}}
              pendingProposedPlan={null}
              onProposedPlanApprove={() => {}}
              onProposedPlanDismiss={() => {}}
              onProposedPlanCustom={() => {}}
              onOpenSubThread={handleOpenCockpitThread}
              onOpenSubThreadInSidePanel={handleOpenLinkedChatInSidePanelById}
              onInspectRun={(runId) => {
                void openLinkedChatAsMain(sideChat).then(() => {
                  setInspectingRunId(runId)
                  setShowCockpit(true)
                  setRightDockTab('run')
                })
              }}
              compactDensity={appearance.compactDensity}
              liveActivityViewport={appearance.liveActivityViewport}
              pendingQueuedAppRunIds={pendingQueuedAppRunIds}
              onCopyMessage={handleCopyMessage}
              onDeleteMessage={(messageId) => deleteMessageFromChat(sideChat, messageId)}
              onTogglePinMessage={(messageId) => togglePinMessageInChat(sideChat, messageId)}
              onPromoteCollaboratorComment={(messageId) =>
                handlePromoteCollaboratorComment(sideChat.appChatId, messageId)
              }
              onPreviewImage={setPreviewChatMediaRef}
              onDetachToPane={openMediaPane}
              jumpToMessageRequest={
                transcriptJumpRequest?.chatId === sideChat.appChatId ? transcriptJumpRequest : null
              }
              onManualTranscriptJump={beginManualSideTranscriptJump}
              copiedId={copiedId}
              copy={copy}
              autoFollowRef={sideAutoFollowRef}
              currency={displayCurrency}
              currencyOverestimatePercent={overestimatePercent}
              showRunCompleteSummary={settings?.showRunCompleteSummary}
              collapseOlderRounds={settings?.ensembleCollapseOlderRounds}
              providerRates={providerRates}
            />
            <form
              className={`side-chat-composer composer-surface side-chat-compact-composer interface-${interfaceStyle}`}
              onSubmit={(event) => {
                event.preventDefault()
                handleSideRun()
              }}
            >
              {(sideQueuedMessagesAboveRowEntries.length > 0 || sideChat.chatKind === 'ensemble') && (
                <div className="composer-above-bar-stack side-chat-above-bar-stack">
                  {sideQueuedMessagesAboveRowEntries.length > 0 && (
                    <QueuedMessagesAboveRow
                      chat={sideChat}
                      entries={sideQueuedMessagesAboveRowEntries}
                      onEdit={(entryId) => handleEditQueuedMessage(entryId, sideChat)}
                      onDelete={(entryId) => handleDeleteQueuedMessage(entryId, sideChat)}
                      onSteer={(entryId) => handleSteerToQueuedMessage(entryId, sideChat)}
                      onReorder={handleReorderQueuedMessages}
                    />
                  )}
                  {sideChat.chatKind === 'ensemble' && (
                    <EnsembleParticipantsAboveRow
                      chat={sideChat}
                      selectedParticipantId={null}
                      onSelectParticipant={() => {}}
                      onChatChange={handleSideChatChange}
                      composerStyle={appearance.composerStyle}
                      grokAvailable={grokProviderAvailable}
                      cursorAvailable={cursorProviderAvailable}
                    />
                  )}
                </div>
              )}
              <div className="composer-inner-module side-chat-inner-module">
                <div className="composer-textarea-wrap side-chat-textarea-wrap">
                  {sideComposerHasMention && (
                    <ComposerHighlightOverlay
                      value={sidePrompt}
                      participants={sideChat.ensemble?.participants}
                      textareaRef={sideComposerTextareaRef}
                      syncEpoch={`${appearance.composerStyle}|side|${sideChat.appChatId}`}
                    />
                  )}
                  <textarea
                    ref={sideComposerTextareaRef}
                    className={`composer-textarea side-chat-textarea${
                      sideComposerHasMention ? ' has-mention-overlay' : ''
                    }`}
                    value={sidePrompt}
                    onContextMenu={sideComposerContextMenu.handleContextMenu}
                    onChange={(event) => setChatPromptDraft(sideChat.appChatId, event.target.value)}
                    onKeyDown={(event) => handleSideChatComposerKeyDown(event, handleSideRun)}
                    placeholder={`Ask ${sidePanelKindLabel.toLowerCase()}`}
                    aria-label="Linked chat prompt"
                    rows={2}
                    disabled={!sideCanRun}
                  />
                </div>
                <ComposerTextareaContextMenu
                  anchor={sideComposerContextMenu.anchor}
                  spellcheckContext={sideComposerContextMenu.spellcheckContext}
                  textareaRef={sideComposerTextareaRef}
                  onValueChange={(value) => setChatPromptDraft(sideChat.appChatId, value)}
                  onOpenFromElectron={sideComposerContextMenu.openContextMenu}
                  onClose={() => sideComposerContextMenu.setAnchor(null)}
                />
                <ComposerLinkPreviewStrip text={sidePrompt} />
                <div className="composer-bottom-controls side-chat-bottom-controls">
                  <div className="composer-control-footer side-chat-control-footer">
                    <div className="composer-inline-pickers side-chat-inline-pickers">
                      <div className="composer-inline-pickers-left">
                        {sideChat.chatKind === 'ensemble' ? (
                          <span
                            className="composer-ensemble-mode side-chat-ensemble-mode"
                            role="group"
                            aria-label="Side ensemble participants"
                            title="Side ensemble providers, models, and permissions are configured on the participant row."
                          >
                            Ensemble participants
                          </span>
                        ) : (
                          <>
                            <ComposerProviderPicker
                              provider={sideComposerProvider}
                              composerStyle={appearance.composerStyle}
                              grokAvailable={grokProviderAvailable}
                              cursorAvailable={cursorProviderAvailable}
                              providerRunPauses={settings?.providerRunPauses}
                              onSelect={handleSideProviderChange}
                              disabled={isSideComposerLocked || isSideChatProviderLocked}
                              activeModelId={sideComposerSelectedModel}
                              title={
                                sidePanelRelation === 'subThread'
                                  ? 'Sub-thread provider'
                                  : `${sidePanelKindLabel} provider`
                              }
                            />
                            <CombinedModelPicker
                              provider={sideComposerProvider}
                              composerStyle={appearance.composerStyle}
                              modelOptions={sideComposerModelOptions}
                              selectedModelId={sideComposerSelectedModel}
                              onSelectModel={handleSideModelChange}
                              reasoningOptions={sideComposerReasoningOptions}
                              selectedReasoning={sideComposerSelectedReasoning}
                              onSelectReasoning={handleSideReasoningChange}
                              codexReasoningEffort={sideCodexReasoning}
                              claudeReasoningEffort={sideClaudeReasoning}
                              kimiThinkingEnabled={sideKimiThinking}
                              fastModeCapableModelIds={sideFastModeCapableModelIds}
                              fastModeEnabled={sideFastModeEnabled}
                              onToggleFastMode={handleSideToggleFastMode}
                              disabled={isSideComposerLocked}
                            />
                            {sideComposerSelectedModel === 'custom' &&
                              sideComposerProvider !== 'kimi' && (
                                <span className="composer-inline-custom-model side-chat-custom-model">
                                  <input
                                    className="composer-inline-input"
                                    type="text"
                                    value={sideComposerSelection?.customModel || ''}
                                    onChange={(event) =>
                                      rememberSideChatComposerSelection({
                                        customModel: event.target.value
                                      })
                                    }
                                    placeholder="Model ID"
                                    disabled={isSideComposerLocked}
                                  />
                                  <button
                                    className="composer-inline-clear"
                                    type="button"
                                    onClick={() =>
                                      rememberSideChatComposerSelection({
                                        customModel: '',
                                        selectedModelType: getDefaultModelForProvider(sideComposerProvider)
                                      })
                                    }
                                    disabled={isSideComposerLocked}
                                    title="Cancel custom model"
                                    aria-label="Cancel custom model"
                                  >
                                    <XSymbolIcon />
                                  </button>
                                </span>
                              )}
                            <CombinedPermissionsPicker
                              provider={sideComposerProvider}
                              composerStyle={appearance.composerStyle}
                              permissionOptions={sidePermissionOptions}
                              selectedPermission={sideSelectedPermission}
                              onSelectPermission={(nextPermissionValue) => {
                                const nextApprovalMode =
                                  nextPermissionValue === 'read_only'
                                    ? 'plan'
                                    : nextPermissionValue
                                const nextWorkflowMode =
                                  nextPermissionValue === 'plan' ? 'plan' : 'normal'
                                const applySideSelection = (): void => {
                                  rememberSideChatComposerSelection({
                                    approvalMode: nextApprovalMode,
                                    workflowMode: nextWorkflowMode
                                  })
                                }
                                const elevation = decideApprovalElevation({
                                  from:
                                    sideSelectedPermission === 'read_only'
                                      ? 'plan'
                                      : sideSelectedPermission,
                                  to: nextApprovalMode,
                                  provider: sideComposerProvider,
                                  workspacePath: currentWorkspacePath,
                                  acknowledgedDefault: acknowledgedElevationDefaults
                                })
                                if (!elevation) {
                                  applySideSelection()
                                  return
                                }
                                setPendingElevation({
                                  tier: elevation.tier,
                                  provider: sideComposerProvider,
                                  workspaceLabel: currentWorkspace?.displayName ?? null,
                                  ackKey: elevation.ackKey,
                                  persistAck: elevation.persistAckOnConfirm,
                                  toMode: nextApprovalMode,
                                  apply: applySideSelection
                                })
                              }}
                              grantServices={sideGrantServices}
                              enabledGrantIds={sideEnabledGrantIds}
                              agenticServices={agenticServices}
                              onToggleGrant={(service, enabled) =>
                                void handleSetSideAgenticWorkspaceGrant(service, enabled)
                              }
                              disabled={isSideComposerLocked}
                            />
                          </>
                        )}
                      </div>
                      <div className="composer-inline-actions side-chat-inline-actions">
                        <span className="side-chat-status" aria-live="polite">
                          {sideChatStatusLabel}
                        </span>
                        <span className="composer-send-cluster side-chat-send-cluster">
                          {isSideChatRunning && (
                            <button
                              type="button"
                              className="composer-action-btn stop-btn"
                              onClick={() => void handleSideCancel()}
                              title="Stop linked chat run"
                              aria-label="Stop linked chat run"
                            >
                              <StopSymbolIcon />
                            </button>
                          )}
                          {(!isSideChatRunning || appearance.composerStyle === 'default') && (
                            <button
                              type="submit"
                              className={`composer-action-btn run-btn${
                                isSideChatRunning ? ' queue' : ''
                              }`}
                              disabled={!sideCanRun || !sidePrompt.trim()}
                              title={
                                sideCanRun
                                  ? isSideChatRunning
                                    ? 'Queue linked chat prompt'
                                    : 'Run linked chat prompt'
                                  : 'Linked chat workspace is unavailable'
                              }
                              aria-label={
                                isSideChatRunning
                                  ? 'Queue linked chat prompt'
                                  : 'Run linked chat prompt'
                              }
                            >
                              {isSideChatRunning ? (
                                <QueueSymbolIcon />
                              ) : appearance.composerStyle === 'claude' ? (
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
                  </div>
                </div>
              </div>
              <div
                className="composer-telemetry-row side-chat-telemetry-row"
                data-has-token-tally={sideThreadTokenTallyHasValue ? 'true' : 'false'}
              >
                <ComposerRunTimecode
                  running={isSideChatRunning}
                  startedAt={sideComposerRunTimecodeStartedAt}
                />
                <ComposerCumulativeTimecode
                  running={isSideChatRunning}
                  startedAt={sideComposerRunTimecodeStartedAt}
                  cumulativeBaseMs={sideCumulativeRunBaseMs}
                />
                <ComposerPlanPopoverButton
                  key={sideChat.appChatId}
                  chat={sideChat}
                  composerStyle={appearance.composerStyle}
                />
                <CopyTranscriptButton
                  disabled={sideChat.archived || (sideChat.messages?.length || 0) === 0}
                  resetKey={sideChat.appChatId}
                  onCopy={() => window.api.copyChatMarkdownTranscript(sideChat.appChatId)}
                />
                <CanvasComposerButton disabled={!window.api.canvas?.openWindow} />
                {sideThreadTokenTallyHasValue && (
                  <LiveThreadTokenTally
                    baseTally={sideChatTokenTally}
                    currency={displayCurrency}
                    dualCostAndRam={sideDualComposerTelemetry}
                    model={sideContextModelId}
                    overestimatePercent={overestimatePercent}
                    provider={sideProvider}
                    providerRates={providerRates}
                    running={isSideChatRunning}
                    liveOutputTokens={sideLiveRunOutputTokens}
                    title="Linked chat token usage"
                  />
                )}
              </div>
            </form>
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
                  <FileEditorPanel workspacePath={currentWorkspace?.path} width={appearance.inspectorWidth} />
                )}

                {activeRightDockTab === 'media' && isChatMediaPanelOpen && (
                  <ChatMediaDockPanel
                    refs={currentChatMediaRefs}
                    workspacePath={currentWorkspace?.path}
                    onClose={() => setChatMediaPanelOpenPreservingTranscript(false)}
                    onPreviewImage={setPreviewChatMediaRef}
                    onDetachToPane={openMediaPane}
                  />
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
                  <div className="gemini-terminal-split right-dock-terminal" role="region" aria-label="Gemini terminal output">
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
              setRightTab={setRightTab}
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
              onRollbackCodexThread={handleRollbackCodexThread}
              onImportCodexUsageCredential={handleImportCodexUsageCredential}
              onClearCodexUsageCredential={handleClearCodexUsageCredential}
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
