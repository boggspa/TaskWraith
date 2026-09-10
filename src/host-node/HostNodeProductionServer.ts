import { ThreadCatalogueHostRunWindow } from './ThreadCatalogueHostRunWindow'
import { ThreadCatalogueHostRecovery } from './ThreadCatalogueHostRecovery'
import { hostNodeReceiptSpanChatId } from './hostNodeReceiptSpanChatId'
import type { HostCatalogueRunOrigin } from '../shared/threadCatalogueTypes'
import { randomUUID } from 'node:crypto'
import { createHostThreadCatalogue } from './ThreadCatalogueHostClient'
import { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import {
  hostCatalogueSummaries,
  projectHostCatalogueThread,
  queryHostCatalogue
} from './ThreadCatalogueHostMirror'
import { ThreadCatalogueSourcePublisher } from '../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import type {
  ThreadCatalogueMaintenanceQuery,
  ThreadCatalogueWireReply
} from '../shared/threadCatalogueProtocol'
/**
 * Production pure-Node Host lifecycle.
 *
 * This server is deliberately independent of a parent PID, Electron, and
 * connection lifetime. It acquires profile authority before identity/store/
 * runtime/listener work; stop releases that authority only after every owned
 * resource has cleaned up successfully.
 */

import type { HostCapability, HostHealthProjection } from '../shared/hostProtocol'
import { isAbsolute, join } from 'node:path'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import { HostLocalServer } from '../host-runtime/HostLocalServer'
import { HostProfileAuthorityLease } from '../host-runtime/HostProfileAuthorityLease'
import type { HostPermissionConsentAuthorityPort } from '../host-runtime/HostPermissionConsent'
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
import { createHostPerfInstrumentation } from '../host-runtime/HostPerfSnapshot'
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

export interface HostNodePermissionConsentAuthority extends HostPermissionConsentAuthorityPort {
  dispose(): void
}

export interface HostNodeProductionSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

