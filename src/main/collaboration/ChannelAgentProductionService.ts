import { createHash } from 'crypto'

import { channelAgentParticipationEnabled } from '../../shared/collaboration/ChannelAgentReviewGate'
import type { ChannelAuditInput, ChannelAuditLike } from './ChannelAuditLog'
import type {
  ChannelAgentDispatchPlan,
  ChannelAgentDispatchPlanResult
} from './ChannelAgentDispatchAuthority'
import type { ChannelAgentDispatchCoordinatorResult } from './ChannelAgentDispatchCoordinator'
import type { ChannelAgentDispatchRecoveryReport } from './ChannelAgentDispatchRecovery'
import {
  admitAcceptedChannelAgentMentions,
  type ChannelAgentMentionTarget
} from './ChannelAgentMentionAdmission'
import type { ChannelAppendResult, HumanChannelMessage } from './ChannelMessageLog'
import type { ChannelMember } from './ChannelStore'

const ADMISSION_AUDIT_DOMAIN = 'taskwraith.channel.agent-production-admission.v1\0'

type DurableHumanAppendResult = Omit<ChannelAppendResult, 'record'> & {
  readonly record: HumanChannelMessage
}

export interface ChannelAgentProductionExecution {
  start(): unknown
  dispatchPlan(plan: ChannelAgentDispatchPlan): Promise<ChannelAgentDispatchCoordinatorResult>
  dispose(): void
}

export interface ChannelAgentProductionRecovery {
  recoverChannel(channelId: string): Promise<ChannelAgentDispatchRecoveryReport>
}

export interface ChannelAgentProductionServiceOptions {
  readonly execution: ChannelAgentProductionExecution
  readonly recovery: ChannelAgentProductionRecovery
  readonly getMembers: (channelId: string) => readonly ChannelMember[]
  readonly resolveDispatchPlan: (args: {
    readonly record: Extract<ChannelAppendResult['record'], { kind: 'human.text' }>
    readonly target: ChannelAgentMentionTarget
  }) => ChannelAgentDispatchPlanResult | Promise<ChannelAgentDispatchPlanResult>
  readonly audit: ChannelAuditLike
  readonly logger?: (line: string) => void
}

export type ChannelAgentProductionServiceState =
  | 'idle'
  | 'review_blocked'
  | 'running'
  | 'stopping'
  | 'stopped'

export interface ChannelAgentProductionServiceStatus {
  readonly state: ChannelAgentProductionServiceState
  readonly pendingOperations: number
  readonly queuedChannels: number
  readonly retainedRecoveries: number
}

export interface ChannelAgentProductionHandleResult {
  readonly kind: 'ignored' | 'processed' | 'rejected' | 'review_required'
  readonly targetCount: number
  readonly dispatched: number
  readonly posted: number
  readonly declined: number
  readonly retained: number
}

export type ChannelAgentProductionServiceErrorCode =
  | 'invalid_channel'
  | 'invalid_options'
  | 'not_running'
  | 'stopped'

export class ChannelAgentProductionServiceError extends Error {
  constructor(
    readonly code: ChannelAgentProductionServiceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentProductionServiceError'
  }
}

