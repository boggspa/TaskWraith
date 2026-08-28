/**
 * Production pure-Node Host lifecycle.
 *
 * This server is deliberately independent of a parent PID, Electron, and
 * connection lifetime. It acquires profile authority before identity/store/
 * runtime/listener work; stop releases that authority only after every owned
 * resource has cleaned up successfully.
 */

import type { HostCapability, HostHealthProjection } from '../shared/hostProtocol'
import { join } from 'node:path'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import { HostLocalServer } from '../host-runtime/HostLocalServer'
import { HostProfileAuthorityLease } from '../host-runtime/HostProfileAuthorityLease'
import {
  assertHostMayOpenProfileWriters,
  writeHostProfileWriterFence
} from '../host-runtime/HostProfileWriterFence'
import { HostProfileDomainStore } from '../host-runtime/HostProfileDomainStore'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput
} from '../host-runtime/HostStandaloneComposition'
import type { HostSessionHostIdentity } from '../host-runtime/HostSession'
import { HostNodeDomainPorts, type HostNodeDomainPortsOptions } from './HostNodeDomainPorts'

export type HostNodeProductionPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'

export interface HostNodeProductionLease {
  readonly path: string
  assertHeld(): void
  release(): boolean
}

export interface HostNodeProductionListener {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface HostNodeProductionSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface HostNodeProductionServerOptions {
  readonly profilePath: string
  readonly mode: 'production'
  readonly domainOptions?: Omit<HostNodeDomainPortsOptions, 'store' | 'events'>
  /** Lease-late resource assembly; runs only after lease → identity → store. */
  readonly createDomainResources?: (input: {
    readonly profilePath: string
    readonly identity: HostSessionHostIdentity
    readonly store: HostProfileDomainStore
  }) => Promise<{
    readonly domainOptions: Omit<HostNodeDomainPortsOptions, 'store' | 'events'>
    readonly dispose?: () => boolean | Promise<boolean>
  }>
  readonly runtimePath?: (profilePath: string) => string
  readonly health?: () => HostHealthProjection
  readonly threadOffersProvider?: HostStandaloneCompositionInput['threadOffersProvider']
  readonly signalTarget?: HostNodeProductionSignalTarget
  readonly acquireLease?: (profilePath: string) => HostNodeProductionLease
  /** Required production-owned identity port; never reuse diagnostic identity. */
  readonly resolveIdentity: (
    profilePath: string,
    lease: HostNodeProductionLease
  ) => HostSessionHostIdentity
  readonly createStore?: (input: {
    profilePath: string
    authority: { assertProfileAuthority(): void }
  }) => HostProfileDomainStore
  readonly createDomain?: (options: HostNodeDomainPortsOptions) => HostNodeDomainPorts
  readonly createComposition?: (input: HostStandaloneCompositionInput) => HostStandaloneComposition
  readonly createListener?: (options: HostLocalServerOptions) => HostNodeProductionListener
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function defaultRuntimePath(profilePath: string): string {
  return join(profilePath, 'host-runtime')
}

/** Signal-supervised standalone production Host. No parent-death behavior exists here. */
export class HostNodeProductionServer {
  private readonly options: Required<Pick<HostNodeProductionServerOptions, 'signalTarget'>> &
    Omit<HostNodeProductionServerOptions, 'signalTarget'>
  private readonly shutdown = deferred()
  private readonly signals = new Map<NodeJS.Signals, () => void>()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private phaseValue: HostNodeProductionPhase = 'idle'
  private stopRequested = false
  private reconcileQueued = false
  private lease: HostNodeProductionLease | null = null
  private domain: HostNodeDomainPorts | null = null
  private composition: HostStandaloneComposition | null = null
  private listener: HostNodeProductionListener | null = null
  private disposeResources: (() => boolean | Promise<boolean>) | null = null
  identity: HostSessionHostIdentity | null = null

  constructor(options: HostNodeProductionServerOptions) {
    if (!options || options.mode !== 'production') {
      throw new Error('HostNodeProductionServer requires production mode')
    }
    if (
      (!options.domainOptions || typeof options.domainOptions !== 'object') &&
      typeof options.createDomainResources !== 'function'
    ) {
      throw new Error('HostNodeProductionServer requires domainOptions or createDomainResources')
    }
    if (typeof options.resolveIdentity !== 'function') {
      throw new Error('HostNodeProductionServer requires resolveIdentity')
    }
    this.options = { ...options, signalTarget: options.signalTarget ?? process }
    // Startup failure may precede any caller waiting for shutdown. Observe the
    // rejection here while retaining the original promise for explicit callers.
    void this.shutdown.promise.catch(() => undefined)
  }

