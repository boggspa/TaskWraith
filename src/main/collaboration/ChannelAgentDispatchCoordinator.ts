import { createHash } from 'crypto'

import {
  hashChannelAgentContent,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import type {
  AgentRunPayload,
  RunAdapterInvocationReceipt,
  RunDispatchFinalAuthorization,
  RunDispatchObserver
} from '../run/AgentRunTypes'
import type { ChannelAuditInput, ChannelAuditLike } from './ChannelAuditLog'
import type {
  ChannelAgentDispatchPlan,
  ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalBinding,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type {
  ChannelAgentDispatchJournalStore,
  ChannelAgentDispatchReservationResult
} from './ChannelAgentDispatchJournalStore'
import type { ChannelAgentIdentityStore } from './ChannelAgentIdentityStore'
import type { ChannelAppendResult, AgentChannelMessage } from './ChannelMessageLog'
import type { ChannelAgentRunTerminalEvidence } from './ChannelAgentRunEventCollector'
import type { ChannelAgentRunComposer } from './ChannelAgentRunComposer'
import { signChannelAgentTerminalPost } from './ChannelAgentTerminalPostSigner'
import type {
  ChannelAgentRunLaunchRegistration,
  ChannelAgentRunLaunchRegistry,
  ChannelAgentRunLaunchStatus
} from './ChannelAgentRunLaunchRegistry'

const AUDIT_DEDUPE_DOMAIN = 'taskwraith.channel.agent-dispatch-audit.v1\0'

export type ChannelAgentDispatchDeclineCode =
  | 'authorization_failed'
  | 'collection_unavailable'
  | 'composition_failed'
  | 'post_authority_unavailable'
  | 'preflight_declined'

export type ChannelAgentDispatchRecoveryStage =
  | 'audit'
  | 'cleanup'
  | 'consumption'
  | 'existing_journal'
  | 'launch'
  | 'launch_confirmation'
  | 'post_append'
  | 'post_receipt'
  | 'signed_post'
  | 'terminal'

interface ChannelAgentDispatchResultBase {
  readonly channelId: string
  readonly dispatchId: string
  readonly runId: string
  readonly triggerMessageId: string
  readonly agentMemberId: string
}

export type ChannelAgentDispatchCoordinatorResult =
  | (ChannelAgentDispatchResultBase & {
      readonly kind: 'posted'
      readonly record: AgentChannelMessage
      readonly deduplicated: boolean
    })
  | (ChannelAgentDispatchResultBase & {
      readonly kind: 'declined'
      readonly code: ChannelAgentDispatchDeclineCode
    })
  | (ChannelAgentDispatchResultBase & {
      readonly kind: 'in_flight'
    })
  | (ChannelAgentDispatchResultBase & {
      readonly kind: 'recovery_required'
      readonly stage: ChannelAgentDispatchRecoveryStage
    })

export type ChannelAgentDispatchCoordinatorErrorCode =
  | 'dependency_unavailable'
  | 'journal_unavailable'

export class ChannelAgentDispatchCoordinatorError extends Error {
  constructor(
    readonly code: ChannelAgentDispatchCoordinatorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentDispatchCoordinatorError'
  }
}

type JournalPort = Pick<
  ChannelAgentDispatchJournalStore,
  'reserve' | 'recordTerminal' | 'recordSignedPost' | 'recordPosted' | 'abandon' | 'complete'
>

type IdentityPort = Pick<ChannelAgentIdentityStore, 'load'>
type ComposerPort = Pick<ChannelAgentRunComposer, 'compose'>
type LaunchRegistryPort = Pick<ChannelAgentRunLaunchRegistry, 'register'>

export interface ChannelAgentDispatchHooks {
  readonly observer: RunDispatchObserver
  readonly finalAuthorization: RunDispatchFinalAuthorization
}

export interface ChannelAgentDispatchPortResult {
  readonly dispatched: boolean
  readonly appRunId: string
}

export interface ChannelAgentDispatchCoordinatorOptions {
  readonly journal: JournalPort
  readonly identities: IdentityPort
  readonly composer: ComposerPort
  readonly launches: LaunchRegistryPort
  /** Regular main dispatch facade; it retains approvals, lifecycle, and provenance. */
  readonly dispatch: (
    payload: AgentRunPayload,
    hooks: ChannelAgentDispatchHooks
  ) => Promise<ChannelAgentDispatchPortResult>
  /** Production binds this to append + live fan-out/host notification. */
  readonly appendSignedPost: (args: {
    readonly signedPost: SignedChannelAgentPost
    readonly now: number
  }) => ChannelAppendResult | Promise<ChannelAppendResult>
  readonly audit: ChannelAuditLike
  readonly now?: () => number
}

function coordinatorError(
  code: ChannelAgentDispatchCoordinatorErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentDispatchCoordinatorError {
  // Provider/storage failures may contain prompt, path, or secret bytes. This
  // boundary exposes only static main-owned outcome copy.
  return new ChannelAgentDispatchCoordinatorError(code, message)
}

export function channelAgentDispatchAuditDedupeKey(
  kind: ChannelAuditInput['kind'],
  dispatchId: string
): string {
  return createHash('sha256')
    .update(AUDIT_DEDUPE_DOMAIN)
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(dispatchId, 'utf8')
    .digest('hex')
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function journalFloor(snapshot: ChannelAgentDispatchJournalSnapshot): number {
  return snapshot.events.at(-1)?.at ?? snapshot.binding.reservedAt
}

function resultBase(
  plan: ChannelAgentDispatchPlan,
  binding: ChannelAgentDispatchJournalBinding
): ChannelAgentDispatchResultBase {
  return {
    channelId: plan.channelId,
    dispatchId: binding.dispatchId,
    runId: binding.runId,
    triggerMessageId: plan.triggerMessageId,
    agentMemberId: plan.member.memberId
  }
}

function recoveryStageForStatus(
  status: ChannelAgentRunLaunchStatus
): ChannelAgentDispatchRecoveryStage {
  if (status === 'consumption_intent_unknown' || status === 'consumption_unknown') {
    return 'consumption'
  }
  if (status === 'launch_intent_unknown' || status === 'launching') return 'launch'
  return 'launch_confirmation'
}

/**
 * Root-free transaction owner for one accepted Channel mention. It deliberately
 * has no review-gate or source-listener dependency: production may call it only
 * from the separately gated admission branch after P3 adversarial acceptance.
 */
export class ChannelAgentDispatchCoordinator {
  private readonly activeDispatches = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: ChannelAgentDispatchCoordinatorOptions) {
    if (
      !options ||
      typeof options.journal?.reserve !== 'function' ||
      typeof options.journal?.recordTerminal !== 'function' ||
      typeof options.journal?.recordSignedPost !== 'function' ||
      typeof options.journal?.recordPosted !== 'function' ||
      typeof options.journal?.abandon !== 'function' ||
      typeof options.journal?.complete !== 'function' ||
      typeof options.identities?.load !== 'function' ||
      typeof options.composer?.compose !== 'function' ||
      typeof options.launches?.register !== 'function' ||
      typeof options.dispatch !== 'function' ||
      typeof options.appendSignedPost !== 'function' ||
      typeof options.audit?.append !== 'function'
    ) {
      throw coordinatorError(
        'dependency_unavailable',
        'Channel agent dispatch coordinator dependencies are unavailable'
      )
    }
    this.now = options.now ?? Date.now
  }

  async run(plan: ChannelAgentDispatchPlan): Promise<ChannelAgentDispatchCoordinatorResult> {
    let reservation: ChannelAgentDispatchReservationResult
    try {
      reservation = this.options.journal.reserve(plan, this.currentTime())
    } catch (error) {
      throw coordinatorError(
        'journal_unavailable',
        'Channel agent dispatch reservation is unavailable',
        error
      )
    }
    let state: ChannelAgentDispatchJournalState
    try {
      state = ChannelAgentDispatchJournalState.restore(reservation.snapshot)
    } catch (error) {
      throw coordinatorError(
        'journal_unavailable',
        'Channel agent dispatch reservation is invalid',
        error
      )
    }
    const binding = state.binding()
    const base = resultBase(plan, binding)
    if (state.phase() !== 'reserved') {
      return { ...base, kind: 'recovery_required', stage: 'existing_journal' }
    }
    if (this.activeDispatches.has(binding.dispatchId)) {
      return { ...base, kind: 'in_flight' }
    }
    this.activeDispatches.add(binding.dispatchId)
    try {
      return await this.runReserved(plan, reservation.snapshot, binding)
    } finally {
      this.activeDispatches.delete(binding.dispatchId)
    }
  }

  pendingCount(): number {
    return this.activeDispatches.size
  }

  private async runReserved(
    plan: ChannelAgentDispatchPlan,
    reservation: ChannelAgentDispatchJournalSnapshot,
    binding: ChannelAgentDispatchJournalBinding
  ): Promise<ChannelAgentDispatchCoordinatorResult> {
    const base = resultBase(plan, binding)
    let payload: AgentRunPayload
    try {
      payload = await this.options.composer.compose(plan, reservation)
    } catch {
      return this.decline(plan, binding, null, 'composition_failed', reservation)
    }

    let registration: ChannelAgentRunLaunchRegistration
    try {
      registration = this.options.launches.register({
        dispatchId: binding.dispatchId,
        plan,
        expectedPayload: payload
      })
    } catch {
      return this.decline(plan, binding, null, 'collection_unavailable', reservation)
    }

    let launchAuditWritten = false
    const writeLaunchAudit = (seal: ChannelAgentRunAuthoritySeal): void => {
      if (launchAuditWritten) return
      this.appendAudit({
        kind: 'agent.dispatch.started',
        plan,
        binding,
        code: seal.provider,
        contentHash: plan.triggerContentHash,
        detail: `provider=${seal.provider}`,
        at: this.currentTime(seal.launchedAt)
      })
      launchAuditWritten = true
    }
    const observer: RunDispatchObserver = Object.freeze({
      onAdapterInvoked: (receipt: RunAdapterInvocationReceipt) => {
        registration.observer.onAdapterInvoked?.(receipt)
        try {
          writeLaunchAudit(registration.requireLaunchConfirmed())
        } catch {
          // The generic dispatcher intentionally swallows observer errors. The
          // exact status and audit are rechecked after it settles.
        }
      }
    })
    const finalAuthorization: RunDispatchFinalAuthorization = Object.freeze({
      authorizeBeforeAdapterRun: (launchPayload: AgentRunPayload) => {
        registration.authorizeBeforeAdapterRun(launchPayload)
        return undefined
      }
    })

    let dispatchResult: ChannelAgentDispatchPortResult | null = null
    let dispatchThrew = false
    try {
      dispatchResult = await this.options.dispatch(payload, { observer, finalAuthorization })
    } catch {
      dispatchThrew = true
    }

    const launchStatus = registration.status()
    if (launchStatus === 'registered' || launchStatus === 'authorization_failed') {
      return this.decline(
        plan,
        binding,
        registration,
        launchStatus === 'authorization_failed' ? 'authorization_failed' : 'preflight_declined',
        reservation
      )
    }
    if (launchStatus !== 'confirmed') {
      this.tryAuditFailure(plan, binding, 'launch_outcome_unknown', reservation)
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: recoveryStageForStatus(launchStatus) }
    }

    let seal: ChannelAgentRunAuthoritySeal
    try {
      seal = registration.requireLaunchConfirmed()
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'launch_confirmation' }
    }
    try {
      writeLaunchAudit(seal)
    } catch {
      // Retry after the terminal/post transaction. The launch journal remains
      // authoritative while the provider owns the run.
    }

    let terminal: ChannelAgentRunTerminalEvidence
    try {
      terminal = await registration.terminal
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'terminal' }
    }
    let terminalSnapshot: ChannelAgentDispatchJournalSnapshot
    try {
      terminalSnapshot = this.options.journal.recordTerminal(plan.channelId, binding.dispatchId, {
        status: terminal.status,
        exitCode: terminal.exitCode,
        content: terminal.content,
        at: terminal.observedAt
      })
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'terminal' }
    }

    if (
      (!dispatchThrew &&
        (!dispatchResult?.dispatched || dispatchResult.appRunId !== binding.runId)) ||
      seal.runId !== binding.runId
    ) {
      this.tryAuditFailure(plan, binding, 'dispatch_receipt_conflict', reservation, terminal)
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'terminal' }
    }

    let signedPost: SignedChannelAgentPost
    try {
      const identity = this.options.identities.load(plan.seat.agentSeatId)
      if (!identity || identity.publicKeyB64 !== plan.member.identityPublicKey) {
        throw new Error('identity unavailable')
      }
      signedPost = signChannelAgentTerminalPost({
        snapshot: terminalSnapshot,
        identity,
        at: this.currentTime(terminal.observedAt)
      })
    } catch {
      return this.finishPostAuthorityFailure(plan, binding, registration, terminal)
    }
    try {
      this.options.journal.recordSignedPost(plan.channelId, binding.dispatchId, signedPost)
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'signed_post' }
    }

    let appended: ChannelAppendResult
    try {
      appended = await this.options.appendSignedPost({
        signedPost,
        now: signedPost.post.createdAt
      })
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'post_append' }
    }
    if (appended.record.kind !== 'agent.text') {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'post_receipt' }
    }
    try {
      this.options.journal.recordPosted(
        plan.channelId,
        binding.dispatchId,
        appended.record,
        appended.deduplicated
      )
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'post_receipt' }
    }

    try {
      writeLaunchAudit(seal)
      this.appendAudit({
        kind: 'agent.dispatch.completed',
        plan,
        binding,
        code: terminal.status,
        contentHash: hashChannelAgentContent(terminal.content),
        detail: `provider=${seal.provider};status=${terminal.status}`,
        at: terminal.observedAt
      })
      this.appendAudit({
        kind: 'agent.post.committed',
        plan,
        binding,
        code: appended.deduplicated ? 'deduplicated' : 'appended',
        contentHash: appended.record.contentHash,
        detail: `sequence=${appended.record.sequence}`,
        at: appended.record.acceptedAt
      })
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'audit' }
    }

    try {
      if (!this.options.journal.complete(plan.channelId, binding.dispatchId)) {
        throw new Error('journal missing')
      }
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'cleanup' }
    }
    registration.releaseAfterTerminal()
    return {
      ...base,
      kind: 'posted',
      record: appended.record,
      deduplicated: appended.deduplicated
    }
  }

  private decline(
    plan: ChannelAgentDispatchPlan,
    binding: ChannelAgentDispatchJournalBinding,
    registration: ChannelAgentRunLaunchRegistration | null,
    code: ChannelAgentDispatchDeclineCode,
    snapshot: ChannelAgentDispatchJournalSnapshot
  ): ChannelAgentDispatchCoordinatorResult {
    const base = resultBase(plan, binding)
    let abandoned: ChannelAgentDispatchJournalSnapshot
    try {
      abandoned = this.options.journal.abandon(
        plan.channelId,
        binding.dispatchId,
        'preflight_declined',
        this.currentTime(journalFloor(snapshot))
      )
    } catch {
      if (registration) this.releaseDeclined(registration)
      return { ...base, kind: 'recovery_required', stage: 'cleanup' }
    }
    try {
      this.appendAudit({
        kind: 'agent.dispatch.failed',
        plan,
        binding,
        code,
        contentHash: plan.triggerContentHash,
        at: abandoned.events.at(-1)?.at ?? abandoned.binding.reservedAt
      })
    } catch {
      if (registration) this.releaseDeclined(registration)
      return { ...base, kind: 'recovery_required', stage: 'audit' }
    }
    try {
      if (!this.options.journal.complete(plan.channelId, binding.dispatchId)) {
        throw new Error('journal missing')
      }
    } catch {
      if (registration) this.releaseDeclined(registration)
      return { ...base, kind: 'recovery_required', stage: 'cleanup' }
    }
    if (registration) this.releaseDeclined(registration)
    return { ...base, kind: 'declined', code }
  }

  private finishPostAuthorityFailure(
    plan: ChannelAgentDispatchPlan,
    binding: ChannelAgentDispatchJournalBinding,
    registration: ChannelAgentRunLaunchRegistration,
    terminal: ChannelAgentRunTerminalEvidence
  ): ChannelAgentDispatchCoordinatorResult {
    const base = resultBase(plan, binding)
    let abandoned: ChannelAgentDispatchJournalSnapshot
    try {
      abandoned = this.options.journal.abandon(
        plan.channelId,
        binding.dispatchId,
        'post_authority_unavailable',
        this.currentTime(terminal.observedAt)
      )
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'signed_post' }
    }
    try {
      this.appendAudit({
        kind: 'agent.dispatch.failed',
        plan,
        binding,
        code: 'post_authority_unavailable',
        contentHash: hashChannelAgentContent(terminal.content),
        at: abandoned.events.at(-1)?.at ?? terminal.observedAt
      })
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'audit' }
    }
    try {
      if (!this.options.journal.complete(plan.channelId, binding.dispatchId)) {
        throw new Error('journal missing')
      }
    } catch {
      this.tryReleaseForRecovery(registration)
      return { ...base, kind: 'recovery_required', stage: 'cleanup' }
    }
    registration.releaseAfterTerminal()
    return { ...base, kind: 'declined', code: 'post_authority_unavailable' }
  }

  private appendAudit(args: {
    kind: Extract<
      ChannelAuditInput['kind'],
      | 'agent.dispatch.started'
      | 'agent.dispatch.completed'
      | 'agent.dispatch.failed'
      | 'agent.post.committed'
    >
    plan: ChannelAgentDispatchPlan
    binding: ChannelAgentDispatchJournalBinding
    code: string
    contentHash: string
    detail?: string
    at: number
  }): void {
    this.options.audit.append({
      kind: args.kind,
      channelId: args.plan.channelId,
      memberId: args.plan.member.memberId,
      code: args.code,
      contentHash: args.contentHash,
      ...(args.detail ? { detail: args.detail } : {}),
      dedupeKey: channelAgentDispatchAuditDedupeKey(args.kind, args.binding.dispatchId),
      at: args.at
    })
  }

  private tryAuditFailure(
    plan: ChannelAgentDispatchPlan,
    binding: ChannelAgentDispatchJournalBinding,
    code: string,
    snapshot: ChannelAgentDispatchJournalSnapshot,
    terminal?: ChannelAgentRunTerminalEvidence
  ): void {
    try {
      this.appendAudit({
        kind: 'agent.dispatch.failed',
        plan,
        binding,
        code,
        contentHash: terminal ? hashChannelAgentContent(terminal.content) : plan.triggerContentHash,
        at: terminal?.observedAt ?? journalFloor(snapshot)
      })
    } catch {
      // The durable dispatch journal remains the recovery authority.
    }
  }

  private releaseDeclined(registration: ChannelAgentRunLaunchRegistration): void {
    try {
      registration.releaseBeforeLaunch()
    } catch {
      this.tryReleaseForRecovery(registration)
    }
  }

  private tryReleaseForRecovery(registration: ChannelAgentRunLaunchRegistration): void {
    try {
      registration.releaseForRecovery()
    } catch {
      // A retained process-local entry is safer than releasing the wrong phase.
    }
  }

  private currentTime(floor = 0): number {
    const value = this.now()
    if (!isTimestamp(value) || value < floor) {
      throw coordinatorError('journal_unavailable', 'Channel agent dispatch clock is invalid')
    }
    return value
  }
}
