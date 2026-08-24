/**
 * Mutation completion coordinator (Wave 2E-2B).
 *
 * Consumes a HostObservedMutationResult and injected publish / receipt /
 * sole-journal ports. Never executes H, captures snapshots, diffs projections,
 * resolves/registers envelopes, or imports Authority / AppStore / Bridge / E /
 * resolver / bootstrap / composition roots.
 *
 * Invariants:
 * - Exact provider outcome is preserved independently of effect count.
 * - Publish real effects before terminal receipt completion.
 * - Terminal / indeterminate positions come only from the sole journal
 *   (published.position or getPosition) — never invented.
 * - Optional envelope consumption runs only after a durable terminal complete
 *   (including idempotent same-terminal replay). Never after indeterminate /
 *   host_unavailable, and never quarantine.
 * - Receipt / publish / position failures are body-free anomalies or honest
 *   host_unavailable (leave pending); no retry.
 */

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostResultRef } from '../shared/hostProtocol'
import {
  HOST_COMMAND_RECEIPT_INDETERMINATE_CODES,
  type HostCommandReceiptCompleteInput,
  type HostCommandReceiptIndeterminateCode,
  type HostCommandReceiptMarkIndeterminateInput,
  type HostCommandReceiptMarkIndeterminateResult,
  type HostCommandReceiptRecord,
  type HostCommandReceiptTerminalStatus
} from './HostCommandReceiptStore'
import type { HostDomainDeltaPublishResult, HostDomainEffectDto } from './HostDomainDeltaPublisher'
import type { HostObservedMutationResult } from './HostObservedMutationExecutor'

/** Publish domain effects through the sole journal (typically HostDomainDeltaPublisher). */
export type HostMutationCompletionPublishEffects = (
  effects: readonly HostDomainEffectDto[]
) => HostDomainDeltaPublishResult

/** Read sole-journal generation/cursor — never fabricate. */
export type HostMutationCompletionGetPosition = () => HostCursorPosition

/** Terminalize a durable receipt; null means refused / not found. */
export type HostMutationCompletionCompleteReceipt = (
  input: HostCommandReceiptCompleteInput
) => HostCommandReceiptRecord | null

/** Promote pending → recoverable indeterminate with a closed error code. */
export type HostMutationCompletionMarkIndeterminate = (
  input: HostCommandReceiptMarkIndeterminateInput
) => HostCommandReceiptMarkIndeterminateResult

/**
 * Optional envelope consume after durable terminal complete.
 * Caller closes over deferredId/actor. Body-free outcomes only.
 */
export type HostMutationCompletionMarkEnvelopeConsumed = () =>
  | { readonly kind: 'updated' }
  | { readonly kind: 'existing' }
  | { readonly kind: 'anomaly' }

export interface HostMutationCompletionCoordinatorOptions {
  readonly publishEffects: HostMutationCompletionPublishEffects
  readonly getPosition: HostMutationCompletionGetPosition
  readonly completeReceipt: HostMutationCompletionCompleteReceipt
  readonly markIndeterminate: HostMutationCompletionMarkIndeterminate
  readonly markEnvelopeConsumed?: HostMutationCompletionMarkEnvelopeConsumed
}

export type HostMutationCompletionInput = {
  readonly commandId: string
  readonly mutation: HostObservedMutationResult
}

export type HostMutationCompletionAnomalyReason =
  | 'invalid_command_id'
  | 'complete_refused'
  | 'complete_threw'
  | 'mark_indeterminate_refused'
  | 'mark_indeterminate_threw'
  | 'publish_threw'

/**
 * Closed body-free coordinator outcomes. Never carries command args, tool
 * output, snapshot bodies, actor/target, or unrestricted error prose.
 */
export type HostMutationCompletionResult =
  | {
      readonly kind: 'completed'
      readonly status: HostCommandReceiptTerminalStatus
      readonly position: HostCursorPosition
      readonly envelope?: 'updated' | 'existing' | 'anomaly'
    }
  | {
      readonly kind: 'indeterminate'
      readonly errorCode: HostCommandReceiptIndeterminateCode
      readonly position: HostCursorPosition
    }
  | {
      readonly kind: 'host_unavailable'
    }
  | {
      readonly kind: 'anomaly'
      readonly reason: HostMutationCompletionAnomalyReason
    }