  get phase(): HostNodeProductionPhase {
    return this.phaseValue
  }

  async start(): Promise<void> {
    if (
      this.phaseValue === 'stopping' ||
      this.phaseValue === 'stopped' ||
      this.phaseValue === 'failed'
    ) {
      throw new Error('HostNodeProductionServer is one-shot and cannot be started again')
    }
    if (this.startPromise) return this.startPromise
    this.phaseValue = 'starting'
    this.startPromise = this.startOnce()
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (!this.startPromise) throw new Error('HostNodeProductionServer must start before stopping')
    this.stopRequested = true
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopOnce()
    return this.stopPromise
  }

  waitForShutdown(): Promise<void> {
    if (!this.startPromise) throw new Error('HostNodeProductionServer must start before waiting')
    return this.shutdown.promise
  }

  private async startOnce(): Promise<void> {
    try {
      const usingDefaultAcquire = typeof this.options.acquireLease !== 'function'
      this.lease = (
        this.options.acquireLease ??
        ((path) => {
          assertHostMayOpenProfileWriters(path)
          return HostProfileAuthorityLease.acquire({ profilePath: path })
        })
      )(this.options.profilePath)
      this.lease.assertHeld()
      this.installSignals()
      if (this.stopRequested) return

      this.identity = this.options.resolveIdentity(this.lease.path, this.lease)
      if (usingDefaultAcquire) {
        writeHostProfileWriterFence(this.lease.path, {
          state: 'host-owned',
          ownership: {
            hostId: this.identity.hostId,
            generation: 0,
            cutoverId: 'host-node-production',
            pid: process.pid
          }
        })
      }
      const store = (this.options.createStore ?? ((input) => new HostProfileDomainStore(input)))({
        profilePath: this.lease.path,
        authority: { assertProfileAuthority: () => this.lease!.assertHeld() }
      })
      const events = {
        publish: () => this.queueReconciliation()
      }
      const resources = this.options.createDomainResources
        ? await this.options.createDomainResources({
            profilePath: this.lease.path,
            identity: this.identity,
            store
          })
        : null
      const domainOptions = resources?.domainOptions ?? this.options.domainOptions
      this.disposeResources = resources?.dispose ?? null
      if (!domainOptions) throw new Error('Production Host domain resources are unavailable')
      if (this.stopRequested) return
      const projectionDirtyRef: { current: (() => void) | null } = { current: null }
      this.domain = (this.options.createDomain ?? ((input) => new HostNodeDomainPorts(input)))({
        ...domainOptions,
        profilePath: this.lease.path,
        store,
        events,
        interactionTimeoutMs: domainOptions.interactionTimeoutMs ?? 5 * 60 * 1000,
        onProjectionDirty: () => projectionDirtyRef.current?.()
      })
      const capabilities = this.capabilities()
      this.composition = (this.options.createComposition ?? createHostStandaloneComposition)({
        runtimePath: (this.options.runtimePath ?? defaultRuntimePath)(this.lease.path),
        lease: this.lease,
        host: this.identity,
        hostCapabilityOffer: capabilities,
        snapshotDonor: () => this.domain!.snapshotDonor(),
        authorityEvaluator: (command, context) => {
          const decision = this.domain!.evaluateAuthority(context, command)
          return decision.decision === 'allow'
            ? { decision: 'allowed', ...(decision.reason ? { reason: decision.reason } : {}) }
            : { decision: 'denied', reason: decision.reason ?? 'standalone_authority_denied' }
        },
        commandExecutor: (command, context) =>
          this.domain!.executeCommand(context, command, { id: context.client.clientId }),
        setupExecutor: this.domain.setupExecutor,
        healthProvider: this.options.health ?? domainOptions.health,
        ...(this.options.threadOffersProvider
          ? { threadOffersProvider: this.options.threadOffersProvider }
          : {}),
        ...(this.domain.supportsWorkspaceGit
          ? { gitReadProvider: (context, request) => this.domain!.gitRead(context, request) }
          : {}),
        providerStatusesProvider: () => this.domain!.providerStatuses(),
        providerOffersProvider: (providerId) => this.domain!.providerOffers(providerId),
        providerAuthFlowsProvider: (providerId) => this.domain!.providerAuthFlows(providerId),
        providerAuthStatusProvider: (providerId) => this.domain!.providerAuthStatus(providerId),
        threadHistoryProvider: (request) => this.domain!.threadHistory(request),
        historySinceProvider: (request) => this.domain!.historySince(request)
      })
      projectionDirtyRef.current = () => {
        void this.composition!.reconcileProjection().catch(() => undefined)
      }
      await this.composition.startProjectionReconciliation()
      if (this.stopRequested) return
      this.listener = (this.options.createListener ?? ((input) => new HostLocalServer(input)))({
        userDataPath: this.lease.path,
        hostId: this.identity.hostId,
        hostVersion: this.identity.hostVersion,
        session: this.composition.session,
        authority: this.composition.authority,
        onAuthenticatedShutdown: () => this.stop(),
        subscribeDeltas: (listener) =>
          this.composition!.subscribeDeltas((event) => listener(event.record.envelope))
      })
      await this.listener.start()
      if (this.stopRequested) return
      this.phaseValue = 'running'
    } catch (error) {
      this.clearSignals()
      try {
        await this.cleanup()
      } catch (cleanupError) {
        this.phaseValue = 'failed'
        this.shutdown.reject(asError(cleanupError))
        throw cleanupError
      }
      this.phaseValue = 'failed'
      this.shutdown.reject(asError(error))
      throw error
    }
  }

