import type { BridgeComposerPromptAction } from '../BridgeActionPayload'
import type { AllowlistDecision, PrepareStartTurnEvaluation } from '../RemoteWorkspaceAllowlist'
import type { RunQueueJob, RunQueueJobStatus } from '../store/types'

export const REMOTE_COMPOSER_ACTIVE_QUEUE_STATUSES: readonly RunQueueJobStatus[] = [
  'starting',
  'active',
  'cancelling'
] as const

export interface RemoteComposerQueueDispatchActionContract {
  /**
   * Internal queue identifier (the id/ run id used in run-queue persistence).
   */
  queueRunId: string
  /**
   * Internal queue run id we must preserve on dispatch so queue and transcript
   * share the same run identity for lifecycle mapping.
   */
  appRunId: string
  /**
   * Original provenance; remote composer queue jobs must remain 'remote' so
   * downstream projection and policy checks can inspect source.
   */
  source: 'remote'
  /**
   * Action to send through the paired-device executor. This is intentionally a
   * wire-level action and must not carry `appRunId` directly.
   */
  action: BridgeComposerPromptAction
}

export interface RemoteComposerQueueDispatchResult {
  queueRunId: string
  appRunId: string
  transitionStatus?: 'failed'
  statusReason?: string
  lastError?: string
}

export interface RemoteComposerQueueDispatchInput {
  queueRunId: string
  appRunId: string
  executed: boolean
  message?: string
}

export interface RemoteComposerQueueDispatchAuthorizationDeps {
  evaluateAllowlist: (check: PrepareStartTurnEvaluation) => AllowlistDecision
}

export type RemoteComposerQueueDispatchAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * Returns true when the given chat has any non-terminal queue job
 * (starting/active/cancelling), including remote-composer jobs.
 */
export function remoteComposerChatIsBusy(
  jobs: readonly RunQueueJob[],
  chatId: string
): boolean {
  return jobs.some(
    (job) =>
      job.chatId === chatId &&
      REMOTE_COMPOSER_ACTIVE_QUEUE_STATUSES.includes(job.status as RunQueueJobStatus)
  )
}

/**
 * Builds a pure dispatch contract for queued remote-composer jobs.
 * Preserves source and provenance fields, sets appRunId and queueRunId to job.runId,
 * and intentionally keeps appRunId off the wire action payload.
 */
export function buildRemoteComposerQueueDispatchAction(
  job: RunQueueJob
): RemoteComposerQueueDispatchActionContract | null {
  if (job.source !== 'remote' || !job.request?.remoteComposer) return null
  const remote = job.request.remoteComposer
  const frozenPreset = job.permissionPosture?.presetId
  const dispatchPermissionPresetId =
    frozenPreset === 'full_access' || frozenPreset === 'workspace_write'
      ? frozenPreset
      : remote.permissionPresetId === 'full_access'
        ? 'workspace_write'
        : undefined
  return {
    queueRunId: job.runId,
    appRunId: job.runId,
    source: 'remote',
    action: {
      kind: 'composerPrompt',
      workspaceId: remote.workspaceId,
      threadId: remote.threadId,
      provider: remote.provider,
      text: remote.text,
      ...(remote.approvalMode ? { approvalMode: remote.approvalMode } : {}),
      ...(remote.workflowMode ? { workflowMode: remote.workflowMode } : {}),
      ...(dispatchPermissionPresetId ? { permissionPresetId: dispatchPermissionPresetId } : {}),
      ...(remote.model ? { model: remote.model } : {}),
      ...(remote.reasoningEffort !== undefined ? { reasoningEffort: remote.reasoningEffort } : {}),
      ...(remote.claudeReasoningEffort !== undefined
        ? { claudeReasoningEffort: remote.claudeReasoningEffort }
        : {}),
      // Re-add the reasoning/fast/thinking fields that were previously dropped on
      // queued-prompt promotion (fixes the pre-existing cursorFastMode loss too).
      ...(remote.grokReasoningEffort !== undefined
        ? { grokReasoningEffort: remote.grokReasoningEffort }
        : {}),
      ...(remote.cursorReasoningEffort !== undefined
        ? { cursorReasoningEffort: remote.cursorReasoningEffort }
        : {}),
      ...(remote.cursorFastMode !== undefined ? { cursorFastMode: remote.cursorFastMode } : {}),
      ...(remote.claudeFastMode !== undefined ? { claudeFastMode: remote.claudeFastMode } : {}),
      ...(remote.codexServiceTier !== undefined
        ? { codexServiceTier: remote.codexServiceTier }
        : {}),
      ...(remote.kimiThinkingEnabled !== undefined
        ? { kimiThinkingEnabled: remote.kimiThinkingEnabled }
        : {}),
      ...(typeof remote.contextTurns === 'number' ? { contextTurns: remote.contextTurns } : {}),
      ...(remote.extraWorkspaceIds?.length ? { extraWorkspaceIds: remote.extraWorkspaceIds } : {})
    }
  }
}

export function authorizeRemoteComposerQueueDispatch(
  job: RunQueueJob,
  deps: RemoteComposerQueueDispatchAuthorizationDeps
): RemoteComposerQueueDispatchAuthorization {
  const dispatch = buildRemoteComposerQueueDispatchAction(job)
  if (!dispatch) {
    return { allowed: false, reason: 'Remote composer queue job is not dispatchable.' }
  }
  const decision = deps.evaluateAllowlist({
    workspaceId: dispatch.action.workspaceId,
    provider: dispatch.action.provider,
    approvalMode: dispatch.action.approvalMode,
    capability: 'startTurn'
  })
  if (decision.allowed) return { allowed: true }
  return { allowed: false, reason: decision.reason }
}

/**
 * Classifies an async dispatch outcome for queue persistence:
 * - accepted/dispatched -> do not transition queue status here;
 * - not-dispatched -> terminal failed transition on queueRunId.
 */
export function classifyRemoteComposerQueueDispatchResult(
  input: RemoteComposerQueueDispatchInput
): RemoteComposerQueueDispatchResult {
  if (input.executed) {
    return {
      queueRunId: input.queueRunId,
      appRunId: input.appRunId
    }
  }
  const reason = input.message || 'Remote queued prompt failed to dispatch.'
  return {
    queueRunId: input.queueRunId,
    appRunId: input.appRunId,
    transitionStatus: 'failed',
    statusReason: reason,
    lastError: reason
  }
}

export function classifyRemoteComposerQueueDispatchFailure(
  input: {
    queueRunId: string
    appRunId: string
    error: unknown
  }
): RemoteComposerQueueDispatchResult {
  const reason = input.error instanceof Error ? input.error.message : String(input.error)
  return {
    queueRunId: input.queueRunId,
    appRunId: input.appRunId,
    transitionStatus: 'failed',
    statusReason: reason || 'Remote queued prompt failed to dispatch.',
    lastError: reason || 'Remote queued prompt failed to dispatch.'
  }
}
