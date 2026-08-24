import type { HostLocalServerOptions } from './HostLocalServer'
import { HostLocalServer } from './HostLocalServer'
import {
  loadOrCreateHostDiagnosticInstallIdentity,
  type HostDiagnosticInstallIdentity
} from './HostDiagnosticIdentity'
import { HostProfileAuthorityLease } from './HostProfileAuthorityLease'
import { HostSession } from './HostSession'
import { HostDiagnosticAuthority, HOST_DIAGNOSTIC_CAPABILITIES } from './HostDiagnosticAuthority'

const DEFAULT_PARENT_POLL_MS = 1_000

export type HostDiagnosticPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

export interface HostDiagnosticServerPort {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface HostDiagnosticLeasePort {
  readonly path: string
  release(): boolean
}

export interface HostDiagnosticSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface HostDiagnosticServerOptions {
  readonly profilePath: string
  readonly mode: 'diagnostic'
  readonly parentPid?: number
  readonly parentPollMs?: number
  readonly now?: () => number
  readonly isParentAlive?: (pid: number) => boolean
  readonly signalTarget?: HostDiagnosticSignalTarget
  /** Host-owned injection seam; CLI callers use the persisted opaque default. */
  readonly resolveInstallIdentity?: (canonicalProfilePath: string) => HostDiagnosticInstallIdentity
  readonly acquireLease?: (profilePath: string) => HostDiagnosticLeasePort
  readonly createServer?: (options: HostLocalServerOptions) => HostDiagnosticServerPort
}

function defaultParentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/**
 * Diagnostic-only standalone Host lifecycle.
 *
 * Lease acquisition always precedes the persisted diagnostic identity and all
 * transport artifacts. Signal and parent-loss supervision are installed while
 * the lifecycle is still `starting`, so a stop request cannot leave a late
 * listener live. Cleanup releases the lease only after server cleanup succeeds.
 */
export class HostDiagnosticServer {
  private readonly options: Required<
    Pick<HostDiagnosticServerOptions, 'now' | 'parentPollMs' | 'isParentAlive' | 'signalTarget'>
  > &
    Omit<HostDiagnosticServerOptions, 'now' | 'parentPollMs' | 'isParentAlive' | 'signalTarget'>
  private readonly shutdown = deferred()
  private readonly signalListeners = new Map<NodeJS.Signals, () => void>()
  private lease: HostDiagnosticLeasePort | null = null
  private server: HostDiagnosticServerPort | null = null
  private parentTimer: ReturnType<typeof setInterval> | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private phaseValue: HostDiagnosticPhase = 'idle'
  private stopRequested = false
  private supervisionInstalled = false

  readonly authority: HostDiagnosticAuthority
  session: HostSession | null = null
  identity: HostDiagnosticInstallIdentity | null = null

  constructor(options: HostDiagnosticServerOptions) {
    if (!options || typeof options !== 'object' || options.mode !== 'diagnostic') {
      throw new Error('Only diagnostic Host mode is implemented.')
    }
    if (
      options.parentPid !== undefined &&
      (!Number.isSafeInteger(options.parentPid) || options.parentPid < 1)
    ) {
      throw new Error('Diagnostic Host parentPid must be a positive safe integer.')
    }
    const parentPollMs = options.parentPollMs ?? DEFAULT_PARENT_POLL_MS
    if (!Number.isSafeInteger(parentPollMs) || parentPollMs < 1) {
      throw new Error('Diagnostic Host parentPollMs must be a positive integer.')
    }
    this.options = {
      ...options,
      now: options.now ?? (() => Date.now()),
      parentPollMs,
      isParentAlive: options.isParentAlive ?? defaultParentAlive,
      signalTarget: options.signalTarget ?? process
    }
    this.authority = new HostDiagnosticAuthority({ now: this.options.now })
  }

  get profilePath(): string | null {
    return this.lease?.path ?? null
  }

  get phase(): HostDiagnosticPhase {
    return this.phaseValue
  }

  get running(): boolean {
    return this.phaseValue === 'running'
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.phaseValue = 'starting'
    const start = deferred()
    this.startPromise = start.promise
    void this.startOnce().then(start.resolve, (error) => start.reject(asError(error)))
    return this.startPromise
  }