export interface HostNodeProductionServerOptions {
  readonly profilePath: string
  readonly createThreadCatalogue?: typeof createHostThreadCatalogue
  readonly mode: 'production'
  readonly payloadVersion?: string
  /**
   * Environment consulted for opt-in diagnostics (HOST_PERF_SNAPSHOT_PATH_ENV);
   * defaults to process.env. Read once, when the composition is built.
   */
  readonly environment?: Readonly<NodeJS.ProcessEnv>
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
  readonly createPermissionConsentAuthority?: (
    profilePath: string,
    lease: HostNodeProductionLease
  ) => HostNodePermissionConsentAuthority
  readonly createStore?: (input: {
    profilePath: string
    authority: { assertProfileAuthority(): void }
    onThreadQuarantined?: (threadId: string, reason: 'record-too-large') => void
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

/**
 * Opt-in Host perf snapshot file (Independent Threads Programme M1, A1.2).
 * The variable names the destination file — absolute, or resolved under the
 * profile directory. Unset or blank keeps the transport off: the Host then
 * writes nothing on a timer. This is the only environment read for it; the
 * composition never touches process.env.
 */
export const HOST_PERF_SNAPSHOT_PATH_ENV = 'TASKWRAITH_PERF_HOST_SNAPSHOT_PATH'

function resolveHostPerfSnapshotFile(
  profilePath: string,
  environment: Readonly<NodeJS.ProcessEnv>
): { readonly path: string } | null {
  const configured = environment[HOST_PERF_SNAPSHOT_PATH_ENV]?.trim()
  if (!configured) return null
  return { path: isAbsolute(configured) ? configured : join(profilePath, configured) }
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
  private permissionConsentAuthority: HostNodePermissionConsentAuthority | null = null
  private threadCatalogue: ThreadCatalogueClient | null = null
  private threadCatalogueMirror: ThreadCatalogueMirror | null = null
  private threadCataloguePublisher: ThreadCatalogueSourcePublisher | null = null
  private hostRunWindow: ThreadCatalogueHostRunWindow | null = null
  private hostRunOrigin: HostCatalogueRunOrigin | undefined
  private hostRecovery: ThreadCatalogueHostRecovery | null = null
  private threadRecovery: ThreadCatalogueRecoveryController | null = null
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
      this.permissionConsentAuthority = this.options.createPermissionConsentAuthority
        ? this.options.createPermissionConsentAuthority(this.lease.path, this.lease)
        : null
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
      if (usingDefaultAcquire) {
        const writerId = randomUUID()
        this.hostRunOrigin = {
          schemaVersion: 1,
          kind: 'host-node',
          hostId: this.identity.hostId,
          incarnation: writerId
        }
        this.threadCatalogue = (this.options.createThreadCatalogue ?? createHostThreadCatalogue)(
          this.lease.path,
          writerId
        )
        this.threadCatalogueMirror = new ThreadCatalogueMirror(this.threadCatalogue)
        this.threadCatalogueMirror.subscribe(() => this.queueReconciliation())
        // Initialization opens only the derived index. History repair runs in
        // the decoder after launch and contributes ordinary projection deltas.
        void this.threadCatalogue.ready.catch((error) =>
          console.warn('[thread-catalogue] reader is restarting', error)
        )
        this.threadCataloguePublisher = new ThreadCatalogueSourcePublisher({
          profilePath: this.lease.path,
          writer: 'host',
          writerId,
          repairSource: (chatId) =>
            this.threadCatalogue!.query<string>({ method: 'repair-source', chatId }),
          segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1',
          canWrite: () => {
            this.lease!.assertHeld()
            return true
          },
          canManageRecoveryHolds: () => {
            this.lease!.assertHeld()
            return true
          },
          onChanged: (chatId) => {
            void this.threadCatalogue!.query({ method: 'changed', chatId }).catch(() => undefined)
          },
          onError: (error) =>
            console.error('[thread-catalogue] Host source publication failed', error)
        })
        this.threadRecovery = new ThreadCatalogueRecoveryController({
          client: this.threadCatalogue,
          publisher: this.threadCataloguePublisher,
          reader: {
            profilePath: this.lease.path,
            runtimeInstanceId: writerId,
            segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1'
          },
          incarnation: writerId,
          assertAuthority: () => this.lease!.assertHeld(),
          hasLiveWork: (chatId) => !this.domain || this.domain.hasRuntimeWorkForThread(chatId)
        })
        this.hostRunWindow = new ThreadCatalogueHostRunWindow(this.threadCatalogueMirror, () =>
          this.queueReconciliation()
        )
        this.threadCatalogueMirror.start()
      }
      const store = (this.options.createStore ?? ((input) => new HostProfileDomainStore(input)))({
        profilePath: this.lease.path,
        authority: { assertProfileAuthority: () => this.lease!.assertHeld() },
        ...(this.threadCatalogueMirror
          ? {
              threadSummarySource: () => hostCatalogueSummaries(this.threadCatalogueMirror!),
              runSummarySource: () => this.hostRunWindow!.snapshot()
            }
          : {}),
        ...(this.threadCataloguePublisher
          ? {
              beginThreadPublication: (thread) => {
                const projection = projectHostCatalogueThread(thread)
                const ticket = this.threadCataloguePublisher!.begin(thread.appChatId)
                return {
                  commit: () => {
                    const witness = this.threadCataloguePublisher!.finishProjection(
                      ticket,
                      projection
                    )
                    this.threadCatalogueMirror!.observe(projection, witness)
                  },
                  abort: () => this.threadCataloguePublisher!.fail(ticket)
                }
              }
            }
          : {}),
        onThreadQuarantined: (threadId, reason) => {
          // The Host previously refused to start over one bad record; it now
          // skips it, so the skip has to be as loud as the refusal was.
          process.stderr.write(`taskwraith-host: chat ${threadId} skipped (${reason})\n`)
        }
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
      // One Host recorder: Domain persist and composition receipts both write
      // into composition.perf.spans (A1.10 durable_commit / receipt_delivery).
      const hostPerf = createHostPerfInstrumentation()
      this.domain = (this.options.createDomain ?? ((input) => new HostNodeDomainPorts(input)))({
        ...domainOptions,
        profilePath: this.lease.path,
        store,
        events,
        hostRunOrigin: this.hostRunOrigin,
        workSpanRecorder: hostPerf.spans,
        ...(this.threadCatalogue
          ? {
              runLocator: {
                find: (runId: string) =>
                  this.threadCatalogue!.available
                    ? this.threadCatalogue!.query<{ chatId: string } | null>({
                        method: 'known-run',
                        runId
                      })
                    : Promise.resolve(null)
              }
            }
          : {}),
        ...(this.permissionConsentAuthority
          ? { permissionConsentAuthority: this.permissionConsentAuthority }
          : {}),
        interactionTimeoutMs: domainOptions.interactionTimeoutMs ?? 5 * 60 * 1000,
        onProjectionDirty: () => projectionDirtyRef.current?.()
      })
      if (
        this.threadCatalogue &&
        this.threadCatalogueMirror &&
        this.threadRecovery &&
        this.hostRunOrigin
      )
        this.hostRecovery = new ThreadCatalogueHostRecovery({
          client: this.threadCatalogue,
          mirror: this.threadCatalogueMirror,
          controller: this.threadRecovery,
          origin: this.hostRunOrigin
        })
      // The first projection is also the baseline for every later Host delta.
      // Resolve account-dependent provider catalogs before that baseline so a
      // cold Host cannot publish the initial empty Ollama/AGY offer set and
      // then leave clients with a permanently incomplete roster.
      const registry = this.domain.registry as typeof this.domain.registry & {
        readonly providerIds?: readonly string[]
        readonly refreshOffers?: (providerId: string) => Promise<unknown>
      }
      if (Array.isArray(registry.providerIds) && typeof registry.refreshOffers === 'function') {
        await Promise.all(
          registry.providerIds.map(async (providerId) => {
            try {
              await registry.refreshOffers!(providerId)
            } catch {
              // Provider adapters close their own failures; one slow/broken
              // catalog must not prevent the other providers from publishing.
            }
          })
        )
      }
      if (this.stopRequested) return
      const capabilities = this.capabilities()
      const perfSnapshotFile = resolveHostPerfSnapshotFile(
        this.lease.path,
        this.options.environment ?? process.env
      )
      this.composition = (this.options.createComposition ?? createHostStandaloneComposition)({
        runtimePath: (this.options.runtimePath ?? defaultRuntimePath)(this.lease.path),
        lease: this.lease,
        host: this.identity,
        hostCapabilityOffer: capabilities,
        perf: {
          instrumentation: hostPerf,
          ...(perfSnapshotFile ? { snapshotFile: perfSnapshotFile } : {})
        },
        resolveReceiptSpanChatId: (record) =>
          hostNodeReceiptSpanChatId(this.domain!.interactions, record),
        snapshotDonor: () => this.domain!.snapshotDonor(),
        authorityEvaluator: async (command, context) => {
          const prepared = await this.domain!.prepareAuthorityEvaluation?.(context, command)
          if (prepared === false) {
            return { decision: 'denied' as const, reason: 'provider_offers_unavailable' }
          }
          const decision = this.domain!.evaluateAuthority(context, command)
          return decision.decision === 'allow'
            ? { decision: 'allowed', ...(decision.reason ? { reason: decision.reason } : {}) }
            : { decision: 'denied', reason: decision.reason ?? 'standalone_authority_denied' }
        },
        commandExecutor: (command, context) =>
          this.domain!.executeCommand(context, command, { id: context.client.clientId }),
        setupExecutor: this.domain.setupExecutor,
        healthProvider: this.options.health ?? domainOptions.health,
        // The domain owns the curated per-thread catalogue, so a standalone Host
        // serves model offers on its own. An injected provider still wins, which
        // keeps the desktop-backed composition free to supply its own resolver.
        threadOffersProvider:
          this.options.threadOffersProvider ?? ((threadId) => this.domain!.threadOffers(threadId)),
        ...(this.domain.supportsWorkspaceGit
          ? { gitReadProvider: (context, request) => this.domain!.gitRead(context, request) }
          : {}),
        providerStatusesProvider: () => this.domain!.providerStatuses(),
        providerOffersProvider: (providerId) => this.domain!.providerOffers(providerId),
        providerAuthFlowsProvider: (providerId) => this.domain!.providerAuthFlows(providerId),
        providerAuthStatusProvider: (providerId) => this.domain!.providerAuthStatus(providerId),
        threadHistoryProvider: (request) => this.domain!.threadHistory(request),
        ...(this.threadCatalogue
          ? {
              threadCatalogueProvider: (request) =>
                queryHostCatalogue(this.threadCatalogue!, request)
            }
          : {}),
        ...(this.threadCatalogue
          ? { threadCatalogueMaintenanceProvider: (request) => this.maintainCatalogue(request) }
          : {}),
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
        ...(this.options.payloadVersion ? { payloadVersion: this.options.payloadVersion } : {}),
        // Same epoch the perf snapshot writer stamps, so a collector reading
        // the file and a client reading the welcome agree on which incarnation
        // they are talking to. Conditional so a composition that never minted
        // one still produces a byte-identical welcome.
        ...(this.composition.perf.identity.bootEpoch
          ? { bootEpoch: this.composition.perf.identity.bootEpoch }
          : {}),
        session: this.composition.session,
        authority: this.composition.authority,
        runCommand: (command, execute) =>
          command.target.threadId && this.threadRecovery
            ? this.threadRecovery.admit(command.target.threadId, execute)
            : execute(),
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
    this.hostRunWindow?.dispose()
    this.hostRecovery?.dispose()
    this.threadRecovery?.dispose()
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
    this.permissionConsentAuthority?.dispose()
    await this.threadCatalogueMirror?.dispose()
    await this.threadCataloguePublisher?.dispose()
    await this.threadCatalogue?.dispose()
    this.threadCatalogueMirror = null
    this.threadCatalogue = null
    this.threadCataloguePublisher = null
    this.threadRecovery = null
    if (this.lease && this.lease.release() !== true) {
      throw new Error('Production Host could not prove profile authority release.')
    }
    this.listener = null
    this.domain = null
    this.composition = null
    this.disposeResources = null
    this.permissionConsentAuthority = null
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
    if (this.options.threadOffersProvider || this.domain) base.push('model-offers')
    if (this.domain?.supportsWorkspaceGit) base.push('workspace-git')
    if (this.domain?.supportsEnsembleSeatControl) base.push('ensemble')
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

  private async maintainCatalogue(
    request: ThreadCatalogueMaintenanceQuery
  ): Promise<ThreadCatalogueWireReply> {
    const client = this.threadCatalogue
    const recovery = this.threadRecovery
    if (!client || !recovery) throw new Error('History recovery is unavailable')
    if (request.method === 'owner') recovery.registerDesktop(request.owner)
    if (request.method === 'begin-recovery')
      return { data: recovery.begin(request.chatId, request.desktopWriterId) }
    if (request.method === 'end-recovery')
      return { data: recovery.end(request.chatId, request.recoveryToken) }
    if (request.method === 'adopt-prepared') {
      const data = await recovery.adopt(request.chatId, request.recoveryToken, request.preparedId)
      this.threadCatalogueMirror?.observe(data)
      return { data }
    }
    if (request.method === 'prepare') recovery.assertHeld(request.chatId, request.recoveryToken)
    if (request.method === 'erase')
      await this.threadCataloguePublisher?.drain(request.chatId ? [request.chatId] : undefined)
    const data = await client.query(request)
    if (request.method === 'finish-erasure' && data === true) {
      recovery.forgetErased(request.chatId)
      this.threadCataloguePublisher?.forgetErased(request.chatId)
    }
    if (request.method === 'erase') {
      if (request.chatId) this.threadCatalogueMirror?.forget(request.chatId)
      else this.threadCatalogueMirror?.forgetAll()
    }
    return { data }
  }
}
