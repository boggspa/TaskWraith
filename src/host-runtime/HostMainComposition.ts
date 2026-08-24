/**
 * Host Arc Wave 3.4 — production in-main Host composition.
 *
 * WHAT THIS IS. The single factory that assembles the production Host out of
 * the durable stores, the deferred-command bridge, the Authority and the
 * session binder. It is the module a composition root (Wave 3.6, last) calls
 * once, so that the root itself contains wiring and no domain logic.
 *
 * WHY IT LOOKS LIKE THIS. Per the ratified placement ruling, this wave hosts
 * the Host IN-MAIN: domain execution cannot move unchanged, because the
 * production executor closes over main-process singletons at the composition
 * root. The seam that survives that ruling is the executor PORT — this module
 * therefore accepts an already-constructed executor and NEVER builds one from
 * AppStore/Bridge singletons. If a dedicated Host child ever ships, only the
 * injected port becomes RPC-backed; nothing here changes shape.
 *
 * SCOPE-4c. Production composition ALWAYS wires the S4a AllowPipeline adapter
 * as Bridge resolve ports (required `pipeline` — no optional refusal default)
 * and wraps the snapshot donor so awaiting approval-kind challenges publish
 * with `approvalId = challengeId` (GAP-A). S4b E-first hooks
 * (`getByChallengeId` / `resolve`) are closed over the same Bridge instance.
 *
 * BOUNDARIES (enforced by the import-isolation test alongside this file):
 * - zero `electron` imports;
 * - zero AppStore / BridgeActionExecutor / provider VALUE imports (the
 *   Authority class shares the historic `AppStoreHostAuthority` name but is
 *   itself an injected-ports module — it reads no AppStore);
 * - zero HostLocalServer construction: the listener's lifecycle belongs to the
 *   supervisor slice (3.5), not to composition;
 * - zero composition-root edits.
 *
 * POSITION AUTHORITY. Generation/cursor are read from HostRuntimeBootstrap,
 * which reads them from the sole delta journal. This module never counts.
 */

import type { HostApprovalProjection, HostCapability } from '../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  type AppStoreHostAuthorityEvaluator,
  type AppStoreHostAuthorityExecutor,
  type AppStoreHostAuthorityHealthProvider,
  type AppStoreHostAuthorityShutdownCallback,
  type AppStoreHostAuthoritySnapshotDonor,
  type AppStoreHostAuthorityThreadOffersProvider
} from './AppStoreHostAuthority'
import type { HostAuthority, HostAuthorityCallContext } from './HostAuthority'
import type { HostDeferredAllowPipeline } from './HostDeferredAllowPipeline'
import {
  captureTwMissionFromHostSnapshot,
  type TwMissionHostCaptureResult
} from '../host-shared/twmission/TwMissionHostCapture'
import {
  HostDeferredCommandBridge,
  type HostDeferredCommandBridgePorts
} from './HostDeferredCommandBridge'
import { createHostDeferredResolutionAdapter } from './HostDeferredResolutionAdapter'
import {
  HostRuntimeBootstrap,
  type HostRuntimeRecoverySummaryWithDeferred
} from './HostRuntimeBootstrap'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import type { HostDeltaAppendListener } from './HostDeltaStore'
import {
  HostProjectionReconciler,
  type HostProjectionReconcileResult
} from './HostProjectionReconciler'
import { HostSession, type HostSessionHostIdentity, type HostSessionIdFactory } from './HostSession'
import { hostRuntimeDataDir } from './HostRuntimePaths'

/**
 * Terminal code surfaced when a deferred challenge is resolved on a Host whose
 * deferred EXECUTION ports were never wired.
 *
 * Retained for Wave-6 audit of the refusal helper and for isolated Bridge
 * tests. Production composition (S4c) never installs these ports — it always
 * wires the AllowPipeline adapter.
 */
