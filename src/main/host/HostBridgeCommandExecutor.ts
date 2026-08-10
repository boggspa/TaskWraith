/**
 * Host → Bridge governed-mutation adapter (Wave 2E-1 Lane H; 2E-2A Lane B pin).
 *
 * Transport-neutral: validates HostCommand arguments + governed-mutation
 * routing, resolves host-owned context the wire omits, then dispatches to a
 * narrow injected BridgeActionExecutor port. Returns migration-authority-
 * compatible terminal semantics ({status, resultSummary?, errorCode?,
 * errorMessage?}) without fabricating domain deltas/effects or exposing
 * unrestricted Bridge data.
 *
 * Bridge actionId is deterministically joined to the Host command as
 * `host:command:<commandId>` (validated UUID, bounded, no random suffix,
 * no raw args/actor data in the id).
 *
 * Non-goals (fail closed / never implemented here):
 * - Authority / receipt / delta / session wiring
 * - Composition-root or control-server registration
 * - Inferring workspace/provider/run/roster from transcript prose or client
 *   assertions
 * - Permission-ceiling widening (Host approval set stays five decisions)
 * - Provider launch
 * - Reserved Authority-RPC read aliases entering Bridge
 */

import type {
  BridgeApprovalReplyAction,
  BridgeCancelRunAction,
  BridgeComposerPromptAction,
  BridgeEnsembleCancelRoundAction,
  BridgeEnsembleRosterUpdateAction,
  BridgeEnsembleSteerAction,
  BridgeQuestionRejectAction,
  BridgeQuestionReplyAction,
  BridgeRosterParticipant,
  BridgeSetWatchedThreadAction
} from '../BridgeActionPayload'
import type { BridgeActionExecutionResult, BridgeActionExecutor } from '../BridgeActionExecutor'
import type { HostActorIdentity, HostCommand, HostDecodeResult } from '../../shared/hostProtocol'
import type { TaskWraithControlThreadOffers } from '../../shared/taskWraithControlProtocol'
import {
  HOST_APPROVAL_DECIDE_DECISIONS,
  HOST_PROTOCOL_MAX_ID,
  type HostApprovalDecideDecision
} from '../../shared/hostProtocol'
import { validateHostCommandArguments } from './HostCommandArguments'
import {
  isHostUuid,
  isSafeHostIdentifier,
  resolveHostApprovalId,
  resolveHostQuestionId
} from './HostCommandIdentity'
import { parseGovernedMutationCommandName } from './HostCommandRouting'

/** Matches the migration authority executor result shape — kept local (no Authority import). */
export type HostBridgeCommandExecutorResult = {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly resultSummary?: string
  readonly errorCode?: string
  readonly errorMessage?: string
}

/** Narrow Bridge port — only the mutation methods this adapter may call. */
export type HostBridgeActionPort = Pick<
  BridgeActionExecutor,
  | 'executeComposerPrompt'
  | 'executeEnsembleSteer'
  | 'executeCancelRun'
  | 'executeEnsembleCancelRound'
  | 'executeApprovalReply'
  | 'executeQuestionReply'
  | 'executeQuestionReject'
  | 'executeEnsembleRosterUpdate'
  | 'executeSetWatchedThread'
>

export type HostBridgeComposerSendContext =
  | {
      readonly mode: 'solo'
      readonly workspaceId: string
      readonly provider: string
      readonly approvalMode?: string
      readonly workflowMode?: 'normal' | 'plan'
      /** Final Host-resolved values. Never copied directly from command args. */
      readonly model?: string
      readonly reasoningEffort?: string
    }
  | {
      readonly mode: 'ensemble'
      readonly workspaceId: string
      readonly roundId?: string
    }

export type HostBridgeRunCancelContext =
  | {
      readonly mode: 'solo'
      readonly workspaceId: string
      readonly provider: string
      readonly runId: string
    }
  | {
      readonly mode: 'ensemble'
      readonly workspaceId: string
      readonly roundId: string
    }
  | {
      readonly mode: 'none'
      readonly message?: string
    }

export type HostBridgeApprovalContext = {
  readonly workspaceId: string
  readonly threadId: string
  /** Bytes equal to Host approvalId (legacy Bridge toolCallId). */
  readonly toolCallId: string
}

