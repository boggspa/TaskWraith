import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { AgentRunPayload } from './AgentRunTypes'
import type { RunCoordinator } from '../services/RunCoordinator'
import type { WorkflowBudgetRegistry } from '../WorkflowBudgetRegistry'
import type { FailoverRunSnapshot } from '../services/ProviderAutoFailover'
import type { AppSettings, ScheduledTask, WorkflowDefinition } from '../store/types'
import type {
  ScheduledOccurrenceOwner,
  ScheduledOccurrenceOwnerRegistry
} from '../ScheduledOccurrenceOwnerRegistry'
import { applyReroutePlanToPayload, resolveProviderDispatch } from '../ProviderRunPause'
import { hasAnyBudget } from '../WorkflowBudgetGuard'

const mainOwnedScheduledOccurrencePayloads = new WeakSet<object>()

/**
 * One-shot process-local authorization for every scheduled payload.
 * Renderer IPC can reproduce fields but cannot reproduce object identity in
 * this WeakSet. The facade consumes the authorization before its first await.
 */
export function authorizeMainOwnedScheduledOccurrenceDispatch(
  payload: AgentRunPayload
): AgentRunPayload {
  mainOwnedScheduledOccurrencePayloads.add(payload)
  return payload
}

/**
 * RunDispatchFacade — M3-2b orchestration-facade extraction (per design-m3-2-spec).
 *
 * `createRunDispatchFacade(deps)` returns the run-dispatch orchestrator that was
 * inline in index.ts's whenReady as `dispatchRunWithProviderPause`. It is a
 * SIDE-EFFECT ORCHESTRATOR over 11 injected deps — the secret-bound fns, the
 * AppStore accessors, and the registry state all stay OWNED in index.ts and are
 * passed in (M3-2a made the seam explicit; M3-2b relocates the body). The 3 pure
 * helpers (resolveProviderDispatch / applyReroutePlanToPayload / hasAnyBudget)
 * are direct-imported here — they carry no index.ts-scoped state.
 *
 * The relocation is behaviour-preserving: the ordered side-effect sequence + the
 * conditional guards are verbatim. RunDispatchFacade.test.ts is the regression
 * net — the risk in moving an orchestrator is reordering / dropping a guard.
 */
export interface RunDispatchFacadeDeps {
  /** Re-derive + re-sign a capped, non-escalating failover posture on a
   *  provider-change reroute (secret-bound). Currently `applyFailoverReroutePosture`. */
  applyFailoverReroutePosture: (
    routedPayload: AgentRunPayload,
    originalPayload: AgentRunPayload
  ) => void
  /** Self-heal stale persisted MCP configs (best-effort, error-swallowed).
   *  Currently `repairKnownStaleGeminiMcpBridgeConfigs`. */
  repairKnownStaleGeminiMcpBridgeConfigs: (cwd?: string) => Promise<void>
  /** Expand PDF attachments to durable per-page images. Expansion failure is
   *  fail-closed so a provider never receives a payload with its PDF omitted.
   *  Currently `expandPdfImagePathsForPayload`. */
  expandPdfImagePathsForPayload: (payload: AgentRunPayload) => Promise<void>
  /** Snapshot the dispatched request for a later failover re-run. Currently
   *  `captureFailoverSnapshot`. */
  captureFailoverSnapshot: (payload: AgentRunPayload) => FailoverRunSnapshot
  /** Exact main-owned live scheduled occurrence registry. */
  scheduledOccurrenceOwners: ScheduledOccurrenceOwnerRegistry
  /** Per-run budget-kill registry (const, owned in index.ts). */
  workflowBudgetRegistry: WorkflowBudgetRegistry
  /** appRunId → failover snapshot registry (const Map, owned in index.ts). */
  failoverSnapshotByRun: Map<string, FailoverRunSnapshot>
  /** The extracted run-dispatch coordinator (context root). */
  runCoordinator: RunCoordinator
  /** Capture the exact durable chat revision synchronously at facade entry,
   * before config repair or attachment expansion can await. */
  reserveDispatch: (payload: AgentRunPayload) => object
  /** Release the facade-owned reservation after dispatch orchestration settles. */
  releaseDispatchReservation: (reservation: object) => void
  /** AppStore accessors, injected so the facade stays AppStore-free (leaf). */
  getSettings: () => AppSettings
  getScheduledTasks: () => ScheduledTask[]
  getWorkflowDefinitions: () => WorkflowDefinition[]
  /** Durable scheduled run-id replay fence, including prior process lifetimes. */
  wasDurableScheduledRunIdObserved: (runId: string) => boolean
}

