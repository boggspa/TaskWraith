import type { ExecutionRunProjection } from './ExecutionGraphRun'
import type { RunQueueJob } from '../store/types'

export function canonicalExecutionGraphRunId(
  runId: string,
  getRunQueueJob: (runIdOrId: string) => RunQueueJob | null
): string {
  const requested = runId.trim()
  if (!requested) return ''
  return getRunQueueJob(requested)?.runId?.trim() || requested
}

export function isExecutionGraphReservedRunIdentity(input: {
  runId: string | undefined
  getRunQueueJob: (runIdOrId: string) => RunQueueJob | null
  listExecutions: () => readonly ExecutionRunProjection[]
}): boolean {
  const requested = input.runId?.trim()
  if (!requested) return false
  const job = input.getRunQueueJob(requested)
  const canonicalRunId = job?.runId?.trim() || requested
  if (job?.executionGraph) return true
  return input.listExecutions().some(
    (projection) =>
      projection.anchorRunRef === canonicalRunId ||
      Object.values(projection.attempts).some(
        (attempt) => attempt.providerRunRef === canonicalRunId
      )
  )
}
