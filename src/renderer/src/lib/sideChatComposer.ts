import { ChatSurfaceComposerRuntime } from './chatSurfaceComposerRuntime'

export type SideChatComposerKeyEvent = {
  key: string
  shiftKey: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  nativeEvent: {
    isComposing?: boolean
  }
  preventDefault: () => void
  stopPropagation: () => void
}

const NOOP_SIDE_CHAT_COMPOSER_ACTION = (): void => {}
const DETACHED_SIDE_CHAT_GOAL_BUTTON_REF = { current: null }
const DETACHED_SIDE_CHAT_GOAL_POPOVER_REF = { current: null }
const DETACHED_SIDE_CHAT_MULTIVIEW = { layout: 'single' }

export { ChatSurfaceComposerRuntime as SideChatComposerRuntime }

export function shouldSubmitSideChatComposerKey(event: SideChatComposerKeyEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

export function handleSideChatComposerKeyDown(
  event: SideChatComposerKeyEvent,
  submit: () => void
): boolean {
  if (!shouldSubmitSideChatComposerKey(event)) return false
  event.preventDefault()
  event.stopPropagation()
  submit()
  return true
}

/**
 * A side chat renders beside the focused parent. Start from the stable shared
 * surface base — never the focused composer's chat-owned literal — then clear
 * every focused-only display surface before applying side-chat-owned fields.
 *
 * Kept generic to avoid coupling this small isolation contract to Composer's
 * intentionally broad transitional prop type.
 */
export function buildSideChatComposerProps<T extends Record<string, unknown>>(
  sharedSurfaceProps: T,
  sideChatProps: Partial<T>
): T {
  return {
    ...sharedSurfaceProps,
    attachedWindow: null,
    composerFileAttachments: [],
    composerImageAttachments: [],
    composerSlashCommands: [],
    composerAboveBarStackAuraClass: '',
    composerAgentAuraClass: '',
    currentDiscordContextSelection: null,
    diffActionMenuOpen: false,
    externalGitSnapshots: {},
    externalComposerTextareaRef: undefined,
    externalPathGrantPrompt: null,
    externalPathGrantPromptBusy: false,
    externalPathGrants: [],
    externalPathRepoMetadata: {},
    externalPrByPath: {},
    externalWorkspaceGroups: [],
    geminiWorkspaceTrustReady: true,
    goalDraft: '',
    goalEditing: false,
    currentGoalModeLabel: '',
    goalPopoverOpen: false,
    goalPopoverPosition: null,
    goalButtonRef: DETACHED_SIDE_CHAT_GOAL_BUTTON_REF,
    goalPopoverRef: DETACHED_SIDE_CHAT_GOAL_POPOVER_REF,
    handleReviewCurrentDiff: undefined,
    handleAgentApprovalAction: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleGroundImportedPlanFiles: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handlePermissionRetry: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleRunImportedPlan: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleSteer: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleSelectMultiviewLayout: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleToggleWelcomeEnsemble: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleCollapseEnsembleToSolo: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    imageAttachments: [],
    isAttachingWindow: false,
    isPreparingDiffReview: false,
    multiview: DETACHED_SIDE_CHAT_MULTIVIEW,
    pendingAgentApproval: null,
    pendingApprovalQueueByChatId: {},
    pendingPlanImport: null,
    planImportExecutionEstimate: null,
    planImportGroundingBusy: false,
    planImportGroundingDisabledReason: undefined,
    pendingWorkspaceRebind: null,
    isEnsembleModeEnabled: false,
    permissionRequestMessage: '',
    permissionRequestPaths: [],
    permissionRequestSource: undefined,
    permissionRequestTitle: '',
    primaryCi: null,
    primaryGitSnapshot: null,
    primaryPr: null,
    composerWorktreeSelection: null,
    queuedMessagesAboveRowEntries: [],
    runtimeProfileControl: null,
    resumeAppWatchSnapshot: null,
    scheduleControls: null,
    sessionYoloMode: { enabled: false },
    showWelcomeNotifications: false,
    setDiffActionMenuOpen: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleTrustWorkspaceClick: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    openDiscordContextPicker: undefined,
    openInspectorTab: undefined,
    shouldShowGhostCompanion: false,
    showWorkspaceGitAboveRows: false,
    setGoalDraft: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    setGoalEditing: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    syncPersistentModelSelection: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    visibleScheduledTasks: [],
    workflowDraft: null,
    workflowForCurrentChat: null,
    workflowIntervalMinutes: null,
    ...sideChatProps
  }
}
