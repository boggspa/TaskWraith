import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, resolve } from 'node:path'

/**
 * Cursor reads native-tool and MCP policy from workspace-global files under
 * `.cursor/`. Two runs in the same workspace therefore cannot safely install
 * different transient policies at the same time: the later snapshot would
 * capture the first run's overlay, and either restore order could leave the
 * wrong policy behind.
 *
 * This coordinator groups compatible runs under one installed overlay and
 * fairly queues incompatible overlays. It is deliberately independent from
 * provider admission: waiting for a shared config file never hides or rejects
 * a Cursor seat.
 *
 * Install, cleanup, and install-failure callbacks must be bounded and must not
 * acquire another lease from this coordinator. Cancellation after installation
 * starts is a quiescence barrier: the acquire promise does not settle until the
 * mutation is stable, and an all-aborted batch is restored before rejection.
 */

export type CursorWorkspaceConfigPosture = 'read-only' | 'plan' | 'write'

export type CursorWorkspaceConfigCleanupReceipt =
  | {
      readonly outcome: 'restored-verified'
    }
  | {
      readonly outcome: 'restore-attempted-unverified'
      readonly detail?: string
    }
  | {
      readonly outcome: 'cleanup-failed'
      readonly message: string
    }

export interface CursorWorkspaceConfigInstallation {
  /** Runs once after the final compatible holder releases. */
  readonly onLastRelease: () =>
    | CursorWorkspaceConfigCleanupReceipt
    | Promise<CursorWorkspaceConfigCleanupReceipt>
}

export type CursorWorkspaceConfigLegacyRestore = () => Promise<void> | void

export type CursorWorkspaceConfigInstallResult =
  | CursorWorkspaceConfigLegacyRestore
  | CursorWorkspaceConfigInstallation

export interface CursorWorkspaceConfigInstallContext {
  readonly resourceKey: string
  readonly configurationKey: string
}

export interface CursorWorkspaceConfigLeaseReleaseReceipt {
  readonly resourceKey: string
  readonly configurationKey: string
  readonly finalHolder: boolean
  readonly cleanup: CursorWorkspaceConfigCleanupReceipt | null
}

export interface CursorWorkspaceConfigLease {
  readonly resourceKey: string
  readonly configurationKey: string
  release(): Promise<CursorWorkspaceConfigLeaseReleaseReceipt>
}

export interface CursorWorkspaceConfigLeaseRequest {
  /**
   * Caller-resolved physical workspace identity. The coordinator requires an
   * absolute path and removes lexical aliases; production should resolve the
   * nearest existing ancestor first so symlink aliases cannot split the lock.
   */
  readonly resourceKey: string
  /** Stable identity of the complete transient config installed for this run. */
  readonly configurationKey: string
  /**
   * Install the transient config and return its exact cleanup operation.
   *
   * A legacy bare restore callback remains accepted for API compatibility, but
   * its cleanup receipt is intentionally `restore-attempted-unverified`.
   */
  readonly install: (
    context: CursorWorkspaceConfigInstallContext
  ) => CursorWorkspaceConfigInstallResult | Promise<CursorWorkspaceConfigInstallResult>
  /**
   * Optional recovery/truth callback when install rejects after it may have
   * mutated the workspace. Without one, rollback is reported as unproven.
   */
  readonly onInstallFailure?: (
    error: unknown,
    context: CursorWorkspaceConfigInstallContext
  ) => CursorWorkspaceConfigCleanupReceipt | Promise<CursorWorkspaceConfigCleanupReceipt>
  /** Cancellation is effective until this request has acquired a lease. */
  readonly signal?: AbortSignal
  /** Observational only; it is never awaited and failures cannot affect FIFO. */
  readonly onQueued?: () => void | Promise<void>
}

interface PendingRequest {
  readonly configurationKey: string
  readonly install: CursorWorkspaceConfigLeaseRequest['install']
  readonly onInstallFailure?: CursorWorkspaceConfigLeaseRequest['onInstallFailure']
  readonly signal?: AbortSignal
  readonly resolve: (lease: CursorWorkspaceConfigLease) => void
  readonly reject: (error: Error) => void
  abortListener?: () => void
  aborted: boolean
  settled: boolean
}

