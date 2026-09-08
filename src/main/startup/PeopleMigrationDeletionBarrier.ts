/** An unfinished deletion must commit before migration can capture any source. */
export function createPeopleMigrationDeletionBarrier(
  pendingOperation: () => { operationId: string } | null
): { ready: Promise<void>; coldPurge(): boolean; releaseAfterRecovery(): void } {
  let blocked: boolean
  try {
    blocked = pendingOperation() !== null
  } catch {
    blocked = true
  }
  let release!: () => void
  const ready = blocked
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : Promise.resolve()
  return {
    ready,
    coldPurge: () => blocked,
    releaseAfterRecovery() {
      if (pendingOperation() !== null) throw new Error('History deletion has not completed')
      if (blocked) {
        blocked = false
        release()
      }
    }
  }
}
