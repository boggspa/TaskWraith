export interface RunIdentity {
  readonly runId: string
}

/**
 * Resolve provider lifecycle events to their exact persisted run. Concurrent
 * provider events must never fall back to whichever run happens to be last.
 */
export function findChatRunIndex(
  runs: readonly RunIdentity[] | null | undefined,
  runId: string | null | undefined
): number {
  if (!Array.isArray(runs) || typeof runId !== 'string' || runId.length === 0) return -1
  return runs.findIndex((run) => run.runId === runId)
}
