import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

/**
 * Cursor's approved MCP server catalogue lives in one process-global file:
 * `~/.cursor/mcp.json`. A Cursor run may need a different TaskWraith broker
 * profile (full, plan, read-only, core, or gateway), but every profile uses the
 * same approved server name. Overwriting that entry while another run is live
 * can therefore make the older run observe the newer run's tool surface.
 *
 * This coordinator leases the canonical registry resource. Exact, compatible
 * registration descriptors may share an installation; incompatible
 * descriptors wait in FIFO order. It does not decide whether Cursor is offered
 * or runnable, and cancellation only withdraws a waiting setup request.
 *
 * Integration lock order is part of the contract: acquire this global lease
 * before a workspace-config lease, then release the workspace lease before
 * this one. Install and cleanup callbacks must be bounded and must never await
 * another acquisition on this coordinator; either would self-deadlock the
 * resource (a runtime reentrancy guard also fails that pattern fast). An
 * installer should commit atomically; if it rejects, its mandatory failure
 * callback owns rollback and must report whether recovery was verified.
 * An unverified or failed install/release cleanup taints that physical
 * registry for this coordinator lifetime: queued and future broker attachments
 * reject into the caller's visible native-only Cursor fallback instead of
 * snapshotting uncertain state. `retained-persistent` and `restored-verified`
 * are the only receipts that permit the next incompatible installation.
 * Production must use the exported process-wide instance below; constructing
 * one coordinator per run would create independent locks and restore the race.
 */

export type CursorGlobalBrokerJson =
  | null
  | boolean
  | number
  | string
  | CursorGlobalBrokerJson[]
  | { [key: string]: CursorGlobalBrokerJson }

export interface CursorGlobalBrokerRegistrationDescriptor {
  /** The exact TaskWraith-owned entries passed to the global registry merge. */
  readonly brokerEntries: Readonly<Record<string, unknown>>
  /** App-owned obsolete aliases removed by the same merge operation. */
  readonly removeServerNames?: readonly string[]
}

export interface NormalizedCursorGlobalBrokerRegistrationDescriptor {
  readonly brokerEntries: Readonly<Record<string, CursorGlobalBrokerJson>>
  readonly removeServerNames: readonly string[]
}

/**
 * Cleanup truth is reported by the installer, not inferred by the coordinator.
 *
 * `restore-attempted-unverified` is the required result when wrapping a helper
 * that catches or suppresses filesystem restore errors. Only a cleanup path
 * that verifies its owned entries while preserving unrelated concurrent
 * registry changes may report `restored-verified`; a blind whole-file rewrite
 * is not sufficient evidence. Installers must document the exact captured
 * filesystem state that outcome proves; it is not implicitly a claim about
 * metadata their runtime cannot observe.
 */
export type CursorGlobalBrokerRegistryCleanupReceipt =
  | {
      readonly outcome: 'retained-persistent'
    }
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

export interface CursorGlobalBrokerRegistryInstallation {
  /**
   * Runs once, after the final compatible holder releases, and is awaited
   * before an incompatible installation begins.
   *
   * Durable global registrations normally return `retained-persistent`.
   */
  readonly onLastRelease: () =>
    | CursorGlobalBrokerRegistryCleanupReceipt
    | Promise<CursorGlobalBrokerRegistryCleanupReceipt>
}

export interface CursorGlobalBrokerRegistryInstallContext {
  readonly resourceKey: string
  readonly registrationKey: string
  readonly descriptor: NormalizedCursorGlobalBrokerRegistrationDescriptor
}

export interface CursorGlobalBrokerRegistryLeaseRequest extends CursorGlobalBrokerRegistrationDescriptor {
  /** Absolute global registry path; lexical aliases are normalized with resolve(). */
  readonly registryPath: string
  /**
   * Optional caller-resolved physical identity for the same registry. Production
   * should resolve the nearest existing ancestor so aliases cannot create two
   * locks for one physical `mcp.json`.
   */
  readonly canonicalRegistryResourcePath?: string
  readonly install: (
    context: CursorGlobalBrokerRegistryInstallContext
  ) => CursorGlobalBrokerRegistryInstallation | Promise<CursorGlobalBrokerRegistryInstallation>
  /**
   * Required rollback/truth path for an install that rejects after it may have
   * mutated the registry. It is awaited before callers settle or another
   * profile installs.
   */
  readonly onInstallFailure: (
    error: unknown,
    context: CursorGlobalBrokerRegistryInstallContext
  ) => CursorGlobalBrokerRegistryCleanupReceipt | Promise<CursorGlobalBrokerRegistryCleanupReceipt>
  /** Cancellation is effective until this request has acquired a lease. */
  readonly signal?: AbortSignal
  /** Observational only; exceptions cannot disturb arbitration. */
  readonly onQueued?: () => void
}