  private async stopOnce(): Promise<void> {
    this.phaseValue = 'stopping'
    let started = false
    try {
      await this.startPromise
      started = true
      this.clearSignals()
      await this.cleanup()
      this.phaseValue = 'stopped'
      this.shutdown.resolve()
    } catch (error) {
      // A cleanup failure after a live start is retryable: retain the lease and
      // resources, keep waitForShutdown pending, and restore signal retry.
      if (started) {
        this.phaseValue = 'failed'
        this.stopPromise = null
        this.installSignals()
        throw error
      }
      this.phaseValue = 'failed'
      this.shutdown.reject(asError(error))
      this.stopPromise = null
      throw error
    }
  }

  private async cleanup(): Promise<void> {
    let listenerFailure: Error | null = null
    if (this.listener) {
      try {
        await this.listener.stop()
      } catch (error) {
        listenerFailure = asError(error)
      }
    }
    try {
      await this.domain?.shutdown()
    } catch (error) {
      throw new Error('Production Host domain cleanup failed; retaining profile authority.', {
        cause: error
      })
    }
    try {
      await this.composition?.shutdown()
    } catch (error) {
      throw new Error('Production Host runtime cleanup failed; retaining profile authority.', {
        cause: error
      })
    }
    try {
      if (this.disposeResources && (await this.disposeResources()) !== true) {
        throw new Error('resource disposal was not proven')
      }
    } catch (error) {
      throw new Error('Production Host resource cleanup failed; retaining profile authority.', {
        cause: error
      })
    }
    if (listenerFailure) {
      throw new Error('Production Host listener cleanup failed; retaining profile authority.', {
        cause: listenerFailure
      })
    }
    if (this.lease && this.lease.release() !== true) {
      throw new Error('Production Host could not prove profile authority release.')
    }
    this.listener = null
    this.domain = null
    this.composition = null
    this.disposeResources = null
    this.lease = null
  }

  private installSignals(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listener = () => void this.stop().catch(() => undefined)
      this.signals.set(signal, listener)
      this.options.signalTarget.once(signal, listener)
    }
  }

  private clearSignals(): void {
    for (const [signal, listener] of this.signals) {
      try {
        this.options.signalTarget.removeListener(signal, listener)
      } catch {
        // Signal handler removal is advisory; cleanup authority must continue.
      }
    }
    this.signals.clear()
  }

  private queueReconciliation(): void {
    if (this.reconcileQueued) return
    this.reconcileQueued = true
    queueMicrotask(() => {
      this.reconcileQueued = false
      void this.composition?.reconcileProjection().catch(() => undefined)
    })
  }

  private capabilities(): readonly HostCapability[] {
    const base: HostCapability[] = ['bootstrap', 'snapshot', 'deltas']
    if (this.options.threadOffersProvider) base.push('model-offers')
    if (this.domain?.supportsWorkspaceGit) base.push('workspace-git')
    base.push(
      'provider-catalog',
      'provider-auth',
      'history',
      'setup',
      'host-lifecycle',
      'commands',
      'receipts',
      'health'
    )
    // Approvals/questions are derived from the constructed domain, never from
    // catalog presence alone. The interaction registry always exposes decide/answer
    // handlers; the capability is advertised only when at least one composed
    // provider supports the corresponding continuation kind.
    if (this.domain?.registry.supportsApprovals) base.push('approvals')
    if (this.domain?.registry.supportsQuestions) base.push('questions')
    return base
  }
}
