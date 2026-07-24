import type { BridgeRemoteAttentionReason } from './BridgeApnsPusher'
import type { RemoteTaskCard, RemoteTaskStatus } from './RemoteTaskProjection'

/**
 * Production user-visible notification reasons.
 *
 * The APNs transport retains a wider reason union for wire compatibility and
 * the explicit Settings test push, but ordinary task activity must not reach
 * the lock screen. Questions and approvals are actionable interruptions; a
 * successful, settled task completion is the sole non-blocking alert.
 */
export type RemoteNotificationReason = Extract<
  BridgeRemoteAttentionReason,
  'approval' | 'question' | 'runComplete'
>

const REMOTE_NOTIFICATION_REASONS = new Set<BridgeRemoteAttentionReason>([
  'approval',
  'question',
  'runComplete'
])

export function isRemoteNotificationReason(
  reason: BridgeRemoteAttentionReason
): reason is RemoteNotificationReason {
  return REMOTE_NOTIFICATION_REASONS.has(reason)
}

interface ObservedTaskNotificationState {
  status: RemoteTaskStatus
  runId?: string
  completionEligible: boolean
}

const IN_FLIGHT_TASK_STATUSES = new Set<RemoteTaskStatus>([
  'queued',
  'running',
  'awaitingApproval',
  'awaitingQuestion'
])

/**
 * Stateful edge detector for the completion alert.
 *
 * A live ensemble can briefly project its latest participant run as successful
 * before the orchestrator has settled the round. The task card carries a
 * separate host-authoritative eligibility bit, so that transient state is
 * remembered but does not alert. When the same run later becomes eligible at
 * the true round boundary, this detector emits exactly once.
 */
export class RemoteTaskCompletionNotificationTracker {
  private readonly stateByTaskId = new Map<string, ObservedTaskNotificationState>()

  shouldNotify(taskCard: RemoteTaskCard): boolean {
    const current: ObservedTaskNotificationState = {
      status: taskCard.status,
      runId: taskCard.runId || taskCard.latestRunId,
      completionEligible: taskCard.completionNotificationEligible === true
    }
    const previous = this.stateByTaskId.get(taskCard.id)
    if (
      previous?.status === current.status &&
      previous.runId === current.runId &&
      previous.completionEligible === current.completionEligible
    ) {
      return false
    }
    this.stateByTaskId.set(taskCard.id, current)

    if (!previous || current.status !== 'success' || !current.completionEligible) {
      return false
    }
    if (IN_FLIGHT_TASK_STATUSES.has(previous.status)) return true
    return (
      previous.status === 'success' &&
      !previous.completionEligible &&
      previous.runId === current.runId
    )
  }
}
