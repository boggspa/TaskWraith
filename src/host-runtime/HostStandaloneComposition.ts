/**
 * Pure standalone Host authority composition.
 *
 * It owns one HostRuntimeBootstrap over the supplied runtime directory and no
 * deferred bridge/envelope/pipeline. All domain ports are already injected by
 * the caller after profile authority is established.
 *
 * Independent Threads Programme M1: the composition also owns the Host's own
 * perf instrumentation (loop-lag meter + Host work-span recorder). The
 * projection serial queue records one `host_queue_wait` span per task into
 * that recorder, and the bounded snapshot file transport (Amendment A1.2) is
 * armed only when the caller supplies `perf.snapshotFile` — the composition
 * never chooses a path or reads the environment itself.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isBootEpoch, type HostCapability, type HostCursorPosition } from '../shared/hostProtocol'
import type { WorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
  type AppStoreHostAuthorityEvaluator,
  type AppStoreHostAuthorityExecutor,
  type AppStoreHostAuthorityGitReadProvider,
  type AppStoreHostAuthorityHealthProvider,
  type AppStoreHostAuthorityHistorySinceProvider,
  type AppStoreHostAuthorityProviderAuthFlowsProvider,
  type AppStoreHostAuthorityProviderAuthStatusProvider,
  type AppStoreHostAuthorityProviderOffersProvider,
  type AppStoreHostAuthorityProviderStatusesProvider,
  type AppStoreHostAuthoritySetupExecutor,
  type AppStoreHostAuthoritySnapshotDonor,
  type AppStoreHostAuthorityThreadHistoryProvider,
  type AppStoreHostAuthorityThreadCatalogueProvider,
  type AppStoreHostAuthorityThreadCatalogueMaintenanceProvider,
  type AppStoreHostAuthorityThreadOffersProvider,
  type AppStoreHostAuthorityRecordDerivedSource,
  type AppStoreHostAuthorityThreadRecordTransaction,
  type HostStandaloneAuthorityLeasePort
} from './AppStoreHostAuthority'
import type { HostAuthority, HostAuthorityCallContext } from './HostAuthority'
import { HostDomainDeltaPublisher, type HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostCommandReceiptRecord } from './HostCommandReceiptStore'
import type { HostDeltaAppendListener } from './HostDeltaStore'
import {
  createHostPerfInstrumentation,
  type HostPerfInstrumentation,
  type HostPerfSnapshot
} from './HostPerfSnapshot'
import {
  createHostPerfSnapshotFileWriter,
  type HostPerfSnapshotFileFs,
  type HostPerfSnapshotFileIdentity,
  type HostPerfSnapshotFileTimers,
  type HostPerfSnapshotFileWriter
} from './HostPerfSnapshotFile'
import {
  HostProjectionReconciler,
  type HostProjectionReconcileResult
} from './HostProjectionReconciler'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import type { HostQueuedStartStartedView } from './HostQueuedStartPublication'
import { createHostProjectionSerialQueue } from './HostProjectionSerialQueue'
import { createHostCommitFence } from './HostCommitFence'
import { createHostCommitGate, type HostCommitGate } from './HostCommitGate'
import type { HostProjectionOperationRunner } from './HostProjectionSerialQueue'
import { HostPublicWindowIndex, hostPublicWindowOwnsEffect } from './HostPublicWindowIndex'
import { createHostScopeLedger } from './HostScopeLedger'
import {
  HostThreadRecordTransaction,
  type HostThreadRecordCommitPort,
  type HostThreadRecordTransactionPorts
} from './HostThreadRecordTransaction'
import {
  modelHostThreadRecordOffLoop,
  prepareHostThreadRecordOffLoop
} from './HostThreadRecordTransferWorker'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  isHostProfileId,
  type HostProfileThread,
  type HostThreadRecordWrittenKind
} from './HostProfileDomainStore'
import { HostPublicWindowFeeder, type HostPublicWindowSeedReport } from './HostPublicWindowFeeder'
import {
  createHostThreadRecordModelPool,
  type HostThreadRecordModelPool
} from './HostThreadRecordModelPool'
import type { HostThreadRecordFileModel, HostThreadRecordModelInput } from './HostThreadRecordModel'
import { consumeHostCleanExit, recordHostCleanExit } from './HostCleanExit'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import {
  recoverHostTransactions,
  type HostTransactionRecoveryReport
} from './HostTransactionRecovery'
import { HostSession, type HostSessionHostIdentity, type HostSessionIdFactory } from './HostSession'
import { randomBytes } from 'node:crypto'

/** Snapshot-file cadence and output cap the programme's harness collector expects. */
export const HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS = 5000
export const HOST_PERF_SNAPSHOT_FILE_MAX_BYTES = 256 * 1024

