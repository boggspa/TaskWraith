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

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { HostCapability } from '../shared/hostProtocol'
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
  type HostStandaloneAuthorityLeasePort
} from './AppStoreHostAuthority'
import type { HostAuthority, HostAuthorityCallContext } from './HostAuthority'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
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
import { createHostProjectionSerialQueue } from './HostProjectionSerialQueue'
import { HostSession, type HostSessionHostIdentity, type HostSessionIdFactory } from './HostSession'
import { randomBytes } from 'node:crypto'

/** Snapshot-file cadence and output cap the programme's harness collector expects. */
export const HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS = 5000
export const HOST_PERF_SNAPSHOT_FILE_MAX_BYTES = 256 * 1024

/** Matches the writer's and the welcome codec's validators exactly. */
const HOST_BOOT_EPOCH_PATTERN = /^[0-9a-f]{64}$/

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

export interface HostStandaloneCompositionInput {
  readonly runtimePath: string
  readonly lease: HostStandaloneAuthorityLeasePort
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
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
}

export interface HostStandaloneComposition {
  readonly authority: HostAuthority
  readonly session: HostSession
  readonly perf: HostStandaloneCompositionPerf
  getPosition(): ReturnType<HostRuntimeBootstrap['getPosition']>
  subscribeDeltas(listener: HostDeltaAppendListener): () => void
  startProjectionReconciliation(): Promise<void>
  reconcileProjection(): Promise<HostProjectionReconcileResult>
  stopProjectionReconciliation(): Promise<void>
  shutdown(): Promise<void>
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
  const runtime = new HostRuntimeBootstrap({ hostDataDir: input.runtimePath })
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
  if (typeof bootEpoch !== 'string' || !HOST_BOOT_EPOCH_PATTERN.test(bootEpoch)) {
    // Refuse rather than drop. A dropped epoch reads downstream as legacy
    // absence rather than as a fault, silently disarming the collector's pin.
    throw new Error('HostStandaloneComposition requires a 64 lowercase hex bootEpoch')
  }
  const hostPerf =
    input.perf?.instrumentation ??
    createHostPerfInstrumentation(input.perf?.now ? { now: input.perf.now } : {})
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
  const runProjectionOperation = createHostProjectionSerialQueue({ spans: hostPerf.spans })
  let stopped = false
  let reconciler: HostProjectionReconciler | null = null
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await reconciler?.stop()
    await runProjectionOperation(async () => undefined)
    // Diagnostics stop after the queue drains so the drain's own span is
    // recorded; the transport stops before the meter it reads.
    snapshotFile?.stop()
    hostPerf.stop()
    runtime.flush()
    await input.onShutdown?.()
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
      onShutdown: shutdown
    }
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
    publishEffects: (effects) => publisher.publishDurableBatch(effects)
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
    startProjectionReconciliation: () => reconciler!.start(),
    reconcileProjection: () => reconciler!.reconcileNow(),
    stopProjectionReconciliation: () => reconciler!.stop(),
    shutdown
  }
}
