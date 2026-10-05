/**
 * Additive evidence for ownership preparation. Legacy persist success keeps
 * its existing policy; an unavailable result here never rejects that success.
 * Capture before submission so asynchronous replies cannot bind to a caller's
 * changed command or transfer descriptor. None of these facts grants ownership.
 * Exact evidence has the immutable transfer protocol's verification boundary;
 * it is not a new digest check at adoption or a same-UID tamper guarantee.
 */
import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import {
  decodeHostCommand,
  decodeHostCommandReceipt,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandReceipt
} from '../../shared/hostProtocol'

export interface ThreadOwnershipReceiptContext {
  readonly commandId: string
  readonly idempotencyKey: string
  readonly commandFingerprint: string
  readonly actor: Readonly<HostActorIdentity>
  readonly threadId: string
  readonly descriptor: Readonly<{ transferId: string; sha256: string; byteLength: number }>
}

type UnavailableReason =
  | 'invalid_submission'
  | 'invalid_receipt'
  | 'command_mismatch'
  | 'descriptor_mismatch'
  | 'legacy_receipt'

export type ThreadOwnershipReceiptEvidence =
  | {
      readonly kind: 'exact'
      readonly threadId: string
      readonly commandId: string
      readonly revision: number
      readonly sha256: string
    }
  | {
      readonly kind: 'reanchor'
      readonly threadId: string
      readonly commandId: string
      readonly revision: number
    }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason }

/** Metadata only: no record body is cloned or hashed. */
export function captureThreadOwnershipReceiptContext(input: {
  readonly command: HostCommand
  readonly threadId: string
  readonly descriptor: {
    readonly transferId: string
    readonly sha256: string
    readonly byteLength: number
  }
}): ThreadOwnershipReceiptContext | null {
  try {
    const decoded = decodeHostCommand(input.command)
    if (!decoded.ok || decoded.value.name !== 'thread.record.persist') return null
    const command = decoded.value
    const descriptor = input.descriptor
    if (
      command.target.threadId !== input.threadId ||
      command.arguments.transferId !== descriptor.transferId ||
      command.arguments.sha256 !== descriptor.sha256 ||
      command.arguments.byteLength !== descriptor.byteLength
    )
      return null
    return Object.freeze({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: fingerprintHostCommand(command).fingerprint,
      actor: Object.freeze({ ...command.actor }),
      threadId: input.threadId,
      descriptor: Object.freeze({
        transferId: descriptor.transferId,
        sha256: descriptor.sha256,
        byteLength: descriptor.byteLength
      })
    })
  } catch {
    return null
  }
}

/** An exact historical publication is not a claim about the Host's current revision or boot. */
export function readThreadOwnershipReceiptEvidence(
  context: ThreadOwnershipReceiptContext | null,
  receipt: HostCommandReceipt
): ThreadOwnershipReceiptEvidence {
  try {
    return readEvidence(context, receipt)
  } catch {
    return Object.freeze({ kind: 'unavailable', reason: 'invalid_receipt' })
  }
}

function readEvidence(
  context: ThreadOwnershipReceiptContext | null,
  receipt: HostCommandReceipt
): ThreadOwnershipReceiptEvidence {
  const unavailable = (reason: UnavailableReason): ThreadOwnershipReceiptEvidence =>
    Object.freeze({ kind: 'unavailable', reason })
  if (!context) return unavailable('invalid_submission')
  const decoded = decodeHostCommandReceipt(receipt)
  if (!decoded.ok || decoded.value.status !== 'succeeded') return unavailable('invalid_receipt')
  const found = decoded.value
  if (
    found.commandId !== context.commandId ||
    found.idempotencyKey !== context.idempotencyKey ||
    found.name !== 'thread.record.persist' ||
    found.commandFingerprint !== context.commandFingerprint ||
    found.actor.actorId !== context.actor.actorId ||
    found.actor.clientId !== context.actor.clientId ||
    found.actor.clientClass !== context.actor.clientClass
  )
    return unavailable('command_mismatch')
  const commit = found.threadRecordCommit
  if (!commit) return unavailable('legacy_receipt')
  const identity = {
    threadId: context.threadId,
    commandId: context.commandId,
    revision: commit.revision
  }
  if (commit.source === 'rewritten') return Object.freeze({ kind: 'reanchor', ...identity })
  if (commit.sha256 !== context.descriptor.sha256) return unavailable('descriptor_mismatch')
  return Object.freeze({ kind: 'exact', ...identity, sha256: commit.sha256 })
}