/**
 * One public opaque boot epoch. 32 bytes of CSPRNG output rendered as 64
 * lowercase hex, drawn independently of every input so it cannot be predicted
 * from host id, path or clock, and never derived from the transport token.
 */
const mintBootEpoch = (): string => randomBytes(32).toString('hex')

export interface HostStandaloneCompositionPerfSnapshotFileInput {
  /** Destination file; the writer's temp sibling is `<path>.<pid>.tmp`. */
  readonly path: string
  /** Defaults to HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS. */
  readonly intervalMs?: number
  /** Defaults to HOST_PERF_SNAPSHOT_FILE_MAX_BYTES. */
  readonly maxBytes?: number
  /** Test seams; production writes through node:fs and the global timers. */
  readonly fs?: HostPerfSnapshotFileFs
  readonly timers?: HostPerfSnapshotFileTimers
  /** Creates the destination directory once; defaults to a recursive mkdir. */
  readonly ensureDirectory?: (directory: string) => void
}

export interface HostStandaloneCompositionPerfInput {
  /** Injection seam for tests; production constructs the native meter + recorder. */
  readonly instrumentation?: HostPerfInstrumentation
  /**
   * Opt-in bounded file transport for the Host perf snapshot. Absent means no
   * file is ever written; the in-process meter and recorder still run.
   */
  readonly snapshotFile?: HostStandaloneCompositionPerfSnapshotFileInput
  /** Clock for snapshot capture timestamps; defaults to the wall clock. */
  readonly now?: () => Date
}

export interface HostStandaloneCompositionPerf {
  /** Loop lag plus Host work-span aggregates; passive unless resetLagWindow. */
  snapshot(options?: { resetLagWindow?: boolean }): HostPerfSnapshot
  /** The Host recorder; hand begin/record to Host subsystems for attribution. */
  readonly spans: WorkSpanRecorder
  /** Identity the file transport stamps; what a collector should expect. */
  readonly identity: HostPerfSnapshotFileIdentity
  /** Null unless the composition was opted into the file transport. */
  readonly snapshotFile: HostPerfSnapshotFileWriter | null
}

/**
 * The transactional `thread.record.persist` (M4 slice 12b). The production
 * server passes this only while `TASKWRAITH_HOST_TXN_PERSIST` is on; absent,
 * nothing below is built and every command runs as before.
 */
export interface HostStandaloneThreadRecordTransactionInput {
  readonly profilePath: string
  readonly records: HostThreadRecordCommitPort
  /** Defaults to the transfer worker's prepare; tests pass an in-process one. */
  readonly prepare?: HostThreadRecordTransactionPorts['prepare']
  /** Defaults to the transfer worker's file model; tests pass an in-process one. */
  readonly model?: (input: HostThreadRecordModelInput) => Promise<HostThreadRecordFileModel>
  readonly now?: () => number
  /**
   * M4 slice 13f1: seed the public window index from the committed files
   * before it publishes. Until `startPublicWindowSeed()` switches, persists
   * take today's path and the index is fed but publishes nothing.
   */
  readonly seed?: {
    readonly poolSize?: number
    /** Replaces the seed's private workers; tests pass an in-process one. */
    readonly model?: (input: HostThreadRecordModelInput) => Promise<HostThreadRecordFileModel>
  }
}

/** How a seed of the public window index ended (slice 13f1). */
export type HostPublicWindowSeedOutcome =
  | {
      readonly kind: 'switched'
      readonly report: HostPublicWindowSeedReport
      /** The generation reset that hands clients to the index. */
      readonly position: HostCursorPosition
    }
  | {
      readonly kind: 'abandoned'
      readonly report: HostPublicWindowSeedReport | null
      readonly reason: string
    }

/** More threads than this lost to dead workers abandons the seed. */
export const HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT = 3