export const HOST_DEFERRED_RESOLUTION_UNWIRED_CODE = 'host_deferred_resolution_unwired'

/**
 * Fail-closed default resolve-side bridge ports.
 *
 * Every port throws. The bridge converts a throwing executor into a terminal
 * `failed` record plus `{ kind: 'failed', code: 'executor_failed' }`, so the
 * ask still dies explicitly and can never be executed twice.
 *
 * Exported so the refusal is asserted directly rather than merely claimed.
 * Production createHostMainComposition does not call this (S4c required flip).
 */
export function createUnwiredDeferredResolutionPorts(): HostDeferredCommandBridgePorts {
  const refuse = (): never => {
    throw new Error(HOST_DEFERRED_RESOLUTION_UNWIRED_CODE)
  }
  return {
    completeReceipt: refuse,
    executeCommand: refuse,
    publishEffects: refuse
  }
}

/**
 * Everything this factory needs, all injected. No singletons are read here:
 * the composition root owns singleton access and hands over ports.
 */
export interface HostMainCompositionInput {
  /** Absolute userData path. The Host data directory is derived from it. */
  readonly userDataPath: string
  /**
   * Already-constructed domain executor port. In production the composition
   * root supplies a HostBridgeCommandExecutor; this module never builds one.
   */
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  readonly host: HostSessionHostIdentity
  readonly hostCapabilityOffer: readonly HostCapability[]
  /** Extra durable-state flush performed after the Host's own flush. */
  readonly onShutdown?: AppStoreHostAuthorityShutdownCallback
  /**
   * AllowPipeline for deferred allow execution (S4c).
   * Composition builds the S4a adapter over this and installs it as Bridge
   * resolve ports — no optional refusal default remains on the production path.
   *
   * Supply EXACTLY ONE of `pipeline` or `pipelineFactory`. Supplying neither
   * keeps S4c's fail-closed rejection verbatim; supplying both is rejected
   * rather than silently preferring one.
   */
  readonly pipeline?: HostDeferredAllowPipeline
  /**
   * Wave 3.6a seam.
   *
   * A REAL AllowPipeline binds the resolver/mutation/coordinator chain to the
   * delta, receipt and envelope stores that HostRuntimeBootstrap owns — and
   * this module deliberately keeps those private (public surface is only
   * authority/session/getPosition/getRecoverySummary/shutdown). A composition
   * root therefore cannot build one without constructing a SECOND bootstrap
   * over the same hostDataDir, which is the forbidden second journal.
   *
   * This closure is the narrow way out: it is handed the composition's own
   * runtime, exactly once, after bootstrap and before the Authority exists.
   * One injected function sees the stores instead of every future consumer,
   * which is why it was ruled over public store-port accessors.
   */
  readonly pipelineFactory?: (runtime: HostRuntimeBootstrap) => HostDeferredAllowPipeline
  readonly sessionIdFactory?: HostSessionIdFactory
  /** Injected ISO clock for tests. */
  readonly now?: () => string
}

