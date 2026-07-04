import type { RunQueueJob, RunQueueJobStatus, ScheduledTask } from '../../../main/store/types'
import type { QueuedRunRequest } from './runRequestTypes'

export const GUEST_PENDING_RUN_QUEUE_STATUSES = new Set<RunQueueJobStatus>([
  'queued',
  'steer_promoting',
  'starting',
  'active',
  'cancelling'
])

export function isScheduledTaskReadyToDispatch(
  task: ScheduledTask,
  nowMs: number = Date.now()
): boolean {
  if (task.status === 'due') return true
  if (task.status !== 'pending') return false
  const runAtMs = new Date(task.runAt).getTime()
  return Number.isFinite(runAtMs) && runAtMs <= nowMs
}

export const isRemoteComposerRunQueueJob = (job: RunQueueJob): boolean =>
  Boolean(job.request?.remoteComposer)

export const isQueuedDesktopRunQueueJob = (job: RunQueueJob): boolean =>
  job.status === 'queued' && !isRemoteComposerRunQueueJob(job)

export const acceptedEnsembleRunQueueWrapperReason = (input: {
  mode: 'normal' | 'queue'
  scheduledTaskId?: string
  scheduledRunAt?: string
}): string | null => {
  if (input.scheduledTaskId || input.scheduledRunAt) return null
  return input.mode === 'queue'
    ? 'Accepted into Ensemble queued prompt list.'
    : 'Accepted by Ensemble orchestrator.'
}

export const queuedRunFallbackId = (request: QueuedRunRequest): string =>
  request.appRunId || `${request.provider}-${request.prompt.slice(0, 16)}`

export const queuedRunJobSortTime = (job: RunQueueJob): number => {
  const parsed = Date.parse(job.enqueuedAt || job.createdAt || job.updatedAt || '')
  return Number.isFinite(parsed) ? parsed : 0
}