interface ActiveConfiguration {
  readonly configurationKey: string
  holders: number
  readonly installation: CursorWorkspaceConfigInstallation
}

interface ResourceState {
  active?: ActiveConfiguration
  taint?: CursorWorkspaceConfigCleanupReceipt
  installing: boolean
  restoring: boolean
  installingConfigurationKey?: string
  installingBatch?: PendingRequest[]
  queue: PendingRequest[]
}

type WorkspaceConfigCallbackPhase = 'install' | 'cleanup' | 'install-failure' | 'queued'

interface WorkspaceConfigCallbackContext {
  readonly phase: WorkspaceConfigCallbackPhase
  readonly resourceKey: string
}

export class CursorWorkspaceConfigLeaseAbortedError extends Error {
  constructor(readonly cleanup: CursorWorkspaceConfigCleanupReceipt | null = null) {
    super('Cursor workspace configuration lease was cancelled before lease admission.')
    this.name = 'CursorWorkspaceConfigLeaseAbortedError'
  }
}

export class CursorWorkspaceConfigInstallError extends Error {
  constructor(
    readonly installError: unknown,
    readonly cleanup: CursorWorkspaceConfigCleanupReceipt
  ) {
    const cleanupDetail =
      cleanup.outcome === 'restored-verified'
        ? ''
        : cleanup.outcome === 'restore-attempted-unverified'
          ? ` Cleanup was attempted but remains unverified${
              cleanup.detail ? `: ${cleanup.detail}` : '.'
            }`
          : ` Cleanup could not be proven: ${cleanup.message}`
    super(
      `Cursor workspace configuration installation failed: ${safeErrorText(
        installError
      )}.${cleanupDetail}`
    )
    this.name = 'CursorWorkspaceConfigInstallError'
  }
}

export class CursorWorkspaceConfigLeaseReentrancyError extends Error {
  constructor(readonly phase: WorkspaceConfigCallbackPhase) {
    super(
      `Cursor workspace configuration ${phase} callback cannot acquire another lease from the same coordinator.`
    )
    this.name = 'CursorWorkspaceConfigLeaseReentrancyError'
  }
}