export type HostBridgeQuestionContext = {
  readonly workspaceId: string
  readonly threadId: string
  /** Bytes equal to Host questionId (legacy Bridge promptId). */
  readonly promptId: string
  readonly runId?: string
}

export type HostBridgeEnsembleSeatContext = {
  readonly workspaceId: string
  /** Full canonical roster in speaking order with the toggled seat applied. */
  readonly participants: readonly BridgeRosterParticipant[]
}

export type HostBridgeThreadSelectContext = {
  readonly appChatId: string | null
}

/**
 * Host-owned resolvers for fields Host commands omit on the wire.
 * Implementations must read Host authority (store/ports), never transcript
 * prose, Bridge result bodies, or client assertions.
 */
export interface HostBridgeContextResolvers {
  resolveThreadOffers(
    threadId: string
  ):
    | HostDecodeResult<TaskWraithControlThreadOffers>
    | Promise<HostDecodeResult<TaskWraithControlThreadOffers>>
  resolveComposerSend(
    threadId: string,
    selection?: { readonly model?: string; readonly reasoningEffort?: string }
  ):
    | HostDecodeResult<HostBridgeComposerSendContext>
    | Promise<HostDecodeResult<HostBridgeComposerSendContext>>
  resolveRunCancel(
    threadId: string
  ):
    | HostDecodeResult<HostBridgeRunCancelContext>
    | Promise<HostDecodeResult<HostBridgeRunCancelContext>>
  resolveApprovalDecide(
    approvalId: string
  ):
    | HostDecodeResult<HostBridgeApprovalContext>
    | Promise<HostDecodeResult<HostBridgeApprovalContext>>
  resolveQuestionAnswer(
    questionId: string
  ):
    | HostDecodeResult<HostBridgeQuestionContext>
    | Promise<HostDecodeResult<HostBridgeQuestionContext>>
  resolveEnsembleSeatToggle(
    threadId: string,
    participantId: string,
    enabled: boolean
  ):
    | HostDecodeResult<HostBridgeEnsembleSeatContext>
    | Promise<HostDecodeResult<HostBridgeEnsembleSeatContext>>
  resolveThreadSelect(
    threadId: string
  ):
    | HostDecodeResult<HostBridgeThreadSelectContext>
    | Promise<HostDecodeResult<HostBridgeThreadSelectContext>>
}

export interface HostBridgeCommandExecutorOptions {
  readonly bridge: HostBridgeActionPort
  readonly resolvers: HostBridgeContextResolvers
  /** Optional clock for Bridge action issuedAt (ms). */
  readonly nowMs?: () => number
}

const RESULT_SUMMARY_MAX = 200
const BRIDGE_ACTION_TTL_MS = 120_000

const HOST_APPROVAL_DECISION_SET = new Set<string>(HOST_APPROVAL_DECIDE_DECISIONS)

/** Validated Host↔Bridge join metadata — computed once per execute() before any resolve/Bridge. */
type HostBridgeActionMeta = {
  readonly actionId: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function failResult(errorCode: string, errorMessage: string): HostBridgeCommandExecutorResult {
  return { status: 'failed', errorCode, errorMessage }
}

function boundText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= RESULT_SUMMARY_MAX ? trimmed : trimmed.slice(0, RESULT_SUMMARY_MAX)
}

/**
 * Map Bridge execution outcomes to Host terminal semantics.
 * executed:false is never succeeded; approvalAlreadyResolved is never success.
 */
export function mapBridgeExecutionResult(
  result: BridgeActionExecutionResult | null | undefined
): HostBridgeCommandExecutorResult {
  if (!result || typeof result !== 'object' || typeof result.executed !== 'boolean') {
    return failResult('bridge_invalid_result', 'unrecognized bridge result')
  }

  const summary = boundText(result.message)

  if (result.reasonCode === 'approvalAlreadyResolved') {
    return {
      status: 'failed',
      errorCode: 'approval_already_resolved',
      ...(summary ? { errorMessage: summary } : {})
    }
  }

  if (result.reasonCode === 'userDeclined') {
    return {
      status: 'cancelled',
      errorCode: 'user_declined',
      ...(summary ? { errorMessage: summary } : {})
    }
  }

  if (!result.executed) {
    const errorCode =
      result.reasonCode === 'approvalDispatchFailed'
        ? 'approval_dispatch_failed'
        : 'bridge_not_executed'
    return {
      status: 'failed',
      errorCode,
      ...(summary ? { errorMessage: summary } : {})
    }
  }

  return {
    status: 'succeeded',
    ...(summary ? { resultSummary: summary } : {})
  }
}

