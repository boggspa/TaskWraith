import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { AppSettings } from '../../../../main/store/types'
import type { AppearanceState } from '../../hooks/useAppearance'
import type { PanelPresence } from '../../hooks/usePanelPresence'
import type { SettingsPanelUpdate } from '../../lib/settingsPanelUpdate'
import type {
  RightDockCanvasSurface,
  RightDockSurfaceDef
} from '../../components/RightDockSurfaceSwitcher'
import type { ExecutionGraphProjection } from '../../lib/executionGraphProjection'
import type { AppDriveDockStatus } from '../../lib/appDriveDockState'
import type { ChatPopoutPresentation } from '../../../../shared/chatPopoutPresentation'

type SidebarProps = ComponentProps<typeof import('../../components/Sidebar').Sidebar>
type SettingsSidebarProps = ComponentProps<
  typeof import('../../components/SettingsSidebar').SettingsSidebar
>
type SidebarModelUsageApiSpend = NonNullable<SidebarProps['modelUsageApiSpend']>
type SidebarDisplayCurrency = NonNullable<SidebarModelUsageApiSpend['currency']>
type SidebarProviderRates = NonNullable<SidebarModelUsageApiSpend['providerRates']>
type ResizeHandleProps = ComponentProps<'div'>
type UpdateStatusState = ReturnType<typeof import('../../hooks/useUpdateStatus').useUpdateStatus>
type SettingsPanelUpdateHandler = (next: SettingsPanelUpdate) => void
type AppearanceUpdateHandler = (partial: Partial<AppearanceState>) => void

type MainAppLayoutSettingsTakeoverAppearanceProps = Pick<
  AppearanceState,
  | 'mode'
  | 'visualEffectStyle'
  | 'themeAppearance'
  | 'themeCornerStyle'
  | 'themeAccentColor'
  | 'diffStatColors'
  | 'appIconVariant'
  | 'promptSurfaceStyle'
  | 'fanoutLaneLayout'
  | 'composerStyle'
  | 'transcriptFontFamily'
  | 'composerFontFamily'
  | 'reduceTransparency'
  | 'reduceMotion'
  | 'compactDensity'
  | 'liveActivityViewport'
  | 'sidebarOpacity'
  | 'mainPaneOpacity'
  | 'funFxEnabled'
  | 'funFxMode'
  | 'advancedFx'
>

type MainAppLayoutAppearanceProps = MainAppLayoutSettingsTakeoverAppearanceProps &
  Pick<AppearanceState, 'showInspector' | 'inspectorWidth'> & {
    update: AppearanceUpdateHandler
    /** Non-persisting live preview (font drafts) — same shape as `update`. */
    applyPreview: AppearanceUpdateHandler
  }

