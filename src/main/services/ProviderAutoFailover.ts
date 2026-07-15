import type {
  ActiveGoal,
  AppSettings,
  ChatScope,
  EffectiveRunPermissions,
  ProviderId
} from '../store/types'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import { selectFailoverTarget } from '../RerouteFailoverPosture'

/**
 * Orchestrates an auto-failover after a run dies on a provider quota wall:
 * pause the throttled provider, then re-dispatch the SAME request to a healthy
 * provider. Pure of Electron/AppStore coupling — every side effect is an
 * injected dependency — so it unit-tests under plain vitest.
 *
 * The dispatch seam (`dispatchRunWithProviderPause` in index.ts) is what
 * actually reroutes the re-dispatched payload to the target and re-derives +
 * re-signs the posture for it (non-escalating). This orchestrator's job is the
 * coordination: dedupe/hop-cap (caller-owned), target selection, writing the
 * auto-pause, and faithfully reconstructing the original request.
 */

/** The captured request, snapshotted at dispatch time, that we re-run on failover. */
export interface FailoverRunSnapshot {
  provider: ProviderId
  scope: ChatScope
  workspace?: string
  prompt: string
  activeGoal?: ActiveGoal | null
  appChatId?: string
  approvalMode?: string
  workflowMode?: AgentRunPayload['workflowMode']
  effectivePermissions?: EffectiveRunPermissions
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  /** Scheduled-task linkage. Its presence makes auto-failover fail closed:
   * main-owned occurrences must retain their exact provider/run owner. */
  scheduledTaskId?: string
  /** Hop count of THIS run (0 for a user-initiated run, N for the Nth failover). */
  failoverHopCount?: number
}

export interface AutoFailoverRequest {
  failedRunId: string
  failedProvider: ProviderId
  appChatId?: string
  snapshot: FailoverRunSnapshot | undefined
  /** ISO reset time parsed from the provider error, if any. */
  resetHintAt?: string
}

export type AutoFailoverNotice =
  | { kind: 'rerouted'; failedProvider: ProviderId; target: ProviderId; appChatId?: string; newRunId: string; until: string }
  | { kind: 'exhausted'; failedProvider: ProviderId; appChatId?: string; hops: number }
  | { kind: 'no-target'; failedProvider: ProviderId; appChatId?: string }
  | { kind: 'dispatch-failed'; failedProvider: ProviderId; target: ProviderId; appChatId?: string; error: string }

export interface AutoFailoverDeps {
  getSettings: () => Pick<AppSettings, 'providerRunPauses'>
  updateSettings: (partial: Partial<AppSettings>) => void
  /** Live (runnable, non-retired) providers, in default failover order. */
  availableProviders: () => ProviderId[]
  isPaused: (provider: ProviderId) => boolean
  signPosture: (
    approvalMode: string | undefined,
    effectivePermissions: EffectiveRunPermissions | undefined,
    context: RunPermissionPostureContext
  ) => string
  makeRunId: (provider: ProviderId) => string
  dispatch: (payload: AgentRunPayload) => Promise<unknown>
  notify: (notice: AutoFailoverNotice) => void
  now?: () => number
  /** Max failover hops per lineage before giving up. Default 2. */
  maxHops?: number
  /** Fallback pause window when the error carried no reset hint. Default 15m. */
  defaultPauseMs?: number
}

export interface AutoFailoverResult {
  ok: boolean
  reason?: 'no-snapshot' | 'scheduled-run' | 'hop-cap' | 'no-target' | 'dispatch-failed'
  target?: ProviderId
  newRunId?: string
}

