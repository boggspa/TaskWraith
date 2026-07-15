import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { AgentRunPayload } from './AgentRunTypes'
import type { RunCoordinator } from '../services/RunCoordinator'
import type { WorkflowBudgetRegistry } from '../WorkflowBudgetRegistry'
import type { FailoverRunSnapshot } from '../services/ProviderAutoFailover'
import type { AppSettings, ScheduledTask, WorkflowDefinition } from '../store/types'
import { applyReroutePlanToPayload, resolveProviderDispatch } from '../ProviderRunPause'
import { hasAnyBudget } from '../WorkflowBudgetGuard'

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
  applyFailoverReroutePosture: (routedPayload: AgentRunPayload, originalPayload: AgentRunPayload) => void
  /** Self-heal stale persisted MCP configs (best-effort, error-swallowed).
   *  Currently `repairKnownStaleGeminiMcpBridgeConfigs`. */
  repairKnownStaleGeminiMcpBridgeConfigs: (cwd?: string) => Promise<void>
  /** Expand PDF attachments to per-page images (best-effort, error-logged).
   *  Currently `expandPdfImagePathsForPayload`. */
  expandPdfImagePathsForPayload: (payload: AgentRunPayload) => Promise<void>
  /** Snapshot the dispatched request for a later failover re-run. Currently
   *  `captureFailoverSnapshot`. */
  captureFailoverSnapshot: (payload: AgentRunPayload) => FailoverRunSnapshot
  /** soloRunId → scheduledTaskId bookkeeping (const Map, owned in index.ts). */
  scheduledTaskIdBySoloRun: Map<string, string>
  /** Per-run budget-kill registry (const, owned in index.ts). */
  workflowBudgetRegistry: WorkflowBudgetRegistry
  /** appRunId → failover snapshot registry (const Map, owned in index.ts). */
  failoverSnapshotByRun: Map<string, FailoverRunSnapshot>
  /** The extracted run-dispatch coordinator (context root). */
  runCoordinator: RunCoordinator
  /** AppStore accessors, injected so the facade stays AppStore-free (leaf). */
  getSettings: () => AppSettings
  getScheduledTasks: () => ScheduledTask[]
  getWorkflowDefinitions: () => WorkflowDefinition[]
}

export function createRunDispatchFacade(deps: RunDispatchFacadeDeps) {
  return async (
    payload: AgentRunPayload,
    event: IpcMainInvokeEvent | { sender: WebContents }
  ): Promise<{ dispatched: boolean; appRunId: string }> => {
    const settings = deps.getSettings()
    const claimedReroute = payload.providerReroute
    const payloadWithoutClaim = { ...payload, providerReroute: undefined }
    // Composer can resolve a provider pause before the renderer round-trip. Do
    // not trust that metadata, but do reconstruct it when the CURRENT main-owned
    // pause plan proves the exact source→target route. All other claims vanish.
    let resolution = resolveProviderDispatch(settings, payload.provider)
    let dispatchInput = payloadWithoutClaim
    if (
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
    await deps.expandPdfImagePathsForPayload(routedPayload).catch((error) => {
      console.warn(
        `[pdf-attachments] failed to expand PDF image paths: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
    // Per-occurrence SOLO-scheduled-run bookkeeping (completion mark + mid-run
    // budget kill) MUST be wired BEFORE dispatch. The default Claude (Agent SDK)
    // path consumes its stream INLINE and fires sendAgentCompatExit SYNCHRONOUSLY
    // before runCoordinator.dispatch returns; a post-dispatch set/register would
    // miss the whole run — the solo completion mark would never fire (the task
    // wedges 'running' until the 6h stall reconciler, which records it 'failed'
    // and can auto-disable the workflow after maxConsecutiveFailures), and onUsage
    // budget checks during the inline run would find no registration. routedPayload
    // is the PRE-normalize raw payload, so scheduledTaskId + appRunId are present;
    // routeWithRunId PRESERVES a set appRunId and a scheduled run always carries
    // one (composeRun), so soloRunId matches the appRunId sendAgentCompatExit reads.
    // Per-workflow limits ARE the opt-in (hasAnyBudget); workflowBudgetKillEnabled
    // is the escape hatch. NOT wired for ensemble — this chokepoint never sees a
    // round runId.
    const budgetScheduledTaskId = (routedPayload as { scheduledTaskId?: string }).scheduledTaskId
    const soloRunId = typeof routedPayload.appRunId === 'string' ? routedPayload.appRunId : ''
    if (budgetScheduledTaskId && soloRunId) {
      // Stage 0b-completion: main marks this solo scheduled run terminal in
      // sendAgentCompatExit, so a mid-run renderer close (or a windowless run)
      // can't wedge it.
      deps.scheduledTaskIdBySoloRun.set(soloRunId, budgetScheduledTaskId)
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
    const dispatchResult = await deps.runCoordinator.dispatch(routedPayload, event)
    // Snapshot the dispatched request so a later quota wall can re-run it.
    // A provider-native `/compact` dispatch is excluded: failing it over
    // would send the literal slash text to a DIFFERENT provider as prose.
    if (
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
  }
}