export interface HostStandaloneCompositionInput {
  readonly runtimePath: string
  /**
   * The profile the chat files live in: boot recovery reads their identity
   * (M4 slice 14b). The transaction's own `profilePath` wins when wired.
   */
  readonly profilePath?: string
  readonly threadRecordTransaction?: HostStandaloneThreadRecordTransactionInput
  readonly lease: HostStandaloneAuthorityLeasePort
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly queuedComposerSend?: AppStoreHostAuthorityExecutor
  readonly queuedStartStartingBind?: (handler: (view: HostQueuedStartStartedView) => void) => void
  readonly queuedStartStartedBind?: (handler: (view: HostQueuedStartStartedView) => void) => void
  readonly queuedStartDispatchSettledBind?: (
    handler: (
      commandId: string,
      result: import('./HostCommandExecutionResult').HostCommandExecutionResult
    ) => void
  ) => void
  /**
   * Startup-only conservative recovery against durable positive claim evidence.
   * The returned body-free classification is internal and deliberately ignored
   * by composition; the callback may also return void.
   */
  readonly queuedStartRecovery?: (
    receipts: readonly HostCommandReceiptRecord[]
  ) => unknown | Promise<unknown>
  /**
   * Bounded companion-evidence retention. Production supplies the same
   * operational claim store used by Domain; composition supplies only the
   * receipt store's exact retained command IDs.
   */
  readonly queuedStartClaimCompaction?: (
    retainedCommandIds: ReadonlySet<string>
  ) => unknown | Promise<unknown>
  readonly setupExecutor?: AppStoreHostAuthoritySetupExecutor
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  readonly gitReadProvider?: AppStoreHostAuthorityGitReadProvider
  readonly providerStatusesProvider?: AppStoreHostAuthorityProviderStatusesProvider
  readonly providerOffersProvider?: AppStoreHostAuthorityProviderOffersProvider
  readonly providerAuthFlowsProvider?: AppStoreHostAuthorityProviderAuthFlowsProvider
  readonly providerAuthStatusProvider?: AppStoreHostAuthorityProviderAuthStatusProvider
  readonly threadHistoryProvider?: AppStoreHostAuthorityThreadHistoryProvider
  readonly threadCatalogueProvider?: AppStoreHostAuthorityThreadCatalogueProvider
  readonly threadCatalogueMaintenanceProvider?: AppStoreHostAuthorityThreadCatalogueMaintenanceProvider
  readonly historySinceProvider?: AppStoreHostAuthorityHistorySinceProvider
  readonly host: HostSessionHostIdentity
  readonly hostCapabilityOffer: readonly HostCapability[]
  readonly onShutdown?: () => void | Promise<void>
  readonly sessionIdFactory?: HostSessionIdFactory
  readonly now?: () => string
  readonly perf?: HostStandaloneCompositionPerfInput
  /**
   * Injected for tests; production mints `randomBytes(32).toString('hex')`.
   * Exactly one epoch is minted per composition incarnation — see the mint
   * site below for why that is the only value here that can witness a restart.
   */
  readonly bootEpochFactory?: () => string
  /**
   * Optional lookup for receipt_delivery on approval/question targets.
   * Production supplies the pending-interaction registry; absence skips those kinds.
   */
  readonly resolveReceiptSpanChatId?: (record: HostCommandReceiptRecord) => string | undefined
}

export interface HostStandaloneComposition {
  readonly authority: HostAuthority
  readonly session: HostSession
  readonly perf: HostStandaloneCompositionPerf
  getPosition(): ReturnType<HostRuntimeBootstrap['getPosition']>
  subscribeDeltas(listener: HostDeltaAppendListener): () => void
  recoverQueuedStarts(): Promise<void>
  startProjectionReconciliation(): Promise<void>
  reconcileProjection(): Promise<HostProjectionReconcileResult>
  stopProjectionReconciliation(): Promise<void>
  shutdown(): Promise<void>
  /**
   * M4 slice 13c1: a chat-file write for the public window feeder. Present
   * only while the transactional persist is wired.
   */
  markThreadRecord?(
    threadId: string,
    kind: HostThreadRecordWrittenKind,
    thread?: HostProfileThread
  ): void
  /**
   * M4 slice 13f1: seed the public window index from the committed files and
   * switch clients to it with one generation reset. Idempotent. Present only
   * while the transactional persist is wired with a seed.
   */
  startPublicWindowSeed?(): { readonly seeded: Promise<HostPublicWindowSeedOutcome> }
  /**
   * M4 slice 14b: decide every transactional persist a crash left open,
   * before any lane, gate or listener opens. Memoized. Null when there is
   * nothing to recover: no transaction wired, no manifest and no
   * transactional receipt.
   */
  recoverTransactions(): Promise<HostTransactionRecoveryReport | null>
  /** Whether the previous incarnation left the clean-exit marker (SF-1). */
  readonly previousExitClean: boolean
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== 'function') throw new Error(`HostStandaloneComposition requires ${label}`)
}

