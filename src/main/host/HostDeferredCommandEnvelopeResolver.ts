/**
 * Host deferred-command envelope resolver (Host Arc Wave 2E-2B Subwave 2 — Lane A).
 *
 * Standalone substrate that bridges HostDeferredCommandEnvelopeStore →
 * HostBridgeCommandExecutor for restart-safe deferred allow execution.
 *
 * NOT yet HostDeferredCommandBridgePorts.executeCommand — the bridge cannot
 * represent indeterminate, so this resolver uses its own standalone result
 * union. Integration into the bridge ports awaits E widening.
 *
 * Pinned flow per Boss 2E-2B2 prerequisites:
 * 1. Actor-bound envelope load → verify stored + has body + all correlation
 *    fields match input.
 * 2. Re-decode HostCommand from the durable body, validate governed
 *    args/routing, refingerprint, compare all identity fields.
 * 3. Actor-bound receipt load → verify pending + all identity/correlation
 *    fields match input.
 * 4. Execute H exactly once and return verified command + H result.
 *
 * Steps 1-3 are the public synchronous `verifyCommand`, which never reaches the
 * executor on ANY path; step 4 is `executeCommand`, which calls `verifyCommand`
 * exactly once and invokes the injected executor exactly once, only on
 * `verified`, using the SAME decoded command object verification returned. The
 * split exists so a later deferred-allow composer can reuse this
 * security-critical verification without duplicating it and without H. It
 * changes no observable `executeCommand` behavior.
 *
 * Any unavailable/notfound/incomplete/mismatch returns body-free explicit
 * indeterminate with zero H calls. Quarantine only when the correct actor
 * and envelope are safely identified. Never markConsumed, never accept/cast
 * compact effects, never log or project command bodies.
 */

import type { HostActorIdentity, HostCommand } from '../../shared/hostProtocol'
import {
  HOST_PROTOCOL_MAX_ID,
  decodeHostCommand,
  type HostCommandName
} from '../../shared/hostProtocol'
import { validateHostCommandArguments } from '../../host-runtime/HostCommandArguments'
import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import { isHostUuid, isSafeHostIdentifier, parseHostIdempotencyKey } from '../../host-shared/HostCommandIdentity'
import { parseGovernedMutationCommandName } from '../../host-runtime/HostCommandRouting'
import type {
  HostDeferredCommandEnvelopeLookupResult,
  HostDeferredCommandEnvelopeQuarantineCode,
  HostDeferredCommandEnvelopeTransitionResult
} from '../../host-runtime/HostDeferredCommandEnvelopeStore'
import type {
  HostCommandReceiptLookupResult,
  HostCommandReceiptStatus
} from '../../host-runtime/HostCommandReceiptStore'
import type {
  HostBridgeCommandExecutor,
  HostBridgeCommandExecutorResult
} from './HostBridgeCommandExecutor'

/** Input shape — subset of HostDeferredExecuteCommandInput + idempotencyKey for receipt lookup. */
export interface HostDeferredCommandEnvelopeResolverInput {
  deferredId: string
  commandId: string
  idempotencyKey: string
  commandFingerprint: string
  commandName: HostCommandName
  actor: HostActorIdentity
  challengeId: string
  challengeKind: 'approval' | 'question'
}

export type HostDeferredCommandEnvelopeResolverIndeterminateCode =
  | 'store_unavailable'
  | 'envelope_not_found'
  | 'envelope_actor_mismatch'
  | 'envelope_corrupt'
  | 'envelope_not_stored'
  | 'envelope_body_missing'
  | 'envelope_correlation_mismatch'
  | 'command_decode_failed'
  | 'command_validation_failed'
  | 'command_fingerprint_mismatch'
  | 'command_identity_mismatch'
  | 'receipt_not_found'
  | 'receipt_actor_mismatch'
  | 'receipt_incomplete'
  | 'receipt_not_pending'
  | 'receipt_not_deferred'
  | 'receipt_correlation_mismatch'
  | 'receipt_already_indeterminate'
  | 'quarantine_failed'