export function createRunDispatchFacade(deps: RunDispatchFacadeDeps) {
  return async (
    payload: AgentRunPayload,
    event: IpcMainInvokeEvent | { sender: WebContents }
  ): Promise<{ dispatched: boolean; appRunId: string }> => {
    // This MUST be the first operation at the outer dispatch boundary. Config
    // repair and PDF expansion both await; a history clear during either wait
    // must invalidate this immutable pre-clear token, not let the coordinator
    // capture a fresh post-clear revision for a stale payload.
    const dispatchReservation = deps.reserveDispatch(payload)
    let ordinaryChatReservation: ReturnType<
      ScheduledOccurrenceOwnerRegistry['reserveOrdinaryChatDispatch']
    > | undefined
    try {
      // A scheduled occurrence is claimed + registered by the main scheduler
      // before it reaches this facade. Prove that exact ownership synchronously,
      // before repair, attachment expansion, or an adapter can run. Conversely,
      // an ordinary dispatch may never reuse either a process-live owner run id
      // or any run id already observed in durable scheduled-task state.
      const scheduledTaskId = scheduledTaskIdFromPayload(payload)
      const occurrenceAuthorized = mainOwnedScheduledOccurrencePayloads.delete(payload)
      const scheduledOwner = scheduledTaskId
        ? requireExactScheduledSoloOwner(deps, payload, scheduledTaskId)
        : resolveExactScheduledChildOwner(deps, payload)
      if (occurrenceAuthorized !== Boolean(scheduledOwner)) {
        throw new Error('Scheduled occurrence dispatch requires one-shot MAIN authorization.')
      }
      if (!scheduledOwner) rejectObservedScheduledRunIdReplay(deps, payload.appRunId)

      ordinaryChatReservation =
        !scheduledOwner && payload.appChatId
          ? deps.scheduledOccurrenceOwners.reserveOrdinaryChatDispatch(payload.appChatId)
          : undefined

    const settings = deps.getSettings()
    const claimedReroute = payload.providerReroute
    const payloadWithoutClaim = { ...payload, providerReroute: undefined }
    // Composer can resolve a provider pause before the renderer round-trip. Do
    // not trust that metadata, but do reconstruct it when the CURRENT main-owned
    // pause plan proves the exact source→target route. All other claims vanish.
    let resolution = resolveProviderDispatch(settings, payload.provider)
    let dispatchInput = payloadWithoutClaim
    if (scheduledOwner) {
      if (
        claimedReroute !== undefined ||
        resolution.reroute ||
        (resolution.provider !== undefined && resolution.provider !== payload.provider)
      ) {
        throw new Error('Scheduled occurrence dispatch cannot be rerouted to another provider.')
      }
    } else if (
      (claimedReroute?.reason === 'provider-paused' ||
        claimedReroute?.reason === 'user-failover') &&
      claimedReroute.to === payload.provider &&
      claimedReroute.from !== claimedReroute.to
    ) {
      try {
        const sourceResolution = resolveProviderDispatch(settings, claimedReroute.from)
        if (
          sourceResolution.reroute?.from === claimedReroute.from &&
          sourceResolution.reroute.to === claimedReroute.to &&
          sourceResolution.reroute.reason === claimedReroute.reason &&
          sourceResolution.provider === payload.provider
        ) {
          resolution = sourceResolution
          dispatchInput = { ...payloadWithoutClaim, provider: claimedReroute.from }
        }
      } catch {
        // The source pause is no longer a valid reroute; dispatch the requested
        // provider without preserving renderer-carried route metadata.
      }
    }
    const routedPayload = applyReroutePlanToPayload(dispatchInput, resolution)
    const routedScheduledTaskId = scheduledTaskIdFromPayload(routedPayload)
    if (scheduledOwner) {
      const exactIdentityPreserved =
        routedPayload.provider === payload.provider &&
        routedPayload.appRunId === payload.appRunId &&
        routedPayload.appChatId === scheduledOwner.chatId &&
        routedPayload.providerReroute === undefined &&
        (scheduledOwner.rootOwner === 'solo'
          ? routedScheduledTaskId === scheduledOwner.taskId &&
            routedPayload.appRunId === scheduledOwner.ownerRunId &&
            routedPayload.provider === scheduledOwner.provider
          : routedScheduledTaskId === undefined)
      if (!exactIdentityPreserved) {
        throw new Error('Scheduled occurrence dispatch identity changed before launch.')
      }
    } else if (routedScheduledTaskId !== undefined) {
      throw new Error('Scheduled occurrence dispatch identity changed before launch.')
    }
    // Auto-failover re-dispatch: a provider-change reroute clears
    // effectivePermissions, which normalize would then downgrade to read-only.
    // Re-derive + re-sign a CAPPED, non-escalating posture for the target so a
    // failover PRESERVES (never raises) the user's approved authority. Scoped
    // to failover runs (failoverHopCount set) so manual reroutes are unchanged.
    if (resolution.reroute && typeof routedPayload.failoverHopCount === 'number') {
      deps.applyFailoverReroutePosture(routedPayload, dispatchInput)
    }
    // Self-heal stale persisted MCP configs on EVERY dispatch path, not
    // just renderer capability refreshes — bridge (iOS) dispatches on a
    // Mac whose UI never opens the capabilities panel were running with
    // pre-rebrand absolute command paths ("Failed to spawn MCP server
    // 'TaskWraith'": ENOENT). The needs-repair probe is a cheap file
    // read+compare and a no-op when healthy.
    const repairCwd =
      typeof routedPayload?.workspace === 'string' && routedPayload.workspace.length > 0
        ? routedPayload.workspace
        : undefined
    await deps.repairKnownStaleGeminiMcpBridgeConfigs(repairCwd).catch(() => {})
    await deps.expandPdfImagePathsForPayload(routedPayload)
    if (
      scheduledOwner &&
      deps.scheduledOccurrenceOwners.lookupByOwnerRunId(scheduledOwner.ownerRunId) !==
        scheduledOwner
    ) {
      throw new Error('Scheduled occurrence ownership ended before provider dispatch.')
    }
    // Per-occurrence SOLO scheduled-run budget bookkeeping MUST be wired BEFORE
    // dispatch. Ownership itself was already registered atomically with the
    // durable claim; this facade never mints or repairs ownership. The default
    // Claude path can consume its stream inline, so the budget registration must
    // still precede runCoordinator.dispatch.
    // Per-workflow limits ARE the opt-in (hasAnyBudget); workflowBudgetKillEnabled
    // is the escape hatch. NOT wired for ensemble — this chokepoint never sees a
    // round runId.
    const soloScheduledOwner =
      scheduledOwner?.rootOwner === 'solo' ? scheduledOwner : undefined
    const budgetScheduledTaskId = soloScheduledOwner?.taskId
    const soloRunId = soloScheduledOwner?.ownerRunId
    if (budgetScheduledTaskId && soloRunId) {
      const budgetSettings = deps.getSettings()
      if (budgetSettings.workflowBudgetKillEnabled !== false) {
        const task = deps.getScheduledTasks().find((t) => t.id === budgetScheduledTaskId)
        const limits = task?.workflowId
          ? deps.getWorkflowDefinitions().find((w) => w.id === task.workflowId)?.limits
          : undefined
        if (hasAnyBudget(limits)) {
          deps.workflowBudgetRegistry.register({
            runId: soloRunId,
            scheduledTaskId: budgetScheduledTaskId,
            provider: routedPayload.provider,
            startedAtMs: Date.now(),
            timeoutSeconds: limits!.timeoutSeconds,
            maxTokens: limits!.maxTokens,
            maxCostUsd: limits!.maxCostUsd
          })
        }
      }
    }
    const dispatchResult = await deps.runCoordinator.dispatch(
      routedPayload,
      event,
      dispatchReservation
    )
    // Snapshot the dispatched request so a later quota wall can re-run it.
    // A provider-native `/compact` dispatch is excluded: failing it over
    // would send the literal slash text to a DIFFERENT provider as prose.
    if (
      !scheduledOwner &&
      dispatchResult.dispatched &&
      deps.getSettings().autoFailoverEnabled &&
      dispatchResult.appRunId &&
      routedPayload.prompt?.trim() !== '/compact'
    ) {
      deps.failoverSnapshotByRun.set(
        dispatchResult.appRunId,
        deps.captureFailoverSnapshot(routedPayload)
      )
    }
    return dispatchResult
    } finally {
      if (ordinaryChatReservation) {
        deps.scheduledOccurrenceOwners.releaseOrdinaryChatDispatch(ordinaryChatReservation)
      }
      deps.releaseDispatchReservation(dispatchReservation)
    }
  }
}