/** Runs a rollback step; its own failure is contained so the cause survives. */
function quietly(operation: () => void): void {
  try {
    operation()
  } catch {
    // Rollback is best effort; the activation error is what the caller sees.
  }
}

function createSnapshotFileTransport(
  options: HostStandaloneCompositionPerfSnapshotFileInput,
  instrumentation: HostPerfInstrumentation,
  identity: HostPerfSnapshotFileIdentity,
  now: (() => Date) | undefined
): HostPerfSnapshotFileWriter {
  // Option validation (path, cadence, cap, identity, timer seam shape) throws
  // here, before the meter starts: a misconfigured opt-in fails composition,
  // not a later tick.
  const timers = options.timers
  if (
    timers !== undefined &&
    (typeof timers.setInterval !== 'function' || typeof timers.clearInterval !== 'function')
  ) {
    throw new Error('Host perf snapshot timers must supply setInterval and clearInterval.')
  }
  const writer = createHostPerfSnapshotFileWriter({
    instrumentation,
    path: options.path,
    intervalMs: options.intervalMs ?? HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS,
    maxBytes: options.maxBytes ?? HOST_PERF_SNAPSHOT_FILE_MAX_BYTES,
    identity,
    ...(now ? { now } : {}),
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.timers ? { timers: options.timers } : {})
  })
  const ensureDirectory =
    options.ensureDirectory ?? ((directory: string) => mkdirSync(directory, { recursive: true }))
  try {
    ensureDirectory(dirname(options.path))
  } catch {
    // The transport is diagnostic: an unwritable directory surfaces as
    // writeFailures on the writer's stats, never as a Host startup failure.
  }
  return writer
}

