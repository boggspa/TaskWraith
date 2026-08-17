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

export interface ForceKillableProviderProcess {
  readonly exitCode?: number | null
  kill(signal?: unknown): unknown
}

/**
 * A bounded escalation for opaque CLI transports whose ordinary SIGTERM can
 * be ignored. The exact close callback clears the run-keyed timer; otherwise
 * the same child receives SIGKILL after the grace period.
 */
export class ProviderProcessTerminationBackstop {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly graceMs: number) {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error('Provider termination grace must be a non-negative duration.')
    }
  }

  arm(runId: string, process: ForceKillableProviderProcess): void {
    const id = runId.trim()
    if (!id) throw new Error('Provider termination backstop requires an exact run id.')
    this.clear(id)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      if (process.exitCode !== null && process.exitCode !== undefined) return
      try {
        process.kill('SIGKILL')
      } catch {
        // The exact close callback remains authoritative if the process raced
        // this escalation or the host could no longer signal it.
      }
    }, this.graceMs)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  clear(runId: string | undefined): void {
    const id = runId?.trim()
    if (!id) return
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  has(runId: string): boolean {
    return this.timers.has(runId.trim())
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

/**
 * Final post-await launch fence. A provider transport needs all three
 * independent authorities at the same instant: an unclaimed active
 * RunManager owner, durable persistence authority, and a live setup signal.
 */
export function providerTransportLaunchStillAuthorized(input: {
  historyBlocked: boolean
  persistenceAuthorized: boolean
  runAdmitted: boolean
  setupSignal?: AbortSignal
}): boolean {
  return (
    input.runAdmitted &&
    !input.setupSignal?.aborted &&
    providerTransportAdmissionStillAuthorized({
      historyBlocked: input.historyBlocked,
      sessionExists: true,
      persistenceAuthorized: input.persistenceAuthorized
    })
  )
}

/**
 * Name the limb that denied a launch, for diagnostics only.
 *
 * `providerTransportLaunchStillAuthorized` answers yes/no, which is all an
 * authorization decision needs — but a caller that skips work on a `false` has
 * nothing to tell the operator, and a downstream failure then gets blamed on
 * whatever surfaced it. Checks the limbs in the same order and with the same
 * predicates as the decision above, so the two cannot disagree.
 *
 * Returns null when the input WOULD authorize. Never call this to authorize.
 */
export function explainProviderTransportLaunchDenial(input: {
  historyBlocked: boolean
  persistenceAuthorized: boolean
  runAdmitted: boolean
  setupSignal?: AbortSignal
}): string | null {
  if (!input.runAdmitted) return 'run admission denied'
  if (input.setupSignal?.aborted) return 'setup signal aborted'
  if (input.historyBlocked) return 'history clear admission blocked'
  if (!input.persistenceAuthorized) return 'run persistence authority denied'
  return null
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