type MainAppLayoutSidebarProps = {
  activeSidebarChatId: SidebarProps['activeChatId']
  appVersion: SettingsSidebarProps['appVersion']
  canOpenWorkspacePopout: SidebarProps['canOpenWorkspacePopout']
  chats: SidebarProps['chats']
  collaboratingChatIds: NonNullable<SidebarProps['collaboratingChatIds']>
  composerDraftChatIds: NonNullable<SidebarProps['composerDraftChatIds']>
  currentChat: SidebarProps['currentChat']
  currentWorkspace: SidebarProps['currentWorkspace']
  displayCurrency: SidebarDisplayCurrency
  handleActiveSidebarTabChange: NonNullable<SidebarProps['onActiveSidebarTabChange']>
  handleAddChatToWorkspaceBoard: NonNullable<SidebarProps['onAddChatToWorkspaceBoard']>
  handleAddLocalServerToWorkspaceBoard: NonNullable<
    SidebarProps['onAddLocalServerToWorkspaceBoard']
  >
  handleAddRunQueueJobToWorkspaceBoard: NonNullable<
    SidebarProps['onAddRunQueueJobToWorkspaceBoard']
  >
  handleAddWorkflowToWorkspaceBoard: NonNullable<SidebarProps['onAddWorkflowToWorkspaceBoard']>
  handleArchiveWorkspaceBoard: NonNullable<SidebarProps['onArchiveWorkspaceBoard']>
  handleAgentApprovalAction: NonNullable<SidebarProps['onRespondAgentApproval']>
  handleAgentQuestionSubmit: NonNullable<SidebarProps['onAnswerAgentQuestion']>
  handleAgentQuestionDismiss: NonNullable<SidebarProps['onDismissAgentQuestion']>
  handleCancelWorkflowExecution: NonNullable<SidebarProps['onCancelWorkflowExecution']>
  handleCreateWorkspaceBoard: NonNullable<SidebarProps['onCreateWorkspaceBoard']>
  handleDeleteChat: NonNullable<SidebarProps['onDeleteChat']>
  handleDeleteWorkflow: NonNullable<SidebarProps['onDeleteWorkflow']>
  handleDeleteWorkspaceBoard: NonNullable<SidebarProps['onDeleteWorkspaceBoard']>
  handleDismissOnboardingHint: NonNullable<SidebarProps['onDismissOnboardingHint']>
  handleDuplicateWorkspaceBoard: NonNullable<SidebarProps['onDuplicateWorkspaceBoard']>
  handleEditWorkflowInterval: NonNullable<SidebarProps['onEditWorkflowInterval']>
  handleManualUsageRefresh: NonNullable<SidebarModelUsageApiSpend['onRefreshUsage']>
  handleRestoreWorkspaceBoard: NonNullable<SidebarProps['onRestoreWorkspaceBoard']>
  handleNavigateToWorkspace: SidebarProps['onSelectWorkspace']
  handleNewChat: SidebarProps['onNewChat']
  handleNewEnsemble: SidebarProps['onNewEnsemble']
  handleNewGlobalChat: SidebarProps['onNewGlobalChat']
  handleNewDefaultGlobalChat: SidebarProps['onNewGlobalChat']
  handleOpenChangelogSheet: NonNullable<SidebarProps['onOpenChangelog']>
  handleOpenInMultiview: NonNullable<SidebarProps['onOpenInMultiview']>
  handleOpenLinkedChatInSidePanelFromSidebar: NonNullable<SidebarProps['onOpenChatInSidePanel']>
  handleOpenPluginWorkflowTemplate: NonNullable<SidebarProps['onCreateWorkflowFromPluginTemplate']>
  handleOpenProjectReferencesLibrary: NonNullable<SidebarProps['onOpenReferencesLibrary']>
  workProjectHeader: Omit<
    import('../../components/ProjectHomeHeader').ProjectHomeHeaderProps,
    'onOpenLibrary'
  > | null
  handleOpenWorkflowCompose: NonNullable<SidebarProps['onCreateWorkflow']>
  handleOpenWorkspaceBoard: NonNullable<SidebarProps['onOpenWorkspaceBoard']>
  handleRemoveWorkspace: SidebarProps['onRemoveWorkspace']
  handleRenameChat: NonNullable<SidebarProps['onRenameChat']>
  handleRenameWorkspaceBoard: NonNullable<SidebarProps['onRenameWorkspaceBoard']>
  handleRunWorkflowNow: NonNullable<SidebarProps['onRunWorkflowNow']>
  handleSelectChat: SidebarProps['onSelectChat']
  handleSelectWorkspace: SidebarProps['onSelectWorkspaceDialog']
  handleSetWorkflowUnattended: NonNullable<SidebarProps['onSetWorkflowUnattended']>
  handleSettingsChange: SettingsPanelUpdateHandler
  handleSidebarPrimarySurfaceSelect: NonNullable<SidebarProps['onPrimarySurfaceSelect']>
  handleSidebarQuickUpdate: NonNullable<SidebarProps['onQuickUpdate']>
  handleStartProjectHome: NonNullable<SidebarProps['onStartProjectHome']>
  handleSelectedProjectChange: NonNullable<SidebarProps['onSelectedProjectChange']>
  handleToggleArchiveChat: NonNullable<SidebarProps['onToggleArchiveChat']>
  handleTogglePinChat: NonNullable<SidebarProps['onTogglePinChat']>
  handleSetChatHiddenFromMainList: NonNullable<SidebarProps['onSetChatHiddenFromMainList']>
  handleClearChatGitWorkflow: NonNullable<SidebarProps['onClearChatGitWorkflow']>
  /** Workspace/branch identity ("TaskWraith/master") for the active chat's
   * sidebar title ticker; null when the chat has no workspace context. */
  activeChatSidebarIdentity: SidebarProps['activeChatIdentityTicker']
  activeChatSidebarBranch: SidebarProps['activeChatIdentityBranch']
  /** Encoded git status strip for the right of that identity face. */
  activeChatSidebarGitIndicators: SidebarProps['activeChatIdentityGitIndicators']
  handleTogglePinWorkspace: NonNullable<SidebarProps['onTogglePinWorkspace']>
  handleTogglePinWorkspaceBoard: NonNullable<SidebarProps['onTogglePinWorkspaceBoard']>
  handleToggleWorkflowEnabled: NonNullable<SidebarProps['onToggleWorkflowEnabled']>
  handleWorkspaceSidebarResizeKeyDown: NonNullable<ResizeHandleProps['onKeyDown']>
  isChatPopoutWindow: boolean
  isEnsembleModeEnabled: SidebarProps['ensembleModeEnabled']
  manualUsageRefreshInFlight: SidebarModelUsageApiSpend['refreshing']
  overestimatePercent: NonNullable<SidebarModelUsageApiSpend['overestimatePercent']>
  pendingAgentApprovalByChatId: SidebarProps['pendingAgentApprovalByChatId']
  pendingApprovalQueueByChatId: SidebarProps['pendingApprovalQueueByChatId']
  pendingAgentQuestionsByChatId: SidebarProps['pendingAgentQuestionsByChatId']
  providerRates: SidebarProviderRates
  runningChatIdsArray: NonNullable<SidebarProps['runningChatIds']>
  scheduledTasks: NonNullable<SidebarProps['scheduledTasks']>
  setSettingsActiveTab: Dispatch<SetStateAction<SettingsSidebarProps['activeTab']>>
  setShowSettings: Dispatch<SetStateAction<boolean>>
  setWorkspaceBoardCreatorOpen: Dispatch<SetStateAction<boolean>>
  settings: AppSettings | null
  settingsActiveTab: SettingsSidebarProps['activeTab']
  showOnboardingHint: SidebarProps['showOnboardingHint']
  showSettings: boolean
  showWorkspaceBoardCreatorSheet: boolean
  sidebarPresence: PanelPresence
  sidebarSearchFocusRequestId: SidebarProps['focusSearchRequestId']
  startWorkspaceSidebarResize: NonNullable<ResizeHandleProps['onMouseDown']>
  updateStatus: UpdateStatusState
  usageRefreshTick: SidebarModelUsageApiSpend['refreshKey']
  usageSummary: SidebarProps['usageSummary']
  pluginWorkflowTemplates: NonNullable<SidebarProps['pluginWorkflowTemplates']>
  workflowDefinitions: NonNullable<SidebarProps['workflows']>
  workspaceBoardApiReady: boolean
  workspaceBoardCards: SidebarProps['workspaceBoardCards']
  workspaceBoards: SidebarProps['workspaceBoards']
  workspaceSearchShortcutHint: SidebarProps['searchShortcutHint']
  workspaceSidebarWidth: number
  workspaces: SidebarProps['workspaces']
}

