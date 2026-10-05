/**
 * Before a queued run reaches its provider, wait for the write containing
 * its starting lease. The store installs an exact-generation, bounded wait
 * under barrier durability. With the switch off this adds no wait.
 */
type RunQueueStartWait = (runId: string) => Promise<void> | null

let installed: RunQueueStartWait | null = null

export function installRunQueueStartWait(wait: RunQueueStartWait | null): void {
  installed = wait
}

export function awaitRunQueueStart(runId: string | undefined): Promise<void> | null {
  return runId ? (installed?.(runId) ?? null) : null
}
