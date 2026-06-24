import type { RunQueueJobStatus } from '../../../main/store/types'

export const ACTIVE_RUN_QUEUE_STATUSES = new Set<RunQueueJobStatus>([
  'steer_promoting',
  'starting',
  'active',
  'cancelling'
])

interface ChatBusyActiveRun {
  chatId?: string | null
}

interface ChatBusyQueueJob {
  id?: string
  runId?: string
  chatId?: string | null
  status?: RunQueueJobStatus
}

export interface IsChatBusyForDispatchInput {
  chatId?: string | null
  activeRuns?: Iterable<ChatBusyActiveRun>
  runQueueJobs?: Iterable<ChatBusyQueueJob>
  ignoreQueueRunId?: string
}

export function isChatBusyForDispatch(input: IsChatBusyForDispatchInput): boolean {
  const chatId = input.chatId
  if (!chatId) return false

  for (const run of input.activeRuns || []) {
    if (run.chatId === chatId) return true
  }

  for (const job of input.runQueueJobs || []) {
    if (job.chatId !== chatId || !job.status || !ACTIVE_RUN_QUEUE_STATUSES.has(job.status)) {
      continue
    }
    const jobRunId = job.runId || job.id
    if (input.ignoreQueueRunId && jobRunId === input.ignoreQueueRunId) {
      continue
    }
    return true
  }

  return false
}
