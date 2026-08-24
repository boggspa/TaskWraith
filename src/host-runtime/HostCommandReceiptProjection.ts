/**
 * Store → wire Host command receipt projector (Host Arc Wave 2B Subwave 4A).
 *
 * Emits a decode-valid HostCommandReceipt from a durable store record.
 * Fail-closed on incomplete legacy identity/position/name. Never leaks
 * target, policy, recoveryState, or other Host-internal fields onto the wire.
 */

import {
  decodeHostCommandReceipt,
  HOST_PROTOCOL_VERSION,
  type HostAuthorityDecision,
  type HostCommandReceipt,
  type HostDecodeResult
} from '../shared/hostProtocol'
import { mapHostStoreAuthorityDecisionToWire } from './HostAuthorityDecisionMap'
import {
  isExactActor,
  isProjectableRecord,
  type HostCommandReceiptRecord
} from './HostCommandReceiptStore'

export type HostCommandReceiptProjectionResult = HostDecodeResult<HostCommandReceipt>

/**
 * Project a durable receipt record to the wire HostCommandReceipt contract.
 * Returns ok:false without inventing identity/position for incomplete rows.
 */
export function projectHostCommandReceipt(
  record: HostCommandReceiptRecord
): HostCommandReceiptProjectionResult {
  if (!isProjectableRecord(record)) {
    return {
      ok: false,
      error:
        'receipt is incomplete for wire projection (missing exact actor, commandName, or delta position)'
    }
  }
  if (!isExactActor(record.actor) || !record.commandName) {
    return { ok: false, error: 'receipt actor/name incomplete for wire projection' }
  }
  if (typeof record.generation !== 'number' || typeof record.cursor !== 'number') {
    return { ok: false, error: 'receipt generation/cursor incomplete for wire projection' }
  }

  const wireDecision = mapHostStoreAuthorityDecisionToWire(record.authority.decision)
  if (!wireDecision) {
    return { ok: false, error: 'receipt authority.decision cannot map to wire vocabulary' }
  }

  let authority: HostAuthorityDecision
  if (wireDecision === 'deny') {
    const reason = record.authority.reason?.trim()
    if (!reason) {
      return { ok: false, error: 'deny authority requires reason for wire projection' }
    }
    authority = { decision: 'deny', reason }
  } else if (wireDecision === 'ask') {
    authority = { decision: 'ask' }
    if (record.authority.reason) {
      authority.reason = record.authority.reason
    }
  } else {
    authority = { decision: 'allow' }
    if (record.authority.reason) {
      authority.reason = record.authority.reason
    }
  }

  // Build only the wire surface — never attach target/policy/recoveryState.
  const candidate: HostCommandReceipt = {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    name: record.commandName,
    actor: {
      actorId: record.actor.actorId,
      clientId: record.actor.clientId,
      clientClass: record.actor.clientClass
    },
    authority,
    status: record.status,
    commandFingerprint: record.commandFingerprint,
    generation: record.generation,
    cursor: record.cursor,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
  if (record.resultSummary !== undefined) {
    candidate.resultSummary = record.resultSummary
  }
  if (record.errorCode !== undefined) {
    candidate.errorCode = record.errorCode
  }
  if (record.errorMessage !== undefined) {
    candidate.errorMessage = record.errorMessage
  }
  if (record.conflictCommandId !== undefined) {
    candidate.conflictCommandId = record.conflictCommandId
  }

  const decoded = decodeHostCommandReceipt(candidate)
  if (!decoded.ok) {
    return decoded
  }

  // Defense in depth: ensure no Host-internal leak keys survived.
  const wire = decoded.value as HostCommandReceipt & Record<string, unknown>
  if ('target' in wire || 'policy' in wire || 'recoveryState' in wire) {
    return { ok: false, error: 'projected receipt leaked Host-internal fields' }
  }
  const json = JSON.stringify(wire)
  if (json.includes('"target"') || json.includes('"policy"') || json.includes('"recoveryState"')) {
    return { ok: false, error: 'projected receipt leaked Host-internal fields' }
  }

  return decoded
}