/** The composed production Host, exposed only through stable surfaces. */
export interface HostMainComposition {
  /** Deterministic durable directory every Host store shares. */
  readonly hostDataDir: string
  /** Facade-typed: consumers see HostAuthority, never the concrete class. */
  readonly authority: HostAuthority
  /** Session binder for an authenticated transport (3.3 server, 3.5 wiring). */
  readonly session: HostSession
  /** Sole-journal position passthrough. */
  getPosition(): ReturnType<HostRuntimeBootstrap['getPosition']>
  /**
   * Narrow post-commit delta feed for supervised transports. Historical
   * catch-up remains authority.deltas(); no durable store is exposed.
   */
  subscribeDeltas(listener: HostDeltaAppendListener): () => void
  /** Body-free recovery summary passthrough — counts and availability only. */
  getRecoverySummary(): HostRuntimeRecoverySummaryWithDeferred
  /**
   * Establish the app-owned projection baseline and start reconciliation.
   * The supervisor calls this before opening the client listener.
   */
  startProjectionReconciliation(): Promise<void>
  /** Run one serialized convergence pass, primarily for lifecycle verification. */
  reconcileProjection(): Promise<HostProjectionReconcileResult>
  /** Stop the convergence loop and drain an in-flight pass. */
  stopProjectionReconciliation(): Promise<void>
  /**
   * Wave 5 next-slice — export a privacy-safe `.twmission` bundle from the
   * live Host snapshot (authority.snapshot → capture). Read-only; does not
   * mutate Host journals. Import remains detached via importTwMissionBundleBytes.
   * Not AC9 PASS.
   */
  exportTwMission(
    context: HostAuthorityCallContext,
    options?: {
      readonly exportedAt?: string
      readonly redactionNotes?: readonly string[]
    }
  ): Promise<TwMissionHostCaptureResult>
  /** Idempotent durable flush. Listener lifecycle belongs to the supervisor. */
  shutdown(): Promise<void>
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== 'function') {
    throw new Error(`HostMainComposition requires an injected ${label}`)
  }
}

/**
 * The ONE pipeline predicate.
 *
 * Applied identically to a directly injected `pipeline` and to whatever
 * `pipelineFactory` returns, so a factory cannot smuggle in a value that a
 * direct injection would have been rejected for. Same checks, same messages.
 */
function requirePipeline(
  candidate: HostDeferredAllowPipeline | undefined
): HostDeferredAllowPipeline {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('HostMainComposition requires an injected pipeline')
  }
  requireFunction(candidate.execute, 'pipeline.execute')
  return candidate
}

/**
 * In-process identity used only to observe the Host's own bounded projection.
 * Transport identity never reaches this context and this context never issues
 * commands, so it cannot mint authority for a client.
 *
 * HostClientClass has no host-internal member yet. Keep the migration-local
 * desktop class explicit until the protocol grows that identity deliberately.
 */
const HOST_RECONCILER_CONTEXT: HostAuthorityCallContext = {
  actor: {
    actorId: 'host-reconciler',
    clientId: 'host-reconciler',
    clientClass: 'desktop'
  },
  client: {
    clientId: 'host-reconciler',
    clientClass: 'desktop',
    clientVersion: '0.0.0'
  }
}

/**
 * Bounded approval card from an awaiting Bridge row (GAP-A / PIN S4-Q).
 * Body-free: challengeId as id, commandName as actionKind, no args/fingerprint.
 */
function awaitingApprovalCardFromBridgeRecord(record: {
  challengeId: string
  commandId: string
  commandName: string
  createdAt: string
}): HostApprovalProjection {
  const parsed = Date.parse(record.createdAt)
  return {
    approvalId: record.challengeId,
    // Wave 4.2c: the durable deferred record has always carried commandId
    // beside challengeId. Publishing it is what makes exact binding possible;
    // nothing here is derived or invented.
    commandId: record.commandId,
    actionKind: record.commandName,
    status: 'pending',
    createdAt: Number.isFinite(parsed) ? parsed : 0,
    summary: `Deferred ${record.commandName}`
  }
}

/**
 * Compose the production in-main Host.
 *
 * CONSTRUCTION ORDER IS LOAD-BEARING — read this before reordering anything.
 * It changed in Wave 3.6a and the previous comment here described the old
 * order, which was bridge-first:
 *
 *   1. HostRuntimeBootstrap FIRST, so `pipelineFactory` can be handed the real
 *      stores. This is what avoids a second bootstrap over the same
 *      hostDataDir (the forbidden second journal). It is safe because the
 *      bridge half of deferred recovery is a LAZY closure: the bootstrap
 *      constructor only stores `deferredRecovery` and does not call `list()`
 *      until getRecoverySummary() runs.
 *   2. the AllowPipeline — injected directly or built by the factory, both
 *      validated by the same predicate.
 *   3. the S4a resolve adapter over that pipeline.
 *   4. the deferred Bridge, which back-fills `deferredBridgeRef` so the
 *      recovery closure from step 1 resolves.
 *   5. the Authority LAST, so it receives both durable halves as narrow ask
 *      ports.
 */
