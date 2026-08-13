export interface RunQueueLeaseClaims {
  has(runId: string): boolean
  tryClaim(runId: string): boolean
  release(runId: string): void
  retainQueuedRunIds(runIds: Iterable<string>): void
}

export function createRunQueueLeaseClaims(): RunQueueLeaseClaims {
  const claimedRunIds = new Set<string>()

  return {
    has: (runId) => claimedRunIds.has(runId),
    tryClaim: (runId) => {
      if (claimedRunIds.has(runId)) return false
      claimedRunIds.add(runId)
      return true
    },
    release: (runId) => {
      claimedRunIds.delete(runId)
    },
    retainQueuedRunIds: (runIds) => {
      const queuedRunIds = new Set(runIds)
      for (const runId of claimedRunIds) {
        if (!queuedRunIds.has(runId)) claimedRunIds.delete(runId)
      }
    }
  }
}

export function removeExactQueuedRunRequest<T extends { appRunId?: string }>(
  requests: T[],
  runId: string
): T[] {
  const index = requests.findIndex((request) => request.appRunId === runId)
  if (index < 0) return requests
  return [...requests.slice(0, index), ...requests.slice(index + 1)]
}