export function createHostStandaloneComposition(
  input: HostStandaloneCompositionInput
): HostStandaloneComposition {
  if (!input || typeof input !== 'object')
    throw new Error('HostStandaloneComposition requires input')
  if (typeof input.runtimePath !== 'string' || input.runtimePath.length === 0) {
    throw new Error('HostStandaloneComposition requires runtimePath')
  }
  if (
    !input.host ||
    typeof input.host.hostId !== 'string' ||
    typeof input.host.hostVersion !== 'string'
  ) {
    throw new Error('HostStandaloneComposition requires host identity')
  }
  if (!Array.isArray(input.hostCapabilityOffer)) {
    throw new Error('HostStandaloneComposition requires hostCapabilityOffer')
  }
  requireFunction(input.snapshotDonor, 'snapshotDonor')
  requireFunction(input.authorityEvaluator, 'authorityEvaluator')
  requireFunction(input.commandExecutor, 'commandExecutor')
  requireFunction(input.healthProvider, 'healthProvider')
  requireFunction(input.onShutdown ?? (() => {}), 'onShutdown')

  // Must be first profile-affecting operation: permit factory synchronously
  // invokes lease.assertHeld before the runtime opens any files.
  const activationPermit = createHostStandaloneAuthorityActivationPermit(input.lease)
  // M1: the Host meters its own loop and attributes its own queue waits. The
  // identity is fixed here so the file transport and any poller agree on it.
  //
  // `generation` is a journal coordinate captured at construction, not a
  // restart counter; later journal resets do not update this identity. A PID
  // may distinguish different live processes but the OS reuses it. The writer
  // sequence is local to a writer and restarts at 1 on recreation. A
  // same-process recreation under a surviving authority lease reproduces all
  // three IDENTICALLY — which is exactly why none of them witnesses a
  // restart: a stale snapshot file from the previous incarnation would be
  // indistinguishable from the live one.
  //
  // `bootEpoch` is the value that can. One public opaque token, minted per
  // composition incarnation and compared for EQUALITY only, so PID reuse, a
  // frozen clock and a reset sequence are all irrelevant by construction. It
  // carries no timestamp, counter or ordering.
  //
  // SECURITY: the epoch is PUBLIC — written into the perf snapshot file and
  // carried on the welcome frame. The transport auth token has the exact same
  // shape (`randomBytes(32).toString('hex')`), so the two are indistinguishable
  // by inspection and a future swap would look like nothing. The epoch is
  // minted HERE, independently; this composition never receives the token.
  const bootEpoch = (input.bootEpochFactory ?? mintBootEpoch)()
  if (!isBootEpoch(bootEpoch)) {
    // Refuse rather than drop. A dropped epoch reads downstream as legacy
    // absence rather than as a fault, silently disarming the collector's pin.
    throw new Error('HostStandaloneComposition requires a 64 lowercase hex bootEpoch')
  }
  const hostPerf =
    input.perf?.instrumentation ??
    createHostPerfInstrumentation(input.perf?.now ? { now: input.perf.now } : {})
  const runtime = new HostRuntimeBootstrap({
    hostDataDir: input.runtimePath,
    receipts: {
      spans: hostPerf.spans,
      ...(input.resolveReceiptSpanChatId
        ? { resolveSpanChatId: input.resolveReceiptSpanChatId }
        : {})
    }
  })
  // SF-1: consumed before anything else can write, so a crash from here on
  // reads unclean at the next boot.
  const previousExitClean = consumeHostCleanExit(input.runtimePath)
  const perfIdentity: HostPerfSnapshotFileIdentity = Object.freeze({
    process: 'host' as const,
    instanceId: input.host.hostId,
    generation: runtime.getPosition().generation,
    pid: process.pid,
    bootEpoch
  })
  const snapshotFile = input.perf?.snapshotFile
    ? createSnapshotFileTransport(input.perf.snapshotFile, hostPerf, perfIdentity, input.perf.now)
    : null
  // The observer requires one journal position across its before/after pair.
  // Background reconciliation must publish outside that command's window.
  // Each task's enqueue→start wait is recorded as host_queue_wait on
  // host_chain; the seam changes neither FIFO order nor results.
  const projectionQueue = createHostProjectionSerialQueue({ spans: hostPerf.spans })
  const threadRecordTransaction = input.threadRecordTransaction
    ? createThreadRecordTransaction(
        input.threadRecordTransaction,
        runtime,
        input.runtimePath,
        bootEpoch
      )
    : null
  // M4 slice 13a: with the transaction wired, every projection window holds
  // the commit gate's observer mode inside its FIFO turn (lock order: lane,
  // FIFO, gate), so no capture sees a half-published commit.
  const fence = threadRecordTransaction ? createHostCommitFence(threadRecordTransaction.gate) : null
  const runProjectionOperation: HostProjectionOperationRunner = fence
    ? (operation, label) =>
        projectionQueue(() => fence(`window:${label ?? 'unlabeled'}`, operation), label)
    : projectionQueue
  let shutdownPromise: Promise<void> | null = null
  let shutdownComplete = false
  let reconciler: HostProjectionReconciler | null = null
  let drainQueuedStartPublication: () => Promise<void> = async () => undefined
  const shutdown = (): Promise<void> => {
    if (shutdownComplete) return Promise.resolve()
    if (shutdownPromise) return shutdownPromise
    const attempt = async (): Promise<void> => {
      // Queued and new transactional writers are refused. One still in
      // prepare aborts at the closed gate; one past it publishes. Either way
      // it settles before the stores below are flushed.
      await threadRecordTransaction?.close()
      // Feeds already marked publish before the stores flush.
      await threadRecordTransaction?.feeder.close()
      // Fence is domain.beginShutdown (ProductionServer calls domain.shutdown
      // first). Drain start publications after dispatches have quiesced and
      // before runtime.flush so a snapshot-only drain cannot miss work.
      await drainQueuedStartPublication()
      await reconciler?.stop()
      await runProjectionOperation(async () => undefined)
      // Diagnostics stop after the queue drains so the drain's own span is
      // recorded; the transport stops before the meter it reads.
      snapshotFile?.stop()
      hostPerf.stop()
      runtime.flush()
      // Production reaches this only after Domain has fenced new starts and
      // awaited queued dispatches. Receipt flush fixes the exact retention
      // authority before companion claim evidence is rewritten.
      await input.queuedStartClaimCompaction?.(runtime.retainedReceiptCommandIds())
      await input.onShutdown?.()
      // SF-1: the drain's last step. A failure only costs the next boot a
      // reset; a shutdown that threw above never gets here.
      try {
        recordHostCleanExit(input.runtimePath)
      } catch {
        // Read unclean next boot.
      }
    }
    shutdownPromise = attempt().then(
      () => {
        shutdownComplete = true
      },
      (error: unknown) => {
        // A failed cleanup remains retryable. Concurrent callers observe this
        // same rejection rather than a false success from a one-way flag.
        shutdownPromise = null
        throw error
      }
    )
    return shutdownPromise
  }

  const authority = new AppStoreHostAuthority({
    mode: 'standalone',
    activationPermit,
    ...(input.now ? { now: input.now } : {}),
    ports: {
      runtime,
      runProjectionOperation,
      snapshotDonor: input.snapshotDonor,
      authorityEvaluator: input.authorityEvaluator,
      commandExecutor: input.commandExecutor,
      ...(input.queuedComposerSend ? { queuedComposerSend: input.queuedComposerSend } : {}),
      ...(input.setupExecutor ? { setupExecutor: input.setupExecutor } : {}),
      healthProvider: input.healthProvider,
      ...(input.threadOffersProvider ? { threadOffersProvider: input.threadOffersProvider } : {}),
      ...(input.gitReadProvider ? { gitReadProvider: input.gitReadProvider } : {}),
      ...(input.providerStatusesProvider
        ? { providerStatusesProvider: input.providerStatusesProvider }
        : {}),
      ...(input.providerOffersProvider
        ? { providerOffersProvider: input.providerOffersProvider }
        : {}),
      ...(input.providerAuthFlowsProvider
        ? { providerAuthFlowsProvider: input.providerAuthFlowsProvider }
        : {}),
      ...(input.providerAuthStatusProvider
        ? { providerAuthStatusProvider: input.providerAuthStatusProvider }
        : {}),
      ...(input.threadHistoryProvider
        ? { threadHistoryProvider: input.threadHistoryProvider }
        : {}),
      ...(input.threadCatalogueProvider
        ? { threadCatalogueProvider: input.threadCatalogueProvider }
        : {}),
      ...(input.threadCatalogueMaintenanceProvider
        ? { threadCatalogueMaintenanceProvider: input.threadCatalogueMaintenanceProvider }
        : {}),
      ...(input.historySinceProvider ? { historySinceProvider: input.historySinceProvider } : {}),
      ...(threadRecordTransaction && fence
        ? {
            threadRecordTransaction: threadRecordTransaction.port,
            fence,
            recordDerived: threadRecordTransaction.recordDerived
          }
        : {}),
      onShutdown: shutdown
    }
  })
  drainQueuedStartPublication = () => authority.drainQueuedStartPublication()
  input.queuedStartStartingBind?.((view) => {
    authority.handleQueuedStartStarting(view)
  })
  input.queuedStartStartedBind?.((view) => {
    authority.handleQueuedStartStarted(view)
  })
  input.queuedStartDispatchSettledBind?.((commandId, result) => {
    authority.handleQueuedStartDispatchSettled(commandId, result)
  })

  const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
  const internalContext: HostAuthorityCallContext = {
    actor: { actorId: 'host-reconciler', clientId: 'host-reconciler', clientClass: 'desktop' },
    client: { clientId: 'host-reconciler', clientClass: 'desktop', clientVersion: '0.0.0' }
  }
  reconciler = new HostProjectionReconciler({
    runProjectionOperation,
    captureSnapshot: async () => {
      const result = await authority.snapshot(internalContext)
      if (!result.ok) throw new Error(`standalone_snapshot_${result.error}`)
      return result.value
    },
    fetchDeltas: (position) => runtime.deltaStore.since(position),
    publishEffects: (effects) => publisher.publishDurableBatch(effects),
    ...(threadRecordTransaction
      ? {
          // Slice 13f2: once the index publishes, its families are its own.
          owns: (effect: HostDomainEffectDto) =>
            threadRecordTransaction.recordDerived.active() &&
            hostPublicWindowOwnsEffect(effect.family, effect.entityId)
        }
      : {})
  })
  const session = new HostSession({
    host: input.host,
    runtime,
    hostCapabilityOffer: input.hostCapabilityOffer,
    ...(input.sessionIdFactory ? { sessionIdFactory: input.sessionIdFactory } : {})
  })
  // Everything that can refuse construction has run. Activation is
  // transactional: if arming the transport throws (an injected timer seam),
  // the meter it would have read is stopped again and the original error
  // propagates, so a failed composition leaves nothing sampling or ticking.
  try {
    hostPerf.start()
    snapshotFile?.start()
  } catch (error) {
    // A rollback failure must not replace the activation error.
    quietly(() => snapshotFile?.stop())
    quietly(() => hostPerf.stop())
    throw error
  }

  let recovering: Promise<HostTransactionRecoveryReport | null> | null = null
  const recoverTransactionsOnce = async (): Promise<HostTransactionRecoveryReport | null> => {
    const manifestPath = join(input.runtimePath, HOST_TRANSACTION_LOG_FILENAME)
    const transactional = runtime.receiptStore
      .list()
      .some((record) => record.commandClass === 'txn-record-persist')
    // The flag turned off after a crash: recovery still runs whenever a
    // manifest or a transactional receipt exists (§12.2).
    const log =
      threadRecordTransaction?.log ??
      (existsSync(manifestPath) || transactional
        ? HostTransactionLog.open({ dataDir: input.runtimePath })
        : null)
    if (!log) return null
    const profilePath = input.threadRecordTransaction?.profilePath ?? input.profilePath
    if (!profilePath) throw new Error('Transaction recovery needs the profile path')
    return recoverHostTransactions(
      {
        receipts: runtime.receiptStore,
        log,
        deltas: runtime.deltaStore,
        profilePath,
        now: input.threadRecordTransaction?.now ?? (() => Date.now())
      },
      // Decision 2: with the index publishing, an unclean exit resets once.
      { reset: threadRecordTransaction && !previousExitClean ? 'always' : 'when-needed' }
    )
  }

  return {
    authority,
    session,
    perf: {
      snapshot: (options) => hostPerf.snapshot(options),
      spans: hostPerf.spans,
      identity: perfIdentity,
      snapshotFile
    },
    getPosition: () => runtime.getPosition(),
    subscribeDeltas: (listener) => runtime.deltaStore.subscribe(listener),
    previousExitClean,
    recoverTransactions: () => {
      recovering ??= recoverTransactionsOnce()
      return recovering
    },
    recoverQueuedStarts: async () => {
      const receipts = runtime.receiptStore.list()
      await input.queuedStartRecovery?.(receipts)
      // Recovery must consume positive evidence before any obsolete claim row
      // can be removed. This still runs before reconciliation/listener startup.
      await input.queuedStartClaimCompaction?.(runtime.retainedReceiptCommandIds())
    },
    startProjectionReconciliation: () => reconciler!.start(),
    reconcileProjection: () => reconciler!.reconcileNow(),
    stopProjectionReconciliation: () => reconciler!.stop(),
    shutdown,
    ...(threadRecordTransaction
      ? {
          markThreadRecord: (
            threadId: string,
            kind: HostThreadRecordWrittenKind,
            thread?: HostProfileThread
          ) => {
            if (kind === 'deleted') authority.threadRecordDeleted(threadId)
            return threadRecordTransaction.feeder.mark(threadId, kind, thread)
          },
          ...(threadRecordTransaction.startSeed
            ? { startPublicWindowSeed: threadRecordTransaction.startSeed }
            : {})
        }
      : {})
  }
}

