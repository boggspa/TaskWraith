import { ThreadCatalogueHostRunWindow } from './ThreadCatalogueHostRunWindow'
import { ThreadCatalogueHostRecovery } from './ThreadCatalogueHostRecovery'
import { hostNodeReceiptSpanChatId } from './hostNodeReceiptSpanChatId'
import type { HostCatalogueRunOrigin } from '../shared/threadCatalogueTypes'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { createHostThreadCatalogue } from './ThreadCatalogueHostClient'
import { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import {
  THREAD_CATALOGUE_CLOSE_TIMEOUT_MS,
  THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS,
  THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS,
  type ThreadCatalogueClient
} from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import {
  hostCatalogueSummaries,
  projectHostCatalogueThread,
  queryHostCatalogue
} from './ThreadCatalogueHostMirror'
import {
  THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS,
  ThreadCatalogueSourcePublisher
} from '../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import type {
  ThreadCatalogueMaintenanceQuery,
  ThreadCatalogueWireReply
} from '../shared/threadCatalogueProtocol'
/**
 * Production pure-Node Host lifecycle.
 *
 * This server is deliberately independent of any parent PID and of Electron.
 * Its lifetime is bounded by client leases (`HostLeaseRegistry`): while any
 * authenticated client holds the Host it runs; once the last lease lapses or
 * is released it finishes live work and stops after a grace period, and the
 * machine-wide registry self-check (`HostRegistryPort`) stops it when its own
 * entry disappears. SIGINT/SIGTERM handling is unchanged. It acquires profile
 * authority before identity/store/runtime/listener work; stop releases that
 * authority only after every owned resource has cleaned up successfully.
 */

import type { HostCapability, HostHealthProjection } from '../shared/hostProtocol'
import { isAbsolute, join } from 'node:path'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import {
  HOST_LOCAL_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS,
  HostLocalServer
} from '../host-runtime/HostLocalServer'
import {
  HOST_LEASE_DISABLED_ENV,
  HOST_LEASE_TIMING_ENV,
  HOST_PERSIST_ENV,
  HostLeaseRegistry,
  isHostLeaseProtocolDisabled,
  isHostPersistEnabled,
  resolveHostLeaseTiming,
  type HostLeaseExitReason,
  type HostLeaseRegistryPorts,
  type HostLeaseTickInfo
} from '../host-runtime/HostLeaseRegistry'
import { HOST_REGISTRY_REFRESH_MS } from '../host-runtime/HostRegistry'
import type { HostRegistryPublisherPort } from '../host-runtime/HostRegistryPort'
import { writeHostStderr } from '../host-runtime/HostStdioGuard'
import { HostThreadOwnerService } from '../host-runtime/HostThreadOwnerService'
import { HostProfileAuthorityLease } from '../host-runtime/HostProfileAuthorityLease'
import type { HostPermissionConsentAuthorityPort } from '../host-runtime/HostPermissionConsent'
import {
  assertHostMayOpenProfileWriters,
  writeHostProfileWriterFence
} from '../host-runtime/HostProfileWriterFence'
import {
  HostProfileDomainStore,
  type HostProfileDomainStoreOptions
} from '../host-runtime/HostProfileDomainStore'
import {
  createHostStandaloneComposition,
  type HostStandaloneComposition,
  type HostStandaloneCompositionInput
} from '../host-runtime/HostStandaloneComposition'
import { createHostPerfInstrumentation } from '../host-runtime/HostPerfSnapshot'
import type { HostSessionHostIdentity } from '../host-runtime/HostSession'
import {
  HOST_NODE_DOMAIN_SHUTDOWN_TIMEOUT_MS,
  HostNodeDomainPorts,
  isHostQueuedStartEnabled,
  type HostNodeDomainPortsOptions
} from './HostNodeDomainPorts'
import { createHostQueuedStartStartedSlot } from '../host-runtime/HostQueuedStartPublication'
import { isHostTxnRecordPersistEnabled } from '../host-runtime/HostCommandExecutionClass'
import {
  createHostThreadRecordCommitPort,
  type HostThreadRecordCommitPort
} from '../host-runtime/HostThreadRecordTransaction'
import type { HostCommandReceiptRecord } from '../host-runtime/HostCommandReceiptStore'
import {
  openHostNodeQueuedStartExecutionClaimStore,
  type HostNodeQueuedStartExecutionClaimStore
} from './HostNodeQueuedStartExecutionClaimStore'
import {
  createHostNodeQueuedStartLifecycle,
  type HostQueuedStartRecoverySummary
} from './HostNodeQueuedStartLifecycle'

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
  /** Published in the machine-wide registry entry when the listener has them. */
  readonly socketPath?: string
  readonly discoveryPath?: string
  /** The discovery record's `startedAt`, once listening. */
  readonly startedAt?: string | null
}