export function createHostMainComposition(input: HostMainCompositionInput): HostMainComposition {
  if (!input || typeof input !== 'object') {
    throw new Error('HostMainComposition requires an options object')
  }
  if (typeof input.userDataPath !== 'string' || input.userDataPath.length === 0) {
    throw new Error('HostMainComposition requires an injected userDataPath')
  }
  requireFunction(input.commandExecutor, 'commandExecutor')
  requireFunction(input.snapshotDonor, 'snapshotDonor')
  requireFunction(input.authorityEvaluator, 'authorityEvaluator')
  requireFunction(input.healthProvider, 'healthProvider')
  if (input.threadOffersProvider !== undefined) {
    requireFunction(input.threadOffersProvider, 'threadOffersProvider')
  }
  if (
    !input.host ||
    typeof input.host.hostId !== 'string' ||
    input.host.hostId.length === 0 ||
    typeof input.host.hostVersion !== 'string' ||
    input.host.hostVersion.length === 0
  ) {
    throw new Error('HostMainComposition requires an injected host identity')
  }
  if (!Array.isArray(input.hostCapabilityOffer)) {
    throw new Error('HostMainComposition requires an injected hostCapabilityOffer')
  }
  // Exactly one deferred-execution source. Both is a wiring mistake worth
  // failing on rather than silently preferring one; neither keeps S4c's
  // original rejection verbatim.
  if (input.pipeline !== undefined && input.pipelineFactory !== undefined) {
    throw new Error(
      'HostMainComposition accepts either an injected pipeline or a pipelineFactory, not both'
    )
  }
  if (input.pipelineFactory !== undefined) {
    requireFunction(input.pipelineFactory, 'pipelineFactory')
  } else {
    requirePipeline(input.pipeline)
  }

  const hostDataDir = hostRuntimeDataDir(input.userDataPath)
  const now = input.now

  // 3.6a construction order: BOOTSTRAP FIRST.
  //
  // Safe because the bridge half of deferred recovery is lazy — the bootstrap
  // constructor only STORES `deferredRecovery`; list() is not called until
  // getRecoverySummary() runs. That is precisely what lets pipelineFactory be
  // handed the real stores without a second bootstrap on the same hostDataDir.
  let deferredBridgeRef: HostDeferredCommandBridge | null = null
  const runtime = new HostRuntimeBootstrap({
    hostDataDir,
    deferredRecovery: { list: () => deferredBridgeRef?.list() ?? [] }
  })

  // Exactly once, after bootstrap, before the Authority exists.
  const pipeline = input.pipelineFactory
    ? requirePipeline(input.pipelineFactory(runtime))
    : requirePipeline(input.pipeline)

  // Envelope store owns the durable idempotencyKey (S4a injection seam — zero
  // store imports inside the adapter module). The runtime already exists at
  // this point, so the lazy ref S4c needed here is gone.
  const adapterPorts = createHostDeferredResolutionAdapter({
    pipeline,
    resolveIdempotencyKey: (executeInput) => {
      const lookup = runtime.envelopeStore.getByDeferredId(
        executeInput.deferredId,
        executeInput.actor
      )
      if (lookup.kind !== 'found') return null
      return lookup.record.idempotencyKey
    }
  })

  const deferredBridge = new HostDeferredCommandBridge({
    dataDir: hostDataDir,
    ports: adapterPorts,
    ...(now ? { now } : {})
  })
  deferredBridgeRef = deferredBridge

  // GAP-A donor wrap: publish Host-minted challengeId as approval card id.
  // Approval-kind + awaiting only (PIN S4-Q excludes question-kind publish).
  const wrappedSnapshotDonor: AppStoreHostAuthoritySnapshotDonor = async () => {
    const families = await input.snapshotDonor()
    const existingIds = new Set(families.approvals.map((a) => a.approvalId))
    const merged: HostApprovalProjection[] = [...families.approvals]
    for (const record of deferredBridge.list()) {
      if (record.state !== 'awaiting' || record.challengeKind !== 'approval') continue
      if (existingIds.has(record.challengeId)) continue
      existingIds.add(record.challengeId)
      merged.push(awaitingApprovalCardFromBridgeRecord(record))
    }
    return {
      ...families,
      approvals: merged
    }
  }

  // Idempotent so an authoritative host shutdown and a supervisor stop cannot
  // double-flush, and so shutdown can never re-enter through the Authority.
  // The reconciler is assigned after Authority construction; its shutdown is
  // awaited before flushing so it cannot append behind the final flush.
  let projectionReconciler: HostProjectionReconciler | null = null
  let stopped = false
  const flushDurableState = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await projectionReconciler?.stop()
    runtime.flush()
    await input.onShutdown?.()
  }

  const authority = new AppStoreHostAuthority({
    mode: 'in-process-migration',
    activationPermit: { hostOwnedStateMayHaveAdvanced: false },
    ...(now ? { now } : {}),
    ports: {
      runtime,
      snapshotDonor: wrappedSnapshotDonor,
      authorityEvaluator: input.authorityEvaluator,
      commandExecutor: input.commandExecutor,
      healthProvider: input.healthProvider,
      ...(input.threadOffersProvider ? { threadOffersProvider: input.threadOffersProvider } : {}),
      onShutdown: flushDurableState,
      deferredAsk: {
        envelopeStorePut: (put) => runtime.envelopeStore.put(put),
        bridgeRegister: (register) => deferredBridge.register(register),
        // S4b E-first hooks — same Bridge instance the adapter resolves against.
        getByChallengeId: (challengeId, actor) =>
          deferredBridge.getByChallengeId(challengeId, actor),
        resolve: (resolveInput) => deferredBridge.resolve(resolveInput)
      }
    }
  })

  const projectionPublisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
  const reconciler = new HostProjectionReconciler({
    captureSnapshot: async () => {
      const result = await authority.snapshot(HOST_RECONCILER_CONTEXT)
      if (!result.ok) throw new Error(`host_projection_snapshot_${result.error}`)
      return result.value
    },
    fetchDeltas: (position) => runtime.deltaStore.since(position),
    publishEffects: (effects) => projectionPublisher.publish(effects)
  })
  projectionReconciler = reconciler

  const session = new HostSession({
    host: input.host,
    runtime,
    hostCapabilityOffer: input.hostCapabilityOffer,
    ...(input.sessionIdFactory ? { sessionIdFactory: input.sessionIdFactory } : {})
  })

  return {
    hostDataDir,
    authority,
    session,
    getPosition: () => runtime.getPosition(),
    subscribeDeltas: (listener) => runtime.deltaStore.subscribe(listener),
    getRecoverySummary: () => runtime.getRecoverySummary(),
    startProjectionReconciliation: () => reconciler.start(),
    reconcileProjection: () => reconciler.reconcileNow(),
    stopProjectionReconciliation: () => reconciler.stop(),
    exportTwMission: async (context, options) => {
      const snap = await authority.snapshot(context)
      if (!snap.ok) {
        return { ok: false, error: snap.error }
      }
      return captureTwMissionFromHostSnapshot({
        snapshot: snap.value,
        hostId: input.host.hostId,
        ...(options?.exportedAt ? { exportedAt: options.exportedAt } : {}),
        ...(options?.redactionNotes ? { redactionNotes: options.redactionNotes } : {}),
        ...(now ? { now } : {})
      })
    },
    shutdown: flushDurableState
  }
}