export async function runProviderAutoFailover(
  deps: AutoFailoverDeps,
  req: AutoFailoverRequest
): Promise<AutoFailoverResult> {
  const snap = req.snapshot
  if (!snap) return { ok: false, reason: 'no-snapshot' }
  // A scheduled occurrence is owned by an exact, immutable provider/run
  // identity. Pausing the provider or dispatching a replacement run would
  // mutate authority underneath that owner and could let the replacement
  // settle the wrong occurrence. Leave settings and dispatch untouched; the
  // scheduled lifecycle owner will settle the failed run itself.
  if (snap.scheduledTaskId !== undefined) return { ok: false, reason: 'scheduled-run' }

  const now = deps.now ? deps.now() : Date.now()
  const maxHops = deps.maxHops ?? 2

  const sourceHop = snap.failoverHopCount ?? 0
  if (sourceHop >= maxHops) {
    deps.notify({ kind: 'exhausted', failedProvider: req.failedProvider, appChatId: req.appChatId, hops: sourceHop })
    return { ok: false, reason: 'hop-cap' }
  }

  const settings = deps.getSettings()
  const preferred = settings.providerRunPauses?.[req.failedProvider]?.reroute?.provider ?? null
  const target = selectFailoverTarget({
    failedProvider: req.failedProvider,
    liveProviders: deps.availableProviders(),
    isPaused: deps.isPaused,
    preferred
  })
  if (!target) {
    deps.notify({ kind: 'no-target', failedProvider: req.failedProvider, appChatId: req.appChatId })
    return { ok: false, reason: 'no-target' }
  }

  // Auto-pause the throttled provider WITH a reroute target, so the seam's
  // resolveProviderDispatch reroutes the re-dispatch (and subsequent runs)
  // off it until the window resets.
  const until = req.resetHintAt ?? new Date(now + (deps.defaultPauseMs ?? 15 * 60_000)).toISOString()
  deps.updateSettings({
    providerRunPauses: {
      ...(settings.providerRunPauses || {}),
      [req.failedProvider]: {
        paused: true,
        until,
        reason: 'Auto-paused after a provider quota wall (429).',
        reroute: { provider: target },
        updatedAt: new Date(now).toISOString()
      }
    }
  })

  // Re-run the SAME request. provider stays the FAILED one; the dispatch seam
  // reroutes it to `target` and re-signs the (capped, non-escalating) posture.
  const newRunId = deps.makeRunId(req.failedProvider)
  const payload: AgentRunPayload = {
    provider: req.failedProvider,
    scope: snap.scope,
    workspace: snap.workspace,
    prompt: snap.prompt,
    activeGoal: snap.activeGoal,
    appRunId: newRunId,
    appChatId: snap.appChatId,
    approvalMode: snap.approvalMode,
    workflowMode: snap.workflowMode === 'plan' ? 'plan' : 'normal',
    model: snap.model,
    reasoningEffort: snap.reasoningEffort,
    serviceTier: snap.serviceTier,
    claudeReasoningEffort: snap.claudeReasoningEffort,
    claudeFastMode: snap.claudeFastMode,
    kimiThinking: snap.kimiThinking,
    runtimeProfileId: snap.runtimeProfileId,
    geminiAuthProfileId: snap.geminiAuthProfileId,
    handoffSourceRunId: req.failedRunId,
    failoverHopCount: sourceHop + 1,
    ...(snap.effectivePermissions ? { effectivePermissions: snap.effectivePermissions } : {})
  }
  // Sign for the (current) failed provider as a defensive baseline; the seam
  // re-signs for the rerouted target. Mirrors maybeAutoResumeParentAgent.
  payload.effectivePermissionsSignature = deps.signPosture(payload.approvalMode, payload.effectivePermissions, {
    provider: payload.provider,
    scope: payload.scope,
    appRunId: payload.appRunId,
    appChatId: payload.appChatId,
    prompt: payload.prompt,
    workflowMode: payload.workflowMode === 'plan' ? 'plan' : 'normal',
    runtimeProfileId: payload.runtimeProfileId
  })

  try {
    await deps.dispatch(payload)
  } catch (error) {
    deps.notify({
      kind: 'dispatch-failed',
      failedProvider: req.failedProvider,
      target,
      appChatId: req.appChatId,
      error: error instanceof Error ? error.message : String(error)
    })
    return { ok: false, reason: 'dispatch-failed', target, newRunId }
  }
  deps.notify({ kind: 'rerouted', failedProvider: req.failedProvider, target, appChatId: req.appChatId, newRunId, until })
  return { ok: true, target, newRunId }
}