/** A serial queue: each piece of work starts once the one before it settled. */
function createSerialLock(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(work)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/**
 * The transaction's stores and locks for one composition (M4 slice 12b):
 * the thread lanes, the commit gate, the manifest, the public window index
 * and the publication lock, over the runtime's delta and receipt stores.
 */
/** Every committed chat file's thread id, largest file first. */
function listCommittedThreadIds(profilePath: string): string[] {
  const directory = join(profilePath, HOST_PROFILE_CHATS_DIRECTORY)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const sized: { threadId: string; size: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const threadId = name.slice(0, -'.json'.length)
    if (!isHostProfileId(threadId)) continue
    let size = 0
    try {
      const stat = lstatSync(join(directory, name))
      if (!stat.isFile()) continue
      size = stat.size
    } catch {
      continue
    }
    sized.push({ threadId, size })
  }
  sized.sort((left, right) => right.size - left.size || compareText(left.threadId, right.threadId))
  return sized.map((entry) => entry.threadId)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function createThreadRecordTransaction(
  options: HostStandaloneThreadRecordTransactionInput,
  runtime: HostRuntimeBootstrap,
  runtimePath: string,
  bootEpoch: string
): {
  port: AppStoreHostAuthorityThreadRecordTransaction
  gate: HostCommitGate
  feeder: HostPublicWindowFeeder
  startSeed?: () => { readonly seeded: Promise<HostPublicWindowSeedOutcome> }
  recordDerived: AppStoreHostAuthorityRecordDerivedSource
  log: HostTransactionLog
  close(): Promise<void>
} {
  const ledger = createHostScopeLedger({ hostIncarnation: bootEpoch })
  const gate = createHostCommitGate()
  const log = HostTransactionLog.open({ dataDir: runtimePath })
  const index = new HostPublicWindowIndex()
  const publicationLock = createSerialLock()
  const now = options.now ?? (() => Date.now())
  const inFlight = new Set<Promise<unknown>>()
  const model = options.model ?? modelHostThreadRecordOffLoop
  const feeder = new HostPublicWindowFeeder({
    index,
    publicationLock,
    gate,
    deltas: runtime.deltaStore,
    model: (threadId) => model({ profilePath: options.profilePath, threadId }),
    now,
    publishing: options.seed === undefined
  })
  // Without a seed the index publishes from the start (the harness since
  // slice 12b); with one, only once the seed switches clients to it.
  let switched = options.seed === undefined
  let seeding: { readonly seeded: Promise<HostPublicWindowSeedOutcome> } | null = null
  let seedPool: HostThreadRecordModelPool | undefined
  const seedOptions = options.seed
  const startSeed = seedOptions
    ? (): { readonly seeded: Promise<HostPublicWindowSeedOutcome> } => {
        seeding ??= {
          seeded: seedPublicWindow(seedOptions).catch(
            (error: unknown): HostPublicWindowSeedOutcome => ({
              kind: 'abandoned',
              report: null,
              reason: error instanceof Error ? error.message : 'seed_failed'
            })
          )
        }
        return seeding
      }
    : undefined
  const seedPublicWindow = async (
    seed: NonNullable<HostStandaloneThreadRecordTransactionInput['seed']>
  ): Promise<HostPublicWindowSeedOutcome> => {
    let seedModel = seed.model
    if (!seedModel) {
      seedPool = createHostThreadRecordModelPool({ size: seed.poolSize })
      if (!seedPool) return { kind: 'abandoned', report: null, reason: 'no_worker_entry' }
      seedModel = seedPool.model
    }
    const read = seedModel
    try {
      const threadIds = listCommittedThreadIds(options.profilePath)
      const report = await feeder.seed(threadIds, (threadId) =>
        read({ profilePath: options.profilePath, threadId })
      )
      if (report.aborted) return { kind: 'abandoned', report, reason: 'aborted' }
      if (report.abandoned.length > HOST_PUBLIC_WINDOW_SEED_ABANDON_LIMIT) {
        return { kind: 'abandoned', report, reason: 'workers_failed' }
      }
      // No committer mid-publish and no observer mid-capture: clients move
      // from today's captures to the index at one reset.
      const entered = await gate.enter('exclusive', { label: 'public-window:switch' })
      if (!entered.ok) return { kind: 'abandoned', report, reason: 'gate_closed' }
      try {
        const reset = await publicationLock(() => {
          feeder.startPublishing()
          switched = true
          return runtime.deltaStore.resetGeneration('public window seeded')
        })
        if (reset.kind !== 'appended') {
          return { kind: 'abandoned', report, reason: 'reset_failed' }
        }
        return { kind: 'switched', report, position: reset.position }
      } finally {
        entered.lease.release()
      }
    } finally {
      await seedPool?.close()
    }
  }
  return {
    gate,
    feeder,
    log,
    ...(startSeed ? { startSeed } : {}),
    // Slice 13f2: once switched, snapshots read the five families here.
    recordDerived: {
      active: () => switched,
      // A committed view is never mutated: a later commit builds a new one.
      read: () => publicationLock(() => index.wire()),
      durable: () => runtime.deltaStore.awaitDurable()
    },
    port: {
      ledger,
      // Only the manifest's health: a closed ledger routes here and refuses
      // (host_shutting_down) rather than falling back to today's path. Until
      // a seed switches, persists take today's path (slice 13f1).
      available: () => switched && log.getFailure() === null,
      create: (legacy) => {
        const transaction = new HostThreadRecordTransaction({
          ledger,
          gate,
          log,
          index,
          deltas: runtime.deltaStore,
          receipts: runtime.receiptStore,
          prepare: options.prepare ?? prepareHostThreadRecordOffLoop,
          records: options.records,
          legacy,
          publicationLock,
          profilePath: options.profilePath,
          now
        })
        return {
          execute: (input) => {
            const running = transaction.execute(input)
            // A persist holds the commit gate through its index commit, so it
            // publishes a short window and the feeder refills it (slice 13e).
            void running.then(
              (outcome) => {
                if (outcome.kind === 'succeeded' && outcome.refill.length > 0) {
                  feeder.refill(outcome.refill)
                }
              },
              () => undefined
            )
            const settled = running.then(
              () => undefined,
              () => undefined
            )
            inFlight.add(settled)
            void settled.then(() => inFlight.delete(settled))
            return running
          }
        }
      }
    },
    close: async () => {
      ledger.close()
      // Already marked feeds must drain while the gate still admits them.
      // Closing the ledger refuses new lane writers; entered transactions
      // finish below before any runtime store is flushed.
      await feeder.close()
      gate.close()
      await Promise.all([...inFlight])
      // A seed still reading is dropped with the feeder; its workers go too.
      await seedPool?.close()
    }
  }
}