export interface CursorGlobalBrokerRegistryLeaseReleaseReceipt {
  readonly resourceKey: string
  readonly registrationKey: string
  readonly finalHolder: boolean
  readonly cleanup: CursorGlobalBrokerRegistryCleanupReceipt | null
}

export interface CursorGlobalBrokerRegistryLease {
  readonly resourceKey: string
  readonly registrationKey: string
  release(): Promise<CursorGlobalBrokerRegistryLeaseReleaseReceipt>
}

interface PendingRequest {
  readonly registrationKey: string
  readonly descriptor: NormalizedCursorGlobalBrokerRegistrationDescriptor
  readonly install: CursorGlobalBrokerRegistryLeaseRequest['install']
  readonly onInstallFailure: CursorGlobalBrokerRegistryLeaseRequest['onInstallFailure']
  readonly signal?: AbortSignal
  readonly resolve: (lease: CursorGlobalBrokerRegistryLease) => void
  readonly reject: (error: Error) => void
  abortListener?: () => void
  aborted: boolean
  settled: boolean
}

interface ActiveRegistration {
  readonly registrationKey: string
  holders: number
  readonly installation: CursorGlobalBrokerRegistryInstallation
}

export type CursorGlobalBrokerRegistryTaintPhase =
  | 'install-failure'
  | 'last-release'
  | 'aborted-install-cleanup'

interface RegistryTaint {
  readonly phase: CursorGlobalBrokerRegistryTaintPhase
  readonly cleanup: CursorGlobalBrokerRegistryCleanupReceipt
}

interface RegistryState {
  active?: ActiveRegistration
  installing: boolean
  releasing: boolean
  installingRegistrationKey?: string
  installingBatch?: PendingRequest[]
  queue: PendingRequest[]
  taint?: RegistryTaint
}

export class CursorGlobalBrokerRegistryLeaseAbortedError extends Error {
  constructor(readonly cleanup: CursorGlobalBrokerRegistryCleanupReceipt | null = null) {
    super('Cursor global broker registry lease was cancelled before lease admission.')
    this.name = 'CursorGlobalBrokerRegistryLeaseAbortedError'
  }
}

export class CursorGlobalBrokerRegistryInstallError extends Error {
  constructor(
    readonly installError: unknown,
    readonly cleanup: CursorGlobalBrokerRegistryCleanupReceipt
  ) {
    super(
      `Cursor global broker registry installation failed: ${
        installError instanceof Error ? installError.message : String(installError)
      }`
    )
    this.name = 'CursorGlobalBrokerRegistryInstallError'
  }
}

/**
 * An uncertain cleanup blocks further broker attachment for this coordinator
 * lifetime. Callers should keep Cursor available in native-only mode; creating
 * another coordinator to bypass this evidence would recreate the registry race.
 */
export class CursorGlobalBrokerRegistryTaintedError extends Error {
  constructor(
    readonly resourceKey: string,
    readonly phase: CursorGlobalBrokerRegistryTaintPhase,
    readonly cleanup: CursorGlobalBrokerRegistryCleanupReceipt
  ) {
    const detail =
      cleanup.outcome === 'cleanup-failed'
        ? `: ${cleanup.message}`
        : cleanup.outcome === 'restore-attempted-unverified' && cleanup.detail
          ? `: ${cleanup.detail}`
          : ''
    super(
      `Cursor global broker registry lease is tainted after ${phase} (${cleanup.outcome}${detail}); broker attachment is skipped for this process, while Cursor remains available in native-only mode.`
    )
    this.name = 'CursorGlobalBrokerRegistryTaintedError'
  }
}

export class CursorGlobalBrokerRegistryReentrancyError extends Error {
  constructor(readonly phase: 'install' | 'cleanup' | 'install-failure') {
    super(
      `Cursor global broker registry ${phase} callback cannot acquire another lease from the same coordinator.`
    )
    this.name = 'CursorGlobalBrokerRegistryReentrancyError'
  }
}

