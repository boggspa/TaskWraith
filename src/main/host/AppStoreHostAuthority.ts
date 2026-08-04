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
  type HostActorIdentity,
  type HostCommand,
  type HostCommandReceipt,
  type HostCursorPosition,
  type HostDeltasSinceResult,
  type HostHealthProjection,
  type HostSnapshot
} from '../../shared/hostProtocol'
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
import { parseGovernedMutationCommandName } from './HostCommandRouting'
import { projectHostCommandReceipt } from './HostCommandReceiptProjection'
import type {
  HostCommandAuthorityDecision,
  HostCommandReceiptActor,
  HostCommandReceiptRecord,
  HostCommandReceiptTarget
} from './HostCommandReceiptStore'
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
}

export type AppStoreHostAuthorityExecutor = (
  command: HostCommand,
  context: HostAuthorityCallContext
) => AppStoreHostAuthorityExecutorResult | Promise<AppStoreHostAuthorityExecutorResult>

export type AppStoreHostAuthorityHealthProvider = () =>
  | HostHealthProjection
  | Promise<HostHealthProjection>

export type AppStoreHostAuthorityShutdownCallback = () => void | Promise<void>

/**
 * Narrow injected ports so a later composition root can wrap AppStore/Bridge
 * without this module importing them.
 */
export interface AppStoreHostAuthorityPorts {
  readonly runtime: HostRuntimeBootstrap
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly onShutdown: AppStoreHostAuthorityShutdownCallback
}

export interface AppStoreHostAuthorityOptions {
  readonly mode: AppStoreHostAuthorityMode
  readonly activationPermit: AppStoreHostAuthorityActivationPermit
  readonly ports: AppStoreHostAuthorityPorts
  /** Optional ISO clock for receipt completion timestamps in tests. */
  readonly now?: () => string
}

const EXECUTOR_FAILURE_CODE = 'executor_failed'
const EXECUTOR_FAILURE_MESSAGE = 'command executor failed'

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
  private readonly healthProvider: AppStoreHostAuthorityHealthProvider
  private readonly onShutdown: AppStoreHostAuthorityShutdownCallback
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
      typeof ports.healthProvider !== 'function' ||
      typeof ports.onShutdown !== 'function'
    ) {
      throw new Error('AppStoreHostAuthority requires complete injected ports')
    }
    this.runtime = ports.runtime
    this.snapshotDonor = ports.snapshotDonor
    this.authorityEvaluator = ports.authorityEvaluator
    this.commandExecutor = ports.commandExecutor
    this.healthProvider = ports.healthProvider
    this.onShutdown = ports.onShutdown
    this.now = options.now ?? (() => new Date().toISOString())
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
    const hostCommand = decoded.value

    // Body-bearing reads are Authority RPC methods only. Reserved read aliases
    // must never reach actor denial, fingerprinting, evaluation, receipts, or
    // execution through the durable mutation path.
    if (parseGovernedMutationCommandName(hostCommand.name) === null) {
      return { ok: false, error: 'invalid_lookup' }
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
      // Durable pending/ask — do not execute.
      return projectFoundReceipt(begin.receipt)
    }

    // allowed — execute once
    let executorResult: AppStoreHostAuthorityExecutorResult
    try {
      executorResult = await this.commandExecutor(hostCommand, context)
    } catch {
      const failed = this.runtime.receiptStore.complete({
        commandId: hostCommand.commandId,
        status: 'failed',
        completedAt: this.now(),
        errorCode: EXECUTOR_FAILURE_CODE,
        errorMessage: EXECUTOR_FAILURE_MESSAGE
      })
      if (!failed) return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(failed)
    }

    if (
      !executorResult ||
      (executorResult.status !== 'succeeded' &&
        executorResult.status !== 'failed' &&
        executorResult.status !== 'cancelled')
    ) {
      const failed = this.runtime.receiptStore.complete({
        commandId: hostCommand.commandId,
        status: 'failed',
        completedAt: this.now(),
        errorCode: EXECUTOR_FAILURE_CODE,
        errorMessage: EXECUTOR_FAILURE_MESSAGE
      })
      if (!failed) return { ok: false, error: 'host_unavailable' }
      return projectFoundReceipt(failed)
    }

    const completed = this.runtime.receiptStore.complete({
      commandId: hostCommand.commandId,
      status: executorResult.status,
      completedAt: this.now(),
      ...(executorResult.resultSummary !== undefined
        ? { resultSummary: executorResult.resultSummary }
        : {}),
      ...(executorResult.errorCode !== undefined ? { errorCode: executorResult.errorCode } : {}),
      ...(executorResult.errorMessage !== undefined
        ? { errorMessage: executorResult.errorMessage }
        : {})
    })
    if (!completed) return { ok: false, error: 'host_unavailable' }
    return projectFoundReceipt(completed)
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