  private async startOnce(): Promise<void> {
    let startupFailure: Error | null = null
    try {
      this.lease = (
        this.options.acquireLease ??
        ((profilePath) => HostProfileAuthorityLease.acquire({ profilePath }))
      )(this.options.profilePath)
      this.installSupervision()
      if (this.stopRequested) return

      const identity = (
        this.options.resolveInstallIdentity ?? loadOrCreateHostDiagnosticInstallIdentity
      )(this.lease.path)
      const session = new HostSession({
        host: identity,
        runtime: this.authority,
        hostCapabilityOffer: HOST_DIAGNOSTIC_CAPABILITIES
      })
      this.identity = identity
      this.session = session
      this.server = (this.options.createServer ?? ((options) => new HostLocalServer(options)))({
        userDataPath: this.lease.path,
        hostId: identity.hostId,
        hostVersion: identity.hostVersion,
        session,
        authority: this.authority,
        now: this.options.now
      })
      if (this.stopRequested) return

      await this.server.start()
      if (this.stopRequested) return
      this.phaseValue = 'running'
    } catch (error) {
      startupFailure = asError(error)
    }

    if (!startupFailure) return
    this.clearSupervision()
    try {
      await this.cleanupServerThenLease()
    } catch (cleanupError) {
      this.phaseValue = 'failed'
      this.shutdown.reject(asError(cleanupError))
      throw cleanupError
    }
    this.phaseValue = 'failed'
    throw startupFailure
  }

  /**
   * Kept as an idempotent compatibility method. Supervision is installed by
   * start() before listener startup, so callers cannot attach it too late.
   */
  installProcessLifecycle(): void {
    if (!this.startPromise) {
      throw new Error('Diagnostic Host must start before lifecycle installation.')
    }
    this.installSupervision()
  }

  /** Await signal/parent-loss/manual shutdown, including cleanup failure. */
  async waitForShutdown(): Promise<void> {
    if (!this.startPromise) {
      throw new Error('Diagnostic Host must start before waiting for shutdown.')
    }
    return this.shutdown.promise
  }

  /** Idempotent stop request. A request during start waits for listener start to settle. */
  async stop(): Promise<void> {
    if (!this.startPromise) {
      throw new Error('Diagnostic Host must start before stopping.')
    }
    this.stopRequested = true
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopOnce()
    return this.stopPromise
  }

  private async stopOnce(): Promise<void> {
    this.phaseValue = 'stopping'
    try {
      await this.startPromise
    } catch (error) {
      this.phaseValue = 'failed'
      this.shutdown.reject(asError(error))
      throw error
    }
    this.clearSupervision()
    try {
      await this.cleanupServerThenLease()
    } catch (error) {
      this.phaseValue = 'failed'
      this.shutdown.reject(asError(error))
      throw error
    }
    this.phaseValue = 'stopped'
    this.shutdown.resolve()
  }

  private installSupervision(): void {
    if (this.supervisionInstalled) return
    this.supervisionInstalled = true
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = () => {
        void this.stop().catch(() => undefined)
      }
      this.signalListeners.set(signal, listener)
      this.options.signalTarget.once(signal, listener)
    }

    const parentPid = this.options.parentPid
    if (!parentPid) return
    const checkParent = (): void => {
      if (this.options.isParentAlive(parentPid)) return
      void this.stop().catch(() => undefined)
    }
    this.parentTimer = setInterval(checkParent, this.options.parentPollMs)
    this.parentTimer.unref?.()
    checkParent()
  }

  private clearSupervision(): void {
    if (this.parentTimer) {
      clearInterval(this.parentTimer)
      this.parentTimer = null
    }
    for (const [signal, listener] of this.signalListeners) {
      this.options.signalTarget.removeListener(signal, listener)
    }
    this.signalListeners.clear()
    this.supervisionInstalled = false
  }

  private async cleanupServerThenLease(): Promise<void> {
    if (this.server) {
      try {
        await this.server.stop()
      } catch (error) {
        // Keep the exact lease intact: a successor must not race residual
        // discovery/token/socket artifacts after an unproven cleanup.
        throw new Error('Diagnostic Host server cleanup failed; retaining profile authority.', {
          cause: error
        })
      }
    }
    if (this.lease && this.lease.release() !== true) {
      throw new Error('Diagnostic Host could not prove profile authority release.')
    }
    this.lease = null
    this.server = null
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
