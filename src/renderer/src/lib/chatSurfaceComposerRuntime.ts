type AnyFunction = (...args: never[]) => unknown

const NOOP_DETACHED_SURFACE_ACTION = (): void => {}
const DETACHED_SURFACE_CHAT_ID_REF = { current: null }
const DETACHED_SURFACE_GOAL_BUTTON_REF = { current: null }
const DETACHED_SURFACE_GOAL_POPOVER_REF = { current: null }
const DETACHED_SURFACE_MULTIVIEW = { layout: 'single' }
const DETACHED_SURFACE_WORKSPACE_DIFF = { filesChanged: 0, additions: 0, deletions: 0 }

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
 * Remove the focused thread's projection before it becomes the base for a
 * simultaneously mounted pane. Shared product settings/capability registries
 * survive; chat identity, mutable controls, telemetry, refs, and handlers do
 * not. Each surface builder applies its own values on top.
 */
export function buildDetachedChatSurfaceBase<T extends Record<string, unknown>>(focused: T): T {
  return {
    ...focused,
    activeEnsembleFanoutPolicy: 'off',
    applyEnsemblePermissionsToAllParticipants: NOOP_DETACHED_SURFACE_ACTION,
    applyEnsembleRosterPreset: NOOP_DETACHED_SURFACE_ACTION,
    setActiveEnsembleRosterPresetId: NOOP_DETACHED_SURFACE_ACTION,
    composerAboveBarStackAuraClass: '',
    composerAgentAuraClass: '',
    composerSlashCommands: [],
    contextLabel: '',
    contextMeter: null,
    contextUsedPercent: 0,
    onCompactContext: undefined,
    onCompactParticipant: undefined,
    compactableParticipantIds: undefined,
    speakingParticipantId: undefined,
    currentChatIdRef: DETACHED_SURFACE_CHAT_ID_REF,
    currentComposerMentionParticipants: [],
    currentDiscordContextSelection: null,
    currentEnsembleFanoutPolicy: 'off',
    currentEnsembleContinuationHops: 0,
    currentEnsembleMaxContinuationHops: 6,
    currentGoalModeLabel: '',
    currentProviderCapabilityWarning: null,
    diffActionMenuOpen: false,
    effectiveSelectedParticipantId: null,
    ensembleBlendStyle: {},
    ensembleEnabledParticipantsForCurrent: [],
    externalGitSnapshots: {},
    externalPrByPath: {},
    externalPathGrants: [],
    externalPathRepoMetadata: {},
    externalWorkspaceGroups: [],
    geminiTrustWriteBusy: false,
    geminiTrustWriteError: null,
    geminiWorkspaceTrustReady: true,
    goalButtonRef: DETACHED_SURFACE_GOAL_BUTTON_REF,
    goalDraft: '',
    goalEditing: false,
    goalPopoverPosition: null,
    goalPopoverRef: DETACHED_SURFACE_GOAL_POPOVER_REF,
    handleDeleteQueuedMessage: NOOP_DETACHED_SURFACE_ACTION,
    handleEditQueuedMessage: NOOP_DETACHED_SURFACE_ACTION,
    handleSelectParticipant: NOOP_DETACHED_SURFACE_ACTION,
    handleSteerToQueuedMessage: NOOP_DETACHED_SURFACE_ACTION,
    intentNote: '',
    isCurrentChatBusyForSteer: false,
    isCurrentEnsembleRoundRunning: false,
    isPreparingDiffReview: false,
    isSteerBusyForCurrentChat: false,
    multiview: DETACHED_SURFACE_MULTIVIEW,
    patchEnsembleParticipantById: NOOP_DETACHED_SURFACE_ACTION,
    pendingApprovalQueueByChatId: {},
    persistentSessionNeedsRestart: false,
    planImportExecutionEstimate: null,
    planImportGroundingBusy: false,
    planImportGroundingDisabledReason: undefined,
    queuedRunQueueCount: 0,
    resumeAppWatchSnapshot: null,
    selectedParticipant: null,
    sessionRestartReason: '',
    sessionTrust: false,
    setCurrentChat: NOOP_DETACHED_SURFACE_ACTION,
    setDiffActionMenuOpen: NOOP_DETACHED_SURFACE_ACTION,
    setGoalDraft: NOOP_DETACHED_SURFACE_ACTION,
    setGoalEditing: NOOP_DETACHED_SURFACE_ACTION,
    setGoalPopoverOpen: NOOP_DETACHED_SURFACE_ACTION,
    setIntentNote: NOOP_DETACHED_SURFACE_ACTION,
    setPrimaryGitSnapshot: NOOP_DETACHED_SURFACE_ACTION,
    setRawLogs: NOOP_DETACHED_SURFACE_ACTION,
    setSessionTrust: NOOP_DETACHED_SURFACE_ACTION,
    setWorkflowDraft: NOOP_DETACHED_SURFACE_ACTION,
    steerIndicatorMessage: null,
    threadTokenTallyTooltip: '',
    trustResult: null,
    trustSelectValue: 'untrusted',
    updateCurrentEnsembleFanoutPolicy: NOOP_DETACHED_SURFACE_ACTION,
    updateCurrentEnsembleFanoutIsolation: NOOP_DETACHED_SURFACE_ACTION,
    updateCurrentEnsembleMaxContinuationHops: NOOP_DETACHED_SURFACE_ACTION,
    updateSelectedParticipant: NOOP_DETACHED_SURFACE_ACTION,
    visibleScheduledTasks: [],
    workflowDraft: null,
    workflowIntervalMinutes: null,
    workspaceDiffStats: DETACHED_SURFACE_WORKSPACE_DIFF
  }
}

/**
 * One mounted chat surface owns one of these runtimes. Callback identities stay
 * fixed while their dispatch target advances to the latest chat-scoped
 * implementation; shallow-equivalent projections reuse their previous value.
 * A noisy parent render therefore cannot invalidate a resting surface unless
 * one of that surface's actual inputs changed.
 */
export class ChatSurfaceComposerRuntime<T extends object> {
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

/** Stable pane ids, rather than chat ids or cell indices, own renderer state. */
export class ChatSurfaceComposerRuntimeRegistry<T extends object> {
  private readonly runtimes = new Map<string, ChatSurfaceComposerRuntime<T>>()

  stabilize(surfaceId: string, next: T): T {
    let runtime = this.runtimes.get(surfaceId)
    if (!runtime) {
      runtime = new ChatSurfaceComposerRuntime<T>()
      this.runtimes.set(surfaceId, runtime)
    }
    return runtime.stabilize(next)
  }

  retain(surfaceIds: Iterable<string>): void {
    const retained = new Set(surfaceIds)
    for (const surfaceId of this.runtimes.keys()) {
      if (!retained.has(surfaceId)) this.runtimes.delete(surfaceId)
    }
  }

  size(): number {
    return this.runtimes.size
  }
}
