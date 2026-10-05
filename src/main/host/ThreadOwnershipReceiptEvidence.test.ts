import { describe, expect, it } from 'vitest'

import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import type { HostCommand, HostCommandReceipt } from '../../shared/hostProtocol'
import {
  captureThreadOwnershipReceiptContext,
  readThreadOwnershipReceiptEvidence
} from './ThreadOwnershipReceiptEvidence'

function fixture() {
  const descriptor = { transferId: 'transfer-1', sha256: 'a'.repeat(64), byteLength: 1024 }
  const command: HostCommand = {
    type: 'host.command',
    protocolVersion: 2,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'persist-1',
    name: 'thread.record.persist',
    target: { threadId: 'thread-1' },
    actor: { actorId: 'desktop', clientId: 'desktop', clientClass: 'desktop' },
    arguments: { ...descriptor, expectedRevision: 6 },
    issuedAt: '2026-10-05T00:00:00Z'
  }
  const receipt: HostCommandReceipt = {
    type: 'host.receipt',
    protocolVersion: 2,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    name: command.name,
    actor: { ...command.actor },
    authority: { decision: 'allow' },
    status: 'succeeded',
    commandFingerprint: fingerprintHostCommand(command).fingerprint,
    generation: 1,
    cursor: 2,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt,
    threadRecordCommit: { revision: 7, source: 'verified-transfer', sha256: descriptor.sha256 }
  }
  const context = captureThreadOwnershipReceiptContext({
    command,
    descriptor,
    threadId: 'thread-1'
  })!
  return { command, descriptor, receipt, context }
}

describe('thread ownership receipt evidence', () => {
  it('binds exact evidence to a frozen submitted command, thread and descriptor', () => {
    const f = fixture()
    f.command.arguments.sha256 = 'b'.repeat(64)
    f.command.actor.actorId = 'changed'
    f.descriptor.sha256 = 'c'.repeat(64)
    const evidence = readThreadOwnershipReceiptEvidence(f.context, f.receipt)
    expect(evidence).toEqual({
      kind: 'exact',
      threadId: 'thread-1',
      commandId: f.receipt.commandId,
      revision: 7,
      sha256: 'a'.repeat(64)
    })
    f.receipt.threadRecordCommit!.revision = 999
    expect(evidence).toMatchObject({ revision: 7 })
    expect(Object.isFrozen(f.context)).toBe(true)
    expect(Object.isFrozen(evidence)).toBe(true)
  })

  it('reports rewritten evidence as requiring re-anchor even at the requested revision', () => {
    const f = fixture()
    f.receipt.threadRecordCommit = { revision: 7, source: 'rewritten' }
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt)).toMatchObject({
      kind: 'reanchor',
      revision: 7
    })
  })

  it('keeps absent evidence unavailable without changing a legacy succeeded receipt', () => {
    const f = fixture()
    delete f.receipt.threadRecordCommit
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt)).toEqual({
      kind: 'unavailable',
      reason: 'legacy_receipt'
    })
    expect(f.receipt.status).toBe('succeeded')
  })

  it.each(['commandId', 'idempotencyKey', 'commandFingerprint', 'name', 'actor'] as const)(
    'does not accept evidence with a different %s',
    (field) => {
      const f = fixture()
      if (field === 'actor') f.receipt.actor = { ...f.receipt.actor, actorId: 'other' }
      else if (field === 'name') f.receipt.name = 'thread.record.delete'
      else f.receipt[field] = field === 'commandFingerprint' ? 'b'.repeat(64) : 'other'
      expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt).kind).toBe('unavailable')
    }
  )

  it('rejects evidence for a different verified descriptor and malformed evidence', () => {
    const f = fixture()
    f.receipt.threadRecordCommit = {
      revision: 7,
      source: 'verified-transfer',
      sha256: 'b'.repeat(64)
    }
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt)).toEqual({
      kind: 'unavailable',
      reason: 'descriptor_mismatch'
    })
    ;(f.receipt.threadRecordCommit as { revision: number }).revision = NaN
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt).kind).toBe('unavailable')
  })

  it('refuses to capture mismatched submitted descriptors, threads, or other commands', () => {
    const f = fixture()
    expect(
      captureThreadOwnershipReceiptContext({
        command: f.command,
        descriptor: { ...f.descriptor, byteLength: 3 },
        threadId: 'thread-1'
      })
    ).toBeNull()
    expect(
      captureThreadOwnershipReceiptContext({
        command: f.command,
        descriptor: f.descriptor,
        threadId: 'another-thread'
      })
    ).toBeNull()
    expect(
      captureThreadOwnershipReceiptContext({
        command: { ...f.command, name: 'thread.record.delete' },
        descriptor: f.descriptor,
        threadId: 'thread-1'
      })
    ).toBeNull()
  })

  it('accepts the same durable historical evidence after receipt lookup changes projection position', () => {
    const f = fixture()
    f.receipt.generation = 999
    f.receipt.cursor = 1000
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt).kind).toBe('exact')
    f.receipt.status = 'indeterminate'
    expect(readThreadOwnershipReceiptEvidence(f.context, f.receipt).kind).toBe('unavailable')
  })
})
