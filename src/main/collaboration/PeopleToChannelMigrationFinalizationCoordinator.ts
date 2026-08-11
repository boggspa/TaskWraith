import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { PeopleToChannelMigrationLegacyWriteGate } from './PeopleToChannelMigrationLegacyWriteGate'
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import type { PeopleToChannelMigrationHistoryMaterialization } from './PeopleToChannelMigrationHistory'
import type { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'
import type {
  PeopleToChannelMigrationMaterialization,
  PeopleToChannelPendingAdmissionReissue
} from './PeopleToChannelMigrationMaterializer'
import type { PeopleToChannelMigrationRecoveryRecord } from './PeopleToChannelMigrationRecoveryStore'
import type { ChannelStore, ChannelStoreMigrationMutation } from './ChannelStore'

export const PEOPLE_TO_CHANNEL_FINALIZATION_COORDINATOR_VERSION = 1

export type PeopleToChannelMigrationFinalizationCoordinatorStage =
  | 'write_gate_quiesced'
  | 'finalization_execution_durable'
  | 'recovery_fenced'
  | 'logs_durable'
  | 'metadata_durable'
  | 'legacy_retired'
  | 'receipt_durable'

export interface PeopleToChannelMigrationFinalizationRecoveryPort {
  load(): PeopleToChannelMigrationRecoveryRecord | null
  beginFinalization(input: {
    planId: string
    finalizationDigest?: string
    now?: number
  }): PeopleToChannelMigrationRecoveryRecord
  completeFinalization(input: {
    planId: string
    now?: number
  }): PeopleToChannelMigrationRecoveryRecord
}

export interface PeopleToChannelMigrationInitialExecutionPort {
  load(): PeopleToChannelMigrationExecution | null
}

export interface PeopleToChannelMigrationFinalizationExecutionPort {
  prepareBeforeRecoveryFence(execution: PeopleToChannelMigrationFinalizationExecution): unknown
  loadForRecoveryFence(input: {
    initialPlanId: string
    initialPlanDigest: string
    finalizationDigest: string
  }): PeopleToChannelMigrationFinalizationExecution
}

export interface PeopleToChannelMigrationFinalizationPeoplePort {
  listShares(): Pick<HumanCollaborationShare, 'shareId'>[]
  retireSharesForChannelMigration(shareIds: readonly string[]): number
}

export interface PeopleToChannelMigrationFinalizationCoordinatorOptions {
  recovery: PeopleToChannelMigrationFinalizationRecoveryPort
  initialExecution: PeopleToChannelMigrationInitialExecutionPort
  finalizationExecution: PeopleToChannelMigrationFinalizationExecutionPort
  legacyWriteGate: PeopleToChannelMigrationLegacyWriteGate
  logs: Pick<PeopleToChannelMigrationLogWriter, 'apply'>
  channels: Pick<ChannelStore, 'applyMigrationBatch'>
  people: PeopleToChannelMigrationFinalizationPeoplePort
  now?: () => number
  /** Test/observability seam invoked only after the named side effect is complete. */
  afterStage?: (stage: PeopleToChannelMigrationFinalizationCoordinatorStage) => void
}

export interface PeopleToChannelMigrationFinalizationCoordinatorResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_COORDINATOR_VERSION
  phase: 'committed'
  planId: string
  finalizationDigest: string
  retireShareIds: string[]
  retainedWorkspaceBootstrapShareIds: string[]
  recovery: PeopleToChannelMigrationRecoveryRecord
}

export class PeopleToChannelMigrationFinalizationCoordinatorError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationCoordinatorError'
  }
}

type FrozenScopeState = 'awaiting_retirement' | 'retired'

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationCoordinatorError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalShareIds(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (shareId) =>
        typeof shareId !== 'string' ||
        !shareId ||
        shareId.trim() !== shareId ||
        shareId.length > 512 ||
        Array.from(shareId).some((character) => {
          const code = character.charCodeAt(0)
          return code < 0x20 || code === 0x7f
        })
    )
  ) {
    blocked('People migration finalization share scope is invalid')
  }
  const ids = [...value].sort(compareText)
  if (new Set(ids).size !== ids.length) {
    blocked('People migration finalization share scope is duplicated')
  }
  return ids
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function stablePolicyAuthority(
  policy: PeopleToChannelMigrationMaterialization['policies'][number]
): unknown {
  return {
    channelId: policy.channelId,
    memberId: policy.memberId,
    sourceShareId: policy.sourceShareId,
    sourceCollaboratorId: policy.sourceCollaboratorId,
    rules: policy.rules,
    requiresHostApproval: policy.requiresHostApproval,
    fullHistory: policy.fullHistory
  }
}

