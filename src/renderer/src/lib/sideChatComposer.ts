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
 * A side chat renders beside the focused parent, so spreading the focused
 * composer's props directly would leak parent-only cards and workspace state
 * into the linked-chat pane. Keep the shared shell, but clear every
 * focused-only display surface before applying the side-chat-scoped fields.
 *
 * Kept generic to avoid coupling this small isolation contract to Composer's
 * intentionally broad transitional prop type.
 */
export function buildSideChatComposerProps<T extends Record<string, unknown>>(
  focusedComposerProps: T,
  sideChatProps: Partial<T>
): T {
  return {
    ...focusedComposerProps,
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
    goalPopoverOpen: false,
    goalPopoverPosition: null,
    goalButtonRef: DETACHED_SIDE_CHAT_GOAL_BUTTON_REF,
    goalPopoverRef: DETACHED_SIDE_CHAT_GOAL_POPOVER_REF,
    handleReviewCurrentDiff: undefined,
    handleAgentApprovalAction: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleSelectMultiviewLayout: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleToggleWelcomeEnsemble: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    imageAttachments: [],
    isAttachingWindow: false,
    pendingAgentApproval: null,
    pendingPlanImport: null,
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
    setDiffActionMenuOpen: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    handleTrustWorkspaceClick: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    openDiscordContextPicker: undefined,
    openInspectorTab: undefined,
    shouldShowGhostCompanion: false,
    showWorkspaceGitAboveRows: false,
    syncPersistentModelSelection: NOOP_SIDE_CHAT_COMPOSER_ACTION,
    visibleScheduledTasks: [],
    ...sideChatProps
  }
}
