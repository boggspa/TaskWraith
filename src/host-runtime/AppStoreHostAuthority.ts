/**
 * In-process migration HostAuthority (Host Arc Wave 2B Subwave 4C).
 *
 * Explicit pre-cutover / rollback adapter over injected current-authority ports.
 * Never reads AppStore, Bridge, or Electron directly; never opens listeners,
 * launches providers, or reimplements work locks / permission walls.
 * No production singleton or composition-root wiring in this module.
 */

import {
  decodeHostCommand,
  decodeHostCommandReceipt,
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
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import {
  HostMutationCompletionCoordinator,
  type HostMutationCompletionResult
} from './HostMutationCompletionCoordinator'
import {
  HostObservedMutationExecutor,
  type HostObservedMutationResult
} from './HostObservedMutationExecutor'
import { projectHostRecovery } from './HostRecoveryProjection'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { projectHostSnapshot, type HostSnapshotProjectorInput } from './HostSnapshotProjector'

/** Literal activation mode — migration/rollback only. */
export type AppStoreHostAuthorityMode = 'in-process-migration'

/**
 * Explicit pre-cutover permit. Construction fails when Host-owned state may
 * already have advanced (no silent fallback after dedicated Host cutover).
 */
export interface AppStoreHostAuthorityActivationPermit {
  readonly hostOwnedStateMayHaveAdvanced: false
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
  readonly runtime: HostRuntimeBootstrap
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly setupExecutor?: AppStoreHostAuthoritySetupExecutor
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  readonly onShutdown: AppStoreHostAuthorityShutdownCallback
  /** Optional only for pre-cutover compatibility; present enables S2–S5. */
  readonly deferredAsk?: HostDeferredAskPorts
}

export interface AppStoreHostAuthorityOptions {
  readonly mode: AppStoreHostAuthorityMode
  readonly activationPermit: AppStoreHostAuthorityActivationPermit
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

function compactTarget(command: HostCommand, targetKind: string): HostCommandReceiptTarget {
  const keys = Object.keys(command.target).sort()
  if (keys.length === 0) return { kind: targetKind }
  const id = command.target[keys[0]!]
  if (typeof id !== 'string' || id.length === 0) return { kind: targetKind }
  return { kind: targetKind, id }
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
  private readonly runtime: HostRuntimeBootstrap
  private readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  private readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  private readonly commandExecutor: AppStoreHostAuthorityExecutor
  private readonly setupExecutor?: AppStoreHostAuthoritySetupExecutor
  private readonly healthProvider: AppStoreHostAuthorityHealthProvider
  private readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  private readonly onShutdown: AppStoreHostAuthorityShutdownCallback
  private readonly deferredAsk?: HostDeferredAskPorts
  private readonly domainPublisher: HostDomainDeltaPublisher
  private readonly completionCoordinator: HostMutationCompletionCoordinator
  private readonly now: () => string
  private stopped = false

  constructor(options: AppStoreHostAuthorityOptions) {
    if (!options || options.mode !== 'in-process-migration') {
      throw new Error('AppStoreHostAuthority requires mode "in-process-migration"')
    }
    const permit = options.activationPermit
    if (
      !permit ||
      permit.hostOwnedStateMayHaveAdvanced !== false ||
      (permit as { hostOwnedStateMayHaveAdvanced?: unknown }).hostOwnedStateMayHaveAdvanced === true
    ) {
      throw new Error(
        'AppStoreHostAuthority requires an explicit pre-cutover activation permit (hostOwnedStateMayHaveAdvanced: false)'
      )
    }
    const ports = options.ports
    if (
      !ports ||
      !ports.runtime ||
      typeof ports.snapshotDonor !== 'function' ||
      typeof ports.authorityEvaluator !== 'function' ||
      typeof ports.commandExecutor !== 'function' ||
      (ports.setupExecutor !== undefined && typeof ports.setupExecutor.execute !== 'function') ||
      typeof ports.healthProvider !== 'function' ||
      (ports.threadOffersProvider !== undefined &&
        typeof ports.threadOffersProvider !== 'function') ||
      typeof ports.onShutdown !== 'function' ||
      (ports.deferredAsk !== undefined && !isValidDeferredAskPorts(ports.deferredAsk))
    ) {
      throw new Error('AppStoreHostAuthority requires complete injected ports')
    }
    this.runtime = ports.runtime
    this.snapshotDonor = ports.snapshotDonor
    this.authorityEvaluator = ports.authorityEvaluator
    this.commandExecutor = ports.commandExecutor
    this.setupExecutor = ports.setupExecutor
    this.healthProvider = ports.healthProvider
    this.threadOffersProvider = ports.threadOffersProvider
    this.onShutdown = ports.onShutdown
    this.deferredAsk = ports.deferredAsk
    this.now = options.now ?? (() => new Date().toISOString())
    // Scope 2: sole-journal publish + completion ports (allowed branch only).
    this.domainPublisher = new HostDomainDeltaPublisher({ store: this.runtime.deltaStore })
    this.completionCoordinator = new HostMutationCompletionCoordinator({
      publishEffects: (effects) => this.domainPublisher.publish(effects),
      getPosition: () => this.runtime.getPosition(),
      completeReceipt: (input) => this.runtime.receiptStore.complete(input),
      markIndeterminate: (input) => this.runtime.receiptStore.markIndeterminate(input)
    })
  }

  private gate(context: HostAuthorityCallContext): HostAuthorityResult<true> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
    if (!contextActorMatchesClient(context)) return { ok: false, error: 'invalid_lookup' }
    return { ok: true, value: true }
  }

  async snapshot(
    context: HostAuthorityCallContext,
    _cursor?: HostCursorPosition
  ): Promise<HostAuthorityResult<HostSnapshot>> {
    const gate = this.gate(context)
    if (!gate.ok) return gate

    let donor: AppStoreHostAuthoritySnapshotDonorFamilies
    try {
      donor = await this.snapshotDonor()
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    if (!donor || typeof donor !== 'object') {
      return { ok: false, error: 'host_unavailable' }
    }

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

  async receipt(
    context: HostAuthorityCallContext,
    lookup: HostAuthorityReceiptLookup
  ): Promise<HostAuthorityReceiptResult> {
    if (this.stopped) return { ok: false, error: 'shutting_down' }
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

    if (found.kind === 'not_found') return { ok: true, outcome: 'not_found' }
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
    return this.executeAllowedMutation(hostCommand, context, this.commandExecutor)
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
    const observedExecutor = new HostObservedMutationExecutor({
      captureSnapshot: () => this.captureMutationSnapshot(),
      executeCommand: async (command) => {
        const result =
          'execute' in executor
            ? await executor.execute(command, context)
            : await executor(command, context)
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

  /** Privacy-clean live snapshot for observe before/after capture. */
  private async captureMutationSnapshot(): Promise<unknown> {
    const donor = await this.snapshotDonor()
    if (!donor || typeof donor !== 'object') {
      throw new Error('snapshot donor unavailable')
    }
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
    if (this.stopped) {
      return { ok: true, value: { stopped: true, alreadyStopped: true } }
    }
    try {
      this.runtime.flush()
    } catch {
      return { ok: false, error: 'host_unavailable' }
    }
    this.stopped = true
    try {
      await this.onShutdown()
    } catch {
      // Stopped flag already set — do not auto-restart; surface still succeeded.
    }
    return { ok: true, value: { stopped: true, alreadyStopped: false } }
  }
}
