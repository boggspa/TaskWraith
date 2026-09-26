import {
  decodeThreadCatalogueReadQuery,
  decodeThreadCatalogueMaintenanceQuery,
  type ThreadCatalogueMaintenanceQuery,
  type ThreadCatalogueRequestOptions,
  type ThreadCatalogueReadQuery,
  type ThreadCatalogueWireReply
} from '../shared/threadCatalogueProtocol'
import { threadCatalogueRequestError } from '../shared/threadCatalogueRequestError'
/**
 * In-process migration HostAuthority (Host Arc Wave 2B Subwave 4C).
 *
 * Explicit pre-cutover / rollback adapter over injected current-authority ports.
 * Never reads AppStore, Bridge, or Electron directly; never opens listeners,
 * launches providers, or reimplements work locks / permission walls.
 * No production singleton or composition-root wiring in this module.
 */

import type { HostProjectionOperationRunner } from './HostProjectionSerialQueue'
import {
  decodeHostCommand,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  decodeHostCommandReceipt,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_MAX_ID,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandReceipt,
  type HostCursorPosition,
  type HostDeltasSinceResult,
  type HostHealthProjection,
  type HostResultRef,
  type HostSnapshot
} from '../shared/hostProtocol'
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import {
  decodeHostWorkspaceGitReadParams,
  decodeHostWorkspaceGitReadResult,
  type HostWorkspaceGitReadParams,
  type HostWorkspaceGitReadResult
} from '../shared/hostProtocolTransport'
import {
  decodeHostHistorySinceRequest,
  decodeHostHistorySinceResult,
  decodeHostThreadHistoryPage,
  decodeHostThreadHistoryRequest,
  type HostHistorySinceRequest,
  type HostHistorySinceResult,
  type HostThreadHistoryPage,
  type HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import {
  decodeHostProviderAuthFlows,
  decodeHostProviderAuthStatusProjection,
  decodeHostProviderOffersProjection,
  decodeHostProviderStatuses,
  type HostProviderAuthFlowProjection,
  type HostProviderAuthStatusProjection,
  type HostProviderOffersProjection,
  type HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import {
  hostAuthorityCommandActorMatchesContext,
  isExactHostActorIdentity,
  parseHostAuthorityReceiptLookup,
  type HostAuthority,
  type HostAuthorityCallContext,
  type HostAuthorityReceiptLookup,
  type HostAuthorityReceiptResult,
  type HostAuthorityResult,
  type HostAuthorityShutdownResult
} from './HostAuthority'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import { validateHostCommandArguments } from './HostCommandArguments'
import {
  parseGovernedMutationCommandName,
  parseSetupMutationCommandName
} from './HostCommandRouting'
import { projectHostCommandReceipt } from './HostCommandReceiptProjection'
import { mintHostCommandId } from '../host-shared/HostCommandIdentity'
import type {
  HostDeferredChallengeKind,
  HostDeferredCommandActor,
  HostDeferredCommandLookupResult,
  HostDeferredCommandRegisterInput,
  HostDeferredCommandRegisterResult,
  HostDeferredCommandResolveInput,
  HostDeferredCommandResolveResult,
  HostDeferredDecision
} from './HostDeferredCommandBridge'
import type {
  HostDeferredCommandEnvelopePutInput,
  HostDeferredCommandEnvelopePutResult
} from './HostDeferredCommandEnvelopeStore'
import type {
  HostCommandAuthorityDecision,
  HostCommandReceiptActor,
  HostCommandReceiptRecord,
  HostCommandReceiptTarget
} from './HostCommandReceiptStore'
import { HostDomainDeltaPublisher, type HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostDeltaDurabilityResult } from './HostDeltaStore'
import { hostPublicWindowOwnsEffect, type HostPublicWindowWire } from './HostPublicWindowIndex'
import {
  HostMutationCompletionCoordinator,
  type HostMutationCompletionResult
} from './HostMutationCompletionCoordinator'
import {
  HostObservedMutationExecutor,
  type HostObservedMutationResult
} from './HostObservedMutationExecutor'
import {
  createHostMutationObservationScope,
  extendHostMutationObservationScope,
  scopeHostMutationObservationFamilies,
  type HostMutationObservationScope
} from './HostMutationObservationScope'
import { projectHostRecovery } from './HostRecoveryProjection'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { hostThreadScope, type HostScopeEpoch, type HostScopeLedger } from './HostScopeLedger'
import type { HostCommitFence } from './HostCommitFence'
import type {
  HostThreadRecordTransactionInput,
  HostThreadRecordTransactionOutcome
} from './HostThreadRecordTransaction'
import { projectHostSnapshot, type HostSnapshotProjectorInput } from './HostSnapshotProjector'
import {
  createHostQueuedStartPublication,
  type HostQueuedStartEntities,
  type HostQueuedStartPublicationRegisterInput,
  type HostQueuedStartStartedView
} from './HostQueuedStartPublication'

/** Explicit activation modes; neither silently falls back to the other. */
export type AppStoreHostAuthorityMode = 'in-process-migration' | 'standalone'

/**
 * Explicit pre-cutover permit. Construction fails when Host-owned state may
 * already have advanced (no silent fallback after dedicated Host cutover).
 */
export interface AppStoreHostAuthorityActivationPermit {
  readonly hostOwnedStateMayHaveAdvanced: false
}

/** Narrow lease shape; factory synchronously proves it before minting a permit. */
export interface HostStandaloneAuthorityLeasePort {
  assertHeld(): void
}

declare const standalonePermitBrand: unique symbol
export interface HostStandaloneAuthorityActivationPermit {
  readonly [standalonePermitBrand]: 'host-standalone-authority'
}

const standalonePermits = new WeakMap<object, HostStandaloneAuthorityLeasePort>()

/**
 * Mint an unforgeable same-process standalone activation permit only after the
 * profile authority lease proves its exact owner record is still held.
 */
export function createHostStandaloneAuthorityActivationPermit(
  lease: HostStandaloneAuthorityLeasePort
): HostStandaloneAuthorityActivationPermit {
  if (!lease || typeof lease.assertHeld !== 'function') {
    throw new Error('Standalone Host authority requires a lease assertHeld port')
  }
  lease.assertHeld()
  const permit = Object.freeze({})
  standalonePermits.set(permit, lease)
  return permit as HostStandaloneAuthorityActivationPermit
}

/** Compact snapshot families from current authority — never trusted for position. */
export type AppStoreHostAuthoritySnapshotDonorFamilies = Omit<
  HostSnapshotProjectorInput,
  'position' | 'recovery'
>

export type AppStoreHostAuthoritySnapshotDonor = () =>
  | AppStoreHostAuthoritySnapshotDonorFamilies
  | Promise<AppStoreHostAuthoritySnapshotDonorFamilies>

export interface AppStoreHostAuthorityEvaluation {
  readonly decision: HostCommandAuthorityDecision
  readonly reason?: string
  readonly policy?: string
  /** Typed deferred challenge source; untyped asks fail closed when wired. */
  readonly challengeKind?: HostDeferredChallengeKind
}

export type AppStoreHostAuthorityEvaluator = (
  command: HostCommand,
  context: HostAuthorityCallContext
) => AppStoreHostAuthorityEvaluation | Promise<AppStoreHostAuthorityEvaluation>

/** Bounded terminal executor result — never raw tool/output/transcript/diff/file bodies. */
export interface AppStoreHostAuthorityExecutorResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly resultSummary?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly resultRef?: HostResultRef
}

export type AppStoreHostAuthorityExecutor = (
  command: HostCommand,
  context: HostAuthorityCallContext
) => AppStoreHostAuthorityExecutorResult | Promise<AppStoreHostAuthorityExecutorResult>

/**
 * Dedicated setup executor seam. It is intentionally distinct from the
 * Bridge-compatible commandExecutor: setup command names can never reach
 * HostBridgeCommandExecutor through this authority.
 */
export interface AppStoreHostAuthoritySetupExecutor {
  execute(
    command: HostCommand,
    context: HostAuthorityCallContext
  ): AppStoreHostAuthorityExecutorResult | Promise<AppStoreHostAuthorityExecutorResult>
}

export type AppStoreHostAuthorityHealthProvider = () =>
  | HostHealthProjection
  | Promise<HostHealthProjection>

export type AppStoreHostAuthorityThreadOffersProvider = (
  threadId: string
) => TaskWraithControlThreadOffers | Promise<TaskWraithControlThreadOffers>

export type AppStoreHostAuthorityGitReadProvider = (
  context: HostAuthorityCallContext,
  request: HostWorkspaceGitReadParams
) => HostWorkspaceGitReadResult | Promise<HostWorkspaceGitReadResult>

export type AppStoreHostAuthorityProviderStatusesProvider = () =>
  | readonly HostProviderStatusProjection[]
  | Promise<readonly HostProviderStatusProjection[]>
export type AppStoreHostAuthorityProviderOffersProvider = (
  providerId: string
) => HostProviderOffersProjection | Promise<HostProviderOffersProjection>
export type AppStoreHostAuthorityProviderAuthFlowsProvider = (
  providerId: string
) => readonly HostProviderAuthFlowProjection[] | Promise<readonly HostProviderAuthFlowProjection[]>
export type AppStoreHostAuthorityProviderAuthStatusProvider = (
  providerId: string
) => HostProviderAuthStatusProjection | Promise<HostProviderAuthStatusProjection>
export type AppStoreHostAuthorityThreadHistoryProvider = (
  request: HostThreadHistoryRequest
) => HostThreadHistoryPage | Promise<HostThreadHistoryPage>
export type AppStoreHostAuthorityThreadCatalogueProvider = (
  request: ThreadCatalogueReadQuery,
  options?: ThreadCatalogueRequestOptions
) => Promise<ThreadCatalogueWireReply>
export type AppStoreHostAuthorityThreadCatalogueMaintenanceProvider = (
  request: ThreadCatalogueMaintenanceQuery
) => Promise<ThreadCatalogueWireReply>
export type AppStoreHostAuthorityHistorySinceProvider = (
  request: HostHistorySinceRequest
) => HostHistorySinceResult | Promise<HostHistorySinceResult>

export type AppStoreHostAuthorityShutdownCallback = () => void | Promise<void>

/**
 * Advisory: HostDeferredCommandEnvelopeStore declares the identical
 * challenge-kind union; Bridge is canonical here and the duplicate remains
 * intentionally ununified in this scope.
 */
/** Narrow deferred ask ports; Authority constructs neither store nor bridge. */
export interface HostDeferredAskPorts {
  readonly envelopeStorePut: (
    input: HostDeferredCommandEnvelopePutInput
  ) => HostDeferredCommandEnvelopePutResult | Promise<HostDeferredCommandEnvelopePutResult>
  readonly bridgeRegister: (
    input: HostDeferredCommandRegisterInput
  ) => HostDeferredCommandRegisterResult | Promise<HostDeferredCommandRegisterResult>
  /**
   * Optional E-first correlation (S4b). Absent ⇒ approval.decide / question.answer
   * keep today's verbatim H path. When either resolve hook is present, both must
   * be functions (lookup before resolve so challengeKind can fail closed).
   */
  readonly getByChallengeId?: (
    challengeId: string,
    actor: HostDeferredCommandActor
  ) => HostDeferredCommandLookupResult | Promise<HostDeferredCommandLookupResult>
  readonly resolve?: (
    input: HostDeferredCommandResolveInput
  ) => HostDeferredCommandResolveResult | Promise<HostDeferredCommandResolveResult>
}

/**
 * Narrow injected ports so a later composition root can wrap AppStore/Bridge
 * without this module importing them.
 */
export interface AppStoreHostAuthorityPorts {
  readonly runProjectionOperation?: HostProjectionOperationRunner
  readonly runtime: HostRuntimeBootstrap
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  /**
   * When present, composer.send uses the short-start ACK path: pending receipt,
   * waits off the projection queue, publication via onStarted. Omit while the
   * queued-start gate is off so the legacy observed path stays byte-equivalent.
   */
  readonly queuedComposerSend?: AppStoreHostAuthorityExecutor
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
  /** Quiesce external queued-start producers before any shutdown flush. */
  readonly onBeforeShutdown?: AppStoreHostAuthorityShutdownCallback
  readonly onShutdown: AppStoreHostAuthorityShutdownCallback
  /** Optional only for pre-cutover compatibility; present enables S2–S5. */
  readonly deferredAsk?: HostDeferredAskPorts
  /** M4 slice 12b; see the interface. */
  readonly threadRecordTransaction?: AppStoreHostAuthorityThreadRecordTransaction
  /**
   * M4 slice 13a: the commit gate's observer mode, for the captures that run
   * outside the projection queue (whose windows the composition fences):
   * controls across both captures, snapshots, and the queued-start ack's
   * before-capture. Wired with `threadRecordTransaction`, never without it.
   */
  readonly fence?: HostCommitFence
  /**
   * M4 slice 13f2: the public window index, once it publishes. Snapshots
   * read the five record-derived families from it, and legacy captures and
   * publications stop carrying them. Wired with `threadRecordTransaction`.
   */
  readonly recordDerived?: AppStoreHostAuthorityRecordDerivedSource
}

/** The index's side of the five record-derived families (M4 slice 13f2). */
export interface AppStoreHostAuthorityRecordDerivedSource {
  /** Whether the index publishes: the seed has switched (slice 13f1). */
  active(): boolean
  /** The published wire rows, read under the publication lock. */
  read(): Promise<HostPublicWindowWire>
  /** Resolves once everything appended so far is durable. */
  durable(): Promise<HostDeltaDurabilityResult>
}

/** The donor with the five record-derived families left to the index. */
function withoutRecordDerived(
  donor: AppStoreHostAuthoritySnapshotDonorFamilies
): AppStoreHostAuthoritySnapshotDonorFamilies {
  return { ...donor, threads: [], runs: [], rounds: [], participants: [], warnings: [] }
}

/**
 * The transactional `thread.record.persist` (Independent Threads M4, slice
 * 12b). Wired only by the standalone composition, and only while
 * `TASKWRAITH_HOST_TXN_PERSIST` is on; absent, every command runs exactly as
 * before.
 */
export interface AppStoreHostAuthorityThreadRecordTransaction {
  /** The thread lanes: persists and deletes of a thread serialize on them. */
  readonly ledger: HostScopeLedger
  /**
   * False once the manifest has fail-stopped: persists then take today's
   * path under today's class until the Host restarts.
   */
  available(): boolean
  /** One transaction whose unsupported fallback runs `legacy`, under the lane. */
  create(legacy: () => Promise<unknown>): {
    execute(input: HostThreadRecordTransactionInput): Promise<HostThreadRecordTransactionOutcome>
  }
}

export interface AppStoreHostAuthorityOptions {
  readonly mode: AppStoreHostAuthorityMode
  readonly activationPermit:
    | AppStoreHostAuthorityActivationPermit
    | HostStandaloneAuthorityActivationPermit
  readonly ports: AppStoreHostAuthorityPorts
  /** Optional ISO clock for receipt completion timestamps in tests. */
  readonly now?: () => string
}

const OBSERVER_THROW_MUTATION: HostObservedMutationResult = Object.freeze({
  kind: 'execution_may_have_begun',
  effects: Object.freeze([]) as readonly [],
  afterCapture: Object.freeze({ status: 'capture_failed' as const })
})

function toReceiptActor(actor: HostActorIdentity): HostCommandReceiptActor {
  return {
    actorId: actor.actorId,
    clientId: actor.clientId,
    clientClass: actor.clientClass
  }
}

function contextActorMatchesClient(context: HostAuthorityCallContext): boolean {
  return (
    isExactHostActorIdentity(context.actor) &&
    context.actor.clientId === context.client.clientId &&
    context.actor.clientClass === context.client.clientClass &&
    typeof context.client.clientVersion === 'string' &&
    context.client.clientVersion.length > 0
  )
}

function isBoundedHostId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= HOST_PROTOCOL_MAX_ID &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- Host protocol IDs reject terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function compactTarget(command: HostCommand, targetKind: string): HostCommandReceiptTarget {
  const keys = Object.keys(command.target).sort()
  if (keys.length === 0) return { kind: targetKind }
  const id = command.target[keys[0]!]
  if (typeof id !== 'string' || id.length === 0) return { kind: targetKind }
  return { kind: targetKind, id }
}

/** Thread id for host_queue_wait attribution; empty/absent falls through to unlabeled. */
function projectionQueueLabel(command: HostCommand): string | undefined {
  const threadId = command?.target?.threadId
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined
}

function isValidDeferredAskPorts(ports: HostDeferredAskPorts): boolean {
  if (
    !ports ||
    typeof ports.envelopeStorePut !== 'function' ||
    typeof ports.bridgeRegister !== 'function'
  ) {
    return false
  }
  const hasGet = ports.getByChallengeId !== undefined
  const hasResolve = ports.resolve !== undefined
  if (hasGet !== hasResolve) return false
  if (hasGet && typeof ports.getByChallengeId !== 'function') return false
  if (hasResolve && typeof ports.resolve !== 'function') return false
  return true
}

function deferredAskHasEFirstPorts(
  ports: HostDeferredAskPorts | undefined
): ports is HostDeferredAskPorts & {
  getByChallengeId: NonNullable<HostDeferredAskPorts['getByChallengeId']>
  resolve: NonNullable<HostDeferredAskPorts['resolve']>
} {
  return (
    !!ports && typeof ports.getByChallengeId === 'function' && typeof ports.resolve === 'function'
  )
}

function toDeferredActor(actor: HostActorIdentity): HostDeferredCommandActor {
  return {
    actorId: actor.actorId,
    clientId: actor.clientId,
    clientClass: actor.clientClass
  }
}

/** PIN S4-V vocabulary join for approval.decide → E decision. */
function mapApprovalDecideToDeferred(decision: unknown): HostDeferredDecision | null {
  if (
    decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision === 'acceptForWorkspace'
  ) {
    return 'allow'
  }
  if (decision === 'decline') return 'deny'
  if (decision === 'cancel') return 'cancel'
  return null
}

type QuestionDecideMap =
  | { kind: 'deferred'; decision: HostDeferredDecision }
  | { kind: 'answer_unsupported' }
  | { kind: 'unmapped' }

/** PIN S4-V: dismiss→cancel; answer→slice-1 unsupported on correlated challenges. */
function mapQuestionAnswerToDeferred(decision: unknown): QuestionDecideMap {
  if (decision === 'dismiss') return { kind: 'deferred', decision: 'cancel' }
  if (decision === 'answer') return { kind: 'answer_unsupported' }
  return { kind: 'unmapped' }
}

function projectFoundReceipt(
  record: HostCommandReceiptRecord
): HostAuthorityResult<HostCommandReceipt> {
  const projected = projectHostCommandReceipt(record)
  if (!projected.ok) return { ok: false, error: 'host_unavailable' }
  const decoded = decodeHostCommandReceipt(projected.value)
  if (!decoded.ok) return { ok: false, error: 'host_unavailable' }
  return { ok: true, value: decoded.value }
}

/**
 * Explicit in-process migration HostAuthority. Activation is fail-closed:
 * missing mode/permit or hostOwnedStateMayHaveAdvanced rejects construction.
 */
export class AppStoreHostAuthority implements HostAuthority {
  private readonly runProjectionOperation: HostProjectionOperationRunner
  private readonly runtime: HostRuntimeBootstrap
  private readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  private readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  private readonly commandExecutor: AppStoreHostAuthorityExecutor
  private readonly queuedComposerSend?: AppStoreHostAuthorityExecutor
  private readonly queuedStartPublication: ReturnType<
    typeof createHostQueuedStartPublication
  > | null
  private readonly setupExecutor?: AppStoreHostAuthoritySetupExecutor
  private readonly healthProvider: AppStoreHostAuthorityHealthProvider
  private readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  private readonly gitReadProvider?: AppStoreHostAuthorityGitReadProvider
  private readonly providerStatusesProvider?: AppStoreHostAuthorityProviderStatusesProvider
  private readonly providerOffersProvider?: AppStoreHostAuthorityProviderOffersProvider
  private readonly providerAuthFlowsProvider?: AppStoreHostAuthorityProviderAuthFlowsProvider
  private readonly providerAuthStatusProvider?: AppStoreHostAuthorityProviderAuthStatusProvider
  private readonly threadHistoryProvider?: AppStoreHostAuthorityThreadHistoryProvider
  private readonly threadCatalogueProvider?: AppStoreHostAuthorityThreadCatalogueProvider
  private readonly threadCatalogueMaintenanceProvider?: AppStoreHostAuthorityThreadCatalogueMaintenanceProvider
  private readonly historySinceProvider?: AppStoreHostAuthorityHistorySinceProvider
  private readonly onBeforeShutdown?: AppStoreHostAuthorityShutdownCallback
  private readonly onShutdown: AppStoreHostAuthorityShutdownCallback
  private readonly deferredAsk?: HostDeferredAskPorts
  private readonly threadRecordTransaction?: AppStoreHostAuthorityThreadRecordTransaction
  private readonly fence: HostCommitFence
  private readonly recordDerived?: AppStoreHostAuthorityRecordDerivedSource
  private readonly domainPublisher: HostDomainDeltaPublisher
  private readonly completionCoordinator: HostMutationCompletionCoordinator
  private readonly now: () => string
  private readonly mode: AppStoreHostAuthorityMode
  private readonly standaloneLease?: HostStandaloneAuthorityLeasePort
  private stopped = false
  private shutdownComplete = false
  private shutdownAttempt: Promise<HostAuthorityResult<HostAuthorityShutdownResult>> | null = null

  constructor(options: AppStoreHostAuthorityOptions) {
    if (!options || (options.mode !== 'in-process-migration' && options.mode !== 'standalone')) {
      throw new Error('AppStoreHostAuthority requires mode "in-process-migration" or "standalone"')
    }
    const permit = options.activationPermit
    if (options.mode === 'in-process-migration') {
      if (
        !permit ||
        (permit as AppStoreHostAuthorityActivationPermit).hostOwnedStateMayHaveAdvanced !== false ||
        (permit as { hostOwnedStateMayHaveAdvanced?: unknown }).hostOwnedStateMayHaveAdvanced ===
          true
      ) {
        throw new Error(
          'AppStoreHostAuthority requires an explicit pre-cutover activation permit (hostOwnedStateMayHaveAdvanced: false)'
        )
      }
    } else if (!permit || typeof permit !== 'object' || !standalonePermits.has(permit)) {
      throw new Error('AppStoreHostAuthority requires a lease-minted standalone activation permit')
    }
    const ports = options.ports
    if (
      !ports ||
      !ports.runtime ||
      typeof ports.snapshotDonor !== 'function' ||
      typeof ports.authorityEvaluator !== 'function' ||
      typeof ports.commandExecutor !== 'function' ||
      (ports.queuedComposerSend !== undefined && typeof ports.queuedComposerSend !== 'function') ||
      (ports.setupExecutor !== undefined && typeof ports.setupExecutor.execute !== 'function') ||
      typeof ports.healthProvider !== 'function' ||
      (ports.threadOffersProvider !== undefined &&
        typeof ports.threadOffersProvider !== 'function') ||
      (ports.gitReadProvider !== undefined && typeof ports.gitReadProvider !== 'function') ||
      (ports.providerStatusesProvider !== undefined &&
        typeof ports.providerStatusesProvider !== 'function') ||
      (ports.providerOffersProvider !== undefined &&
        typeof ports.providerOffersProvider !== 'function') ||
      (ports.providerAuthFlowsProvider !== undefined &&
        typeof ports.providerAuthFlowsProvider !== 'function') ||
      (ports.providerAuthStatusProvider !== undefined &&
        typeof ports.providerAuthStatusProvider !== 'function') ||
      (ports.threadHistoryProvider !== undefined &&
        typeof ports.threadHistoryProvider !== 'function') ||
      (ports.historySinceProvider !== undefined &&
        typeof ports.historySinceProvider !== 'function') ||
      (ports.onBeforeShutdown !== undefined && typeof ports.onBeforeShutdown !== 'function') ||
      typeof ports.onShutdown !== 'function' ||
      (ports.deferredAsk !== undefined && !isValidDeferredAskPorts(ports.deferredAsk)) ||
      (options.mode === 'standalone' && ports.deferredAsk !== undefined) ||
      (ports.threadRecordTransaction !== undefined &&
        (options.mode !== 'standalone' ||
          typeof ports.threadRecordTransaction.create !== 'function' ||
          typeof ports.threadRecordTransaction.available !== 'function' ||
          !ports.threadRecordTransaction.ledger ||
          typeof ports.fence !== 'function')) ||
      (ports.fence !== undefined &&
        (typeof ports.fence !== 'function' || ports.threadRecordTransaction === undefined))
    ) {
      throw new Error('AppStoreHostAuthority requires complete injected ports')
    }
    this.runProjectionOperation = ports.runProjectionOperation ?? ((operation) => operation())
    this.runtime = ports.runtime
    this.mode = options.mode
    this.standaloneLease =
      options.mode === 'standalone' ? standalonePermits.get(permit as object) : undefined
    this.snapshotDonor = ports.snapshotDonor
    this.authorityEvaluator = ports.authorityEvaluator
    this.commandExecutor = ports.commandExecutor
    this.queuedComposerSend = ports.queuedComposerSend
    this.queuedStartPublication = ports.queuedComposerSend
      ? createHostQueuedStartPublication({
          getReceipt: (commandId, actor) =>
            this.runtime.receiptStore.getByCommandId(commandId, actor),
          completeReceipt: (input) => this.runtime.receiptStore.complete(input),
          markIndeterminate: (input) => this.runtime.receiptStore.markIndeterminate(input),
          updateReceiptPhase: (commandId, phase, executionClaimCursor) =>
            this.runtime.receiptStore.updatePhase(commandId, phase, executionClaimCursor),
          readScopedFamilies: async (scope) => {
            // The full donor: the start's proof needs its run and thread rows.
            const donor = await this.readFullSnapshotDonor()
            return scopeHostMutationObservationFamilies(donor, scope)
          },
          publishEffects: (effects) => this.publishLegacyEffects(effects),
          getPosition: () => this.runtime.getPosition(),
          runProjectionOperation: (operation, label) =>
            this.runProjectionOperation(operation, label),
          now: () => this.now()
        })
      : null
    this.setupExecutor = ports.setupExecutor
    this.healthProvider = ports.healthProvider
    this.threadOffersProvider = ports.threadOffersProvider
    this.gitReadProvider = ports.gitReadProvider
    this.providerStatusesProvider = ports.providerStatusesProvider
    this.providerOffersProvider = ports.providerOffersProvider
    this.providerAuthFlowsProvider = ports.providerAuthFlowsProvider
    this.providerAuthStatusProvider = ports.providerAuthStatusProvider
    this.threadHistoryProvider = ports.threadHistoryProvider
    this.threadCatalogueProvider = ports.threadCatalogueProvider
    this.threadCatalogueMaintenanceProvider = ports.threadCatalogueMaintenanceProvider
    this.historySinceProvider = ports.historySinceProvider
    this.onBeforeShutdown = ports.onBeforeShutdown
    this.onShutdown = ports.onShutdown
    this.deferredAsk = ports.deferredAsk
    this.threadRecordTransaction = ports.threadRecordTransaction
    this.fence = ports.fence ?? ((_label, operation) => operation())
    if (ports.recordDerived) this.recordDerived = ports.recordDerived
    this.now = options.now ?? (() => new Date().toISOString())
    // Scope 2: sole-journal publish + completion ports (allowed branch only).
    // A command's observed effects commit as one journal batch behind one
    // fsync: a persist that touched many rows used to pay one per row.
    this.domainPublisher = new HostDomainDeltaPublisher({ store: this.runtime.deltaStore })
    this.completionCoordinator = new HostMutationCompletionCoordinator({
      publishEffects: (effects) => this.publishLegacyEffects(effects),
      getPosition: () => this.runtime.getPosition(),
      completeReceipt: (input) => this.runtime.receiptStore.complete(input),
      markIndeterminate: (input) => this.runtime.receiptStore.markIndeterminate(input)
    })
  }

  private gate(context: HostAuthorityCallContext): HostAuthorityResult<true> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
    const lease = this.assertStandaloneLease()
    if (!lease.ok) return lease
    if (!contextActorMatchesClient(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: true, value: true }
  }

  private assertStandaloneLease(): HostAuthorityResult<true> {
    if (this.mode !== 'standalone') return { ok: true, value: true }
    try {
      if (!this.standaloneLease) return { ok: false, error: 'host_unavailable' }
      this.standaloneLease.assertHeld()
      return { ok: true, value: true }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async snapshot(
    context: HostAuthorityCallContext,
    _cursor?: HostCursorPosition
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    // The donor read and the position stamp see no half-published commit.
    return this.fence('snapshot', () => this.captureSnapshot())
  }

  private async captureSnapshot(): Promise<HostAuthorityResult<HostSnapshot>> {
    const recordDerived = this.recordDerived?.active() ? this.recordDerived : null
    if (!recordDerived) return this.captureDonorSnapshot(false)
    // RR-7: a snapshot is delivered only once everything it shows is durable.
    // A reset while waiting stamps it in a dead generation: capture once more.
    let captured = await this.captureIndexSnapshot(recordDerived)
    if (!captured.ok) return captured
    let durable = await recordDerived.durable()
    if (durable.kind === 'reset') {
      captured = await this.captureIndexSnapshot(recordDerived)
      if (!captured.ok) return captured
      durable = await recordDerived.durable()
    }
    if (durable.kind === 'fail-stopped') return { ok: false, error: 'host_unavailable' }
    return captured
  }

  /**
   * The donor's families without the five record-derived ones, then the
   * index's wire rows spliced in. The stamp (the durable head at the donor
   * read) may precede groups the wire holds: every group's effects are
   * absolute, so replaying from the stamp ends at the wire, and the index
   * commits before its group appends, so the wire never lacks a group at or
   * before the stamp.
   */
  private async captureIndexSnapshot(
    recordDerived: AppStoreHostAuthorityRecordDerivedSource
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    const projected = await this.captureDonorSnapshot(true)
    if (!projected.ok) return projected
    let wire: HostPublicWindowWire
    try {
      wire = await recordDerived.read()
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    const rows = <T>(family: 'thread' | 'run' | 'round' | 'participant' | 'warning'): T[] =>
      [...(wire.get(family)?.values() ?? [])] as T[]
    const snapshot = projected.value
    // The projector raised warnings only for the families it still projects:
    // with the five emptied, none of its warnings is the index's.
    const warnings = [
      ...snapshot.warnings,
      ...rows<HostSnapshot['warnings'][number]>('warning')
    ].sort((left, right) =>
      left.warningId < right.warningId ? -1 : left.warningId > right.warningId ? 1 : 0
    )
    return {
      ok: true,
      value: {
        ...snapshot,
        threads: rows('thread'),
        runs: rows('run'),
        rounds: rows('round'),
        participants: rows('participant'),
        warnings: warnings.slice(0, HOST_PROTOCOL_MAX_COLLECTION)
      }
    }
  }

  private async captureDonorSnapshot(
    withoutIndexFamilies: boolean
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    let donor: AppStoreHostAuthoritySnapshotDonorFamilies
    try {
      donor = await this.snapshotDonor()
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    if (!donor || typeof donor !== 'object') {
      return { ok: false, error: 'host_unavailable' }
    }
    if (withoutIndexFamilies) donor = withoutRecordDerived(donor)

    const position = this.runtime.getPosition()
    const generatedAt = this.now()
    const recovery = projectHostRecovery({ summary: this.runtime.getRecoverySummary() })

    // Never trust donor position/recovery — overwrite from runtime sole journal.
    const input: HostSnapshotProjectorInput = {
      ...donor,
      position: {
        generation: position.generation,
        cursor: position.cursor,
        freshness: 'live',
        generatedAt
      },
      recovery
    }

    const projected = projectHostSnapshot(input)
    if (!projected.ok) return { ok: false, error: 'host_unavailable' }
    return { ok: true, value: projected.value }
  }

  async deltas(
    context: HostAuthorityCallContext,
    since: HostCursorPosition
  ): Promise<HostAuthorityResult<HostDeltasSinceResult>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    try {
      const result = this.runtime.deltaStore.since(since)
      return { ok: true, value: result }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async threadOffers(
    context: HostAuthorityCallContext,
    threadId: string
  ): Promise<HostAuthorityResult<TaskWraithControlThreadOffers>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    if (
      typeof threadId !== 'string' ||
      threadId.length === 0 ||
      threadId.length > HOST_PROTOCOL_MAX_ID ||
      !this.threadOffersProvider
    ) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const offers = await this.threadOffersProvider(threadId)
      if (
        !offers ||
        offers.threadId !== threadId ||
        offers.source !== 'curated' ||
        !Array.isArray(offers.models)
      ) {
        return { ok: false, error: 'host_unavailable' }
      }
      return { ok: true, value: offers }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async gitRead(
    context: HostAuthorityCallContext,
    request: HostWorkspaceGitReadParams
  ): Promise<HostAuthorityResult<HostWorkspaceGitReadResult>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    const decodedRequest = decodeHostWorkspaceGitReadParams(request)
    if (!decodedRequest.ok || !this.gitReadProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostWorkspaceGitReadResult(
        await this.gitReadProvider(context, decodedRequest.value)
      )
      return decoded.ok
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async providerStatuses(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<readonly HostProviderStatusProjection[]>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    if (!this.providerStatusesProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostProviderStatuses(await this.providerStatusesProvider())
      return decoded.ok
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async providerOffers(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<HostProviderOffersProjection>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    if (!isBoundedHostId(providerId) || !this.providerOffersProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostProviderOffersProjection(
        await this.providerOffersProvider(providerId)
      )
      return decoded.ok && decoded.value.providerId === providerId
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async providerAuthFlows(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<readonly HostProviderAuthFlowProjection[]>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    if (!isBoundedHostId(providerId) || !this.providerAuthFlowsProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostProviderAuthFlows(await this.providerAuthFlowsProvider(providerId))
      return decoded.ok
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async providerAuthStatus(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<HostProviderAuthStatusProjection>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    if (!isBoundedHostId(providerId) || !this.providerAuthStatusProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostProviderAuthStatusProjection(
        await this.providerAuthStatusProvider(providerId)
      )
      return decoded.ok && decoded.value.providerId === providerId
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async threadHistory(
    context: HostAuthorityCallContext,
    request: HostThreadHistoryRequest
  ): Promise<HostAuthorityResult<HostThreadHistoryPage>> {
    const gate = this.gate(context)
    const decodedRequest = decodeHostThreadHistoryRequest(request)
    if (!gate.ok) return gate
    if (!decodedRequest.ok || !this.threadHistoryProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostThreadHistoryPage(
        await this.threadHistoryProvider(decodedRequest.value)
      )
      return decoded.ok && decoded.value.threadId === decodedRequest.value.threadId
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async threadCatalogue(
    context: HostAuthorityCallContext,
    request: ThreadCatalogueReadQuery,
    options: ThreadCatalogueRequestOptions = {}
  ): Promise<HostAuthorityResult<ThreadCatalogueWireReply>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    const decoded = decodeThreadCatalogueReadQuery(request)
    if (!decoded || !this.threadCatalogueProvider) return { ok: false, error: 'host_unavailable' }
    try {
      return { ok: true, value: await this.threadCatalogueProvider(decoded, options) }
    } catch (error) {
      const requestError = threadCatalogueRequestError(error)
      if (requestError)
        return { ok: true, value: { data: null, error: { code: requestError.code } } }
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async threadCatalogueMaintenance(
    context: HostAuthorityCallContext,
    request: ThreadCatalogueMaintenanceQuery
  ): Promise<HostAuthorityResult<ThreadCatalogueWireReply>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    const expected = TASKWRAITH_DESKTOP_HOST_ACTOR
    if (
      context.client.clientClass !== expected.clientClass ||
      context.client.clientId !== expected.clientId ||
      context.actor.clientClass !== expected.clientClass ||
      context.actor.clientId !== expected.clientId ||
      context.actor.actorId !== expected.actorId
    )
      return { ok: false, error: 'host_unavailable' }
    const decoded = decodeThreadCatalogueMaintenanceQuery(request)
    if (!decoded || !this.threadCatalogueMaintenanceProvider)
      return { ok: false, error: 'host_unavailable' }
    try {
      return { ok: true, value: await this.threadCatalogueMaintenanceProvider(decoded) }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async historySince(
    context: HostAuthorityCallContext,
    request: HostHistorySinceRequest
  ): Promise<HostAuthorityResult<HostHistorySinceResult>> {
    const gate = this.gate(context)
    const decodedRequest = decodeHostHistorySinceRequest(request)
    if (!gate.ok) return gate
    if (!decodedRequest.ok || !this.historySinceProvider) {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      const decoded = decodeHostHistorySinceResult(
        await this.historySinceProvider(decodedRequest.value)
      )
      return decoded.ok && decoded.value.threadId === decodedRequest.value.threadId
        ? { ok: true, value: decoded.value }
        : { ok: false, error: 'host_unavailable' }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async receipt(
    context: HostAuthorityCallContext,
    lookup: HostAuthorityReceiptLookup
  ): Promise<HostAuthorityReceiptResult> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
    const lease = this.assertStandaloneLease()
    if (!lease.ok) return lease
    const parsed = parseHostAuthorityReceiptLookup(lookup)
    if (!parsed) return { ok: false, error: 'invalid_lookup' }
    if (!contextActorMatchesClient(context)) {
      return { ok: true, outcome: 'incomplete' }
    }

    const actor = toReceiptActor(context.actor)
    const found =
      'commandId' in parsed && typeof parsed.commandId === 'string'
        ? this.runtime.receiptStore.getByCommandId(parsed.commandId, actor)
        : this.runtime.receiptStore.getByIdempotencyKey(parsed.idempotencyKey, actor)

    if (found.kind === 'not_found') {
      // A failed recovery can leave readable durable rows without establishing
      // that any other identity is absent. Preserve that distinction for retries.
      return this.runtime.receiptStore.durabilityStatus.kind === 'ok'
        ? { ok: true, outcome: 'not_found' }
        : { ok: false, error: 'host_unavailable' }
    }
    if (found.kind === 'actor_mismatch') return { ok: true, outcome: 'actor_mismatch' }
    if (found.kind === 'incomplete') return { ok: true, outcome: 'incomplete' }

    const projected = projectHostCommandReceipt(found.receipt)
    if (!projected.ok) return { ok: true, outcome: 'incomplete' }
    const decoded = decodeHostCommandReceipt(projected.value)
    if (!decoded.ok) return { ok: true, outcome: 'incomplete' }
    return { ok: true, outcome: 'found', receipt: decoded.value }
  }

  async command(
    context: HostAuthorityCallContext,
    command: HostCommand
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    try {
      // A queued start can be waiting for capacity held by a run that needs a
      // cancellation or a human reply. Keep those release paths out of the queue;
      // they still pass through the same validation, policy, and observation.
      if (
        command?.name === 'run.cancel' ||
        command?.name === 'approval.decide' ||
        command?.name === 'question.answer' ||
        this.usesQueuedComposerSend(command)
      ) {
        // A control holds the observer across both its captures (M4 §1.6).
        // The queued-start ack fences only its before-capture: it returns
        // before the dispatch its publication waits for.
        if (this.usesQueuedComposerSend(command)) return await this.executeCommand(context, command)
        return await this.fence(`control:${command?.name}`, () =>
          this.executeCommand(context, command)
        )
      }
      // M4: a command on a thread lane takes the lane before the projection
      // queue (lock order: lane, legacy FIFO, gate, publication lock). It
      // enters the queue itself, and only for the legacy window it runs.
      if (this.takesThreadLane(command)) {
        return await this.executeCommand(context, command, { queued: false })
      }
      return await this.runProjectionOperation(
        () => this.executeCommand(context, command),
        projectionQueueLabel(command)
      )
    } catch {
      // Receipt admission and completion can fail at a durable I/O boundary.
      // Preserve the uncertain outcome; never manufacture a failed receipt or
      // retry the executor after an exception that may follow domain effects.
      return { ok: false, error: 'host_unavailable' }
    }
  }

  /** Whether the command takes a thread lane (M4 slice 12b). */
  private takesThreadLane(command: HostCommand | undefined): boolean {
    return (
      this.threadRecordTransaction !== undefined &&
      (command?.name === 'thread.record.persist' || command?.name === 'thread.record.delete')
    )
  }

  /**
   * Run a legacy window in the projection queue, unless the caller already
   * holds it. Laned commands reach here outside it (M4 slice 12b).
   */
  private inProjectionQueue<T>(
    queued: boolean,
    command: HostCommand,
    operation: () => Promise<T>
  ): Promise<T> {
    return queued
      ? operation()
      : this.runProjectionOperation(operation, projectionQueueLabel(command))
  }

  private async executeCommand(
    context: HostAuthorityCallContext,
    command: HostCommand,
    options: { readonly queued: boolean } = { queued: true }
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate

    const decoded = decodeHostCommand(command)
    if (!decoded.ok) return { ok: false, error: 'invalid_lookup' }
    const validated = validateHostCommandArguments(decoded.value)
    if (!validated.ok) return { ok: false, error: 'invalid_lookup' }
    const hostCommand = validated.value

    // Body-bearing reads are Authority RPC methods only. Reserved read aliases
    // must never reach actor denial, fingerprinting, evaluation, receipts, or
    // execution through the durable mutation path.
    const governedName = parseGovernedMutationCommandName(hostCommand.name)
    const setupName = parseSetupMutationCommandName(hostCommand.name)
    if (governedName === null && setupName === null) {
      return { ok: false, error: 'invalid_lookup' }
    }
    // Never mint an orphan pending receipt when this compatibility authority
    // has no dedicated setup executor wired. Setup is unavailable, not queued.
    if (setupName !== null && !this.setupExecutor) {
      return { ok: false, error: 'host_unavailable' }
    }

    // Actor spoof: bind any durable denial to authenticated context.actor.
    if (!hostAuthorityCommandActorMatchesContext(context, hostCommand)) {
      return this.persistActorMismatchDenial(context, hostCommand)
    }

    let fingerprintResult: ReturnType<typeof fingerprintHostCommand>
    try {
      fingerprintResult = fingerprintHostCommand(hostCommand)
    } catch {
      return { ok: false, error: 'invalid_lookup' }
    }

    const evaluation = await this.authorityEvaluator(hostCommand, context)
    if (
      !evaluation ||
      (evaluation.decision !== 'allowed' &&
        evaluation.decision !== 'denied' &&
        evaluation.decision !== 'deferred')
    ) {
      return { ok: false, error: 'host_unavailable' }
    }

    // Standalone Host has no deferred bridge/envelope/pipeline. Refuse before
    // durable begin so an `ask` can never leave a pending receipt behind.
    if (this.mode === 'standalone' && evaluation.decision === 'deferred') {
      return { ok: false, error: 'host_unavailable' }
    }

    // S4b: E-first pre-route for decision commands when resolve hooks are wired.
    // Runs before begin so a correlated E outcome never leaves an orphan decide
    // receipt and never falls through to H — even on E non-success.
    if (
      evaluation.decision === 'allowed' &&
      deferredAskHasEFirstPorts(this.deferredAsk) &&
      (hostCommand.name === 'approval.decide' || hostCommand.name === 'question.answer')
    ) {
      const preRoute = await this.tryEFirstDecisionPreRoute(hostCommand, context)
      if (preRoute.action === 'return') {
        return preRoute.result
      }
      // action === 'fallthrough' → uncorrelated live Bridge card; verbatim H below.
    }

    // M4: admit a transactional persist under the thread's current epoch. A
    // delete that commits after this point refuses it as epoch-stale.
    const transactionalEpoch = this.transactionalPersistEpoch(hostCommand)
    const begin = this.runtime.receiptStore.begin({
      commandId: hostCommand.commandId,
      idempotencyKey: hostCommand.idempotencyKey,
      commandName: hostCommand.name,
      commandFingerprint: fingerprintResult.fingerprint,
      actor: toReceiptActor(context.actor),
      target: compactTarget(hostCommand, fingerprintResult.targetKind),
      authority: {
        decision: evaluation.decision,
        ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
        ...(evaluation.policy !== undefined ? { policy: evaluation.policy } : {})
      },
      ...(transactionalEpoch !== null ? { commandClass: 'txn-record-persist' as const } : {}),
      createdAt: this.now()
    })

    if (begin.kind === 'existing') {
      // Exact replay — never re-execute.
      return projectFoundReceipt(begin.receipt)
    }

    if (begin.kind === 'actor_denied') {
      return { ok: false, error: 'host_unavailable' }
    }

    if (begin.kind === 'conflict') {
      if (begin.receipt) {
        return projectFoundReceipt(begin.receipt)
      }
      // Occupied commandId / cross-actor conflict without a durable attempt row.
      return { ok: false, error: 'host_unavailable' }
    }

    if (begin.kind !== 'created') {
      return { ok: false, error: 'host_unavailable' }
    }

    if (evaluation.decision === 'denied') {
      const reason = evaluation.reason?.trim() || 'authority denied'
      const completed = this.runtime.receiptStore.complete({
        commandId: hostCommand.commandId,
        status: 'denied',
        completedAt: this.now(),
        authority: {
          decision: 'denied',
          reason,
          ...(evaluation.policy !== undefined ? { policy: evaluation.policy } : {})
        },
        errorCode: 'authority_denied',
        errorMessage: reason
      })
      if (!completed) return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(completed)
    }

    if (evaluation.decision === 'deferred') {
      // Preserve the pre-cutover dead-end exactly when ask ports are absent.
      if (!this.deferredAsk) return projectFoundReceipt(begin.receipt)
      return this.persistDeferredAsk(
        hostCommand,
        context,
        evaluation,
        begin.receipt,
        fingerprintResult.fingerprint
      )
    }

    // allowed — setup uses the explicit injected executor, never the Bridge
    // command port. Both paths retain the same observation + sole-journal
    // terminal completion so result references survive replay/restart.
    if (setupName !== null) {
      // Guarded before durable begin above; this narrows the structural port.
      if (!this.setupExecutor) return { ok: false, error: 'host_unavailable' }
      return this.executeAllowedMutation(hostCommand, context, this.setupExecutor)
    }
    if (this.usesQueuedComposerSend(hostCommand)) {
      return this.executeQueuedComposerSend(hostCommand, context, fingerprintResult.fingerprint)
    }
    if (transactionalEpoch !== null) {
      return this.executeTransactionalPersist(
        hostCommand,
        context,
        transactionalEpoch,
        options.queued
      )
    }
    if (hostCommand.name === 'thread.record.delete' && this.threadRecordTransaction) {
      return this.executeLanedDelete(
        hostCommand,
        context,
        this.threadRecordTransaction,
        options.queued
      )
    }
    return this.inProjectionQueue(options.queued, hostCommand, () =>
      this.executeAllowedMutation(hostCommand, context, this.commandExecutor)
    )
  }

  /** The admit-time epoch of a persist that takes the transactional path; null otherwise. */
  private transactionalPersistEpoch(hostCommand: HostCommand): HostScopeEpoch | null {
    const transaction = this.threadRecordTransaction
    if (!transaction || hostCommand.name !== 'thread.record.persist') return null
    const threadId = hostCommand.target.threadId
    if (typeof threadId !== 'string') return null
    try {
      if (!transaction.available()) return null
      return transaction.ledger.view(hostThreadScope(threadId)).epoch
    } catch {
      return null
    }
  }

  /**
   * M4 slice 12b: a persist through the transaction. The transaction
   * completes the receipt on every outcome it decides; its unsupported
   * fallback runs today's observed path, which completes its own.
   */
  private async executeTransactionalPersist(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext,
    epoch: HostScopeEpoch,
    queued: boolean
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const transaction = this.threadRecordTransaction
    if (!transaction) return { ok: false, error: 'host_unavailable' }
    let legacyAnswer: HostAuthorityResult<HostCommandReceipt> | undefined
    // The fallback runs under the lane, then in the projection queue.
    const run = transaction.create(async () => {
      legacyAnswer = await this.inProjectionQueue(queued, hostCommand, () =>
        this.executeAllowedMutation(hostCommand, context, this.commandExecutor)
      )
      return legacyAnswer
    })
    const args = hostCommand.arguments
    let outcome: HostThreadRecordTransactionOutcome
    try {
      outcome = await run.execute({
        commandId: hostCommand.commandId,
        threadId: hostCommand.target.threadId as string,
        descriptor: {
          transferId: args.transferId as string,
          sha256: args.sha256 as string,
          byteLength: args.byteLength as number
        },
        expectedRevision: args.expectedRevision as number,
        epoch
      })
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    if (outcome.kind === 'legacy') return legacyAnswer ?? { ok: false, error: 'host_unavailable' }
    // A fail-stopped delta store leaves the receipt pending for boot recovery.
    if (outcome.kind === 'fail-stopped') return { ok: false, error: 'host_unavailable' }
    const found = this.runtime.receiptStore.getByCommandId(
      hostCommand.commandId,
      toReceiptActor(context.actor)
    )
    if (found.kind !== 'found') return { ok: false, error: 'host_unavailable' }
    return projectFoundReceipt(found.receipt)
  }

  /**
   * M4 slice 12b: a delete takes its thread's lane, so it orders against
   * transactional persists. A committed delete closes the lane for the
   * incarnation: a persist admitted before it fails epoch-stale, one admitted
   * after fails as gone, and a second delete succeeds as already absent.
   */
  private async executeLanedDelete(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext,
    transaction: AppStoreHostAuthorityThreadRecordTransaction,
    queued: boolean
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const threadId = hostCommand.target.threadId
    if (typeof threadId !== 'string') {
      return this.inProjectionQueue(queued, hostCommand, () =>
        this.executeAllowedMutation(hostCommand, context, this.commandExecutor)
      )
    }
    const actor = toReceiptActor(context.actor)
    const acquired = await transaction.ledger.acquire(hostThreadScope(threadId), {
      owner: hostCommand.commandId
    })
    if (!acquired.ok) {
      const completed =
        acquired.reason === 'deleted'
          ? this.runtime.receiptStore.complete({
              commandId: hostCommand.commandId,
              status: 'succeeded',
              completedAt: this.now(),
              resultSummary: 'thread_record_already_absent'
            })
          : this.runtime.receiptStore.complete({
              commandId: hostCommand.commandId,
              status: 'failed',
              completedAt: this.now(),
              errorCode: 'host_shutting_down'
            })
      if (!completed) return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(completed)
    }
    const slot = acquired.slot
    try {
      // Lane first, then the projection queue for the delete's legacy window.
      const answer = await this.inProjectionQueue(queued, hostCommand, () =>
        this.executeAllowedMutation(hostCommand, context, this.commandExecutor)
      )
      const found = this.runtime.receiptStore.getByCommandId(hostCommand.commandId, actor)
      if (
        found.kind === 'found' &&
        found.receipt.status === 'succeeded' &&
        found.receipt.resultSummary === 'thread_record_deleted'
      ) {
        slot.deleted()
      }
      return answer
    } finally {
      slot.release()
    }
  }

  private usesQueuedComposerSend(command: HostCommand | undefined): boolean {
    return command?.name === 'composer.send' && this.queuedStartPublication !== null
  }

  /** Durable-claim transition, bound by composition before provider side effects. */
  handleQueuedStartStarting(view: HostQueuedStartStartedView): void {
    this.queuedStartPublication?.onStarting(view)
  }

  /**
   * Lifecycle onStarted entry. Bound by composition through the started slot.
   * Witness only — never succeeds a receipt (beginRun is before user-prompt persist).
   */
  handleQueuedStartStarted(view: HostQueuedStartStartedView): void {
    this.queuedStartPublication?.onStarted(view)
  }

  /**
   * Off-stack DomainPorts dispatch settlement. Persist-proven success publishes
   * start effects on the projection queue; any other outcome terminalizes the
   * original pending receipt. Never mints a second receipt.
   */
  handleQueuedStartDispatchSettled(
    commandId: string,
    result: HostCommandExecutionResult,
    startEntities?: HostQueuedStartEntities
  ): void {
    // Start evidence travels ONLY with a persist-proven success. Failed and
    // cancelled dispatches terminalize exactly as before: binding a run row to
    // a non-start would let a route claim proof it never earned.
    if (result.status === 'succeeded')
      this.queuedStartPublication?.completeStart(commandId, startEntities)
    else this.queuedStartPublication?.fail(commandId, result)
  }

  /**
   * Abandon proof for a still-pending queued start.
   *
   * NOT a settlement: a settlement carries a terminal execution result, while
   * this says the dispatch reported success we cannot verify — the in-main
   * absorb race, where a send registers with no live round and the orchestrator
   * then absorbs it into one that started meanwhile, so no start evidence ever
   * arrives. The receipt becomes indeterminate: never succeeded, because
   * nothing was proven, and never failed, because the prompt may well have been
   * delivered. That is why this is a separate method rather than a fourth
   * HostCommandExecutionResult status.
   *
   * Contained and body-free like markDeferredUnavailable. A missing publication
   * (flag OFF) or an unknown/already-published commandId is a silent no-op:
   * `abort` acts only on its own pending map, so it can never resurrect or
   * re-stamp a receipt that already reached a terminal state.
   */
  abortQueuedStart(commandId: string): void {
    this.queuedStartPublication?.abort(commandId)
  }

  /** Drain in-flight start publications. Composition shutdown calls this before runtime.flush. */
  async drainQueuedStartPublication(): Promise<void> {
    await this.queuedStartPublication?.drain()
  }

  private async executeQueuedComposerSend(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext,
    fingerprint: string
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const publication = this.queuedStartPublication
    const acknowledge = this.queuedComposerSend
    if (!publication || !acknowledge) {
      return { ok: false, error: 'host_unavailable' }
    }
    const found = this.runtime.receiptStore.getByCommandId(
      hostCommand.commandId,
      toReceiptActor(context.actor)
    )
    if (found.kind !== 'found' || found.receipt.status !== 'pending') {
      return { ok: false, error: 'host_unavailable' }
    }
    const actor = toReceiptActor(context.actor)
    let donor: AppStoreHostAuthoritySnapshotDonorFamilies
    try {
      donor = await this.fence('queued-start:before', () => this.readFullSnapshotDonor())
    } catch {
      // No dispatch yet — settle the begun receipt rather than leave it pending.
      this.runtime.receiptStore.complete({
        commandId: hostCommand.commandId,
        status: 'failed',
        completedAt: this.now(),
        errorCode: 'host_unavailable'
      })
      return { ok: false, error: 'host_unavailable' }
    }
    const scope = createHostMutationObservationScope(hostCommand, donor)
    const registerInput: HostQueuedStartPublicationRegisterInput = {
      commandId: hostCommand.commandId,
      actor,
      fingerprint,
      command: hostCommand,
      beforeScoped: scopeHostMutationObservationFamilies(donor, scope),
      scope
    }
    publication.register(registerInput)
    let acknowledgement: Promise<AppStoreHostAuthorityExecutorResult>
    try {
      // Invoke the ACK path before persisting queued, but do not await it:
      // queued must land before the off-stack dispatch can publish starting.
      acknowledgement = Promise.resolve(acknowledge(hostCommand, context))
    } catch {
      publication.abort(hostCommand.commandId)
      return { ok: false, error: 'host_unavailable' }
    }

    const queued = publication.markQueued(hostCommand.commandId)
    if (queued.kind !== 'queued') {
      try {
        await acknowledgement
      } catch {
        // The phase failure already fenced the original receipt.
      }
      const settled = this.runtime.receiptStore.getByCommandId(hostCommand.commandId, actor)
      if (settled.kind !== 'found') return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(settled.receipt)
    }

    let ack: AppStoreHostAuthorityExecutorResult
    try {
      ack = await acknowledgement
    } catch {
      // Dispatch may already have been scheduled; do not certify "no execution".
      publication.abort(hostCommand.commandId)
      return { ok: false, error: 'host_unavailable' }
    }
    if (ack.status !== 'succeeded') {
      publication.fail(hostCommand.commandId, ack)
      const settled = this.runtime.receiptStore.getByCommandId(hostCommand.commandId, actor)
      if (settled.kind !== 'found') return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(settled.receipt)
    }
    const current = this.runtime.receiptStore.getByCommandId(hostCommand.commandId, actor)
    if (current.kind !== 'found') return { ok: false, error: 'host_unavailable' }
    return projectFoundReceipt(current.receipt)
  }

  /**
   * Scope 2 allowed path: HostObservedMutationExecutor wraps the injected
   * commandExecutor (context closed over); HostMutationCompletionCoordinator
   * publishes effects and terminalizes from the sole journal position.
   */
  private async executeAllowedMutation(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext,
    executor: AppStoreHostAuthorityExecutor | AppStoreHostAuthoritySetupExecutor
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    let observationScope: HostMutationObservationScope | null = null
    let executionResult: AppStoreHostAuthorityExecutorResult | undefined
    const observedExecutor = new HostObservedMutationExecutor({
      captureSnapshot: async () => {
        const donor = await this.readMutationSnapshotDonor()
        observationScope = observationScope
          ? extendHostMutationObservationScope(observationScope, executionResult?.resultRef, donor)
          : createHostMutationObservationScope(hostCommand, donor)
        return this.projectMutationSnapshot(
          scopeHostMutationObservationFamilies(donor, observationScope)
        )
      },
      executeCommand: async (command) => {
        const result =
          'execute' in executor
            ? await executor.execute(command, context)
            : await executor(command, context)
        executionResult = result
        return result
      }
    })

    let mutation: HostObservedMutationResult
    try {
      mutation = await observedExecutor.execute(hostCommand)
    } catch {
      mutation = OBSERVER_THROW_MUTATION
    }

    let completion: HostMutationCompletionResult
    try {
      completion = this.completionCoordinator.complete({
        commandId: hostCommand.commandId,
        mutation
      })
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }

    return this.projectAllowedCompletion(hostCommand.commandId, context, completion)
  }

  /** Complete donor families before the public per-family cap is applied. */
  private async readFullSnapshotDonor(): Promise<AppStoreHostAuthoritySnapshotDonorFamilies> {
    const donor = await this.snapshotDonor()
    if (!donor || typeof donor !== 'object') {
      throw new Error('snapshot donor unavailable')
    }
    return donor
  }

  /**
   * A command window's capture. A queued start reads the full donor instead
   * (`readFullSnapshotDonor`): its completion proof needs the run and thread
   * rows, and its owned effects are dropped at publication.
   */
  private async readMutationSnapshotDonor(): Promise<AppStoreHostAuthoritySnapshotDonorFamilies> {
    const donor = await this.readFullSnapshotDonor()
    // Once the index publishes, a command window's captures leave its five
    // families to it. Both captures of a window sit in one fenced turn, and
    // the switch holds the gate exclusively, so a window never straddles it.
    return this.recordDerived?.active() ? withoutRecordDerived(donor) : donor
  }

  /**
   * A legacy publication. Once the index publishes, effects it owns are
   * dropped: a queued start whose before-capture preceded the switch would
   * otherwise tombstone rows the index serves (slice 13f2).
   */
  private publishLegacyEffects(
    effects: readonly HostDomainEffectDto[]
  ): ReturnType<HostDomainDeltaPublisher['publishDurableBatch']> {
    if (!this.recordDerived?.active()) return this.domainPublisher.publishDurableBatch(effects)
    return this.domainPublisher.publishDurableBatch(
      effects.filter((effect) => !hostPublicWindowOwnsEffect(effect.family, effect.entityId))
    )
  }

  /** Privacy-clean command-scoped snapshot for observe before/after capture. */
  private projectMutationSnapshot(donor: AppStoreHostAuthoritySnapshotDonorFamilies): unknown {
    const position = this.runtime.getPosition()
    const generatedAt = this.now()
    const recovery = projectHostRecovery({ summary: this.runtime.getRecoverySummary() })
    const input: HostSnapshotProjectorInput = {
      ...donor,
      position: {
        generation: position.generation,
        cursor: position.cursor,
        freshness: 'live',
        generatedAt
      },
      recovery
    }
    const projected = projectHostSnapshot(input)
    if (!projected.ok) {
      throw new Error('snapshot projection failed')
    }
    return projected.value
  }

  /** Map coordinator outcome to the existing HostAuthority receipt union. */
  private projectAllowedCompletion(
    commandId: string,
    context: HostAuthorityCallContext,
    completion: HostMutationCompletionResult
  ): HostAuthorityResult<HostCommandReceipt> {
    if (completion.kind !== 'completed' && completion.kind !== 'indeterminate') {
      return { ok: false, error: 'host_unavailable' }
    }
    const found = this.runtime.receiptStore.getByCommandId(commandId, toReceiptActor(context.actor))
    if (found.kind !== 'found') {
      return { ok: false, error: 'host_unavailable' }
    }
    return projectFoundReceipt(found.receipt)
  }

  /**
   * S4b E-first pre-route for approval.decide / question.answer.
   *
   * - not_found → fall through to live-Bridge H (unchanged)
   * - challengeKind mismatch / actor_mismatch / correlated answer → body-free
   *   reject, zero H, zero resolve (answer keeps challenge awaiting)
   * - any resolve outcome including non-success → E owns terminalization, zero H
   */
  private async tryEFirstDecisionPreRoute(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext
  ): Promise<
    | { action: 'fallthrough' }
    | { action: 'return'; result: HostAuthorityResult<HostCommandReceipt> }
  > {
    const deferredAsk = this.deferredAsk
    if (!deferredAskHasEFirstPorts(deferredAsk)) {
      return { action: 'fallthrough' }
    }

    const expectedKind: HostDeferredChallengeKind | null =
      hostCommand.name === 'approval.decide'
        ? 'approval'
        : hostCommand.name === 'question.answer'
          ? 'question'
          : null
    if (!expectedKind) return { action: 'fallthrough' }

    const challengeId =
      expectedKind === 'approval' ? hostCommand.target.approvalId : hostCommand.target.questionId
    if (typeof challengeId !== 'string' || challengeId.length === 0) {
      // Let H validate malformed targets (byte-compat for live cards).
      return { action: 'fallthrough' }
    }

    let deferredDecision: HostDeferredDecision | null = null
    if (expectedKind === 'approval') {
      deferredDecision = mapApprovalDecideToDeferred(hostCommand.arguments.decision)
      if (!deferredDecision) return { action: 'fallthrough' }
    } else {
      const mapped = mapQuestionAnswerToDeferred(hostCommand.arguments.decision)
      if (mapped.kind === 'unmapped') return { action: 'fallthrough' }
      if (mapped.kind === 'answer_unsupported') {
        // Correlated vs uncorrelated decided after lookup — unsupported only
        // when E owns the challenge; uncorrelated falls through to live H.
        let lookup: HostDeferredCommandLookupResult
        try {
          lookup = await deferredAsk.getByChallengeId(challengeId, toDeferredActor(context.actor))
        } catch {
          return {
            action: 'return',
            result: { ok: false, error: 'host_unavailable' }
          }
        }
        if (lookup.kind === 'not_found') return { action: 'fallthrough' }
        if (lookup.kind === 'actor_mismatch') {
          return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
        }
        if (lookup.record.challengeKind !== 'question') {
          return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
        }
        // GAP 2 / PIN S4-V: correlated answer is slice-1 unsupported — challenge
        // stays awaiting; dismiss/restart still terminalize; zero H / zero allow.
        return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
      }
      deferredDecision = mapped.decision
    }

    let lookup: HostDeferredCommandLookupResult
    try {
      lookup = await deferredAsk.getByChallengeId(challengeId, toDeferredActor(context.actor))
    } catch {
      return { action: 'return', result: { ok: false, error: 'host_unavailable' } }
    }

    if (lookup.kind === 'not_found') {
      return { action: 'fallthrough' }
    }
    if (lookup.kind === 'actor_mismatch') {
      return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
    }

    // challengeKind mismatch rejected zero-H (never resolve, never H).
    if (lookup.record.challengeKind !== expectedKind) {
      return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
    }

    let resolveResult: HostDeferredCommandResolveResult
    try {
      resolveResult = await deferredAsk.resolve({
        challengeId,
        actor: toDeferredActor(context.actor),
        decision: deferredDecision
      })
    } catch {
      return { action: 'return', result: { ok: false, error: 'host_unavailable' } }
    }

    // Any non-not_found resolve outcome (incl. failed/indeterminate): E owns it.
    // A not_found after a successful lookup is a race — still no H fall-through.
    if (resolveResult.kind === 'not_found') {
      return { action: 'return', result: { ok: false, error: 'host_unavailable' } }
    }

    if (resolveResult.kind === 'actor_mismatch' || resolveResult.kind === 'command_mismatch') {
      return { action: 'return', result: { ok: false, error: 'invalid_lookup' } }
    }

    if (
      resolveResult.kind === 'completed' ||
      resolveResult.kind === 'existing' ||
      resolveResult.kind === 'indeterminate' ||
      resolveResult.kind === 'not_awaiting'
    ) {
      const found = this.runtime.receiptStore.getByCommandId(
        resolveResult.record.commandId,
        toReceiptActor(context.actor)
      )
      if (found.kind === 'found') {
        return { action: 'return', result: projectFoundReceipt(found.receipt) }
      }
      // E terminalized but receipt projection unavailable — body-free non-success.
      return { action: 'return', result: { ok: false, error: 'host_unavailable' } }
    }

    // failed (and any future closed kinds): E already attempted; never H.
    return { action: 'return', result: { ok: false, error: 'host_unavailable' } }
  }

  private async persistDeferredAsk(
    hostCommand: HostCommand,
    context: HostAuthorityCallContext,
    evaluation: AppStoreHostAuthorityEvaluation,
    pendingReceipt: HostCommandReceiptRecord,
    commandFingerprint: string
  ): Promise<HostAuthorityResult<HostCommandReceipt>> {
    const deferredAsk = this.deferredAsk
    if (!deferredAsk) return projectFoundReceipt(pendingReceipt)

    const challengeKind = evaluation.challengeKind
    if (challengeKind !== 'approval' && challengeKind !== 'question') {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }

    // S2: mint both durable correlation IDs before exposing an envelope or ask.
    const deferredId = mintHostCommandId()
    const challengeId = mintHostCommandId()
    if (!deferredId.ok || !challengeId.ok) {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }

    const envelopeInput: HostDeferredCommandEnvelopePutInput = {
      deferredId: deferredId.value,
      challengeId: challengeId.value,
      challengeKind,
      commandFingerprint,
      command: hostCommand
    }

    // S3: the durable body must exist before the compact bridge row.
    let envelopeResult: HostDeferredCommandEnvelopePutResult
    try {
      envelopeResult = await deferredAsk.envelopeStorePut(envelopeInput)
    } catch {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }
    if (envelopeResult.kind !== 'created' && envelopeResult.kind !== 'existing') {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }

    const bridgeInput: HostDeferredCommandRegisterInput = {
      deferredId: deferredId.value,
      commandId: hostCommand.commandId,
      idempotencyKey: hostCommand.idempotencyKey,
      commandFingerprint,
      commandName: hostCommand.name,
      actor: {
        actorId: context.actor.actorId,
        clientId: context.actor.clientId,
        clientClass: context.actor.clientClass
      },
      challengeId: challengeId.value,
      challengeKind,
      createdAt: this.now()
    }

    // S4: publish the awaiting bridge row only after S3 succeeds.
    let bridgeResult: HostDeferredCommandRegisterResult
    try {
      bridgeResult = await deferredAsk.bridgeRegister(bridgeInput)
    } catch {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }
    if (bridgeResult.kind !== 'created' && bridgeResult.kind !== 'existing') {
      return this.markDeferredUnavailable(hostCommand.commandId)
    }

    // S5: expose the pending ask only after both durable writes succeed.
    return projectFoundReceipt(pendingReceipt)
  }

  /** Promote a deferred receipt to the closed, recoverable unavailable state. */
  private markDeferredUnavailable(commandId: string): HostAuthorityResult<HostCommandReceipt> {
    try {
      this.runtime.receiptStore.markIndeterminate({
        commandId,
        position: this.runtime.getPosition(),
        errorCode: 'deferred_envelope_unavailable',
        updatedAt: this.now()
      })
    } catch {
      // Keep the external result body-free even if durable promotion fails.
    }
    return { ok: false, error: 'host_unavailable' }
  }

  /**
   * Persist a denial bound to the authenticated context actor when the commandId
   * is free. Never execute. Occupied ids fail body-free (no overwrite / invent).
   */
  private persistActorMismatchDenial(
    context: HostAuthorityCallContext,
    hostCommand: HostCommand
  ): HostAuthorityResult<HostCommandReceipt> {
    let fingerprintResult: ReturnType<typeof fingerprintHostCommand>
    try {
      fingerprintResult = fingerprintHostCommand(hostCommand)
    } catch {
      return { ok: false, error: 'invalid_lookup' }
    }

    const reason = 'command actor does not match authenticated call context'
    const begin = this.runtime.receiptStore.begin({
      commandId: hostCommand.commandId,
      idempotencyKey: hostCommand.idempotencyKey,
      commandName: hostCommand.name,
      commandFingerprint: fingerprintResult.fingerprint,
      actor: toReceiptActor(context.actor),
      target: compactTarget(hostCommand, fingerprintResult.targetKind),
      authority: { decision: 'denied', reason },
      createdAt: this.now()
    })

    if (begin.kind === 'created') {
      const completed = this.runtime.receiptStore.complete({
        commandId: hostCommand.commandId,
        status: 'denied',
        completedAt: this.now(),
        authority: { decision: 'denied', reason },
        errorCode: 'actor_mismatch',
        errorMessage: reason
      })
      if (!completed) return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(completed)
    }

    if (begin.kind === 'conflict' && begin.receipt) {
      return projectFoundReceipt(begin.receipt)
    }

    // existing / actor_denied / occupied commandId without durable attempt row
    return { ok: false, error: 'host_unavailable' }
  }

  async health(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostHealthProjection>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate
    try {
      const health = await this.healthProvider()
      if (!health || typeof health !== 'object') {
        return { ok: false, error: 'host_unavailable' }
      }
      return { ok: true, value: health }
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
  }

  async shutdown(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostAuthorityShutdownResult>> {
    if (!contextActorMatchesClient(context)) {
      return { ok: false, error: 'invalid_lookup' }
    }
    // Preserve legacy already-stopped behaviour when no producer hook is installed;
    // with a hook, a failed drain or flush remains retryable until shutdown completes.
    if (this.stopped && (!this.onBeforeShutdown || this.shutdownComplete)) {
      return { ok: true, value: { stopped: true, alreadyStopped: true } }
    }
    if (this.shutdownAttempt) return this.shutdownAttempt
    const lease = this.assertStandaloneLease()
    if (!lease.ok) return lease
    this.stopped = true
    this.shutdownAttempt = this.finishShutdown()
    try {
      return await this.shutdownAttempt
    } finally {
      this.shutdownAttempt = null
    }
  }

  private async finishShutdown(): Promise<HostAuthorityResult<HostAuthorityShutdownResult>> {
    try {
      if (this.onBeforeShutdown) await this.onBeforeShutdown()
    } catch {
      // Admission stays closed, but an incomplete producer drain can be retried.
      // Nothing may flush while a producer could still append start evidence.
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      await this.queuedStartPublication?.drain()
    } catch {
      // Drain is best-effort; shutdown still proceeds.
    }
    try {
      this.runtime.flush()
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    try {
      await this.onShutdown()
    } catch {
      // Stopped flag already set — do not auto-restart; surface still succeeded.
    }
    this.shutdownComplete = true
    return { ok: true, value: { stopped: true, alreadyStopped: false } }
  }
}