function isHostApprovalDecision(value: unknown): value is HostApprovalDecideDecision {
  return typeof value === 'string' && HOST_APPROVAL_DECISION_SET.has(value)
}

/**
 * Governed Host mutation → Bridge adapter.
 * Call execute() with a HostCommand; reserved read aliases and unknowns fail
 * closed without any Bridge dispatch.
 */
export class HostBridgeCommandExecutor {
  private readonly bridge: HostBridgeActionPort
  private readonly resolvers: HostBridgeContextResolvers
  private readonly nowMs: () => number

  constructor(options: HostBridgeCommandExecutorOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostBridgeCommandExecutor requires options')
    }
    const bridge = options.bridge
    if (
      !bridge ||
      typeof bridge.executeComposerPrompt !== 'function' ||
      typeof bridge.executeEnsembleSteer !== 'function' ||
      typeof bridge.executeCancelRun !== 'function' ||
      typeof bridge.executeEnsembleCancelRound !== 'function' ||
      typeof bridge.executeApprovalReply !== 'function' ||
      typeof bridge.executeQuestionReply !== 'function' ||
      typeof bridge.executeQuestionReject !== 'function' ||
      typeof bridge.executeEnsembleRosterUpdate !== 'function' ||
      typeof bridge.executeSetWatchedThread !== 'function'
    ) {
      throw new Error('HostBridgeCommandExecutor requires a complete HostBridgeActionPort')
    }
    const resolvers = options.resolvers
    if (
      !resolvers ||
      typeof resolvers.resolveThreadOffers !== 'function' ||
      typeof resolvers.resolveComposerSend !== 'function' ||
      typeof resolvers.resolveRunCancel !== 'function' ||
      typeof resolvers.resolveApprovalDecide !== 'function' ||
      typeof resolvers.resolveQuestionAnswer !== 'function' ||
      typeof resolvers.resolveEnsembleSeatToggle !== 'function' ||
      typeof resolvers.resolveThreadSelect !== 'function'
    ) {
      throw new Error('HostBridgeCommandExecutor requires complete HostBridgeContextResolvers')
    }
    this.bridge = bridge
    this.resolvers = resolvers
    this.nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now()
  }

  /**
   * Execute one governed Host mutation through Bridge.
   * Compatible with the migration authority executor shape (command, _context).
   */
  async execute(
    command: HostCommand,
    _context?: { actor?: HostActorIdentity }
  ): Promise<HostBridgeCommandExecutorResult> {
    const governed = parseGovernedMutationCommandName(command?.name)
    if (!governed) {
      return failResult(
        'not_governed_mutation',
        'reserved read aliases and unknown commands cannot enter Bridge'
      )
    }

    const validated = validateHostCommandArguments(command)
    if (!validated.ok) {
      return failResult('invalid_command_arguments', validated.error)
    }

    const hostCommand = validated.value

    // Validate actionMeta exactly once before the switch and before every
    // resolver/Bridge call so invalid commandId never touches Host context
    // resolvers or Bridge.
    const metaResolved = this.actionMeta(hostCommand.commandId)
    if (!metaResolved.ok) {
      return failResult('invalid_command_id', metaResolved.error)
    }
    const meta = metaResolved.value

    try {
      switch (hostCommand.name) {
        case 'composer.send':
          return await this.executeComposerSend(hostCommand, meta)
        case 'run.cancel':
          return await this.executeRunCancel(hostCommand, meta)
        case 'approval.decide':
          return await this.executeApprovalDecide(hostCommand, meta)
        case 'question.answer':
          return await this.executeQuestionAnswer(hostCommand, meta)
        case 'ensemble.seat.toggle':
          return await this.executeEnsembleSeatToggle(hostCommand, meta)
        case 'thread.select':
          return await this.executeThreadSelect(hostCommand, meta)
        default:
          return failResult('not_governed_mutation', 'command is not a governed mutation')
      }
    } catch (error) {
      const message = error instanceof Error ? boundText(error.message) : 'bridge adapter threw'
      return failResult('bridge_adapter_threw', message || 'bridge adapter threw')
    }
  }

  /**
   * Deterministic Host↔Bridge join key: `host:command:<commandId>`.
   * Fail-closed when commandId is missing, unsafe, non-UUID, or the bound
   * actionId exceeds the protocol identifier ceiling. Never embeds random
   * suffixes, raw args, or actor material.
   */
  private actionMeta(commandId: string): HostDecodeResult<HostBridgeActionMeta> {
    if (!isSafeHostIdentifier(commandId) || !isHostUuid(commandId)) {
      return {
        ok: false,
        error: 'commandId is missing, unsafe, or not a UUID'
      }
    }
    const actionId = `host:command:${commandId}`
    if (actionId.length > HOST_PROTOCOL_MAX_ID || !isSafeHostIdentifier(actionId)) {
      return { ok: false, error: 'actionId exceeds protocol bound or is unsafe' }
    }
    const issuedAt = this.nowMs()
    return {
      ok: true,
      value: {
        actionId,
        issuedAt,
        expiresAt: issuedAt + BRIDGE_ACTION_TTL_MS
      }
    }
  }

  private async executeComposerSend(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const threadId = command.target.threadId
    if (!threadId)
      return failResult('invalid_command_arguments', 'composer.send target.threadId required')

    const selection = {
      ...(typeof command.arguments.model === 'string' ? { model: command.arguments.model } : {}),
      ...(typeof command.arguments.reasoningEffort === 'string'
        ? { reasoningEffort: command.arguments.reasoningEffort }
        : {})
    }
    const resolved = await this.resolvers.resolveComposerSend(threadId, selection)
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    const text = String(command.arguments.text ?? '')
    const ctx = resolved.value

    if (ctx.mode === 'ensemble') {
      const action: BridgeEnsembleSteerAction = {
        kind: 'ensembleSteer',
        ...meta,
        workspaceId: ctx.workspaceId,
        threadId,
        text,
        message: 'Sent via Host protocol',
        ...(ctx.roundId ? { roundId: ctx.roundId } : {})
      }
      return mapBridgeExecutionResult(await this.bridge.executeEnsembleSteer(action))
    }

    const action: BridgeComposerPromptAction = {
      kind: 'composerPrompt',
      ...meta,
      workspaceId: ctx.workspaceId,
      threadId,
      text,
      provider: ctx.provider,
      ...(ctx.approvalMode ? { approvalMode: ctx.approvalMode } : {}),
      ...(ctx.workflowMode ? { workflowMode: ctx.workflowMode } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {})
    }
    return mapBridgeExecutionResult(await this.bridge.executeComposerPrompt(action))
  }

  private async executeRunCancel(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const threadId = command.target.threadId
    if (!threadId)
      return failResult('invalid_command_arguments', 'run.cancel target.threadId required')

    const resolved = await this.resolvers.resolveRunCancel(threadId)
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    const ctx = resolved.value
    if (ctx.mode === 'none') {
      return {
        status: 'failed',
        errorCode: 'no_active_run',
        errorMessage: boundText(ctx.message) || 'No active run to cancel.'
      }
    }

    if (ctx.mode === 'ensemble') {
      const action: BridgeEnsembleCancelRoundAction = {
        kind: 'ensembleCancelRound',
        ...meta,
        workspaceId: ctx.workspaceId,
        threadId,
        roundId: ctx.roundId,
        message: 'Cancelled via Host protocol'
      }
      return mapBridgeExecutionResult(await this.bridge.executeEnsembleCancelRound(action))
    }

    const action: BridgeCancelRunAction = {
      kind: 'cancelRun',
      ...meta,
      workspaceId: ctx.workspaceId,
      threadId,
      provider: ctx.provider,
      runId: ctx.runId,
      message: 'Cancelled via Host protocol'
    }
    return mapBridgeExecutionResult(await this.bridge.executeCancelRun(action))
  }

  private async executeApprovalDecide(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const approvalResolved = resolveHostApprovalId({
      approvalId: command.target.approvalId
    })
    if (!approvalResolved.ok) {
      return failResult('invalid_command_arguments', approvalResolved.error)
    }

    const decision = command.arguments.decision
    if (!isHostApprovalDecision(decision)) {
      return failResult('invalid_command_arguments', 'approval.decide decision is invalid')
    }

    const resolved = await this.resolvers.resolveApprovalDecide(approvalResolved.value)
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    // Alias honesty: resolver toolCallId must equal Host approvalId bytes.
    const aliasCheck = resolveHostApprovalId({
      approvalId: approvalResolved.value,
      toolCallId: resolved.value.toolCallId
    })
    if (!aliasCheck.ok) {
      return failResult('approval_alias_conflict', aliasCheck.error)
    }

    const action: BridgeApprovalReplyAction = {
      kind: 'approvalReply',
      ...meta,
      workspaceId: resolved.value.workspaceId,
      threadId: resolved.value.threadId,
      toolCallId: aliasCheck.value,
      decision,
      ...(typeof command.arguments.message === 'string'
        ? { message: command.arguments.message }
        : {})
    }
    return mapBridgeExecutionResult(await this.bridge.executeApprovalReply(action))
  }

  private async executeQuestionAnswer(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const questionResolved = resolveHostQuestionId({
      questionId: command.target.questionId
    })
    if (!questionResolved.ok) {
      return failResult('invalid_command_arguments', questionResolved.error)
    }

    const resolved = await this.resolvers.resolveQuestionAnswer(questionResolved.value)
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    const aliasCheck = resolveHostQuestionId({
      questionId: questionResolved.value,
      promptId: resolved.value.promptId
    })
    if (!aliasCheck.ok) {
      return failResult('question_alias_conflict', aliasCheck.error)
    }

    const decision = command.arguments.decision

    if (decision === 'dismiss') {
      const action: BridgeQuestionRejectAction = {
        kind: 'questionReject',
        ...meta,
        workspaceId: resolved.value.workspaceId,
        threadId: resolved.value.threadId,
        promptId: aliasCheck.value,
        receiptId: command.commandId,
        ...(resolved.value.runId ? { runId: resolved.value.runId } : {}),
        ...(typeof command.arguments.message === 'string'
          ? { message: command.arguments.message }
          : {})
      }
      return mapBridgeExecutionResult(await this.bridge.executeQuestionReject(action))
    }

    if (decision !== 'answer' || typeof command.arguments.answer !== 'string') {
      return failResult('invalid_command_arguments', 'question.answer answer is required')
    }

    const action: BridgeQuestionReplyAction = {
      kind: 'questionReply',
      ...meta,
      workspaceId: resolved.value.workspaceId,
      threadId: resolved.value.threadId,
      promptId: aliasCheck.value,
      receiptId: command.commandId,
      answer: command.arguments.answer,
      ...(resolved.value.runId ? { runId: resolved.value.runId } : {}),
      ...(typeof command.arguments.isCustom === 'boolean'
        ? { isCustom: command.arguments.isCustom }
        : {})
    }
    return mapBridgeExecutionResult(await this.bridge.executeQuestionReply(action))
  }

  private async executeEnsembleSeatToggle(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const threadId = command.target.threadId
    const participantId = command.arguments.participantId
    const enabled = command.arguments.enabled
    if (!threadId || typeof participantId !== 'string' || typeof enabled !== 'boolean') {
      return failResult('invalid_command_arguments', 'ensemble.seat.toggle arguments invalid')
    }

    const resolved = await this.resolvers.resolveEnsembleSeatToggle(
      threadId,
      participantId,
      enabled
    )
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    const action: BridgeEnsembleRosterUpdateAction = {
      kind: 'ensembleRosterUpdate',
      ...meta,
      workspaceId: resolved.value.workspaceId,
      threadId,
      participants: [...resolved.value.participants]
    }
    return mapBridgeExecutionResult(await this.bridge.executeEnsembleRosterUpdate(action))
  }

  private async executeThreadSelect(
    command: HostCommand,
    meta: HostBridgeActionMeta
  ): Promise<HostBridgeCommandExecutorResult> {
    const threadId = command.target.threadId
    if (!threadId) {
      return failResult('invalid_command_arguments', 'thread.select target.threadId required')
    }

    const resolved = await this.resolvers.resolveThreadSelect(threadId)
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }

    const action: BridgeSetWatchedThreadAction = {
      kind: 'setWatchedThread',
      ...meta,
      appChatId: resolved.value.appChatId
    }
    return mapBridgeExecutionResult(await this.bridge.executeSetWatchedThread(action))
  }
}