function stablePendingAuthority(policy: PeopleToChannelPendingAdmissionReissue): unknown {
  return {
    sourceShareId: policy.sourceShareId,
    channelId: policy.channelId,
    pendingCollaboratorIds: policy.pendingCollaboratorIds,
    pendingCollaboratorLabels: policy.pendingCollaboratorLabels,
    pendingMemberPresentations: policy.pendingMemberPresentations,
    openInviteCount: policy.openInviteCount,
    policy: {
      rules: policy.policy.rules,
      requiresHostApproval: policy.policy.requiresHostApproval,
      fullHistory: policy.policy.fullHistory
    }
  }
}

function stableAuthorities(base: PeopleToChannelMigrationMaterialization): unknown {
  return {
    policies: base.policies
      .map(stablePolicyAuthority)
      .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right))),
    pendingAdmissions: base.pendingAdmissionReissues
      .map(stablePendingAuthority)
      .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
  }
}

/**
 * This first terminal writer intentionally carries only history and metadata
 * deltas. Existing policy and admission authorities remain valid while their
 * semantic source shape is unchanged; a changed/new policy or pending
 * admission fails closed until its own terminal reconciler is installed.
 */
function assertSupportedDeltaAuthority(args: {
  initial: PeopleToChannelMigrationExecution
  finalization: PeopleToChannelMigrationFinalizationExecution
}): void {
  if (
    canonicalJson(stableAuthorities(args.initial.base)) !==
    canonicalJson(stableAuthorities(args.finalization.delta.base))
  ) {
    blocked(
      'People migration finalization has a policy or pending-admission state delta requiring reconciliation'
    )
  }
}

function assertRecoveryBinding(args: {
  recovery: PeopleToChannelMigrationRecoveryRecord
  initial: PeopleToChannelMigrationExecution
  finalization: PeopleToChannelMigrationFinalizationExecution
}): void {
  const { recovery, initial, finalization } = args
  if (
    recovery.planId !== initial.plan.planId ||
    recovery.planDigest !== initial.planDigest ||
    recovery.sourceDigest !== initial.plan.sourceDigest ||
    finalization.initialPlanId !== initial.plan.planId ||
    finalization.initialPlanDigest !== initial.planDigest ||
    recovery.channelStateDigest !== finalization.channelStateDigest ||
    recovery.cutoverStateDigest !== finalization.cutoverStateDigest
  ) {
    blocked('People migration finalization does not match durable additive-cutover authority')
  }
}

function finalizationHistory(
  execution: PeopleToChannelMigrationFinalizationExecution
): PeopleToChannelMigrationHistoryMaterialization {
  return execution.delta.history
}

function finalizationMetadata(
  execution: PeopleToChannelMigrationFinalizationExecution
): ChannelStoreMigrationMutation[] {
  return execution.delta.history.metadataMutations
}

/**
 * The concrete terminal P4 state machine. The caller captures the encrypted
 * final execution only while recovery is still `cutover_applied`; every later
 * retry loads that exact fenced execution and converges each side effect.
 */