function scheduledTaskIdFromPayload(payload: AgentRunPayload): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'scheduledTaskId')) return undefined
  const value = (payload as AgentRunPayload & { scheduledTaskId?: unknown }).scheduledTaskId
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('Scheduled occurrence dispatch requires an exact task id.')
  }
  return value
}

function requireExactScheduledSoloOwner(
  deps: RunDispatchFacadeDeps,
  payload: AgentRunPayload,
  scheduledTaskId: string
): ScheduledOccurrenceOwner {
  const owner = deps.scheduledOccurrenceOwners.lookupByTaskId(scheduledTaskId)
  if (
    !owner ||
    owner.rootOwner !== 'solo' ||
    payload.appRunId !== owner.ownerRunId ||
    payload.provider !== owner.provider ||
    payload.appChatId !== owner.chatId ||
    payload.scope !== 'workspace' ||
    payload.workspace !== owner.workspacePath
  ) {
    throw new Error('Scheduled occurrence dispatch does not match its live solo owner.')
  }
  return owner
}

function resolveExactScheduledChildOwner(
  deps: RunDispatchFacadeDeps,
  payload: AgentRunPayload
): ScheduledOccurrenceOwner | undefined {
  const appRunId = payload.appRunId
  const loopOwner = appRunId
    ? deps.scheduledOccurrenceOwners.lookupLoopChildRun(appRunId, payload.provider)
    : undefined
  const roundId = payload.ensembleRun?.roundId
  const ensembleChildOwner = appRunId
    ? deps.scheduledOccurrenceOwners.lookupEnsembleChildRun(appRunId, payload.provider)
    : undefined
  const ensembleRoundOwner = roundId
    ? deps.scheduledOccurrenceOwners.lookupEnsembleRound(roundId)
    : undefined
  if (loopOwner && (ensembleChildOwner || ensembleRoundOwner)) {
    throw new Error('A scheduled child run cannot belong to both a loop and an ensemble round.')
  }
  if (
    Boolean(ensembleChildOwner) !== Boolean(ensembleRoundOwner) ||
    (ensembleChildOwner && ensembleRoundOwner && ensembleChildOwner !== ensembleRoundOwner)
  ) {
    throw new Error('Scheduled ensemble child identity does not match its live round.')
  }
  const ensembleOwner = ensembleChildOwner ?? ensembleRoundOwner
  const owner = loopOwner ?? ensembleOwner
  if (!owner) return undefined
  if (
    payload.appChatId !== owner.chatId ||
    payload.scope !== 'workspace' ||
    (loopOwner && owner.rootOwner !== 'loop-root') ||
    (ensembleOwner && owner.rootOwner !== 'ensemble-root')
  ) {
    throw new Error('Scheduled child dispatch does not match its live root owner.')
  }
  return owner
}

function rejectObservedScheduledRunIdReplay(
  deps: RunDispatchFacadeDeps,
  appRunId: string | undefined
): void {
  if (typeof appRunId !== 'string' || appRunId.length === 0) return
  if (
    deps.scheduledOccurrenceOwners.isAppRunIdLiveOwned(appRunId) ||
    deps.scheduledOccurrenceOwners.wasChildRunIdObserved(appRunId) ||
    deps.getScheduledTasks().some((task) => task.runId === appRunId) ||
    deps.wasDurableScheduledRunIdObserved(appRunId)
  ) {
    throw new Error('Ordinary dispatch cannot reuse a scheduled occurrence run id.')
  }
}