/**
 * Consecutive `missing`/`foreign` self-checks before a graceful stop. The
 * checks run every HOST_REGISTRY_REFRESH_MS of awake time (owned by
 * HostRegistry, the publisher's module).
 */
export const HOST_REGISTRY_SELF_CHECK_STRIKES = 2

/**
 * What HOST_LIFETIME_STOP_DEADLINE_MS keeps over the bounds it sums, for the
 * stop steps with no bound of their own: the providers' and the composition's
 * shutdowns, resource disposal and artefact removal, which normally take well
 * under a second.
 */
export const HOST_LIFETIME_STOP_DEADLINE_MARGIN_MS = 10_000

/**
 * How long a stop nobody retries may run: one the Host decides on its own (the
 * last lease went, or its registry entry did), or one a client requested over
 * the listener, which the stop closes first. It is summed from the bounds its
 * cleanup steps run under, one after another, plus the margin, so a stop that
 * runs every bounded step out to its bound still finishes inside it:
 *   - the listener's three drains, HOST_LOCAL_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS
 *     each;
 *   - the domain's queued dispatches, then its provider runs' completions,
 *     HOST_NODE_DOMAIN_SHUTDOWN_TIMEOUT_MS each;
 *   - the history mirror's last read, waiting on a history worker restart
 *     that is due, THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS;
 *   - the history writers' drain, THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS;
 *   - the history worker's `close`, then its termination,
 *     THREAD_CATALOGUE_CLOSE_TIMEOUT_MS and THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS.
 * Not covered: the mirror's read itself, up to THREAD_CATALOGUE_REQUEST_TIMEOUT_MS.
 * Only a history worker that is alive but wedged takes that long, and such a
 * stop ends at the deadline like any other.
 *
 * Nothing retries such a stop, so the deadline is a hard one: a stop still
 * running when it passes is reported and ends the process, the way a stop
 * that fails does (stopWithoutRetry). Until then the deadline's timer is ref'd
 * and keeps the process alive: by then the listener is closed and may be all
 * that held the event loop, and a step waiting only on unref'd timers (a
 * history worker restart's backoff) would otherwise let the process run dry
 * and exit 0 halfway, with the profile authority and registry entry still
 * held.
 */
export const HOST_LIFETIME_STOP_DEADLINE_MS =
  3 * HOST_LOCAL_SERVER_SHUTDOWN_DRAIN_TIMEOUT_MS +
  2 * HOST_NODE_DOMAIN_SHUTDOWN_TIMEOUT_MS +
  THREAD_CATALOGUE_RESTART_BACKOFF_CAP_MS +
  THREAD_CATALOGUE_SOURCE_DRAIN_TIMEOUT_MS +
  THREAD_CATALOGUE_CLOSE_TIMEOUT_MS +
  THREAD_CATALOGUE_TERMINATE_TIMEOUT_MS +
  HOST_LIFETIME_STOP_DEADLINE_MARGIN_MS

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
    onThreadRecordWritten?: HostProfileDomainStoreOptions['onThreadRecordWritten']
  }) => HostProfileDomainStore
  readonly createDomain?: (options: HostNodeDomainPortsOptions) => HostNodeDomainPorts
  readonly createComposition?: (input: HostStandaloneCompositionInput) => HostStandaloneComposition
  readonly createListener?: (options: HostLocalServerOptions) => HostNodeProductionListener
  /**
   * Machine-wide registry publisher (S1b). Absent means nothing is published
   * and the self-check never runs; the lease lifetime is unaffected.
   */
  readonly registry?: HostRegistryPublisherPort
  /** Lease registry clock/scheduler seam for tests; production uses the defaults. */
  readonly leasePorts?: HostLeaseRegistryPorts
  /**
   * Seam for tests. Production uses HOST_LIFETIME_STOP_DEADLINE_MS, or a
   * shorter `stop:` in TASKWRAITH_HOST_LEASE_TIMING.
   */
  readonly lifetimeStopDeadlineMs?: number
  /**
   * Ends the process after a stop nobody retries has failed or run out of time
   * (stopWithoutRetry). The CLI's Host passes one; an in-process embedder
   * (most tests) does not, and then such a stop only fails waitForShutdown.
   */
  readonly endProcess?: (code: number) => void
}