function isNonEmptyCommandId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function toReceiptPosition(position: HostCursorPosition): {
  generation: number
  cursor: number
} {
  return { generation: position.generation, cursor: position.cursor }
}

function clonePosition(position: HostCursorPosition): HostCursorPosition {
  return { generation: position.generation, cursor: position.cursor }
}

function isValidPosition(position: unknown): position is HostCursorPosition {
  if (!position || typeof position !== 'object') return false
  const p = position as HostCursorPosition
  return (
    typeof p.generation === 'number' &&
    typeof p.cursor === 'number' &&
    Number.isFinite(p.generation) &&
    Number.isFinite(p.cursor) &&
    Number.isInteger(p.generation) &&
    Number.isInteger(p.cursor) &&
    p.generation >= 0 &&
    p.cursor >= 0
  )
}

/**
 * Isolated completion coordinator: observe result in → publish / receipt /
 * optional envelope out. Never retries ports.
 */
export class HostMutationCompletionCoordinator {
  private readonly publishEffects: HostMutationCompletionPublishEffects
  private readonly getPosition: HostMutationCompletionGetPosition
  private readonly completeReceipt: HostMutationCompletionCompleteReceipt
  private readonly markIndeterminate: HostMutationCompletionMarkIndeterminate
  private readonly markEnvelopeConsumed: HostMutationCompletionMarkEnvelopeConsumed | undefined

