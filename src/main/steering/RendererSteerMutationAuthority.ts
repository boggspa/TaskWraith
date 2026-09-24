import type { RendererRunQueueMutation } from '../ipc/runQueueHandlers'

export interface RendererSteerMutationAuthorityDeps {
  resolveCanonicalQueuedRunId: (candidateId: string) => string | null
  hasPendingQueuedRun: (runId: string) => boolean
  hasPendingActiveRun: (runId: string) => boolean
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function queuedTargetIds(mutation: RendererRunQueueMutation): string[] {
  const candidates: unknown[] = []
  if (mutation.operation === 'request') {
    const job = record(mutation.job)
    candidates.push(job?.runId, job?.id)
  } else if (mutation.operation === 'lease') {
    candidates.push(mutation.request.runId)
  } else if (mutation.operation === 'transition') {
    candidates.push(mutation.runIdOrId)
  } else if (mutation.operation === 'promote-steer') {
    candidates.push(
      mutation.input.runId,
      mutation.input.prepareJob?.runId,
      mutation.input.prepareJob?.id
    )
  } else {
    candidates.push(mutation.input.runId)
  }
  return candidates.map(optionalId).filter((value): value is string => Boolean(value))
}

/**
 * Renderer queue IPC cannot mutate a row while MAIN owns its live-delivery
 * transaction. The fence covers every mutation shape, including aliases by
 * job id and promotion requests that would otherwise cancel the active run.
 */
export function rendererMutationTargetsMainOwnedSteer(
  mutation: RendererRunQueueMutation,
  deps: RendererSteerMutationAuthorityDeps
): boolean {
  if (
    queuedTargetIds(mutation).some((candidateId) => {
      const canonicalRunId = deps.resolveCanonicalQueuedRunId(candidateId) || candidateId
      return deps.hasPendingQueuedRun(canonicalRunId)
    })
  ) {
    return true
  }

  if (mutation.operation !== 'promote-steer') return false
  const cancelRunId = optionalId(mutation.input.cancelRunId)
  return Boolean(cancelRunId && deps.hasPendingActiveRun(cancelRunId))
}