interface RegistryCallbackContext {
  readonly phase: 'install' | 'cleanup' | 'install-failure'
  readonly resourceKey: string
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

/** Lexical canonicalization matching TaskWraith's existing canonicalPath(). */
export function canonicalCursorGlobalBrokerRegistryResource(registryPath: string): string {
  const path = requireNonEmptyString(registryPath, 'Cursor global MCP registry path')
  if (!isAbsolute(path)) {
    throw new Error('Cursor global MCP registry path must be absolute.')
  }
  // Production must pass its one hard-wired app.getPath('home') location.
  // resolve() removes lexical aliases. It deliberately does not claim physical
  // realpath/case identity for arbitrary caller-supplied paths.
  return resolve(path)
}

function normalizeJson(
  value: unknown,
  label: string,
  ancestors: WeakSet<object>
): CursorGlobalBrokerJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only finite JSON numbers.`)
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON values.`)
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain circular references.`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const normalized: CursorGlobalBrokerJson[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error(`${label} must not contain sparse arrays.`)
        }
        normalized.push(normalizeJson(value[index], `${label}[${index}]`, ancestors))
      }
      return normalized
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects.`)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${label} must not contain symbol-keyed values.`)
    }
    const record = value as Record<string, unknown>
    // A normal `{}` assignment would invoke the legacy __proto__ setter,
    // silently dropping that own JSON key and colliding with a different
    // descriptor. Null-prototype records plus defineProperty preserve every
    // exact enumerable string key.
    const normalized = Object.create(null) as Record<string, CursorGlobalBrokerJson>
    for (const key of Object.keys(record).sort()) {
      Object.defineProperty(normalized, key, {
        value: normalizeJson(record[key], `${label}.${key}`, ancestors),
        enumerable: true,
        configurable: false,
        writable: false
      })
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

function deepFreezeJson<T extends CursorGlobalBrokerJson>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(child)
    }
    Object.freeze(value)
  }
  return value
}

export function normalizeCursorGlobalBrokerRegistrationDescriptor(
  descriptor: CursorGlobalBrokerRegistrationDescriptor
): NormalizedCursorGlobalBrokerRegistrationDescriptor {
  const brokerEntries = normalizeJson(
    descriptor.brokerEntries,
    'Cursor global broker entries',
    new WeakSet()
  )
  if (!brokerEntries || Array.isArray(brokerEntries) || typeof brokerEntries !== 'object') {
    throw new Error('Cursor global broker entries must be a JSON object.')
  }
  const names = descriptor.removeServerNames ?? []
  const removeServerNames = [
    ...new Set(
      names.map((name) => requireNonEmptyString(name, 'Cursor global broker removal name'))
    )
  ].sort()
  return Object.freeze({
    brokerEntries: deepFreezeJson(brokerEntries),
    removeServerNames: Object.freeze(removeServerNames)
  })
}

export function cursorGlobalBrokerRegistrationKey(
  descriptor: CursorGlobalBrokerRegistrationDescriptor
): string {
  const normalized = normalizeCursorGlobalBrokerRegistrationDescriptor(descriptor)
  const digest = createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
  return `cursor-global-broker-registration:v1:sha256:${digest}`
}

export function retainedCursorGlobalBrokerRegistration(): CursorGlobalBrokerRegistryInstallation {
  return {
    onLastRelease: () => ({ outcome: 'retained-persistent' })
  }
}

/**
 * Adapts a restore callback that cannot report failure. The resulting receipt
 * intentionally remains unverified even when the callback returns normally.
 */
export function unverifiedCursorGlobalBrokerRestore(
  restore: () => void | Promise<void>,
  detail = 'The restore helper does not expose filesystem restore failures.'
): CursorGlobalBrokerRegistryInstallation {
  return {
    onLastRelease: async () => {
      await restore()
      return { outcome: 'restore-attempted-unverified', detail }
    }
  }
}

function normalizeCleanupReceipt(
  receipt: CursorGlobalBrokerRegistryCleanupReceipt
): CursorGlobalBrokerRegistryCleanupReceipt {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.outcome !== 'string') {
    throw new Error('Cursor global broker cleanup returned an invalid receipt.')
  }
  switch (receipt.outcome) {
    case 'retained-persistent':
    case 'restored-verified':
      return Object.freeze({ outcome: receipt.outcome })
    case 'restore-attempted-unverified':
      return Object.freeze({
        outcome: receipt.outcome,
        ...(typeof receipt.detail === 'string' && receipt.detail.trim()
          ? { detail: receipt.detail.trim() }
          : {})
      })
    case 'cleanup-failed':
      return Object.freeze({
        outcome: receipt.outcome,
        message:
          typeof receipt.message === 'string' && receipt.message.trim()
            ? receipt.message.trim()
            : 'Unknown cleanup failure.'
      })
    default:
      throw new Error('Cursor global broker cleanup returned an unknown receipt outcome.')
  }
}

function cleanupFailure(error: unknown): CursorGlobalBrokerRegistryCleanupReceipt {
  return Object.freeze({
    outcome: 'cleanup-failed',
    message: error instanceof Error ? error.message : String(error)
  })
}

export class CursorGlobalBrokerRegistryLeaseCoordinator {
  private readonly registries = new Map<string, RegistryState>()
  private readonly callbackContext = new AsyncLocalStorage<RegistryCallbackContext>()

  acquire(
    request: CursorGlobalBrokerRegistryLeaseRequest
  ): Promise<CursorGlobalBrokerRegistryLease> {
    let resourceKey: string
    let descriptor: NormalizedCursorGlobalBrokerRegistrationDescriptor
    try {
      const registryPath = canonicalCursorGlobalBrokerRegistryResource(request.registryPath)
      resourceKey = request.canonicalRegistryResourcePath
        ? canonicalCursorGlobalBrokerRegistryResource(request.canonicalRegistryResourcePath)
        : registryPath
      descriptor = normalizeCursorGlobalBrokerRegistrationDescriptor(request)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const callbackContext = this.callbackContext.getStore()
    if (callbackContext) {
      return Promise.reject(new CursorGlobalBrokerRegistryReentrancyError(callbackContext.phase))
    }
    if (typeof request.install !== 'function') {
      return Promise.reject(
        new Error('Cursor global broker registry install callback is required.')
      )
    }
    if (typeof request.onInstallFailure !== 'function') {
      return Promise.reject(
        new Error('Cursor global broker registry install-failure recovery callback is required.')
      )
    }
    if (request.signal?.aborted) {
      return Promise.reject(new CursorGlobalBrokerRegistryLeaseAbortedError())
    }
    const registrationKey = cursorGlobalBrokerRegistrationKey(descriptor)

    let state = this.registries.get(resourceKey)
    if (!state) {
      state = { installing: false, releasing: false, queue: [] }
      this.registries.set(resourceKey, state)
    }
    if (state.taint) {
      return Promise.reject(
        new CursorGlobalBrokerRegistryTaintedError(
          resourceKey,
          state.taint.phase,
          state.taint.cleanup
        )
      )
    }

    // Once an incompatible request is waiting, new compatible arrivals queue
    // behind it instead of starving it.
    if (
      state.active?.registrationKey === registrationKey &&
      state.queue.length === 0 &&
      !state.installing &&
      !state.releasing
    ) {
      state.active.holders += 1
      return Promise.resolve(this.createLease(resourceKey, registrationKey, state))
    }

    return new Promise<CursorGlobalBrokerRegistryLease>((resolveLease, rejectLease) => {
      const pending: PendingRequest = {
        registrationKey,
        descriptor,
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
            this.rejectPending(pending, new CursorGlobalBrokerRegistryLeaseAbortedError())
            this.admitCompatibleQueueHead(resourceKey, state!)
            if (!state!.active && !state!.installing && !state!.releasing) {
              void this.pump(resourceKey, state!)
            } else {
              this.pruneRegistry(resourceKey, state!)
            }
            return
          }
          // Once installation has begun, cancellation is a quiescence barrier:
          // keep the acquire Promise pending until the install is stable. If
          // every compatible member aborted, pump() also awaits cleanup before
          // rejecting them and includes that cleanup truth on the error.
          this.detachAbortListener(pending)
        }
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }

      if (
        state!.installing &&
        state!.installingRegistrationKey === registrationKey &&
        state!.queue.length === 0 &&
        state!.installingBatch
      ) {
        state!.installingBatch.push(pending)
        return
      }

      const queued = Boolean(
        state!.active || state!.installing || state!.releasing || state!.queue.length > 0
      )
      state!.queue.push(pending)
      if (queued) {
        try {
          request.onQueued?.()
        } catch {
          // Diagnostics are observational and cannot corrupt lease ownership.
        }
      }
      void this.pump(resourceKey, state!)
    })
  }

  snapshot(): Array<{
    resourceKey: string
    activeRegistrationKey: string | null
    activeHolders: number
    installing: boolean
    releasing: boolean
    queuedRegistrationKeys: string[]
    taint: Readonly<{
      phase: CursorGlobalBrokerRegistryTaintPhase
      cleanup: CursorGlobalBrokerRegistryCleanupReceipt
    }> | null
  }> {
    return [...this.registries.entries()].map(([resourceKey, state]) => ({
      resourceKey,
      activeRegistrationKey: state.active?.registrationKey ?? null,
      activeHolders: state.active?.holders ?? 0,
      installing: state.installing,
      releasing: state.releasing,
      queuedRegistrationKeys: state.queue.map((request) => request.registrationKey),
      taint: state.taint
        ? Object.freeze({
            phase: state.taint.phase,
            cleanup: state.taint.cleanup
          })
        : null
    }))
  }

  private async pump(resourceKey: string, state: RegistryState): Promise<void> {
    if (state.active || state.installing || state.releasing) return
    if (state.taint) {
      this.rejectTaintedQueue(resourceKey, state)
      return
    }
    while (state.queue[0]?.aborted) {
      const aborted = state.queue.shift()!
      this.rejectPending(aborted, new CursorGlobalBrokerRegistryLeaseAbortedError())
    }
    const first = state.queue.shift()
    if (!first) {
      this.pruneRegistry(resourceKey, state)
      return
    }

    const batch = [first]
    while (state.queue[0]?.registrationKey === first.registrationKey) {
      batch.push(state.queue.shift()!)
    }
    state.installing = true
    state.installingRegistrationKey = first.registrationKey
    state.installingBatch = batch
    const installContext: CursorGlobalBrokerRegistryInstallContext = {
      resourceKey,
      registrationKey: first.registrationKey,
      descriptor: first.descriptor
    }
    try {
      const installation = await this.runRegistryCallback(resourceKey, 'install', () =>
        first.install(installContext)
      )
      if (!installation || typeof installation.onLastRelease !== 'function') {
        throw new Error(
          'Cursor global broker installation must declare its last-release cleanup truth.'
        )
      }

      // Freeze membership before any last-release callback can await. A later
      // compatible request belongs to a new batch.
      state.installingBatch = undefined
      const admitted = batch.filter((request) => !request.aborted)

      if (admitted.length === 0) {
        state.releasing = true
        let cleanup: CursorGlobalBrokerRegistryCleanupReceipt
        try {
          cleanup = await this.cleanup(resourceKey, installation)
        } finally {
          state.releasing = false
        }
        this.taintAfterUncertainCleanup(resourceKey, state, 'aborted-install-cleanup', cleanup)
        for (const request of batch) {
          this.rejectPending(request, new CursorGlobalBrokerRegistryLeaseAbortedError(cleanup))
        }
      } else {
        state.active = {
          registrationKey: first.registrationKey,
          holders: admitted.length,
          installation
        }
        for (const request of batch) {
          if (request.aborted) {
            this.rejectPending(request, new CursorGlobalBrokerRegistryLeaseAbortedError())
          }
        }
        for (const request of admitted) {
          this.resolvePending(request, this.createLease(resourceKey, first.registrationKey, state))
        }
      }
    } catch (error) {
      // The failed batch owns recovery, but a request arriving during that
      // recovery must queue for a fresh installation rather than joining work
      // that has already failed.
      state.installingBatch = undefined
      state.installingRegistrationKey = undefined
      const cleanup = await this.recoverInstallFailure(
        resourceKey,
        first.onInstallFailure,
        error,
        installContext
      )
      this.taintAfterUncertainCleanup(resourceKey, state, 'install-failure', cleanup)
      const failure = new CursorGlobalBrokerRegistryInstallError(error, cleanup)
      for (const request of batch) {
        this.rejectPending(
          request,
          request.aborted ? new CursorGlobalBrokerRegistryLeaseAbortedError(cleanup) : failure
        )
      }
    } finally {
      state.installing = false
      state.installingRegistrationKey = undefined
      state.installingBatch = undefined
      if (!state.active && !state.releasing) void this.pump(resourceKey, state)
    }
  }

  private createLease(
    resourceKey: string,
    registrationKey: string,
    state: RegistryState
  ): CursorGlobalBrokerRegistryLease {
    let releasePromise: Promise<CursorGlobalBrokerRegistryLeaseReleaseReceipt> | undefined
    return {
      resourceKey,
      registrationKey,
      release: () => {
        releasePromise ??= this.releaseLease(resourceKey, registrationKey, state)
        return releasePromise
      }
    }
  }

  private async releaseLease(
    resourceKey: string,
    registrationKey: string,
    state: RegistryState
  ): Promise<CursorGlobalBrokerRegistryLeaseReleaseReceipt> {
    const active = state.active
    if (!active || active.registrationKey !== registrationKey || active.holders <= 0) {
      return { resourceKey, registrationKey, finalHolder: false, cleanup: null }
    }
    active.holders -= 1
    if (active.holders > 0) {
      return { resourceKey, registrationKey, finalHolder: false, cleanup: null }
    }

    if (state.active === active) state.active = undefined
    state.releasing = true
    let cleanup: CursorGlobalBrokerRegistryCleanupReceipt
    try {
      cleanup = await this.cleanup(resourceKey, active.installation)
      this.taintAfterUncertainCleanup(resourceKey, state, 'last-release', cleanup)
    } finally {
      state.releasing = false
      void this.pump(resourceKey, state)
    }
    return { resourceKey, registrationKey, finalHolder: true, cleanup }
  }

  private async cleanup(
    resourceKey: string,
    installation: CursorGlobalBrokerRegistryInstallation
  ): Promise<CursorGlobalBrokerRegistryCleanupReceipt> {
    try {
      return normalizeCleanupReceipt(
        await this.runRegistryCallback(resourceKey, 'cleanup', () => installation.onLastRelease())
      )
    } catch (error) {
      return cleanupFailure(error)
    }
  }

  private async recoverInstallFailure(
    resourceKey: string,
    recover: CursorGlobalBrokerRegistryLeaseRequest['onInstallFailure'],
    error: unknown,
    context: CursorGlobalBrokerRegistryInstallContext
  ): Promise<CursorGlobalBrokerRegistryCleanupReceipt> {
    try {
      return normalizeCleanupReceipt(
        await this.runRegistryCallback(resourceKey, 'install-failure', () =>
          recover(error, context)
        )
      )
    } catch (recoveryError) {
      return cleanupFailure(recoveryError)
    }
  }

  private runRegistryCallback<T>(
    resourceKey: string,
    phase: RegistryCallbackContext['phase'],
    callback: () => T
  ): T {
    return this.callbackContext.run({ resourceKey, phase }, callback)
  }

  private resolvePending(request: PendingRequest, lease: CursorGlobalBrokerRegistryLease): void {
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

  private taintAfterUncertainCleanup(
    resourceKey: string,
    state: RegistryState,
    phase: CursorGlobalBrokerRegistryTaintPhase,
    cleanup: CursorGlobalBrokerRegistryCleanupReceipt
  ): void {
    if (
      cleanup.outcome !== 'restore-attempted-unverified' &&
      cleanup.outcome !== 'cleanup-failed'
    ) {
      return
    }
    state.taint ??= Object.freeze({ phase, cleanup })
    this.rejectTaintedQueue(resourceKey, state)
  }

  private rejectTaintedQueue(resourceKey: string, state: RegistryState): void {
    const taint = state.taint
    if (!taint) return
    for (const request of state.queue.splice(0)) {
      this.rejectPending(
        request,
        request.aborted
          ? new CursorGlobalBrokerRegistryLeaseAbortedError(taint.cleanup)
          : new CursorGlobalBrokerRegistryTaintedError(resourceKey, taint.phase, taint.cleanup)
      )
    }
  }

  private admitCompatibleQueueHead(resourceKey: string, state: RegistryState): void {
    const active = state.active
    if (!active || state.installing || state.releasing) return
    while (state.queue[0]?.registrationKey === active.registrationKey) {
      const request = state.queue.shift()!
      if (request.aborted) {
        this.rejectPending(request, new CursorGlobalBrokerRegistryLeaseAbortedError())
        continue
      }
      active.holders += 1
      this.resolvePending(request, this.createLease(resourceKey, active.registrationKey, state))
    }
  }

  private pruneRegistry(resourceKey: string, state: RegistryState): void {
    if (
      !state.taint &&
      !state.active &&
      !state.installing &&
      !state.releasing &&
      state.queue.length === 0
    ) {
      this.registries.delete(resourceKey)
    }
  }
}

/** The one process-wide arbiter production Cursor launches should share. */
export const cursorGlobalBrokerRegistryLeases = new CursorGlobalBrokerRegistryLeaseCoordinator()