  constructor(options: HostMutationCompletionCoordinatorOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostMutationCompletionCoordinator requires options')
    }
    if (typeof options.publishEffects !== 'function') {
      throw new Error('HostMutationCompletionCoordinator requires publishEffects')
    }
    if (typeof options.getPosition !== 'function') {
      throw new Error('HostMutationCompletionCoordinator requires getPosition')
    }
    if (typeof options.completeReceipt !== 'function') {
      throw new Error('HostMutationCompletionCoordinator requires completeReceipt')
    }
    if (typeof options.markIndeterminate !== 'function') {
      throw new Error('HostMutationCompletionCoordinator requires markIndeterminate')
    }
    if (
      options.markEnvelopeConsumed !== undefined &&
      typeof options.markEnvelopeConsumed !== 'function'
    ) {
      throw new Error('HostMutationCompletionCoordinator markEnvelopeConsumed must be a function')
    }
    this.publishEffects = options.publishEffects
    this.getPosition = options.getPosition
    this.completeReceipt = options.completeReceipt
    this.markIndeterminate = options.markIndeterminate
    this.markEnvelopeConsumed = options.markEnvelopeConsumed
  }

  /**
   * Apply one observed-mutation result to publish + receipt (+ optional
   * envelope) ports. Does not mutate the input mutation object.
   */
  complete(input: HostMutationCompletionInput): HostMutationCompletionResult {
    if (!input || typeof input !== 'object') {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }
    if (!isNonEmptyCommandId(input.commandId)) {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }
    const commandId = input.commandId
    const mutation = input.mutation
    if (!mutation || typeof mutation !== 'object' || typeof mutation.kind !== 'string') {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }

    switch (mutation.kind) {
      case 'pre_execution_failed':
        return this.completePreExecutionFailed(commandId)
      case 'observed':
        return this.completeObserved(commandId, mutation.execution, mutation.effects)
      case 'observation_failed':
        return this.promoteIndeterminate(commandId, 'deferred_receipt_uncertain')
      case 'execution_may_have_begun':
        return this.promoteIndeterminate(commandId, 'deferred_execution_may_have_begun')
      default: {
        // Exhaustiveness: unknown kind is treated as invalid input, body-free.
        const _exhaustive: never = mutation
        void _exhaustive
        return { kind: 'anomaly', reason: 'invalid_command_id' }
      }
    }
  }

  private completePreExecutionFailed(commandId: string): HostMutationCompletionResult {
    const position = this.readPosition()
    if (!position) return { kind: 'host_unavailable' }
    // H never invoked — terminal failed at current sole-journal position.
    // No envelope consumption (nothing executed / no deferred resolve).
    return this.finalizeTerminal(
      commandId,
      'failed',
      position,
      {
        errorCode: 'pre_execution_failed'
      },
      { consumeEnvelope: false }
    )
  }

  private completeObserved(
    commandId: string,
    execution: HostCommandExecutionResult,
    effects: readonly HostDomainEffectDto[]
  ): HostMutationCompletionResult {
    // Defensive guard: malformed internal input → closed anomaly, zero port calls.
    if (!execution || typeof execution !== 'object' || typeof execution.status !== 'string') {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }
    if (!Array.isArray(effects)) {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }
    const status = execution.status
    if (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }

    if (effects.length === 0) {
      const position = this.readPosition()
      if (!position) return { kind: 'host_unavailable' }
      return this.finalizeTerminal(commandId, status, position, executionFields(execution), {
        consumeEnvelope: true
      })
    }

    // Nonempty effects: publish once, then terminalize exact provider status
    // (including failed/cancelled + real effects).
    let publishResult: HostDomainDeltaPublishResult
    try {
      publishResult = this.publishEffects(effects)
    } catch {
      const position = this.readPosition()
      if (!position) return { kind: 'host_unavailable' }
      // Publisher threw after possible partial journal advance is unknown;
      // mark partial at current readable position. No retry.
      return this.promoteIndeterminateAt(commandId, position, 'deferred_effects_partial')
    }

    switch (publishResult.kind) {
      case 'published': {
        if (!isValidPosition(publishResult.position)) {
          return { kind: 'anomaly', reason: 'publish_threw' }
        }
        return this.finalizeTerminal(
          commandId,
          status,
          clonePosition(publishResult.position),
          executionFields(execution),
          { consumeEnvelope: true }
        )
      }
      case 'rejected': {
        if (!isValidPosition(publishResult.position)) {
          return { kind: 'anomaly', reason: 'publish_threw' }
        }
        return this.promoteIndeterminateAt(
          commandId,
          clonePosition(publishResult.position),
          'deferred_effects_unavailable'
        )
      }
      case 'partial': {
        if (!isValidPosition(publishResult.position)) {
          return { kind: 'anomaly', reason: 'publish_threw' }
        }
        return this.promoteIndeterminateAt(
          commandId,
          clonePosition(publishResult.position),
          'deferred_effects_partial'
        )
      }
      case 'store_error': {
        if (publishResult.position === null) {
          // Unknown journal advance — leave pending for reopen promotion.
          return { kind: 'host_unavailable' }
        }
        if (!isValidPosition(publishResult.position)) {
          return { kind: 'anomaly', reason: 'publish_threw' }
        }
        return this.promoteIndeterminateAt(
          commandId,
          clonePosition(publishResult.position),
          'deferred_effects_partial'
        )
      }
      default: {
        const _exhaustive: never = publishResult
        void _exhaustive
        return { kind: 'anomaly', reason: 'publish_threw' }
      }
    }
  }

  private finalizeTerminal(
    commandId: string,
    status: HostCommandReceiptTerminalStatus,
    position: HostCursorPosition,
    fields: {
      errorCode?: string
      errorMessage?: string
      resultSummary?: string
      resultRef?: HostResultRef
    },
    options: { consumeEnvelope: boolean }
  ): HostMutationCompletionResult {
    let record: HostCommandReceiptRecord | null
    try {
      const completeInput: HostCommandReceiptCompleteInput = {
        commandId,
        status,
        position: toReceiptPosition(position),
        ...(fields.errorCode !== undefined ? { errorCode: fields.errorCode } : {}),
        ...(fields.errorMessage !== undefined ? { errorMessage: fields.errorMessage } : {}),
        ...(fields.resultSummary !== undefined ? { resultSummary: fields.resultSummary } : {}),
        ...(fields.resultRef !== undefined ? { resultRef: fields.resultRef } : {})
      }
      record = this.completeReceipt(completeInput)
    } catch {
      return { kind: 'anomaly', reason: 'complete_threw' }
    }
    if (!record) {
      return { kind: 'anomaly', reason: 'complete_refused' }
    }

    // Validate returned durable record: commandId, status, and position must be
    // honest. On idempotent same-terminal replay the store returns the original
    // durable record whose generation/cursor may differ from the candidate.
    if (
      record.commandId !== commandId ||
      record.status !== status ||
      !isValidPosition({ generation: record.generation, cursor: record.cursor })
    ) {
      return { kind: 'anomaly', reason: 'complete_refused' }
    }

    const durablePosition: HostCursorPosition = {
      generation: record.generation as number,
      cursor: record.cursor as number
    }
    const durableStatus: HostCommandReceiptTerminalStatus =
      record.status as HostCommandReceiptTerminalStatus

    // Envelope only after durable terminal complete (incl. idempotent replay).
    if (!options.consumeEnvelope || !this.markEnvelopeConsumed) {
      return {
        kind: 'completed',
        status: durableStatus,
        position: clonePosition(durablePosition)
      }
    }

    let envelope: 'updated' | 'existing' | 'anomaly'
    try {
      const consumed = this.markEnvelopeConsumed()
      if (consumed && (consumed.kind === 'updated' || consumed.kind === 'existing')) {
        envelope = consumed.kind
      } else {
        envelope = 'anomaly'
      }
    } catch {
      envelope = 'anomaly'
    }
    // Envelope anomaly must not rewrite the receipt outcome.
    return {
      kind: 'completed',
      status: durableStatus,
      position: clonePosition(durablePosition),
      envelope
    }
  }

  private promoteIndeterminate(
    commandId: string,
    errorCode: HostCommandReceiptIndeterminateCode
  ): HostMutationCompletionResult {
    const position = this.readPosition()
    if (!position) return { kind: 'host_unavailable' }
    return this.promoteIndeterminateAt(commandId, position, errorCode)
  }

  private promoteIndeterminateAt(
    commandId: string,
    position: HostCursorPosition,
    errorCode: HostCommandReceiptIndeterminateCode
  ): HostMutationCompletionResult {
    let result: HostCommandReceiptMarkIndeterminateResult
    try {
      result = this.markIndeterminate({
        commandId,
        position: toReceiptPosition(position),
        errorCode
      })
    } catch {
      return { kind: 'anomaly', reason: 'mark_indeterminate_threw' }
    }

    if (result.kind === 'marked' || result.kind === 'already_indeterminate') {
      const receipt = result.receipt
      // Validate receipt identity, indeterminate status, durable position,
      // and closed error code. On idempotent already_indeterminate replay the
      // store returns the original durable receipt whose position/errorCode
      // may differ from the candidate.
      if (
        receipt.commandId !== commandId ||
        receipt.status !== 'indeterminate' ||
        !isValidPosition({ generation: receipt.generation, cursor: receipt.cursor }) ||
        typeof receipt.errorCode !== 'string' ||
        !HOST_COMMAND_RECEIPT_INDETERMINATE_CODES.has(
          receipt.errorCode as HostCommandReceiptIndeterminateCode
        )
      ) {
        return { kind: 'anomaly', reason: 'mark_indeterminate_refused' }
      }
      return {
        kind: 'indeterminate',
        errorCode: receipt.errorCode as HostCommandReceiptIndeterminateCode,
        position: {
          generation: receipt.generation as number,
          cursor: receipt.cursor as number
        }
      }
    }
    return { kind: 'anomaly', reason: 'mark_indeterminate_refused' }
  }

  private readPosition(): HostCursorPosition | null {
    try {
      const position = this.getPosition()
      if (!isValidPosition(position)) {
        return null
      }
      return clonePosition(position)
    } catch {
      return null
    }
  }
}

function executionFields(execution: HostCommandExecutionResult): {
  errorCode?: string
  errorMessage?: string
  resultSummary?: string
  resultRef?: HostResultRef
} {
  return {
    ...(execution.errorCode !== undefined ? { errorCode: execution.errorCode } : {}),
    ...(execution.errorMessage !== undefined ? { errorMessage: execution.errorMessage } : {}),
    ...(execution.resultSummary !== undefined ? { resultSummary: execution.resultSummary } : {}),
    ...(execution.status === 'succeeded' && execution.resultRef !== undefined
      ? { resultRef: execution.resultRef }
      : {})
  }
}
