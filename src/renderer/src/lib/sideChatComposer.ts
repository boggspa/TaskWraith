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

type AnyFunction = (...args: never[]) => unknown

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function reuseEquivalentValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) {
    return previous.length === next.length &&
      previous.every((entry, index) => Object.is(entry, next[index]))
      ? previous
      : next
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous)
    const nextKeys = Object.keys(next)
    return previousKeys.length === nextKeys.length &&
      previousKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(next, key) && Object.is(previous[key], next[key])
      )
      ? previous
      : next
  }
  return next
}

/**
 * A side composer remains mounted beside a much noisier parent App tree. Keep
 * function props as stable dispatchers to their latest chat-scoped handlers,
 * and reuse shallow-equivalent arrays/records, so React.memo(Composer) only
 * wakes when this side chat's actual presentation changes.
 */
export class SideChatComposerRuntime<T extends object> {
  private previous: T | null = null
  private readonly latestFunctions = new Map<string, AnyFunction>()
  private readonly stableFunctions = new Map<string, AnyFunction>()

  stabilize(next: T): T {
    const nextRecord = next as Record<string, unknown>
    const previousRecord = this.previous as Record<string, unknown> | null
    const keys = Object.keys(nextRecord)
    let changed = !previousRecord || Object.keys(previousRecord).length !== keys.length
    const stabilized: Record<string, unknown> = {}

    for (const key of keys) {
      const nextValue = nextRecord[key]
      let stableValue: unknown
      if (typeof nextValue === 'function') {
        this.latestFunctions.set(key, nextValue as AnyFunction)
        let stableFunction = this.stableFunctions.get(key)
        if (!stableFunction) {
          stableFunction = ((...args: never[]) =>
            this.latestFunctions.get(key)?.(...args)) as AnyFunction
          this.stableFunctions.set(key, stableFunction)
        }
        stableValue = stableFunction
      } else {
        stableValue = reuseEquivalentValue(previousRecord?.[key], nextValue)
      }
      stabilized[key] = stableValue
      if (!Object.is(previousRecord?.[key], stableValue)) changed = true
    }

    if (!changed && this.previous) return this.previous
    this.previous = stabilized as T
    return this.previous
  }
}

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
