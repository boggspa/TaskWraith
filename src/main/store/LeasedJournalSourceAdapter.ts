import type { ChatPreparationCommand } from './ChatPreparationLane'

/** Thread result is exit-qualified by the executor; custody never follows a reply alone. */
export function startLeasedJournalSourceAdapter<Artifact>(
  command: Extract<ChatPreparationCommand, { type: 'start' }>,
  ports: {
    ownsSubmittedLineage(command: Extract<ChatPreparationCommand, { type: 'start' }>): boolean
    start(): {
      result: Promise<Artifact>
      isCurrent(): boolean
      cancel(): void
      release(): void
    } | null
    cleanupExactOutput(artifact: Artifact): void
  }
) {
  if (!ports.ownsSubmittedLineage(command)) return null
  const job = ports.start()
  if (!job) return null
  let exited = false
  let cancelled = false
  let releaseRequested = false
  let released = false
  let cleanupIndeterminate = false
  const release = (): void => {
    releaseRequested = true
    if (!exited || released || cleanupIndeterminate) return
    job.release()
    released = true
  }
  let artifactHeld = false
  let completedArtifact: Artifact | undefined
  const discard = (artifact: Artifact): void => {
    try {
      ports.cleanupExactOutput(artifact)
      artifactHeld = false
      cleanupIndeterminate = false
    } catch (error) {
      cleanupIndeterminate = true
      throw error
    }
  }
  const result = job.result
    .then((artifact) => {
      exited = true
      artifactHeld = true
      completedArtifact = artifact
      let current: boolean
      try {
        current = !cancelled && ports.ownsSubmittedLineage(command) && job.isCurrent()
      } catch (error) {
        try {
          discard(artifact)
        } catch {
          /* Retain uncertain custody. */
        }
        throw error
      }
      if (!current) {
        // This port must check the executor's exact output identity. It may
        // refuse cleanup when Host custody is indeterminate.
        discard(artifact)
        throw new Error('Journal publication lineage is no longer current')
      }
      return artifact
    })
    .catch((error) => {
      exited = true
      releaseRequested = true
      // Preserve the executor/validation error even if resource release fails.
      if (!cleanupIndeterminate) {
        try {
          release()
        } catch {
          /* Original terminal error remains authoritative. */
        }
      }
      throw error
    })
    .finally(() => {
      exited = true
      if (releaseRequested && !released && !cleanupIndeterminate) {
        try {
          release()
        } catch {
          /* A later explicit release may retry. */
        }
      }
    })
  return {
    result,
    isCurrent: () =>
      !cancelled && !released && ports.ownsSubmittedLineage(command) && job.isCurrent(),
    cancel: () => {
      cancelled = true
      if (!exited) {
        job.cancel()
        return
      }
      if (artifactHeld) discard(completedArtifact as Artifact)
      release()
    },
    release
  }
}
