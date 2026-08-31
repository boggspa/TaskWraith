import type { RunSessionStatus } from '../RunManager'
import type { RunQueueJob, RunQueueJobStatus } from '../store/types'

/** Only exact graph-owned queue rows bypass ordinary same-chat occupancy. */
export function executionGraphBypassesOrdinaryChatOccupancy(
  job: Pick<RunQueueJob, 'executionGraph'>
): boolean {
  return Boolean(job.executionGraph)
}

/**
 * The queue/session handshake around adapter adoption. A provisional lifecycle
 * is starting+starting; only the provider-owned adoption may advance it to
 * running+active.
 */
export function executionGraphLifecyclePairMatches(input: {
  hasExistingSession: boolean
  sessionStatus?: RunSessionStatus
  jobStatus?: RunQueueJobStatus
}): boolean {
  if (!input.hasExistingSession) return input.jobStatus === 'starting'
  return (
    (input.sessionStatus === 'starting' && input.jobStatus === 'starting') ||
    (input.sessionStatus === 'running' && input.jobStatus === 'active')
  )
}

export function executionGraphPrelaunchJobIsStarting(status: RunQueueJobStatus): boolean {
  return status === 'starting'
}
