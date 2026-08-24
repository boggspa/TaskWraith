import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decodeHostCommandReceipt } from '../../shared/hostProtocol'
import { projectHostCommandReceipt } from './HostCommandReceiptProjection'
import {
  HostCommandReceiptStore,
  hostCommandFingerprint,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME,
  type HostCommandReceiptActor
} from '../../host-runtime/HostCommandReceiptStore'

const OWNER: HostCommandReceiptActor = {
  clientId: 'client-tui-1',
  actorId: 'user-1',
  clientClass: 'tui'
}

describe('HostCommandReceiptProjection', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-receipt-proj-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(cursor = 0) {
    return new HostCommandReceiptStore({
      dataDir,
      getPosition: () => ({ generation: 1, cursor }),
      now: () => '2026-08-03T18:00:00.000Z'
    })
  }

  it('projects a durable receipt to a decode-valid HostCommandReceipt', () => {
    const store = openStore(4)
    const begun = store.begin({
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      commandName: 'composer.send',
      commandFingerprint: hostCommandFingerprint({
        type: 'composer.send',
        targetKind: 'thread',
        targetId: 'thread-1',
        argsDigest: 'abc'
      }),
      actor: OWNER,
      target: { kind: 'thread', id: 'thread-1' },
      authority: { decision: 'allowed', reason: 'policy ok', policy: 'workspace' }
    })
    expect(begun.kind).toBe('created')
    if (begun.kind !== 'created') return

    store.complete({
      commandId: 'cmd-1',
      status: 'succeeded',
      resultSummary: 'sent'
    })
    const found = store.getByCommandId('cmd-1', OWNER)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return

    const projected = projectHostCommandReceipt(found.receipt)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return

    expect(projected.value).toMatchObject({
      type: 'host.receipt',
      protocolVersion: 2,
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      name: 'composer.send',
      actor: OWNER,
      authority: { decision: 'allow', reason: 'policy ok' },
      status: 'succeeded',
      generation: 1,
      cursor: 4,
      resultSummary: 'sent'
    })
    // No Host-internal leaks.
    expect(projected.value).not.toHaveProperty('target')
    expect(projected.value).not.toHaveProperty('policy')
    expect(projected.value).not.toHaveProperty('recoveryState')
    expect(JSON.stringify(projected.value)).not.toMatch(/"policy"|"target"|"recoveryState"/)

    // Round-trip through the shared decoder.
    const decoded = decodeHostCommandReceipt(projected.value)
    expect(decoded.ok).toBe(true)
  })

  it('maps denied store authority to wire deny with required reason', () => {
    const store = openStore()
    store.begin({
      commandId: 'cmd-deny',
      idempotencyKey: 'idem-deny',
      commandName: 'approval.decide',
      commandFingerprint: 'd'.repeat(64),
      actor: OWNER,
      target: { kind: 'approval', id: 'ap-1' },
      authority: { decision: 'denied', reason: 'user declined', policy: 'ask' }
    })
    store.complete({
      commandId: 'cmd-deny',
      status: 'denied',
      authority: { decision: 'denied', reason: 'user declined', policy: 'ask' }
    })
    const found = store.getByCommandId('cmd-deny', OWNER)
    expect(found.kind).toBe('found')
    if (found.kind !== 'found') return

    const projected = projectHostCommandReceipt(found.receipt)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.value.authority).toEqual({ decision: 'deny', reason: 'user declined' })
    expect(JSON.stringify(projected.value)).not.toMatch(/"policy"/)
  })

  it('fails closed on incomplete legacy rows without inventing identity/position', () => {
    const store = openStore()
    store.begin({
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      commandName: 'ping',
      commandFingerprint: 'e'.repeat(64),
      actor: OWNER,
      target: { kind: 'host' },
      authority: { decision: 'allowed' }
    })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const legacy = JSON.stringify({
      op: 'upsert',
      record: {
        schemaVersion: 1,
        commandId: 'cmd-legacy',
        idempotencyKey: 'idem-legacy',
        commandFingerprint: 'f'.repeat(64),
        status: 'succeeded',
        actor: { clientId: 'client-legacy' },
        target: { kind: 'thread', id: 't1' },
        authority: { decision: 'allowed' },
        createdAt: '2026-08-03T16:00:00.000Z',
        updatedAt: '2026-08-03T16:00:00.000Z'
      }
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${legacy}\n`)

    const reopened = openStore()
    const legacyRecord = reopened.list().find((r) => r.commandId === 'cmd-legacy')
    expect(legacyRecord).toBeTruthy()
    if (!legacyRecord) return

    const projected = projectHostCommandReceipt(legacyRecord)
    expect(projected.ok).toBe(false)
    if (projected.ok) return
    expect(projected.error).toMatch(/incomplete/)
  })

  it('fails closed when deny authority lacks a reason', () => {
    const projected = projectHostCommandReceipt({
      schemaVersion: 1,
      commandId: 'cmd-x',
      idempotencyKey: 'idem-x',
      commandFingerprint: 'a'.repeat(64),
      commandName: 'ping',
      status: 'denied',
      actor: OWNER,
      target: { kind: 'host' },
      authority: { decision: 'denied' },
      generation: 1,
      cursor: 0,
      createdAt: '2026-08-03T18:00:00.000Z',
      updatedAt: '2026-08-03T18:00:00.000Z'
    })
    expect(projected.ok).toBe(false)
    if (projected.ok) return
    expect(projected.error).toMatch(/deny authority requires reason/)
  })
})