export type HostDeferredCommandEnvelopeResolverResult =
  | { kind: 'executed'; command: HostCommand; result: HostBridgeCommandExecutorResult }
  | { kind: 'indeterminate'; code: HostDeferredCommandEnvelopeResolverIndeterminateCode }
  | { kind: 'already_terminal'; receiptStatus: HostCommandReceiptStatus }

/**
 * Result of zero-H verification.
 *
 * `verified` carries the decoded command that `executeCommand` hands to the
 * executor unchanged. Callers MUST execute that exact object and never a
 * re-decode: fingerprint/identity drift between verification and execution
 * would defeat the whole envelope check.
 */
export type HostDeferredCommandEnvelopeResolverVerifyResult =
  | { kind: 'verified'; command: HostCommand }
  | { kind: 'indeterminate'; code: HostDeferredCommandEnvelopeResolverIndeterminateCode }
  | { kind: 'already_terminal'; receiptStatus: HostCommandReceiptStatus }

/** Narrow injected envelope store port — actor-bound lookup + quarantine only. */
export interface HostDeferredCommandEnvelopeResolverEnvelopePort {
  getByCommandId(
    commandId: string,
    actor: HostActorIdentity
  ): HostDeferredCommandEnvelopeLookupResult
  markQuarantined(
    deferredId: string,
    actor: HostActorIdentity,
    quarantineCode: HostDeferredCommandEnvelopeQuarantineCode
  ): HostDeferredCommandEnvelopeTransitionResult
}

/** Narrow injected receipt store port — actor-bound lookup only. */
export interface HostDeferredCommandEnvelopeResolverReceiptPort {
  getByCommandId(commandId: string, actor: HostActorIdentity): HostCommandReceiptLookupResult
}

export interface HostDeferredCommandEnvelopeResolverOptions {
  envelopeStore: HostDeferredCommandEnvelopeResolverEnvelopePort
  receiptStore: HostDeferredCommandEnvelopeResolverReceiptPort
  executor: Pick<HostBridgeCommandExecutor, 'execute'>
}

export class HostDeferredCommandEnvelopeResolver {
  private readonly envelopeStore: HostDeferredCommandEnvelopeResolverEnvelopePort
  private readonly receiptStore: HostDeferredCommandEnvelopeResolverReceiptPort
  private readonly executor: Pick<HostBridgeCommandExecutor, 'execute'>