export class CursorWorkspaceConfigLeaseTaintedError extends Error {
  constructor(readonly cleanup: CursorWorkspaceConfigCleanupReceipt) {
    const detail =
      cleanup.outcome === 'cleanup-failed'
        ? cleanup.message
        : cleanup.outcome === 'restore-attempted-unverified'
          ? cleanup.detail || 'restore outcome was unverified'
          : 'unexpected verified cleanup taint'
    super(
      `Cursor workspace configuration management is paused for this workspace because prior cleanup was not verified: ${detail}`
    )
    this.name = 'CursorWorkspaceConfigLeaseTaintedError'
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain a NUL byte.`)
  }
  return value
}

function safeErrorText(error: unknown): string {
  try {
    if (error instanceof Error) {
      try {
        if (typeof error.message === 'string' && error.message) return error.message
      } catch {
        // Fall through to guarded coercion.
      }
    }
  } catch {
    // A hostile Proxy can throw from instanceof/getPrototypeOf.
  }
  try {
    return String(error)
  } catch {
    return 'Unprintable thrown value.'
  }
}

function immutableCleanupReceipt(
  receipt: CursorWorkspaceConfigCleanupReceipt
): CursorWorkspaceConfigCleanupReceipt {
  return Object.freeze(receipt)
}

/**
 * Remove lexical aliases from a caller-resolved physical workspace identity.
 * This deliberately does not claim that resolve() discovers symlink or
 * case-folding aliases; production supplies that physical identity.
 */
export function canonicalCursorWorkspaceConfigResource(resourcePath: string): string {
  const path = requireNonEmptyString(resourcePath, 'Cursor workspace configuration resource path')
  if (!isAbsolute(path)) {
    throw new Error('Cursor workspace configuration resource path must be absolute.')
  }
  return resolve(path)
}

export function cursorWorkspaceConfigurationKey(posture: CursorWorkspaceConfigPosture): string {
  return `cursor-workspace-config:v1:${posture}`
}

/**
 * Explicit adapter for restore helpers which suppress errors or otherwise
 * cannot prove that the original bytes were restored.
 */
export function unverifiedCursorWorkspaceConfigRestore(
  restore: CursorWorkspaceConfigLegacyRestore,
  detail = 'The workspace restore helper does not expose filesystem restore failures.'
): CursorWorkspaceConfigInstallation {
  return {
    onLastRelease: async () => {
      await restore()
      return immutableCleanupReceipt({ outcome: 'restore-attempted-unverified', detail })
    }
  }
}

function normalizeCleanupReceipt(
  receipt: CursorWorkspaceConfigCleanupReceipt
): CursorWorkspaceConfigCleanupReceipt {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.outcome !== 'string') {
    throw new Error('Cursor workspace configuration cleanup returned an invalid receipt.')
  }
  switch (receipt.outcome) {
    case 'restored-verified':
      return immutableCleanupReceipt({ outcome: 'restored-verified' })
    case 'restore-attempted-unverified':
      return immutableCleanupReceipt({
        outcome: 'restore-attempted-unverified',
        ...(typeof receipt.detail === 'string' && receipt.detail.trim()
          ? { detail: receipt.detail.trim() }
          : {})
      })
    case 'cleanup-failed':
      return immutableCleanupReceipt({
        outcome: 'cleanup-failed',
        message:
          typeof receipt.message === 'string' && receipt.message.trim()
            ? receipt.message.trim()
            : 'Unknown cleanup failure.'
      })
    default:
      throw new Error('Cursor workspace configuration cleanup returned an unknown outcome.')
  }
}

function cleanupFailure(error: unknown): CursorWorkspaceConfigCleanupReceipt {
  return immutableCleanupReceipt({
    outcome: 'cleanup-failed',
    message: safeErrorText(error)
  })
}

function normalizeInstallation(
  installation: CursorWorkspaceConfigInstallResult
): CursorWorkspaceConfigInstallation {
  if (typeof installation === 'function') {
    return Object.freeze(unverifiedCursorWorkspaceConfigRestore(installation))
  }
  const onLastRelease = installation?.onLastRelease
  if (!installation || typeof onLastRelease !== 'function') {
    throw new Error(
      'Cursor workspace configuration installation must declare its last-release cleanup truth.'
    )
  }
  // Snapshot the cleanup authority returned by install. Keeping the caller's
  // mutable object would let it replace onLastRelease after admission and
  // manufacture a verified receipt without executing the admitted cleanup.
  return Object.freeze({
    onLastRelease: () => onLastRelease.call(installation)
  })
}

export class CursorWorkspaceConfigLeaseCoordinator {
  private readonly resources = new Map<string, ResourceState>()
  private readonly callbackContext = new AsyncLocalStorage<WorkspaceConfigCallbackContext>()

  acquire(request: CursorWorkspaceConfigLeaseRequest): Promise<CursorWorkspaceConfigLease> {
    let resourceKey: string
    let configurationKey: string
    try {
      resourceKey = canonicalCursorWorkspaceConfigResource(request.resourceKey)
      configurationKey = requireNonEmptyString(
        request.configurationKey,
        'Cursor workspace configuration identity'
      )
    } catch (error) {
      return Promise.reject(new Error(safeErrorText(error)))
    }

    const callbackContext = this.callbackContext.getStore()
    if (callbackContext) {
      return Promise.reject(new CursorWorkspaceConfigLeaseReentrancyError(callbackContext.phase))
    }
    if (request.signal?.aborted) {
      return Promise.reject(new CursorWorkspaceConfigLeaseAbortedError())
    }

    let state = this.resources.get(resourceKey)
    if (!state) {
      state = { installing: false, restoring: false, queue: [] }
      this.resources.set(resourceKey, state)
    }
    if (state.taint) {
      return Promise.reject(new CursorWorkspaceConfigLeaseTaintedError(state.taint))
    }

    // A compatible caller may join the active batch only while no incompatible
    // request is already waiting. Once a different posture queues, FIFO
    // fairness prevents a stream of compatible arrivals from starving it.
    if (
      state.active?.configurationKey === configurationKey &&
      state.queue.length === 0 &&
      !state.installing &&
      !state.restoring
    ) {
      state.active.holders += 1
      return Promise.resolve(this.createLease(resourceKey, configurationKey, state))
    }

    return new Promise<CursorWorkspaceConfigLease>((resolveLease, rejectLease) => {
      const pending: PendingRequest = {
        configurationKey,
        install: request.install,
        onInstallFailure: request.onInstallFailure,
        signal: request.signal,
        resolve: resolveLease,
        reject: rejectLease,
        aborted: false,
        settled: false
      }
      if (request.signal) {
        pending.abortListener = () => {
          pending.aborted = true
          const index = state!.queue.indexOf(pending)
          if (index >= 0) {
            state!.queue.splice(index, 1)
            this.rejectPending(pending, new CursorWorkspaceConfigLeaseAbortedError())
            this.admitCompatibleQueueHead(resourceKey, state!)
            if (!state!.active && !state!.installing && !state!.restoring) {
              void this.pump(resourceKey, state!)
            } else {
              this.pruneResource(resourceKey, state!)
            }
            return
          }
          // Once installation begins, cancellation is a quiescence barrier.
          // Keep the request unsettled until install is stable. If every batch
          // member aborts, pump() also awaits exact cleanup before rejection.
          this.detachAbortListener(pending)
        }
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }

      // A request arriving while the same overlay is still installing may join
      // that batch, provided an incompatible waiter has not already established
      // FIFO priority.
      if (
        state!.installing &&
        state!.installingConfigurationKey === configurationKey &&
        state!.queue.length === 0 &&
        state!.installingBatch
      ) {
        state!.installingBatch.push(pending)
        return
      }

      const queued = Boolean(
        state!.active || state!.installing || state!.restoring || state!.queue.length > 0
      )
      state!.queue.push(pending)
      if (queued) this.invokeQueuedCallback(resourceKey, request.onQueued)
      void this.pump(resourceKey, state!)
    })
  }

  snapshot(): Array<{
    resourceKey: string
    activeConfigurationKey: string | null
    activeHolders: number
    installing: boolean
    restoring: boolean
    cleanupTaint: CursorWorkspaceConfigCleanupReceipt | null
    queuedConfigurationKeys: string[]
  }> {
    return [...this.resources.entries()].map(([resourceKey, state]) => ({
      resourceKey,
      activeConfigurationKey: state.active?.configurationKey ?? null,
      activeHolders: state.active?.holders ?? 0,
      installing: state.installing,
      restoring: state.restoring,
      cleanupTaint: state.taint ?? null,
      queuedConfigurationKeys: state.queue.map((request) => request.configurationKey)
    }))
  }

  private async pump(resourceKey: string, state: ResourceState): Promise<void> {
    if (state.active || state.installing || state.restoring) return
    if (state.taint) {
      for (const request of state.queue.splice(0)) {
        this.rejectPending(request, new CursorWorkspaceConfigLeaseTaintedError(state.taint))
      }
      return
    }
    while (state.queue[0] && this.isRequestAborted(state.queue[0])) {
      const aborted = state.queue.shift()!
      this.rejectPending(aborted, new CursorWorkspaceConfigLeaseAbortedError())
    }
    const first = state.queue.shift()
    if (!first) {
      this.pruneResource(resourceKey, state)
      return
    }

    // Admit the contiguous compatible batch at the head. We intentionally do
    // not skip over a different configuration and gather later matches.
    const batch = [first]
    while (state.queue[0]?.configurationKey === first.configurationKey) {
      batch.push(state.queue.shift()!)
    }

    state.installing = true
    state.installingConfigurationKey = first.configurationKey
    state.installingBatch = batch
    const installContext: CursorWorkspaceConfigInstallContext = {
      resourceKey,
      configurationKey: first.configurationKey
    }
    try {
      const installation = normalizeInstallation(
        await this.runCallback(resourceKey, 'install', () => first.install(installContext))
      )

      // Freeze membership before any cleanup callback can await. A compatible
      // request arriving after this point belongs to the next installation.
      state.installingBatch = undefined
      const admitted = batch.filter((request) => !this.isRequestAborted(request))

      if (admitted.length === 0) {
        state.restoring = true
        let cleanup: CursorWorkspaceConfigCleanupReceipt
        try {
          cleanup = await this.cleanup(resourceKey, installation)
          this.recordCleanupTruth(state, cleanup)
        } finally {
          state.restoring = false
        }
        for (const request of batch) {
          this.rejectPending(request, new CursorWorkspaceConfigLeaseAbortedError(cleanup))
        }
      } else {
        state.active = {
          configurationKey: first.configurationKey,
          holders: admitted.length,
          installation
        }
        for (const request of batch) {
          if (this.isRequestAborted(request)) {
            this.rejectPending(request, new CursorWorkspaceConfigLeaseAbortedError())
          }
        }
        for (const request of admitted) {
          this.resolvePending(request, this.createLease(resourceKey, first.configurationKey, state))
        }
      }
    } catch (error) {
      // Do not let another compatible caller join a batch whose install has
      // already failed while failure recovery awaits.
      state.installingBatch = undefined
      state.restoring = true
      let cleanup: CursorWorkspaceConfigCleanupReceipt
      try {
        cleanup = await this.recoverInstallFailure(
          resourceKey,
          first.onInstallFailure,
          error,
          installContext
        )
        this.recordCleanupTruth(state, cleanup)
      } finally {
        state.restoring = false
      }
      const failure = new CursorWorkspaceConfigInstallError(error, cleanup)
      for (const request of batch) {
        this.rejectPending(
          request,
          this.isRequestAborted(request)
            ? new CursorWorkspaceConfigLeaseAbortedError(cleanup)
            : failure
        )
      }
    } finally {
      state.installing = false
      state.installingConfigurationKey = undefined
      state.installingBatch = undefined
      if (!state.active && !state.restoring) void this.pump(resourceKey, state)
    }
  }

  private createLease(
    resourceKey: string,
    configurationKey: string,
    state: ResourceState
  ): CursorWorkspaceConfigLease {
    let releasePromise: Promise<CursorWorkspaceConfigLeaseReleaseReceipt> | undefined
    return {
      resourceKey,
      configurationKey,
      release: () => {
        const callbackContext = this.callbackContext.getStore()
        if (callbackContext) {
          return Promise.reject(
            new CursorWorkspaceConfigLeaseReentrancyError(callbackContext.phase)
          )
        }
        // Install the idempotency promise before releaseLease can synchronously
        // enter onLastRelease. A cleanup callback that recursively releases this
        // lease then hits the reentrancy guard above instead of observing a
        // second, contradictory receipt.
        releasePromise ??= Promise.resolve().then(() =>
          this.releaseLease(resourceKey, configurationKey, state)
        )
        return releasePromise
      }
    }
  }

  private async releaseLease(
    resourceKey: string,
    configurationKey: string,
    state: ResourceState
  ): Promise<CursorWorkspaceConfigLeaseReleaseReceipt> {
    const active = state.active
    if (!active || active.configurationKey !== configurationKey || active.holders <= 0) {
      return Object.freeze({
        resourceKey,
        configurationKey,
        finalHolder: false,
        cleanup: null
      })
    }
    active.holders -= 1
    if (active.holders > 0) {
      return Object.freeze({
        resourceKey,
        configurationKey,
        finalHolder: false,
        cleanup: null
      })
    }

    // Remove the joinable active batch before restoration starts. A same-
    // posture arrival must queue too: joining here would hand it a lease while
    // the overlay is actively being removed.
    if (state.active === active) state.active = undefined
    state.restoring = true
    let cleanup: CursorWorkspaceConfigCleanupReceipt
    try {
      cleanup = await this.cleanup(resourceKey, active.installation)
      this.recordCleanupTruth(state, cleanup)
    } finally {
      state.restoring = false
      void this.pump(resourceKey, state)
    }
    return Object.freeze({ resourceKey, configurationKey, finalHolder: true, cleanup })
  }

  private async cleanup(
    resourceKey: string,
    installation: CursorWorkspaceConfigInstallation
  ): Promise<CursorWorkspaceConfigCleanupReceipt> {
    try {
      return normalizeCleanupReceipt(
        await this.runCallback(resourceKey, 'cleanup', () => installation.onLastRelease())
      )
    } catch (error) {
      return cleanupFailure(error)
    }
  }

  private async recoverInstallFailure(
    resourceKey: string,
    recover: CursorWorkspaceConfigLeaseRequest['onInstallFailure'],
    error: unknown,
    context: CursorWorkspaceConfigInstallContext
  ): Promise<CursorWorkspaceConfigCleanupReceipt> {
    if (!recover) {
      return immutableCleanupReceipt({
        outcome: 'cleanup-failed',
        message:
          'The installer rejected without an install-failure recovery receipt; rollback is not proven.'
      })
    }
    try {
      return normalizeCleanupReceipt(
        await this.runCallback(resourceKey, 'install-failure', () => recover(error, context))
      )
    } catch (recoveryError) {
      return cleanupFailure(recoveryError)
    }
  }

  private runCallback<T>(
    resourceKey: string,
    phase: WorkspaceConfigCallbackPhase,
    callback: () => T
  ): T {
    return this.callbackContext.run({ resourceKey, phase }, callback)
  }

  private invokeQueuedCallback(
    resourceKey: string,
    callback: CursorWorkspaceConfigLeaseRequest['onQueued']
  ): void {
    if (!callback) return
    try {
      const result = this.runCallback(resourceKey, 'queued', callback)
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Queue diagnostics are observational and cannot corrupt arbitration.
    }
  }

  private resolvePending(request: PendingRequest, lease: CursorWorkspaceConfigLease): void {
    if (request.settled) return
    request.settled = true
    this.detachAbortListener(request)
    request.resolve(lease)
  }

  private rejectPending(request: PendingRequest, error: Error): void {
    if (request.settled) return
    request.settled = true
    this.detachAbortListener(request)
    request.reject(error)
  }

  private detachAbortListener(request: PendingRequest): void {
    if (!request.signal || !request.abortListener) return
    request.signal.removeEventListener('abort', request.abortListener)
    request.abortListener = undefined
  }

  private admitCompatibleQueueHead(resourceKey: string, state: ResourceState): void {
    const active = state.active
    if (!active || state.installing || state.restoring) return
    while (state.queue[0]?.configurationKey === active.configurationKey) {
      const request = state.queue.shift()!
      if (this.isRequestAborted(request)) {
        this.rejectPending(request, new CursorWorkspaceConfigLeaseAbortedError())
        continue
      }
      active.holders += 1
      this.resolvePending(request, this.createLease(resourceKey, active.configurationKey, state))
    }
  }

  private isRequestAborted(request: PendingRequest): boolean {
    if (request.aborted || request.signal?.aborted) {
      request.aborted = true
      return true
    }
    return false
  }

  private recordCleanupTruth(
    state: ResourceState,
    cleanup: CursorWorkspaceConfigCleanupReceipt
  ): void {
    if (cleanup.outcome !== 'restored-verified') {
      state.taint = cleanup
    }
  }

  private pruneResource(resourceKey: string, state: ResourceState): void {
    if (
      !state.active &&
      !state.taint &&
      !state.installing &&
      !state.restoring &&
      state.queue.length === 0
    ) {
      this.resources.delete(resourceKey)
    }
  }
}