function serviceError(
  code: ChannelAgentProductionServiceErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentProductionServiceError {
  // Authority/provider callbacks may contain prompt, output, or local paths.
  return new ChannelAgentProductionServiceError(code, message)
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function auditDedupeKey(
  kind: ChannelAuditInput['kind'],
  channelId: string,
  messageId: string,
  targetId: string,
  code: string
): string {
  return createHash('sha256')
    .update(ADMISSION_AUDIT_DOMAIN)
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(channelId, 'utf8')
    .update('\0', 'utf8')
    .update(messageId, 'utf8')
    .update('\0', 'utf8')
    .update(targetId, 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest('hex')
}

function emptyResult(
  kind: ChannelAgentProductionHandleResult['kind'],
  targetCount = 0
): ChannelAgentProductionHandleResult {
  return { kind, targetCount, dispatched: 0, posted: 0, declined: 0, retained: 0 }
}

/**
 * Serial main-only admission owner for fsynced human Channel records. The
 * immutable source gate is checked both before execution startup and by the
 * mention admission function. With the production gate false, no recovery,
 * authority-plan, composer, run-event, or provider port is touched.
 */
export class ChannelAgentProductionService {
  private stateValue: ChannelAgentProductionServiceState = 'idle'
  private readonly activeOperations = new Set<Promise<unknown>>()
  private readonly channelTails = new Map<string, Promise<void>>()
  private readonly quiescingChannels = new Set<string>()
  private retainedRecoveryCount = 0
  private executionStarted = false
  private stopPromise: Promise<void> | null = null

  constructor(private readonly options: ChannelAgentProductionServiceOptions) {
    if (
      !options ||
      typeof options.execution?.start !== 'function' ||
      typeof options.execution?.dispatchPlan !== 'function' ||
      typeof options.execution?.dispose !== 'function' ||
      typeof options.recovery?.recoverChannel !== 'function' ||
      typeof options.getMembers !== 'function' ||
      typeof options.resolveDispatchPlan !== 'function' ||
      typeof options.audit?.append !== 'function' ||
      (options.logger !== undefined && typeof options.logger !== 'function')
    ) {
      throw serviceError(
        'invalid_options',
        'Channel agent production service ports are unavailable'
      )
    }
  }

  start(channelIds: readonly string[]): ChannelAgentProductionServiceStatus {
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') {
      throw serviceError('stopped', 'Channel agent production service has stopped')
    }
    if (this.stateValue !== 'idle') return this.status()
    if (!channelAgentParticipationEnabled()) {
      this.stateValue = 'review_blocked'
      return this.status()
    }
    if (!Array.isArray(channelIds) || channelIds.some((channelId) => !isIdentifier(channelId))) {
      throw serviceError('invalid_options', 'Channel agent recovery Channel ids are invalid')
    }
    try {
      this.options.execution.start()
    } catch (error) {
      throw serviceError('not_running', 'Channel agent production execution could not start', error)
    }
    this.executionStarted = true
    this.stateValue = 'running'
    for (const channelId of new Set(channelIds)) {
      if (this.quiescingChannels.has(channelId)) continue
      const operation = this.enqueueChannel(channelId, async () => {
        try {
          const report = await this.options.recovery.recoverChannel(channelId)
          this.retainedRecoveryCount += report.retained
          for (const item of report.items) {
            if (item.disposition !== 'retained') continue
            this.tryAudit({
              kind: 'agent.dispatch.blocked',
              channelId,
              code: `recovery_${item.code}`,
              dedupeKey: auditDedupeKey(
                'agent.dispatch.blocked',
                channelId,
                item.dispatchId,
                item.runId,
                item.code
              )
            })
          }
        } catch {
          this.retainedRecoveryCount += 1
          this.options.logger?.('[channels] agent dispatch recovery unavailable')
        }
      })
      this.track(operation)
    }
    return this.status()
  }

  handleDurableAppend(result: ChannelAppendResult): Promise<ChannelAgentProductionHandleResult> {
    if (result?.deduplicated || result?.record?.kind !== 'human.text') {
      return Promise.resolve(emptyResult('ignored'))
    }
    const humanResult = result as DurableHumanAppendResult
    let members: readonly ChannelMember[]
    try {
      members = this.options.getMembers(result.record.channelId)
    } catch {
      this.options.logger?.('[channels] agent mention membership unavailable')
      return Promise.resolve(emptyResult('rejected'))
    }
    const admission = admitAcceptedChannelAgentMentions({ record: result.record, members })
    for (const ambiguity of admission.ambiguities) {
      const ambiguityId = ambiguity.candidateMemberIds.join('\0')
      if (
        !this.tryAudit({
          kind: 'agent.mention.rejected',
          channelId: result.record.channelId,
          code: 'ambiguous_agent_mention',
          contentHash: result.record.contentHash,
          detail: `candidate_count:${ambiguity.candidateMemberIds.length}`,
          dedupeKey: auditDedupeKey(
            'agent.mention.rejected',
            result.record.channelId,
            result.record.messageId,
            ambiguityId,
            'ambiguous_agent_mention'
          ),
          at: result.record.acceptedAt
        })
      ) {
        return Promise.resolve(emptyResult('rejected'))
      }
    }
    if (admission.kind === 'ignored') return Promise.resolve(emptyResult('ignored'))
    if (admission.kind === 'rejected') {
      if (admission.reason !== 'ambiguous_agent_mention') {
        this.tryAudit({
          kind: 'agent.mention.rejected',
          channelId: result.record.channelId,
          code: admission.reason,
          contentHash: result.record.contentHash,
          dedupeKey: auditDedupeKey(
            'agent.mention.rejected',
            result.record.channelId,
            result.record.messageId,
            result.record.authorMemberId,
            admission.reason
          ),
          at: result.record.acceptedAt
        })
      }
      return Promise.resolve(emptyResult('rejected'))
    }
    if (admission.kind === 'review_required') {
      for (const target of admission.targets) {
        this.tryAudit({
          kind: 'agent.dispatch.blocked',
          channelId: result.record.channelId,
          memberId: target.memberId,
          code: admission.code,
          contentHash: result.record.contentHash,
          detail: admission.reviewId,
          dedupeKey: auditDedupeKey(
            'agent.dispatch.blocked',
            result.record.channelId,
            result.record.messageId,
            target.memberId,
            admission.code
          ),
          at: result.record.acceptedAt
        })
      }
      return Promise.resolve(emptyResult('review_required', admission.targets.length))
    }
    if (this.stateValue !== 'running') {
      for (const target of admission.targets) {
        this.auditBlocked(humanResult, target, 'agent_execution_not_running')
      }
      return Promise.resolve(emptyResult('rejected', admission.targets.length))
    }
    if (this.quiescingChannels.has(result.record.channelId)) {
      for (const target of admission.targets) {
        this.auditBlocked(humanResult, target, 'agent_channel_quiescing')
      }
      return Promise.resolve(emptyResult('rejected', admission.targets.length))
    }
    const operation = this.enqueueChannel(result.record.channelId, () =>
      this.dispatchAdmitted(humanResult, admission.targets)
    )
    return this.track(operation)
  }

  /** Wait for work accepted before this call without fencing later work. */
  drainChannel(channelId: string): Promise<void> {
    if (!isIdentifier(channelId)) {
      throw serviceError('invalid_channel', 'Channel agent production Channel id is invalid')
    }
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') {
      throw serviceError('stopped', 'Channel agent production service has stopped')
    }
    if (this.stateValue !== 'running') return Promise.resolve()
    return this.track(this.enqueueChannel(channelId, async () => undefined))
  }

  /** Fence new work immediately, then wait for already accepted work. */
  quiesceChannel(channelId: string): Promise<void> {
    if (!isIdentifier(channelId)) {
      throw serviceError('invalid_channel', 'Channel agent production Channel id is invalid')
    }
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') {
      throw serviceError('stopped', 'Channel agent production service has stopped')
    }
    this.quiescingChannels.add(channelId)
    return this.drainChannel(channelId)
  }

  status(): ChannelAgentProductionServiceStatus {
    return {
      state: this.stateValue,
      pendingOperations: this.activeOperations.size,
      queuedChannels: this.channelTails.size,
      retainedRecoveries: this.retainedRecoveryCount
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stateValue = 'stopping'
    this.stopPromise = Promise.allSettled([...this.activeOperations]).then(() => {
      if (this.executionStarted) {
        try {
          this.options.execution.dispose()
        } catch (error) {
          throw serviceError(
            'not_running',
            'Channel agent production execution could not stop',
            error
          )
        }
      }
      this.executionStarted = false
      this.stateValue = 'stopped'
    })
    return this.stopPromise
  }

  private async dispatchAdmitted(
    result: DurableHumanAppendResult,
    targets: readonly ChannelAgentMentionTarget[]
  ): Promise<ChannelAgentProductionHandleResult> {
    let dispatched = 0
    let posted = 0
    let declined = 0
    let retained = 0
    for (const target of targets) {
      let planResult: ChannelAgentDispatchPlanResult
      try {
        planResult = await this.options.resolveDispatchPlan({ record: result.record, target })
      } catch {
        this.auditBlocked(result, target, 'dispatch_plan_unavailable')
        declined += 1
        continue
      }
      if (planResult.kind === 'denied') {
        this.auditBlocked(result, target, planResult.reason)
        declined += 1
        continue
      }
      dispatched += 1
      let outcome: ChannelAgentDispatchCoordinatorResult
      try {
        outcome = await this.options.execution.dispatchPlan(planResult.plan)
      } catch {
        this.auditBlocked(result, target, 'dispatch_unavailable')
        retained += 1
        continue
      }
      if (outcome.kind === 'posted') posted += 1
      else if (outcome.kind === 'declined') declined += 1
      else retained += 1
    }
    return {
      kind: 'processed',
      targetCount: targets.length,
      dispatched,
      posted,
      declined,
      retained
    }
  }

  private auditBlocked(
    result: DurableHumanAppendResult,
    target: ChannelAgentMentionTarget,
    code: string
  ): boolean {
    return this.tryAudit({
      kind: 'agent.dispatch.blocked',
      channelId: result.record.channelId,
      memberId: target.memberId,
      code,
      contentHash: result.record.contentHash,
      dedupeKey: auditDedupeKey(
        'agent.dispatch.blocked',
        result.record.channelId,
        result.record.messageId,
        target.memberId,
        code
      ),
      at: result.record.acceptedAt
    })
  }

  private tryAudit(event: ChannelAuditInput): boolean {
    try {
      this.options.audit.append(event)
      return true
    } catch {
      this.options.logger?.('[channels] agent production audit unavailable')
      return false
    }
  }

  private enqueueChannel<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channelTails.get(channelId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.channelTails.set(channelId, tail)
    void tail.then(() => {
      if (this.channelTails.get(channelId) === tail) this.channelTails.delete(channelId)
    })
    return result
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation)
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => undefined)
    return operation
  }
}