  constructor(options: HostDeferredCommandEnvelopeResolverOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires options')
    }
    if (!options.envelopeStore || typeof options.envelopeStore !== 'object') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires envelopeStore')
    }
    if (typeof options.envelopeStore.getByCommandId !== 'function') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires envelopeStore.getByCommandId')
    }
    if (typeof options.envelopeStore.markQuarantined !== 'function') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires envelopeStore.markQuarantined')
    }
    if (!options.receiptStore || typeof options.receiptStore !== 'object') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires receiptStore')
    }
    if (typeof options.receiptStore.getByCommandId !== 'function') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires receiptStore.getByCommandId')
    }
    if (!options.executor || typeof options.executor.execute !== 'function') {
      throw new Error('HostDeferredCommandEnvelopeResolver requires executor.execute')
    }
    this.envelopeStore = options.envelopeStore
    this.receiptStore = options.receiptStore
    this.executor = options.executor
  }

  async executeCommand(
    input: HostDeferredCommandEnvelopeResolverInput
  ): Promise<HostDeferredCommandEnvelopeResolverResult> {
    const verified = this.verifyCommand(input)
    if (verified.kind !== 'verified') {
      return verified
    }

    // 7) Execute H exactly once, with the exact object verification decoded.
    //
    // `command.actor` is provably the validated input actor: correlation
    // required envelope.actor === input actor on actorId/clientId/clientClass,
    // and body identity required command.actor === envelope.actor on those same
    // three fields, so the two are character-identical by transitivity.
    const result = await this.executor.execute(verified.command, {
      actor: verified.command.actor
    })

    return { kind: 'executed', command: verified.command, result }
  }

  /**
   * Steps 1-6, with ZERO executor calls on every path.
   *
   * Synchronous by construction: every injected verification port is
   * synchronous and there is nothing to await, which makes "never reaches H"
   * structural rather than incidental.
   */
  verifyCommand(
    input: HostDeferredCommandEnvelopeResolverInput
  ): HostDeferredCommandEnvelopeResolverVerifyResult {
    // 1) Validate input shape.
    const validated = validateInput(input)
    if (!validated.ok) {
      return { kind: 'indeterminate', code: validated.code }
    }

    // 2) Actor-bound envelope load.
    let envelopeResult: HostDeferredCommandEnvelopeLookupResult
    try {
      envelopeResult = this.envelopeStore.getByCommandId(
        validated.value.commandId,
        validated.value.actor
      )
    } catch {
      return { kind: 'indeterminate', code: 'store_unavailable' }
    }

    if (envelopeResult.kind === 'unavailable') {
      return { kind: 'indeterminate', code: 'store_unavailable' }
    }
    if (envelopeResult.kind === 'not_found') {
      return { kind: 'indeterminate', code: 'envelope_not_found' }
    }
    if (envelopeResult.kind === 'actor_mismatch') {
      return { kind: 'indeterminate', code: 'envelope_actor_mismatch' }
    }

    const envelopeRecord = envelopeResult.record

    // 3) Envelope must be stored with a body.
    if (envelopeRecord.state !== 'stored') {
      return { kind: 'indeterminate', code: 'envelope_not_stored' }
    }
    if (!envelopeRecord.command) {
      return this.indeterminateAfterQuarantine(
        'envelope_body_missing',
        envelopeRecord.deferredId,
        validated.value.actor,
        'body_missing'
      )
    }

    // 4) Correlation: all input fields must match the envelope record.
    if (
      envelopeRecord.deferredId !== validated.value.deferredId ||
      envelopeRecord.commandId !== validated.value.commandId ||
      envelopeRecord.idempotencyKey !== validated.value.idempotencyKey ||
      envelopeRecord.commandFingerprint !== validated.value.commandFingerprint ||
      envelopeRecord.commandName !== validated.value.commandName ||
      envelopeRecord.challengeId !== validated.value.challengeId ||
      envelopeRecord.challengeKind !== validated.value.challengeKind ||
      !actorsMatch(envelopeRecord.actor, validated.value.actor)
    ) {
      return this.indeterminateAfterQuarantine(
        'envelope_correlation_mismatch',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    // 5) Re-decode + validate + refingerprint the stored command body.
    const decoded = decodeHostCommand(envelopeRecord.command)
    if (!decoded.ok) {
      return this.indeterminateAfterQuarantine(
        'command_decode_failed',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    const argsValidated = validateHostCommandArguments(decoded.value)
    if (!argsValidated.ok) {
      return this.indeterminateAfterQuarantine(
        'command_validation_failed',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    const governed = parseGovernedMutationCommandName(argsValidated.value.name)
    if (!governed) {
      return this.indeterminateAfterQuarantine(
        'command_validation_failed',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    let fingerprintResult: ReturnType<typeof fingerprintHostCommand>
    try {
      fingerprintResult = fingerprintHostCommand(argsValidated.value)
    } catch {
      return this.indeterminateAfterQuarantine(
        'command_fingerprint_mismatch',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    if (fingerprintResult.fingerprint !== envelopeRecord.commandFingerprint) {
      return this.indeterminateAfterQuarantine(
        'command_fingerprint_mismatch',
        envelopeRecord.deferredId,
        validated.value.actor,
        'fingerprint_mismatch'
      )
    }

    // Verify body identity fields match the envelope metadata.
    const verifiedCommand = argsValidated.value
    if (
      verifiedCommand.commandId !== envelopeRecord.commandId ||
      verifiedCommand.idempotencyKey !== envelopeRecord.idempotencyKey ||
      verifiedCommand.actor.actorId !== envelopeRecord.actor.actorId ||
      verifiedCommand.actor.clientId !== envelopeRecord.actor.clientId ||
      verifiedCommand.actor.clientClass !== envelopeRecord.actor.clientClass
    ) {
      return this.indeterminateAfterQuarantine(
        'command_identity_mismatch',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    // 6) Actor-bound receipt lookup.
    let receiptResult: HostCommandReceiptLookupResult
    try {
      receiptResult = this.receiptStore.getByCommandId(
        validated.value.commandId,
        validated.value.actor
      )
    } catch {
      return { kind: 'indeterminate', code: 'store_unavailable' }
    }

    if (receiptResult.kind === 'not_found') {
      return this.indeterminateAfterQuarantine(
        'receipt_not_found',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }
    if (receiptResult.kind === 'actor_mismatch') {
      return { kind: 'indeterminate', code: 'receipt_actor_mismatch' }
    }
    if (receiptResult.kind === 'incomplete') {
      return this.indeterminateAfterQuarantine(
        'receipt_incomplete',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    const receipt = receiptResult.receipt
    if (
      receipt.commandName === undefined ||
      typeof receipt.generation !== 'number' ||
      !Number.isInteger(receipt.generation) ||
      !Number.isFinite(receipt.generation) ||
      receipt.generation < 0 ||
      typeof receipt.cursor !== 'number' ||
      !Number.isInteger(receipt.cursor) ||
      !Number.isFinite(receipt.cursor) ||
      receipt.cursor < 0 ||
      receipt.actor.actorId === undefined ||
      receipt.actor.clientClass === undefined
    ) {
      return this.indeterminateAfterQuarantine(
        'receipt_incomplete',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    const targetId = singleTargetId(verifiedCommand)
    if (
      receipt.commandId !== validated.value.commandId ||
      receipt.idempotencyKey !== validated.value.idempotencyKey ||
      receipt.commandFingerprint !== validated.value.commandFingerprint ||
      receipt.commandName !== validated.value.commandName ||
      !actorsMatch(receipt.actor, validated.value.actor) ||
      targetId === null ||
      receipt.target.kind !== fingerprintResult.targetKind ||
      receipt.target.id !== targetId
    ) {
      return this.indeterminateAfterQuarantine(
        'receipt_correlation_mismatch',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    // Terminal receipts are already resolved and must never reach H.
    if (
      receipt.status === 'succeeded' ||
      receipt.status === 'failed' ||
      receipt.status === 'denied' ||
      receipt.status === 'cancelled' ||
      receipt.status === 'conflict'
    ) {
      return { kind: 'already_terminal', receiptStatus: receipt.status }
    }

    if (receipt.status === 'indeterminate') {
      return { kind: 'indeterminate', code: 'receipt_already_indeterminate' }
    }
    if (receipt.status !== 'pending') {
      return { kind: 'indeterminate', code: 'receipt_not_pending' }
    }
    if (receipt.authority.decision !== 'deferred') {
      return this.indeterminateAfterQuarantine(
        'receipt_not_deferred',
        envelopeRecord.deferredId,
        validated.value.actor,
        'verification_failed'
      )
    }

    return { kind: 'verified', command: verifiedCommand }
  }

  private indeterminateAfterQuarantine(
    rootCode: HostDeferredCommandEnvelopeResolverIndeterminateCode,
    deferredId: string,
    actor: HostActorIdentity,
    quarantineCode: HostDeferredCommandEnvelopeQuarantineCode
  ): { kind: 'indeterminate'; code: HostDeferredCommandEnvelopeResolverIndeterminateCode } {
    let result: HostDeferredCommandEnvelopeTransitionResult
    try {
      result = this.envelopeStore.markQuarantined(deferredId, actor, quarantineCode)
    } catch {
      return { kind: 'indeterminate', code: 'quarantine_failed' }
    }
    if (
      (result.kind === 'updated' || result.kind === 'existing') &&
      result.state === 'quarantined'
    ) {
      return { kind: 'indeterminate', code: rootCode }
    }
    return { kind: 'indeterminate', code: 'quarantine_failed' }
  }
}

function validateInput(
  input: unknown
):
  | { ok: true; value: HostDeferredCommandEnvelopeResolverInput }
  | { ok: false; code: HostDeferredCommandEnvelopeResolverIndeterminateCode } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'envelope_corrupt' }
  }

  const raw = input as Record<string, unknown>
  if (
    !hasExactKeys(raw, [
      'deferredId',
      'commandId',
      'idempotencyKey',
      'commandFingerprint',
      'commandName',
      'actor',
      'challengeId',
      'challengeKind'
    ])
  ) {
    return { ok: false, code: 'envelope_corrupt' }
  }

  if (
    typeof raw.deferredId !== 'string' ||
    !isHostUuid(raw.deferredId) ||
    !isSafeHostIdentifier(raw.deferredId)
  ) {
    return { ok: false, code: 'envelope_corrupt' }
  }
  if (
    typeof raw.commandId !== 'string' ||
    !isHostUuid(raw.commandId) ||
    !isSafeHostIdentifier(raw.commandId)
  ) {
    return { ok: false, code: 'envelope_corrupt' }
  }
  if (
    typeof raw.commandFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.commandFingerprint)
  ) {
    return { ok: false, code: 'envelope_corrupt' }
  }
  const commandName = parseGovernedMutationCommandName(raw.commandName)
  if (!commandName) {
    return { ok: false, code: 'envelope_corrupt' }
  }
  if (
    typeof raw.challengeId !== 'string' ||
    !isHostUuid(raw.challengeId) ||
    !isSafeHostIdentifier(raw.challengeId)
  ) {
    return { ok: false, code: 'envelope_corrupt' }
  }
  if (raw.challengeKind !== 'approval' && raw.challengeKind !== 'question') {
    return { ok: false, code: 'envelope_corrupt' }
  }

  const actor = validateActor(raw.actor)
  if (!actor) {
    return { ok: false, code: 'envelope_actor_mismatch' }
  }

  const idempotency = parseHostIdempotencyKey(raw.idempotencyKey)
  if (
    !idempotency.ok ||
    idempotency.value.clientClass !== actor.clientClass ||
    idempotency.value.clientId !== actor.clientId
  ) {
    return { ok: false, code: 'envelope_actor_mismatch' }
  }

  return {
    ok: true,
    value: {
      deferredId: raw.deferredId,
      commandId: raw.commandId,
      idempotencyKey: `${idempotency.value.clientClass}:${idempotency.value.clientId}:${idempotency.value.uuid}`,
      commandFingerprint: raw.commandFingerprint,
      commandName,
      actor,
      challengeId: raw.challengeId,
      challengeKind: raw.challengeKind
    }
  }
}

function validateActor(value: unknown): HostActorIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!hasExactKeys(raw, ['actorId', 'clientId', 'clientClass'])) return null
  if (
    typeof raw.actorId !== 'string' ||
    typeof raw.clientId !== 'string' ||
    typeof raw.clientClass !== 'string'
  ) {
    return null
  }
  if (
    !isSafeHostIdentifier(raw.actorId, HOST_PROTOCOL_MAX_ID) ||
    !isSafeHostIdentifier(raw.clientId, HOST_PROTOCOL_MAX_ID)
  ) {
    return null
  }
  if (
    raw.clientClass !== 'desktop' &&
    raw.clientClass !== 'tui' &&
    raw.clientClass !== 'ios' &&
    raw.clientClass !== 'test'
  ) {
    return null
  }
  return {
    actorId: raw.actorId,
    clientId: raw.clientId,
    clientClass: raw.clientClass
  }
}

function actorsMatch(
  left: { actorId?: string; clientId: string; clientClass?: string },
  right: HostActorIdentity
): boolean {
  return (
    left.actorId === right.actorId &&
    left.clientId === right.clientId &&
    left.clientClass === right.clientClass
  )
}

function singleTargetId(command: HostCommand): string | null {
  const values = Object.values(command.target)
  return values.length === 1 && typeof values[0] === 'string' && values[0].length > 0
    ? values[0]
    : null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}