// R9 MainAppLayout extraction — still mostly flat; R9b-1 types the left sidebar shell.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MainAppLayoutProps = MainAppLayoutSidebarProps & {
  acknowledgedElevationDefaults: any
  activateRightDockTab: any
  activateCanvasDockSurface: (surface: RightDockCanvasSurface) => void
  toggleRightDockPanel: any
  activeDiff: any
  activeProvider: any
  activeRightDockTab: any
  activeSidebarChatId: MainAppLayoutSidebarProps['activeSidebarChatId']
  activeThreadSearchIndex: any
  activeWorkspaceBoard: any
  activeWorkspaceBoardCards: any
  activeWorkspaceBoardId: any
  activeWorkspaceBoardWorkspace: any
  activeProjectGraphId: string | null
  activeProjectGraphProjection:
    | import('../../lib/projectThreadGraphProjection').ProjectThreadGraphProjection
    | null
  projectGraphEntries: { id: string; name: string; memberCount: number }[]
  onOpenProjectGraph: (project: { id: string }) => void
  onBackFromProjectGraph: () => void
  onOpenThreadFromProjectGraph: (chatId: string) => void
  onAddProjectDependency: (fromChatId: string, toChatId: string) => void
  onRemoveProjectDependency: (edgeId: string) => void
  capabilityLedgerSnapshot: any
  advancedFxIntensity: any
  agentMcpStatusByProvider: any
  agentStatusByProvider: any
  agenticServices: any
  agenticWorkspaceGrantCount: any
  agenticWorkspaceGrants: any
  appMainStyle: any
  appTranscriptRef: any
  appVersion: MainAppLayoutSidebarProps['appVersion']
  appearance: MainAppLayoutAppearanceProps
  approvalTimeouts: any
  auraProviderKey: any
  autoFollowRef: any
  markMainTranscriptProgrammaticScroll: (landedScrollTop: number) => void
  getMainTranscriptUserScrollGestureLive: () => boolean
  markSideTranscriptProgrammaticScroll: (landedScrollTop: number) => void
  getSideTranscriptUserScrollGestureLive: () => boolean
  autoUpdateEnabled: any
  auditBundleVerificationResult: any
  beginManualMainTranscriptJump: any
  beginManualSideTranscriptJump: any
  canCreateSideChatFromCurrent: any
  canOpenWorkspacePopout: MainAppLayoutSidebarProps['canOpenWorkspacePopout']
  chatByIdRef: any
  chatContextNotice: any
  chatContextTurns: any
  chatPopoutPresentation: ChatPopoutPresentation
  chatPopoutParentChat: any
  chatSplitRegionRef: any
  chatSplitStyle: any
  chats: MainAppLayoutSidebarProps['chats']
  claudeAuthStatus: any
  claudeBinaryPath: any
  claudeLoginState: any
  claudeReasoningEffort: any
  closeRightDockPanel: any
  closeThreadSearch: any
  codexMcpStatus: any
  codexReasoningEffort: any
  codexSandboxFallback: any
  codexStatus: any
  collaboratingChatIds: MainAppLayoutSidebarProps['collaboratingChatIds']
  composerCtx: any
  composerSurfaceBase: any
  configuredProviderSnapshot: import('../../hooks/useConfiguredProviderSnapshot').ConfiguredProviderSnapshot
  executionMapProjection: ExecutionGraphProjection | null
  executionMapSelectedStepId?: string
  handleBackFromExecutionMap: () => void
  handleSelectExecutionMapStep: (stepId: string) => void
  handleOpenExecutionThread: (threadRef: string) => void
  handleCancelExecutionRun: (executionId: string) => void
  handleOpenExecutionMap: (executionId: string, stepId?: string) => void
  executionRunEntries: ReadonlyArray<{
    executionId: string
    title: string
    statusLabel: string
    isLive: boolean
  }>
  handleOpenExecutionRunFromWork: (executionId: string) => void
  handleSaveExecutionGraph: (runId: string) => void
  copiedId: any
  copy: any
  currentBlackboardEntries: any
  currentChat: MainAppLayoutSidebarProps['currentChat']
  currentChatIdRef: any
  currentChatMediaRefs: any
  chatMediaPromoteTarget:
    | { projectName: string; onPromote: (ref: { path?: string }) => void }
    | undefined
  commitsInspectorWorkspacePath: string | null
  currentGeminiWorktree: any
  currentGitPresentationPath: string | undefined
  currentPinnedMessages: any
  currentPreviewMenuOpen: any
  currentPreviewTargets: any
  currentProvider: any
  currentProviderCapabilities: any
  currentProviderLabel: any
  currentRun: any
  currentWorkspace: MainAppLayoutSidebarProps['currentWorkspace']
  currentWorkspacePath: any
  cursorProviderAvailable: any
  customModel: any
  deleteMessageFromChat: any
  diff: any
  diffRefreshStatus: any
  diffView: any
  displayCurrency: MainAppLayoutSidebarProps['displayCurrency']
  displayFileChangeSummaries: any
  dockChatPopoutWindow: any
  dockPresence: any
  dockTabDefs: RightDockSurfaceDef[]
  effectiveInspectorWidth: any
  effectiveIsThinking: any
  ensembleEnabledParticipantsForCurrent: any
  exportProductDiagnostics: any
  exportProductAuditBundle: any
  verifyProductAuditBundle: any
  fileChangeDisplayAdds: any
  fileChangeDisplayDels: any
  fileChangeShouldShowStats: any
  fileChangeSummaryText: any
  focusedPaneGhostEnabled: any
  focusedPaneLivingWorkspaceEnabled: any
  focusedPaneSkyEnabled: any
  geminiCheckpointingEnabled: any
  geminiMcpBridgeEnabled: any
  geminiTerminalEndRef: any
  geminiTerminalInput: any
  geminiTerminalStatusLabel: any
  getDefaultModelForProvider: any
  grokProviderAvailable: any
  handleAddChatToWorkspaceBoard: MainAppLayoutSidebarProps['handleAddChatToWorkspaceBoard']
  handleAddLocalServerToWorkspaceBoard: MainAppLayoutSidebarProps['handleAddLocalServerToWorkspaceBoard']
  handleAddPinnedMessageToWorkspaceBoard: any
  handleAddRunQueueJobToWorkspaceBoard: MainAppLayoutSidebarProps['handleAddRunQueueJobToWorkspaceBoard']
  geminiVersion: any
  handleAddTranscriptMessageToPrompt: any
  handleAddWorkflowToWorkspaceBoard: MainAppLayoutSidebarProps['handleAddWorkflowToWorkspaceBoard']
  handleAddWorkspaceBoardCard: any
  handleAgentQuestionDismiss: MainAppLayoutSidebarProps['handleAgentQuestionDismiss']
  handleAgentQuestionSubmit: MainAppLayoutSidebarProps['handleAgentQuestionSubmit']
  handleArchiveWorkspaceBoard: MainAppLayoutSidebarProps['handleArchiveWorkspaceBoard']
  handleCancelAuditRun: any
  handleCancelWorkflowExecution: MainAppLayoutSidebarProps['handleCancelWorkflowExecution']
  handleClearClaudeApiKey: any
  handleClearCodexUsageCredential: any
  handleClearKimiApiKey: any
  handleCopyMessage: any
  handleCreateWorkspaceBoard: MainAppLayoutSidebarProps['handleCreateWorkspaceBoard']
  handleDeleteAllChatHistory: any
  handleDeleteChat: MainAppLayoutSidebarProps['handleDeleteChat']
  handleDeleteMessage: any
  handleDeleteQueuedMessage: any
  handleDeleteWorkflow: MainAppLayoutSidebarProps['handleDeleteWorkflow']
  handleDeleteWorkspaceBoard: MainAppLayoutSidebarProps['handleDeleteWorkspaceBoard']
  handleDeleteWorkspaceBoardCard: any
  handleDismissAuditRun: any
  handleDismissAuditRunNotice: any
  handleDismissOnboardingHint: MainAppLayoutSidebarProps['handleDismissOnboardingHint']
  handleDuplicateWorkspaceBoard: MainAppLayoutSidebarProps['handleDuplicateWorkspaceBoard']
  handleEditQueuedMessage: any
  handleEditWorkflowInterval: MainAppLayoutSidebarProps['handleEditWorkflowInterval']
  handleRestoreWorkspaceBoard: MainAppLayoutSidebarProps['handleRestoreWorkspaceBoard']
  handleEndCurrentLinkedMainChat: any
  handleEndSidePanelChat: any
  handleToggleSideChatAuthorityReturn: any
  handleGeminiTerminalSubmit: any
  handleImportCodexUsageCredential: any
  handleJumpToLatest: any
  handleManualUsageRefresh: MainAppLayoutSidebarProps['handleManualUsageRefresh']
  handleMessageSelectionCandidate: any
  handleNavigateToWorkspace: MainAppLayoutSidebarProps['handleNavigateToWorkspace']
  handleNewChat: MainAppLayoutSidebarProps['handleNewChat']
  handleNewEnsemble: MainAppLayoutSidebarProps['handleNewEnsemble']
  handleNewGlobalChat: MainAppLayoutSidebarProps['handleNewGlobalChat']
  handleNewDefaultGlobalChat: MainAppLayoutSidebarProps['handleNewDefaultGlobalChat']
  handleOpenChangelogSheet: MainAppLayoutSidebarProps['handleOpenChangelogSheet']
  handleOpenCockpitThread: any
  handleOpenInMultiview: MainAppLayoutSidebarProps['handleOpenInMultiview']
  handleOpenLinkedChatInSidePanelById: any
  handleOpenLinkedChatInSidePanelFromSidebar: MainAppLayoutSidebarProps['handleOpenLinkedChatInSidePanelFromSidebar']
  handleOpenPinnedMessageFromSettings: any
  handleOpenSideChatFromLatestRunResult: any
  handleOpenSideChatFromMessage: any
  handleOpenSideChatFromRunResult: any
  handleOpenSideChatFromSelectedMessage: any
  handleOpenSideChatFromSummary: any
  handleOpenPluginWorkflowTemplate: MainAppLayoutSidebarProps['handleOpenPluginWorkflowTemplate']
  handleOpenWorkflowCompose: MainAppLayoutSidebarProps['handleOpenWorkflowCompose']
  handleOpenWorkspaceBoard: MainAppLayoutSidebarProps['handleOpenWorkspaceBoard']
  handlePlanChoiceSubmit: any
  handlePromoteCollaboratorComment: any
  handleProposedPlanApprove: any
  handleProposedPlanCustom: any
  handleProposedPlanDismiss: any
  handleRemoveAgenticWorkspaceGrant: any
  handleRemoveWorkspace: MainAppLayoutSidebarProps['handleRemoveWorkspace']
  handleRenameChat: MainAppLayoutSidebarProps['handleRenameChat']
  handleRenameWorkspaceBoard: MainAppLayoutSidebarProps['handleRenameWorkspaceBoard']
  handleReorderQueuedMessages: any
  handleReturnToSideChatParent: any
  handleRightPanelResizeKeyDown: any
  handleRunWorkflowNow: MainAppLayoutSidebarProps['handleRunWorkflowNow']
  handleSelectChat: MainAppLayoutSidebarProps['handleSelectChat']
  handleSelectSideChatTypeOption: any
  handleSelectWorkspace: MainAppLayoutSidebarProps['handleSelectWorkspace']
  handleSetSideAgenticWorkspaceGrant: any
  handleSetWorkflowUnattended: MainAppLayoutSidebarProps['handleSetWorkflowUnattended']
  handleSettingsChange: MainAppLayoutSidebarProps['handleSettingsChange']
  handleSideCancel: any
  handleSideAgentApprovalAction: any
  handleRemoveSideImageAttachment: any
  handlePickFolderForChat: (chatId: string) => Promise<void>
  handleSideChatChange: any
  handleSideModelChange: any
  handleSideProviderChange: any
  handleSideReasoningChange: any
  handleSideRun: any
  handleSideSteer: any
  handleSideToggleFastMode: any
  handleSidebarQuickUpdate: MainAppLayoutSidebarProps['handleSidebarQuickUpdate']
  handleSteerToQueuedMessage: any
  handleStoreClaudeApiKey: any
  handleStoreKimiApiKey: any
  handleToggleArchiveChat: MainAppLayoutSidebarProps['handleToggleArchiveChat']
  handleTogglePinChat: MainAppLayoutSidebarProps['handleTogglePinChat']
  handleSetChatHiddenFromMainList: MainAppLayoutSidebarProps['handleSetChatHiddenFromMainList']
  handleClearChatGitWorkflow: MainAppLayoutSidebarProps['handleClearChatGitWorkflow']
  activeChatSidebarIdentity: MainAppLayoutSidebarProps['activeChatSidebarIdentity']
  activeChatSidebarGitIndicators: MainAppLayoutSidebarProps['activeChatSidebarGitIndicators']
  handleTogglePinWorkspace: MainAppLayoutSidebarProps['handleTogglePinWorkspace']
  handleTogglePinWorkspaceBoard: MainAppLayoutSidebarProps['handleTogglePinWorkspaceBoard']
  handleToggleWorkflowEnabled: MainAppLayoutSidebarProps['handleToggleWorkflowEnabled']
  handleTriggerClaudeLogin: any
  handleUpdateWorkspaceBoardCard: any
  handleProviderLogin: any
  handleUpgradeProviderCli: any
  handleWorkspaceSidebarResizeKeyDown: MainAppLayoutSidebarProps['handleWorkspaceSidebarResizeKeyDown']
  hasCurrentHandoffDraft: any
  hasWorkspaceContext: any
  hideSideChatPane: any
  hostWeather: any
  installGeminiMcpBridge: any
  interfaceStyle: any
  isAdvancedFxActive: any
  isOldVersion: any
  isChatExpanded: any
  isChatMediaPanelOpen: any
  isChatPopoutWindow: MainAppLayoutSidebarProps['isChatPopoutWindow']
  isCurrentEnsembleChat: any
  isCurrentGlobalChat: any
  isEnsembleModeEnabled: MainAppLayoutSidebarProps['isEnsembleModeEnabled']
  isFxEnabled: any
  isLinkedChatPopout: any
  isMultiviewSplit: any
  isPinnedMessagesPanelOpen: any
  isProjectReferencesPanelOpen: any
  isWorkRouteReferencesPinned: boolean
  activeWorkProjectId: string | null
  isSideChatProviderLocked: any
  isSideChatRunning: any
  isSideComposerLocked: any
  isSideSplitOpen: any
  isTerminalDockAvailable: any
  isThinking: any
  isWelcomeChat: any
  jumpToTranscriptMessage: any
  kimiAuthStatus: any
  kimiBinaryPath: any
  kimiFastMode: any
  kimiReasoningEffort: any
  kimiThinkingEnabled: any
  latestSideChatRunResultSeed: any
  logsEndRef: any
  manualUsageRefreshInFlight: MainAppLayoutSidebarProps['manualUsageRefreshInFlight']
  managedPolicyStatus: any
  multiview: any
  ollamaBaseUrl: any
  ollamaDefaultModel: any
  openChatPopoutWindow: any
  openCompactChatCompanion: any
  openCurrentSideChatPresentation: any
  openFileChangeInWorkbench: any
  openLinkedChatAsMain: any
  openMediaPane: any
  openInspectorTab: any
  openWorkspacePopoutWindow: any
  overestimatePercent: MainAppLayoutSidebarProps['overestimatePercent']
  pendingAgentApproval: any
  pendingAgentApprovalByChatId: MainAppLayoutSidebarProps['pendingAgentApprovalByChatId']
  pendingAgentQuestions: any
  pendingAgentQuestionsByChatId: MainAppLayoutSidebarProps['pendingAgentQuestionsByChatId']
  pendingApprovalQueueByChatId: MainAppLayoutSidebarProps['pendingApprovalQueueByChatId']
  pendingPlanChoice: any
  pendingProposedPlan: any
  applyEnsemblePermissionsToAllParticipantsForChat: any
  patchSideParticipantWithSeatGate: any
  popOutLinkedChat: any
  popoutMenuOpen: any
  popoutMenuRef: any
  previewChatMediaRef: any
  productOperationsStatus: any
  prompt: any
  providerCapabilitiesByProvider: any
  providerCliUpgradeState: any
  providerRates: MainAppLayoutSidebarProps['providerRates']
  providerShellClass: any
  queuedRunQueueCount: any
  rawFilter: any
  rawLogs: any
  rawLogsEndRef: any
  refractionEnabled: any
  refreshDiff: any
  refreshGeminiMcpBridgeStatus: any
  refreshProductOperationsStatus: any
  refreshProviderMetadata: any
  dryRunAuditRetention: any
  rememberSideChatComposerSelection: any
  renderMultiviewPaneCell: any
  renderPreviewLaunchError: any
  renderPreviewTargetMenu: any
  repairProductInstall: any
  purgeAuditRetention: any
  rightDockStyle: any
  rightDockVisible: any
  rightTab: any
  roundFileChangeSummaries: any
  runCompleteDurationText: any
  runCompleteNotice: any
  runDiff: any
  runFxStatus: any
  runPreviewTargetAction: any
  runQueueJobs: any
  runningChatIds: any
  runningChatIdsArray: MainAppLayoutSidebarProps['runningChatIdsArray']
  scheduledTasks: MainAppLayoutSidebarProps['scheduledTasks']
  selectThreadSearchMatch: any
  selectedModelType: any
  selectedParticipant: any
  selectedSideChatSeedMessage: any
  selectedSideChatTypeOption: any
  setChatMediaPanelOpenPreservingTranscript: any
  setChatPromptDraft: any
  setDiffView: any
  setGeminiTerminalInput: any
  setIsPinnedMessagesPanelOpen: any
  setPendingElevation: any
  setPopoutMenuOpen: any
  setPreviewChatMediaRef: any
  setPreviewMenuTarget: any
  setRawFilter: any
  setRawLogs: any
  setRightDockTab: any
  setSettingsActiveTab: MainAppLayoutSidebarProps['setSettingsActiveTab']
  setShowBugReportSheet: any
  setShowFileEditor: any
  setShowFirstLaunchSheet: any
  setShowGeminiTerminal: any
  setShowGhostCompanion: any
  setShowSettings: MainAppLayoutSidebarProps['setShowSettings']
  setShowSkyVisualFx: any
  setShowWorkspaceSidebar: any
  setSideChatMenuOpen: any
  setSubThreadCreatorParent: any
  setThreadRawLogs: any
  setThreadSearchActiveIndex: any
  setThreadSearchQuery: any
  settings: MainAppLayoutSidebarProps['settings']
  settingsActiveTab: MainAppLayoutSidebarProps['settingsActiveTab']
  settingsPinnedMessageGroups: any
  shouldShowWelcomeUsageDashboard: any
  showAgentAuraFx: any
  showBugReportSheet: any
  showChangelogSheet: any
  showFileEditor: any
  showOfficeSuite: any
  isCanvasDockPanelOpen: any
  isAppDriveDockPanelOpen: boolean
  appDriveDockStatus: AppDriveDockStatus | null
  handleAppDrivePause: () => void
  handleAppDriveResume: () => void
  handleAppDriveTakeOver: () => void
  handleAppDriveStop: () => void
  threadHomeOpen: boolean
  openThreadHome: () => void
  officeOpenRequest: any
  onOpenOfficeDocument: any
  onRequestOfficeExternalAccess: any
  citationOpenRequest: any
  onCitationOpenRequestConsumed: () => void
  onOpenProjectReferenceCitation: any
  showFirstLaunchSheet: any
  showGeminiTerminal: any
  showJumpToLatestPill: any
  showOnboardingHint: MainAppLayoutSidebarProps['showOnboardingHint']
  showRunDataVizFx: any
  showSettings: MainAppLayoutSidebarProps['showSettings']
  showWorkspaceSidebar: any
  sideAutoFollowRef: any
  sideCanRun: any
  sideChat: any
  sideChatIsHydrating: boolean
  sideChatIsWelcome: any
  sideChatMenuOpen: any
  sideChatMenuRef: any
  sideChatSeedMessageId: any
  sideChatStatusLabel: any
  sideChatSummarySeed: any
  sideChatTokenTally: any
  sideChatTypePickerOptions: any
  sideChatWelcomeThreadLabel: any
  sideChatWelcomeWorkspaceLabel: any
  sideClaudeReasoning: any
  sideCodexReasoning: any
  sideGrokReasoning: any
  sideMuseReasoning: any
  sideCursorReasoning: any
  sideComposerContextMenu: any
  sideComposerHasMention: any
  sideComposerModelOptions: any
  sideComposerProvider: any
  sideComposerReasoningOptions: any
  sideComposerRunTimecodeStartedAt: any
  sideComposerSelectedModel: any
  sideComposerSelectedReasoning: any
  sideComposerSelection: any
  sideComposerTextareaRef: any
  sideContextModelId: any
  sideCumulativeRunBaseMs: any
  sideDualComposerTelemetry: any
  sideEnabledGrantIds: any
  sideFastModeCapableModelIds: any
  sideFastModeEnabled: any
  sideGrantServices: any
  sideKimiThinking: any
  sideImageAttachments: any
  sideLiveRunOutputTokens: any
  sideLogsEndRef: any
  sidePanelAgentIdentity: any
  sidePanelKindLabel: any
  sidePanelLayoutClass: any
  sidePanelParentChat: any
  sidePanelRelation: any
  sideChatAuthorityReturnEnabled: boolean
  currentChatSideChatAuthorityReturnEnabled: boolean
  sidePermissionOptions: any
  sidePrompt: any
  sideProvider: any
  sideQueuedMessagesAboveRowEntries: any
  sideRun: any
  sideRunCompleteNotice: any
  sideSelectedPermission: any
  sideThinkingModelBadge: any
  sideThinkingProvider: any
  sideThinkingProviderClass: any
  sideThinkingProviderLabel: any
  sideThreadTokenTallyHasValue: any
  sideTranscriptContentRef: any
  sideExternalRestoreAnchorMessageId: any
  sideTranscriptScrollRef: any
  sideWorkspace: any
  sidebarPresence: MainAppLayoutSidebarProps['sidebarPresence']
  sidebarSearchFocusRequestId: MainAppLayoutSidebarProps['sidebarSearchFocusRequestId']
  startRightPanelResize: any
  startWorkspaceSidebarResize: MainAppLayoutSidebarProps['startWorkspaceSidebarResize']
  thinkingModelBadge: any
  thinkingProvider: any
  thinkingProviderClass: any
  thinkingProviderLabel: any
  threadSearchFocusRequestId: any
  threadSearchMatches: any
  threadSearchQuery: any
  threadSearchShortcutHint: any
  threadSearchVisible: any
  toggleFeedbackMessageInChat: any
  togglePinMessageInChat: any
  transcriptContentRef: any
  mainExternalRestoreAnchorMessageId: any
  transcriptJumpRequest: any
  transcriptMessages: any
  transcriptScrollRef: any
  transcriptStyle: any
  unreadFromBottomCount: any
  updateChannel: any
  updatePinnedNotesForChat: any
  updateStatus: MainAppLayoutSidebarProps['updateStatus']
  usageInitialized: any
  usageRecords: any
  usageRefreshTick: MainAppLayoutSidebarProps['usageRefreshTick']
  usageSummary: MainAppLayoutSidebarProps['usageSummary']
  visibleAuditRun: any
  visibleAuditRunNotice: any
  visibleGeminiTerminalLogs: any
  visibleRunCompleteNotice: any
  /** Threads still accountable for an unsettled durable execution. */
  liveOwnedExecutionThreads: Set<string>
  pluginWorkflowTemplates: MainAppLayoutSidebarProps['pluginWorkflowTemplates']
  welcomeDashboardCardEnabled: any
  welcomeFitLevel: any
  welcomeDashboardRegionRef: any
  welcomeUsageDashboardData: any
  workflowDefinitions: MainAppLayoutSidebarProps['workflowDefinitions']
  workspaceBoardApiReady: MainAppLayoutSidebarProps['workspaceBoardApiReady']
  workspaceBoardCards: MainAppLayoutSidebarProps['workspaceBoardCards']
  workspaceBoards: MainAppLayoutSidebarProps['workspaceBoards']
  workspaceSearchShortcutHint: MainAppLayoutSidebarProps['workspaceSearchShortcutHint']
  workspaceSidebarWidth: MainAppLayoutSidebarProps['workspaceSidebarWidth']
  workspaces: MainAppLayoutSidebarProps['workspaces']
}
