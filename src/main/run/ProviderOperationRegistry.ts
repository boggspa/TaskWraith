export class ProviderOperationRegistry {
  private readonly operations = new Map<string, Promise<void>>()

  track(runId: string, operation: Promise<void>): Promise<void> {
    const id = runId.trim()
    if (!id) throw new Error('Provider operation requires an exact run id.')
    if (this.operations.has(id)) {
      throw new Error(`Provider operation is already tracked for run ${id}.`)
    }
    const tracked = Promise.resolve(operation)
    this.operations.set(id, tracked)
    void tracked
      .finally(() => {
        if (this.operations.get(id) === tracked) this.operations.delete(id)
      })
      .catch(() => {})
    return tracked
  }

  get(runId: string): Promise<void> | undefined {
    return this.operations.get(runId)
  }
}

/** Re-evaluate launch authority after an awaited setup/preflight boundary.
 * Before RunManager registration there may be no session to authorize yet;
 * after registration, the exact persistence authority is mandatory. */
export function providerTransportAdmissionStillAuthorized(input: {
  historyBlocked: boolean
  sessionExists: boolean
  persistenceAuthorized: boolean
}): boolean {
  return !input.historyBlocked && (!input.sessionExists || input.persistenceAuthorized)
}

export interface ProviderTransportCloseOperation {
  operation: Promise<void>
  markTransportClosed(): void
}

export interface ProviderTerminalProjectionOperation {
  operation: Promise<void>
  markTerminalProjectionComplete(): void
}

/**
 * Build the exact settlement promise for a one-shot child transport. The
 * operation cannot settle before the child close callback is observed, and it
 * remains live until provider-owned cleanup has finished. Cleanup is
 * best-effort to preserve the ordinary provider lifecycle, but a failed
 * cleanup still has to settle before destructive-history callers may proceed.
 */
export function createProviderTransportCloseOperation(
  cleanup?: () => Promise<void> | void
): ProviderTransportCloseOperation {
  let closeObserved = false
  let resolveOperation!: () => void
  const operation = new Promise<void>((resolve) => {
    resolveOperation = resolve
  })

  return {
    operation,
    markTransportClosed(): void {
      if (closeObserved) return
      closeObserved = true
      void Promise.resolve()
        .then(() => cleanup?.())
        .catch(() => undefined)
        .then(resolveOperation)
    }
  }
}

/**
 * Build the exact settlement promise for a provider transport that remains
 * alive across runs (for example, Codex app-server). The shared daemon closing
 * is not per-run terminal evidence: only the exact turn's terminal
 * notification, after its main-owned projection has finished, may settle the
 * operation joined by destructive-history deletion.
 */
export function createProviderTerminalProjectionOperation(): ProviderTerminalProjectionOperation {
  let projectionComplete = false
  let resolveOperation!: () => void
  const operation = new Promise<void>((resolve) => {
    resolveOperation = resolve
  })

  return {
    operation,
    markTerminalProjectionComplete(): void {
      if (projectionComplete) return
      projectionComplete = true
      resolveOperation()
    }
  }
}

export async function waitForProviderOperationSettlement(
  operation: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