export class PeopleToChannelMigrationFinalizationCoordinator {
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationFinalizationCoordinatorOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('People migration finalization coordinator requires options')
    }
    this.now = options.now ?? Date.now
  }

  run(
    input: {
      /** Required only while recovery is at the additive `cutover_applied` boundary. */
      capture?: () => PeopleToChannelMigrationFinalizationExecution
      /** P5-owned exception supplied before the gate can freeze ordinary People writes. */
      retainedWorkspaceBootstrapShareIds?: readonly string[]
    } = {}
  ): PeopleToChannelMigrationFinalizationCoordinatorResult {
    const initial = this.options.initialExecution.load()
    if (!initial) blocked('People migration finalization has no initial execution checkpoint')
    let recovery = this.options.recovery.load()
    if (!recovery) blocked('People migration finalization recovery intent is missing')

    let execution: PeopleToChannelMigrationFinalizationExecution
    if (recovery.phase === 'cutover_applied') {
      const requestedRetained = canonicalShareIds(input.retainedWorkspaceBootstrapShareIds ?? [])
      this.options.legacyWriteGate.quiesce({
        retainedWorkspaceBootstrapShareIds: requestedRetained
      })
      this.options.afterStage?.('write_gate_quiesced')
      if (!input.capture) {
        blocked('People migration finalization capture is required at the cutover boundary')
      }
      execution = input.capture()
      if (
        !sameIds(
          canonicalShareIds(execution.scope.retainedWorkspaceBootstrapShareIds),
          requestedRetained
        )
      ) {
        blocked('People migration finalization capture changed the requested P5 retention scope')
      }
      assertRecoveryBinding({ recovery, initial, finalization: execution })
      assertSupportedDeltaAuthority({ initial, finalization: execution })
      this.assertFrozenScope(execution, 'awaiting_retirement')
      this.options.finalizationExecution.prepareBeforeRecoveryFence(execution)
      this.options.afterStage?.('finalization_execution_durable')
      recovery = this.options.recovery.beginFinalization({
        planId: initial.plan.planId,
        finalizationDigest: execution.finalizationDigest,
        now: this.now()
      })
      if (recovery.phase !== 'finalizing') {
        blocked('People migration finalization recovery fence did not become durable')
      }
      this.options.afterStage?.('recovery_fenced')
    } else if (recovery.phase === 'finalizing' || recovery.phase === 'committed') {
      if (!recovery.finalizationDigest) {
        blocked('People migration finalization recovery fence is missing its digest')
      }
      execution = this.options.finalizationExecution.loadForRecoveryFence({
        initialPlanId: initial.plan.planId,
        initialPlanDigest: initial.planDigest,
        finalizationDigest: recovery.finalizationDigest
      })
      assertRecoveryBinding({ recovery, initial, finalization: execution })
      assertSupportedDeltaAuthority({ initial, finalization: execution })
      this.options.legacyWriteGate.quiesce({
        retainedWorkspaceBootstrapShareIds: execution.scope.retainedWorkspaceBootstrapShareIds
      })
      this.options.afterStage?.('write_gate_quiesced')
      if (recovery.phase === 'committed') {
        this.assertFrozenScope(execution, 'retired')
        return this.result(execution, recovery)
      }
    } else {
      blocked('People migration finalization phase is out of order')
    }

    // Never replay a terminal delta against a source generation that is half
    // retired (or has gained an unsealed ordinary share) after a crash.
    this.assertFrozenScope(execution)
    this.options.logs.apply(finalizationHistory(execution))
    this.options.afterStage?.('logs_durable')
    this.options.channels.applyMigrationBatch(finalizationMetadata(execution))
    this.options.afterStage?.('metadata_durable')

    if (this.assertFrozenScope(execution) === 'awaiting_retirement') {
      const removed = this.options.people.retireSharesForChannelMigration(
        execution.scope.retireShareIds
      )
      if (removed !== execution.scope.retireShareIds.length) {
        blocked('People migration terminal retirement did not remove its complete ordinary scope')
      }
      this.assertFrozenScope(execution, 'retired')
      this.options.afterStage?.('legacy_retired')
    }

    recovery = this.options.recovery.completeFinalization({
      planId: initial.plan.planId,
      now: this.now()
    })
    if (recovery.phase !== 'committed') {
      blocked('People migration finalization receipt did not become durable')
    }
    this.options.afterStage?.('receipt_durable')
    return this.result(execution, recovery)
  }

  private assertFrozenScope(
    execution: PeopleToChannelMigrationFinalizationExecution,
    expected?: FrozenScopeState
  ): FrozenScopeState {
    const retirement = canonicalShareIds(execution.scope.retireShareIds)
    const retained = canonicalShareIds(execution.scope.retainedWorkspaceBootstrapShareIds)
    const all = canonicalShareIds([...retirement, ...retained])
    const current = canonicalShareIds(
      this.options.people.listShares().map((share) => share.shareId)
    )
    const state: FrozenScopeState = sameIds(current, all)
      ? 'awaiting_retirement'
      : sameIds(current, retained)
        ? 'retired'
        : blocked('People migration terminal legacy scope is partial or changed')
    if (expected && state !== expected) {
      blocked('People migration terminal legacy scope is at an unsafe recovery boundary')
    }
    return state
  }

  private result(
    execution: PeopleToChannelMigrationFinalizationExecution,
    recovery: PeopleToChannelMigrationRecoveryRecord
  ): PeopleToChannelMigrationFinalizationCoordinatorResult {
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_COORDINATOR_VERSION,
      phase: 'committed',
      planId: recovery.planId,
      finalizationDigest: execution.finalizationDigest,
      retireShareIds: [...execution.scope.retireShareIds],
      retainedWorkspaceBootstrapShareIds: [...execution.scope.retainedWorkspaceBootstrapShareIds],
      recovery: clone(recovery)
    }
  }
}

export function isPeopleToChannelMigrationFinalizationCoordinatorError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationCoordinatorError {
  return (
    error instanceof PeopleToChannelMigrationFinalizationCoordinatorError &&
    error.code === 'recovery_blocked'
  )
}