/**
 * The catalogue ticket a transactional persist writes before its rename (M4
 * slice 12b, §13 MF-1). A ticket that degraded to `untracked` is failed and
 * refused, so the write never proceeds without one. With no catalogue
 * configured there is nothing to track, as on today's path.
 */
export function hostNodeThreadRecordCatalogueTicket(
  publisher: Pick<ThreadCatalogueSourcePublisher, 'begin' | 'finishProjection' | 'fail'> | null,
  mirror: Pick<ThreadCatalogueMirror, 'observe'> | null
): HostThreadRecordCommitPort['beginTicket'] {
  return async (threadId, projection) => {
    if (!publisher) return { finish: () => undefined, fail: () => undefined }
    const ticket = publisher.begin(threadId)
    if (ticket.untracked) {
      publisher.fail(ticket, 'unchanged')
      return null
    }
    return {
      finish: () => {
        const witness = publisher.finishProjection(ticket, projection)
        mirror?.observe(projection, witness)
      },
      fail: () => publisher.fail(ticket)
    }
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** An error and its `cause` chain on one line: the stderr record of a failed stop. */
function describeFailure(value: unknown): string {
  const parts: string[] = []
  let current: unknown = value
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined
  }
  return parts.join(' <- ')
}

function defaultRuntimePath(profilePath: string): string {
  return join(profilePath, 'host-runtime')
}

function ensureDefaultRuntimePath(profilePath: string, runtimePath: string): void {
  if (runtimePath !== defaultRuntimePath(profilePath)) return
  try {
    const existing = lstatSync(runtimePath)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('Unsafe Host runtime directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(runtimePath, { recursive: false, mode: 0o700 })
  }
  if (process.platform !== 'win32') chmodSync(runtimePath, 0o700)
}

/**
 * Classify body-free restart candidates against positive durable claim
 * evidence. A dedicated lifecycle is opened lazily only when at least one
 * eligible receipt carries a cursor; Domain's operational lifecycle and store
 * remain separate and live. Every current production result stays
 * indeterminate and non-resubmittable.
 */
export async function recoverHostNodeQueuedStarts(input: {
  readonly openExecutionClaimStore: () => HostNodeQueuedStartExecutionClaimStore
  readonly receipts: readonly HostCommandReceiptRecord[]
}): Promise<readonly HostQueuedStartRecoverySummary[]> {
  const candidates = input.receipts.flatMap((receipt) => {
    if (
      receipt.status !== 'indeterminate' ||
      receipt.recoveryState !== 'recoverable-indeterminate' ||
      receipt.commandName !== 'composer.send' ||
      receipt.target.kind !== 'thread' ||
      typeof receipt.target.id !== 'string' ||
      receipt.target.id.length === 0
    ) {
      return []
    }
    return [
      {
        commandId: receipt.commandId,
        threadId: receipt.target.id,
        fingerprint: receipt.commandFingerprint,
        ...(receipt.executionClaimCursor
          ? { executionClaimCursor: receipt.executionClaimCursor }
          : {})
      }
    ]
  })
  if (!candidates.some((candidate) => candidate.executionClaimCursor !== undefined)) {
    return candidates.map((candidate) => ({
      commandId: candidate.commandId,
      classification: 'unknown'
    }))
  }

  const recoveryLifecycle = createHostNodeQueuedStartLifecycle({
    executionClaimStore: input.openExecutionClaimStore()
  })
  const detailed = await recoveryLifecycle.reopenWithEvidence(candidates)
  if (
    detailed.outcomes.length !== candidates.length ||
    detailed.summaries.length !== candidates.length ||
    detailed.outcomes.some(
      (outcome) => outcome.outcome !== 'indeterminate' || outcome.resubmittable !== null
    ) ||
    detailed.summaries.some(
      (summary, index) =>
        summary.commandId !== candidates[index]?.commandId ||
        (summary.classification !== 'claimed' && summary.classification !== 'unknown')
    )
  ) {
    throw new Error('Queued-start recovery attempted to grant resubmission without absence proof')
  }
  return detailed.summaries
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

/**
 * Signal-supervised, lease-bounded standalone production Host. No parent-death
 * behaviour exists here: it exits on SIGINT/SIGTERM, on an authenticated
 * `host.shutdown`, when its last client lease has been gone for the grace
 * period (finishing live runs first), or when the registry self-check finds
 * its own entry gone.
 */
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
  private leases: HostLeaseRegistry | null = null
  private leaseTickUnsubscribe: (() => void) | null = null
  private registryPublished = false
  private registryLastRefreshAwakeMs = 0
  private registrySelfCheckStrikes = 0
  private lifetimeStopDeadlineMs = HOST_LIFETIME_STOP_DEADLINE_MS
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
          hasLiveWork: (chatId) => !this.domain || this.domain.hasRuntimeWorkForThread(chatId),
          onAdopted: (chatId) => this.composition?.markThreadRecord?.(chatId, 'record')
        })
        this.hostRunWindow = new ThreadCatalogueHostRunWindow(this.threadCatalogueMirror, () =>
          this.queueReconciliation()
        )
        this.threadCatalogueMirror.start()
      }
      const store = (this.options.createStore ?? ((input) => new HostProfileDomainStore(input)))({
        profilePath: this.lease.path,
        // M4 slice 13c1: every chat-file write reaches the public window
        // feeder, which exists only while the transactional persist is on.
        onThreadRecordWritten: (threadId, kind, thread) =>
          this.composition?.markThreadRecord?.(threadId, kind, thread),
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
          writeHostStderr(`taskwraith-host: chat ${threadId} skipped (${reason})\n`)
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
      const runtimePath = (this.options.runtimePath ?? defaultRuntimePath)(this.lease.path)
      const queuedStartEnabled = isHostQueuedStartEnabled(this.options.environment ?? process.env)
      // M4: read once. A harness switch until boot recovery and the index
      // seed land (slice 14); nothing sets it in production.
      const txnRecordPersistEnabled = isHostTxnRecordPersistEnabled(
        this.options.environment ?? process.env
      )
      const threadRecordStore = store as Partial<
        Pick<HostProfileDomainStore, 'threadRecordState' | 'admitCommittedThreadRecord'>
      >
      if (
        txnRecordPersistEnabled &&
        (typeof threadRecordStore.threadRecordState !== 'function' ||
          typeof threadRecordStore.admitCommittedThreadRecord !== 'function')
      ) {
        writeHostStderr(
          'taskwraith-host: TASKWRAITH_HOST_TXN_PERSIST=1 ignored: the profile store cannot commit a transaction\n'
        )
      }
      const threadRecordTransaction: HostStandaloneCompositionInput['threadRecordTransaction'] =
        txnRecordPersistEnabled &&
        typeof threadRecordStore.threadRecordState === 'function' &&
        typeof threadRecordStore.admitCommittedThreadRecord === 'function'
          ? {
              profilePath: this.lease.path,
              records: createHostThreadRecordCommitPort({
                store: threadRecordStore as Pick<
                  HostProfileDomainStore,
                  'threadRecordState' | 'admitCommittedThreadRecord'
                >,
                profilePath: this.lease.path,
                beginTicket: hostNodeThreadRecordCatalogueTicket(
                  this.threadCataloguePublisher,
                  this.threadCatalogueMirror
                )
              }),
              // Slice 13f1: the index publishes only once seeded from the
              // committed files; until then persists take today's path.
              seed: {}
            }
          : undefined
      const queuedStartSlot = queuedStartEnabled ? createHostQueuedStartStartedSlot() : null
      if (queuedStartEnabled) ensureDefaultRuntimePath(this.lease.path, runtimePath)
      const queuedStartExecutionClaimStore = queuedStartEnabled
        ? openHostNodeQueuedStartExecutionClaimStore({ dataDir: runtimePath })
        : null
      this.domain = (this.options.createDomain ?? ((input) => new HostNodeDomainPorts(input)))({
        ...domainOptions,
        hostQueuedStartEnabled: queuedStartEnabled,
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
        onProjectionDirty: () => projectionDirtyRef.current?.(),
        ...(queuedStartSlot && queuedStartExecutionClaimStore
          ? {
              executionClaimStore: queuedStartExecutionClaimStore,
              queuedStartOnStarting: queuedStartSlot.dispatchStarting,
              queuedStartOnStarted: queuedStartSlot.dispatch,
              queuedStartOnDispatchSettled: async (commandId, threadId, result) => {
                if (result.status === 'succeeded') {
                  // The Host run window intentionally debounces display refreshes.
                  // A short-start publication cannot: refresh the exact persisted
                  // run now, before the coordinator captures its proof snapshot.
                  await this.hostRunWindow?.refreshFor(threadId, commandId)
                }
                queuedStartSlot.dispatchSettled(commandId, result)
              }
            }
          : {})
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
        runtimePath,
        profilePath: this.lease.path,
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
        ...(queuedStartSlot && queuedStartExecutionClaimStore
          ? {
              queuedStartRecovery: (receipts) =>
                recoverHostNodeQueuedStarts({
                  openExecutionClaimStore: () =>
                    openHostNodeQueuedStartExecutionClaimStore({ dataDir: runtimePath }),
                  receipts
                }),
              queuedStartClaimCompaction: (retainedCommandIds) => {
                if (typeof queuedStartExecutionClaimStore.compact !== 'function') {
                  throw new Error('Queued-start execution claim compaction is unavailable')
                }
                return queuedStartExecutionClaimStore.compact(retainedCommandIds)
              },
              queuedComposerSend: (command, context) =>
                this.domain!.acknowledgeQueuedComposerSend(context, command, {
                  id: context.client.clientId
                }),
              queuedStartStartingBind: queuedStartSlot.bindStarting,
              queuedStartStartedBind: queuedStartSlot.bind,
              queuedStartDispatchSettledBind: queuedStartSlot.bindSettled
            }
          : {}),
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
              threadCatalogueProvider: (request, options) =>
                queryHostCatalogue(this.threadCatalogue!, request, options)
            }
          : {}),
        ...(this.threadCatalogue
          ? { threadCatalogueMaintenanceProvider: (request) => this.maintainCatalogue(request) }
          : {}),
        historySinceProvider: (request) => this.domain!.historySince(request),
        ...(threadRecordTransaction ? { threadRecordTransaction } : {})
      })
      // M4 slice 14b (RR-2, R1-M1): every transactional persist a crash left
      // open is decided before catalogue recovery starts adopting, before any
      // queued start resumes, and before the seed and the listener. A
      // recovery that fails (SF-2: a reset it could not write) fails startup.
      const recovered = await this.composition.recoverTransactions?.()
      if (recovered) {
        const counts = Object.entries(recovered.counts)
          .filter(([action]) => action !== 'none' && action !== 'not_transactional')
          .map(([action, count]) => `${action}=${count}`)
          .join(' ')
        writeHostStderr(
          `taskwraith-host: transaction recovery${counts ? ` ${counts}` : ' found nothing open'}` +
            `${recovered.reset ? `; generation reset to ${recovered.reset.generation}` : ''}` +
            `; ${recovered.anchorsReleased.length} anchor(s) released, ` +
            `${recovered.artifactsRemoved.length} artifact(s) removed\n`
        )
      }
      if (this.stopRequested) return
      // Catalogue recovery adopts from its constructor: only after the above.
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
      await this.composition.recoverQueuedStarts()
      // Slice 13f1: seed the public window index in the background. The
      // listener opens as today; clients move to the index at one reset.
      const seeding = this.composition.startPublicWindowSeed?.()
      void seeding?.seeded.then((outcome) => {
        const report = outcome.report
        const counts = report
          ? ` (${report.modelled} modelled, ${report.absent} absent, ${report.invalid} invalid, ` +
            `${report.abandoned.length} abandoned, ${Math.round(report.ms)} ms)`
          : ''
        writeHostStderr(
          outcome.kind === 'switched'
            ? `taskwraith-host: public window seeded${counts}\n`
            : `taskwraith-host: public window seed abandoned: ${outcome.reason}${counts}; persists stay on today's path\n`
        )
      })
      projectionDirtyRef.current = () => {
        void this.composition!.reconcileProjection().catch(() => undefined)
      }
      await this.composition.startProjectionReconciliation()
      if (this.stopRequested) return
      const leaseProtocolDisabled = isHostLeaseProtocolDisabled(
        this.options.environment ?? process.env
      )
      if (leaseProtocolDisabled) {
        // Test-only legacy simulation: no lease kinds, no lease lifetime, no
        // registry entry — what a Host from before this programme looks like.
        writeHostStderr(
          `taskwraith-host: [host-lease] ${HOST_LEASE_DISABLED_ENV}=1 under ${HOST_LEASE_TIMING_ENV}: answering host.lease and host.status as a pre-lease Host\n`
        )
      }
      this.leases = leaseProtocolDisabled ? null : this.createLeaseRegistry()
      // Which app process writes each thread (`thread.owner`). The thread log
      // authority switch is read once, here; grants carry the welcome's epoch.
      const threadOwners = new HostThreadOwnerService({
        environment: this.options.environment ?? process.env,
        transactionalPersist: txnRecordPersistEnabled,
        profilePath: this.lease.path,
        incarnation: this.composition.perf.identity.bootEpoch ?? randomBytes(32).toString('hex'),
        fullCopyRevision: (threadId) => store.threadRecordState(threadId)?.revision ?? null,
        hostRunActive: (threadId) => !this.domain || this.domain.hasRuntimeWorkForThread(threadId),
        log: writeHostStderr
      })
      await threadOwners.start()
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
        onAuthenticatedShutdown: () => this.stopWithoutRetry('stopping on request'),
        subscribeDeltas: (listener) =>
          this.composition!.subscribeDeltas((event) => listener(event.record.envelope)),
        ...(this.leases ? { leases: this.leases } : { leaseProtocol: 'disabled' as const }),
        threadOwners
      })
      await this.listener.start()
      if (this.stopRequested) return
      this.publishRegistryEntry()
      this.phaseValue = 'running'
    } catch (error) {
      this.clearSignals()
      try {
        await this.cleanup()
      } catch (cleanupError) {
        this.phaseValue = 'failed'
        this.shutdown.reject(asError(cleanupError))
        // Nothing retries a start, and the signals are gone: whatever the
        // cleanup left live must not hold the process, and the profile
        // authority with it, for good (see stopWithoutRetry).
        this.options.endProcess?.(1)
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
    this.leaseTickUnsubscribe?.()
    this.leaseTickUnsubscribe = null
    this.leases?.stop()
    if (this.listener) {
      try {
        await this.listener.stop()
      } catch (error) {
        listenerFailure = asError(error)
      }
    }
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
    // Keep the run window available until Domain's queued dispatches have
    // crossed their exact-run refresh barrier and composition has drained
    // their receipt publication. A failed earlier cleanup remains retryable
    // with the window intact.
    this.hostRunWindow?.dispose()
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
    this.removeRegistryEntry()
    if (this.lease && this.lease.release() !== true) {
      throw new Error('Production Host could not prove profile authority release.')
    }
    this.listener = null
    this.domain = null
    this.composition = null
    this.disposeResources = null
    this.permissionConsentAuthority = null
    this.lease = null
    this.leases = null
  }

  // ---------------------------------------------------------------------------
  // Lease lifetime and the machine-wide registry
  // ---------------------------------------------------------------------------

  private createLeaseRegistry(): HostLeaseRegistry {
    const environment = this.options.environment ?? process.env
    const timing = resolveHostLeaseTiming(environment)
    const persist = isHostPersistEnabled(environment)
    const log = (line: string) => writeHostStderr(`taskwraith-host: ${line}\n`)
    if (timing.source === 'rejected') {
      log(`[host-lease] ${HOST_LEASE_TIMING_ENV}=${timing.raw} ignored: ${timing.reason}`)
    } else if (timing.source === 'environment') {
      let stop = ''
      if (timing.stopDeadlineMs !== undefined) {
        // Like the lease timing, it may only shorten the deadline.
        if (timing.stopDeadlineMs < HOST_LIFETIME_STOP_DEADLINE_MS) {
          this.lifetimeStopDeadlineMs = timing.stopDeadlineMs
          stop = `, stop deadline ${timing.stopDeadlineMs}ms`
        } else {
          stop = `; stop:${timing.stopDeadlineMs} ignored, it may only shorten the ${HOST_LIFETIME_STOP_DEADLINE_MS}ms stop deadline`
        }
      }
      log(
        `[host-lease] ${HOST_LEASE_TIMING_ENV} shortened timing to heartbeat ${timing.timing.heartbeatMs}ms, ttl ${timing.timing.ttlMs}ms, grace ${timing.timing.graceMs}ms${stop}`
      )
    }
    if (persist) log(`[host-lease] ${HOST_PERSIST_ENV}=1: the last-lease grace exit is disabled`)
    const leases = new HostLeaseRegistry({
      timing: timing.timing,
      persist,
      liveWork: () => this.liveRunCount(),
      onExit: (reason) => this.onLeaseExit(reason),
      log,
      ...(this.options.leasePorts ? { ports: this.options.leasePorts } : {})
    })
    this.leaseTickUnsubscribe = leases.subscribeTick((info) => this.onLeaseTick(info))
    return leases
  }

  /**
   * Live work the last-lease grace must not cut off: every provider run this
   * process is executing or has queued. The Host-wide run gate holds an
   * admission from `composer.send` (the only command that starts a provider
   * run) until the run's completion settles, so its occupancy is exactly the
   * in-process work — a superset of `hasRuntimeWorkForThread` over every
   * thread. A persisted run still projected `running` with no admission here
   * is a stale record, not work: nothing in this process would be lost by the
   * exit, and counting it would pin every such Host to the busy cap.
   */
  private liveRunCount(): number {
    const domain = this.domain
    if (!domain || typeof domain.runAdmissionOccupancy !== 'function') return 0
    const occupancy = domain.runAdmissionOccupancy()
    return occupancy.inflight + occupancy.queued
  }

  private onLeaseExit(reason: HostLeaseExitReason): void {
    writeHostStderr(`taskwraith-host: stopping after the last client lease (${reason})\n`)
    this.stopWithoutRetry('stopping after the last client lease')
  }

  /**
   * A stop nobody retries. The Host decides on one when its last lease is gone
   * or its registry entry is. A client requests one over the listener
   * (`host.shutdown`, from `cli.js stop` or the Desktop's HostShutdownClient),
   * and the stop closes that listener first, so the request cannot be sent
   * again. Only a signalled stop has a retry: a failed one re-arms SIGINT and
   * SIGTERM for the sender's next signal. So this stop must never leave the
   * process up with its listener closed and the profile authority held, where
   * every relaunch finds no Host. It has until its deadline
   * (HOST_LIFETIME_STOP_DEADLINE_MS). If it fails, or is still running then,
   * the Host names why on stderr, fails waitForShutdown, and ends the process
   * through `endProcess`, live handles or not. That is crash-equivalent: the
   * cleanup it could do has run, and the authority lease names this pid and
   * its birth, so the next Host takes the profile over once this process is
   * gone. A stop still running at the deadline can yet finish while the
   * process ends (endProcess waits for stderr), releasing the authority the
   * deadline's line called retained; the Host then says that too.
   */
  private stopWithoutRetry(action: string): void {
    const deadlineMs = this.options.lifetimeStopDeadlineMs ?? this.lifetimeStopDeadlineMs
    // Whichever comes first ends 'running': the stop settling, or giving up.
    let state: 'running' | 'settled' | 'gave-up' = 'running'
    const giveUp = (line: string, error: Error): void => {
      if (state !== 'running') return
      state = 'gave-up'
      writeHostStderr(`taskwraith-host: ${line}\n`)
      this.shutdown.reject(error)
      this.options.endProcess?.(1)
    }
    // Ref'd on purpose: until the stop settles or this fires, it is what keeps
    // the process alive.
    const deadline = setTimeout(
      () =>
        giveUp(
          `${action} did not finish within ${deadlineMs} ms, profile authority retained`,
          new Error(`${action} did not finish within ${deadlineMs} ms`)
        ),
      deadlineMs
    )
    void this.stop().then(
      () => {
        clearTimeout(deadline)
        if (state === 'gave-up') {
          // Only promise hops separate this from the release at the end of
          // cleanup(), so the process cannot end between the two.
          writeHostStderr(
            `taskwraith-host: ${action} finished after its ${deadlineMs} ms deadline, profile authority released\n`
          )
        }
        state = 'settled'
      },
      (error: unknown) => {
        clearTimeout(deadline)
        giveUp(
          `${action} failed, profile authority retained: ${describeFailure(error)}`,
          asError(error)
        )
      }
    )
  }

  private onLeaseTick(info: HostLeaseTickInfo): void {
    const registry = this.options.registry
    if (!registry || !this.registryPublished || !this.leases) return
    if (info.awakeMs - this.registryLastRefreshAwakeMs < HOST_REGISTRY_REFRESH_MS) return
    this.registryLastRefreshAwakeMs = info.awakeMs
    const summary = this.leases.summary()
    try {
      registry.refresh({
        holders: summary.holders,
        implicitHolders: summary.implicitHolders,
        lifetimePhase: summary.phase
      })
    } catch (error) {
      writeHostStderr(`taskwraith-host: registry refresh failed: ${String(error)}\n`)
    }
    let verdict: ReturnType<HostRegistryPublisherPort['check']>
    try {
      verdict = registry.check()
    } catch (error) {
      writeHostStderr(`taskwraith-host: registry self-check failed: ${String(error)}\n`)
      verdict = 'unreadable'
    }
    if (verdict === 'missing' || verdict === 'foreign') {
      this.registrySelfCheckStrikes += 1
      if (this.registrySelfCheckStrikes >= HOST_REGISTRY_SELF_CHECK_STRIKES) {
        writeHostStderr(
          `taskwraith-host: registry entry ${verdict} on ${this.registrySelfCheckStrikes} checks since it was last present; stopping\n`
        )
        this.stopWithoutRetry('stopping after the registry self-check')
      }
      return
    }
    // Only `present` clears the streak. `unreadable` is no information: it is
    // never a strike, so a flaky disk alone cannot take a Host down, and it
    // never breaks a streak either: a streak means the entry was already seen
    // deleted or taken over, which a read that failed cannot contradict.
    if (verdict === 'present') this.registrySelfCheckStrikes = 0
  }

  private publishRegistryEntry(): void {
    const registry = this.options.registry
    if (!registry || !this.lease || !this.identity || !this.leases) return
    const summary = this.leases.summary()
    try {
      registry.publish({
        profilePath: this.lease.path,
        pid: process.pid,
        // The discovery record's instant, so the two artefacts agree.
        startedAt: this.listener?.startedAt ?? new Date().toISOString(),
        hostId: this.identity.hostId,
        ...(this.composition?.perf.identity.bootEpoch
          ? { bootEpoch: this.composition.perf.identity.bootEpoch }
          : {}),
        ...(this.options.payloadVersion ? { payloadVersion: this.options.payloadVersion } : {}),
        ...(this.listener?.socketPath ? { socketPath: this.listener.socketPath } : {}),
        ...(this.listener?.discoveryPath ? { discoveryPath: this.listener.discoveryPath } : {}),
        persist: summary.persist,
        leaseMode: 'lease',
        holders: summary.holders,
        implicitHolders: summary.implicitHolders,
        lifetimePhase: summary.phase
      })
      this.registryPublished = true
    } catch (error) {
      writeHostStderr(`taskwraith-host: registry publish failed: ${String(error)}\n`)
    }
  }

  private removeRegistryEntry(): void {
    if (!this.registryPublished) return
    this.registryPublished = false
    try {
      this.options.registry?.remove()
    } catch (error) {
      writeHostStderr(`taskwraith-host: registry remove failed: ${String(error)}\n`)
    }
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
