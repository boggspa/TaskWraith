export interface MainProviderTerminationSession<Provider> {
  provider: Provider
  status: string
  process?: { kill(signal: 'SIGKILL'): unknown } | null
}

export interface MainProviderRunTerminationPorts<Provider> {
  getSession(runId: string): MainProviderTerminationSession<Provider> | undefined
  getOperations(runId: string): readonly Promise<void>[]
  isActive(status: string): boolean
  terminate(provider: Provider, runId: string): Promise<boolean>
  wait(operation: Promise<void>, timeoutMs: number): Promise<boolean>
}

/** Joins only the exact main-owned session; never edits history or Host leases. */
export async function terminateAndJoinMainProviderRun<Provider>(
  ports: MainProviderRunTerminationPorts<Provider>,
  provider: Provider,
  runId: string
): Promise<boolean> {
  const session = ports.getSession(runId)
  const operations = [...new Set(ports.getOperations(runId))]
  const join = (timeout: number): Promise<boolean[]> =>
    Promise.all(operations.map((operation) => ports.wait(operation, timeout)))
  if (!session) return operations.length > 0 && (await join(10_000)).every(Boolean)
  if (session.provider !== provider) return false
  const active = (): boolean => ports.isActive(ports.getSession(runId)?.status ?? 'cancelled')
  const stopped = ports.isActive(session.status) ? await ports.terminate(provider, runId) : true
  if (!stopped && active()) return false
  if (operations.length > 0) {
    let settled = await join(5_000)
    if (!settled.every(Boolean)) {
      try {
        session.process?.kill('SIGKILL')
      } catch {
        // Exact child may already have exited.
      }
      settled = await join(5_000)
    }
    if (!settled.every(Boolean)) return false
  }
  return !active()
}
