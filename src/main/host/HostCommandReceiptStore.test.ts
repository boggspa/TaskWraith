import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostCommandReceiptStore,
  hostCommandFingerprint,
  HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME,
  type HostCommandReceiptBeginInput
} from './HostCommandReceiptStore'

function baseInput(
  overrides: Partial<HostCommandReceiptBeginInput> = {}
): HostCommandReceiptBeginInput {
  const fingerprint =
    overrides.commandFingerprint ??
    hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'abc'
    })
  return {
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    commandFingerprint: fingerprint,
    actor: { clientId: 'client-tui-1', clientKind: 'tui', actorId: 'user-1' },
    target: { kind: 'thread', id: 'thread-1' },
    authority: { decision: 'allowed', reason: 'policy ok', policy: 'workspace' },
    ...overrides
  }
}

describe('HostCommandReceiptStore', () => {
  let dataDir: string
  let clock: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-cmd-receipts-'))
    clock = '2026-08-03T17:00:00.000Z'
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: { maxRecords?: number; compactAfterRecords?: number }) {
    return new HostCommandReceiptStore({
      dataDir,
      now: () => clock,
      maxRecords: options?.maxRecords,
      compactAfterRecords: options?.compactAfterRecords
    })
  }

  it('persists pending then terminal receipts and looks up by commandId and idempotencyKey', () => {
    const store = openStore()
    const begun = store.begin(baseInput())
    expect(begun.kind).toBe('created')
    if (begun.kind !== 'created') return

    expect(begun.receipt.status).toBe('pending')
    expect(store.getByCommandId('cmd-1')?.status).toBe('pending')
    expect(store.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')

    clock = '2026-08-03T17:00:01.000Z'
    const completed = store.complete({
      commandId: 'cmd-1',
      status: 'succeeded',
      resultSummary: 'sent'
    })
    expect(completed?.status).toBe('succeeded')
    expect(completed?.completedAt).toBe(clock)
    expect(completed?.resultSummary).toBe('sent')
    expect(completed?.actor.clientId).toBe('client-tui-1')
    expect(completed?.authority.decision).toBe('allowed')
  })

  it('returns the original receipt for an exact repeated command', () => {
    const store = openStore()
    const first = store.begin(baseInput())
    expect(first.kind).toBe('created')
    if (first.kind !== 'created') return

    clock = '2026-08-03T17:00:05.000Z'
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'ok' })

    const again = store.begin(baseInput())
    expect(again.kind).toBe('existing')
    if (again.kind !== 'existing') return
    expect(again.receipt.commandId).toBe('cmd-1')
    expect(again.receipt.status).toBe('succeeded')
    expect(again.receipt.resultSummary).toBe('ok')
  })

  it('durably records conflict when the same idempotency key has a different fingerprint', () => {
    const store = openStore()
    const first = store.begin(baseInput())
    expect(first.kind).toBe('created')

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'DIFFERENT'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp,
        actor: { clientId: 'client-attacker', clientKind: 'tui', actorId: 'user-x' },
        target: { kind: 'thread', id: 'thread-other' }
      })
    )
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') return
    expect(conflict.reason).toBe('idempotency_key_command_mismatch')
    expect(conflict.existing.commandId).toBe('cmd-1')
    expect(conflict.requestedFingerprint).toBe(otherFp)
    expect(conflict.receipt?.status).toBe('conflict')
    expect(conflict.receipt?.commandId).toBe('cmd-2')
    expect(conflict.receipt?.conflictCommandId).toBe('cmd-1')
    expect(conflict.receipt?.errorCode).toBe('idempotency_key_command_mismatch')
    expect(conflict.receipt?.commandFingerprint).toBe(otherFp)
    expect(conflict.receipt?.actor.clientId).toBe('client-attacker')
    expect(conflict.receipt?.target.id).toBe('thread-other')

    // Durable by distinct commandId; original remains sole idempotency owner.
    const durable = store.getByCommandId('cmd-2')
    expect(durable?.status).toBe('conflict')
    expect(durable?.conflictCommandId).toBe('cmd-1')
    expect(store.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')
    expect(store.getByIdempotencyKey('idem-1')?.status).not.toBe('conflict')

    // No raw command body fields.
    const json = JSON.stringify(durable)
    expect(json).not.toMatch(/args|toolOutput|hiddenReasoning|DIFFERENT/)
  })

  it('treats cancelled as a normal terminal complete status and is idempotent on replay', () => {
    const store = openStore()
    store.begin(baseInput())
    clock = '2026-08-03T17:00:02.000Z'
    const cancelled = store.complete({
      commandId: 'cmd-1',
      status: 'cancelled',
      resultSummary: 'user cancelled'
    })
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.completedAt).toBe(clock)
    expect(cancelled?.resultSummary).toBe('user cancelled')

    // Idempotent complete with same terminal status.
    const again = store.complete({ commandId: 'cmd-1', status: 'cancelled' })
    expect(again?.status).toBe('cancelled')
    expect(again?.completedAt).toBe(clock)

    // Exact re-begin returns the cancelled receipt.
    const replay = store.begin(baseInput())
    expect(replay.kind).toBe('existing')
    if (replay.kind !== 'existing') return
    expect(replay.receipt.status).toBe('cancelled')
  })

  it('does not overwrite an already occupied commandId on mismatch', () => {
    const store = openStore()
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'kept' })

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'OTHER'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-1',
        idempotencyKey: 'idem-other',
        commandFingerprint: otherFp
      })
    )
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') return
    expect(conflict.reason).toBe('command_id_mismatch')
    expect(conflict.existing.commandId).toBe('cmd-1')
    expect(conflict.existing.status).toBe('succeeded')
    expect(conflict.receipt).toBeUndefined()

    // Original unchanged; no second durable row under any other id for this attempt.
    expect(store.getByCommandId('cmd-1')?.status).toBe('succeeded')
    expect(store.getByCommandId('cmd-1')?.resultSummary).toBe('kept')
    expect(store.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')
    expect(store.size).toBe(1)
  })

  it('preserves durable conflict lookup across reopen and compaction', () => {
    const store = openStore({ maxRecords: 10, compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded' })

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'CONFLICT-BODY'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp
      })
    )
    expect(conflict.kind).toBe('conflict')

    // Reopen (simulated Host restart) keeps conflict by commandId and original by key.
    const reopened = openStore({ maxRecords: 10, compactAfterRecords: 1000 })
    expect(reopened.getByCommandId('cmd-2')?.status).toBe('conflict')
    expect(reopened.getByCommandId('cmd-2')?.conflictCommandId).toBe('cmd-1')
    expect(reopened.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')
    expect(reopened.getByIdempotencyKey('idem-1')?.status).toBe('succeeded')

    reopened.compact()
    expect(reopened.getByCommandId('cmd-2')?.status).toBe('conflict')
    expect(reopened.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')

    // Checkpoint-only reopen after compact.
    const fromCheckpoint = openStore({ maxRecords: 10 })
    expect(fromCheckpoint.getByCommandId('cmd-2')?.status).toBe('conflict')
    expect(fromCheckpoint.getByCommandId('cmd-2')?.errorCode).toBe(
      'idempotency_key_command_mismatch'
    )
    expect(fromCheckpoint.getByIdempotencyKey('idem-1')?.commandId).toBe('cmd-1')
  })

  it('reopens after simulated Host restart and preserves terminal receipts', () => {
    const store = openStore()
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'failed', errorCode: 'timeout' })

    // New store instance = simulated Host process restart.
    const reopened = openStore()
    const receipt = reopened.getByCommandId('cmd-1')
    expect(receipt?.status).toBe('failed')
    expect(receipt?.errorCode).toBe('timeout')
    expect(receipt?.idempotencyKey).toBe('idem-1')
    expect(receipt?.recoveryState).toBeUndefined()
  })

  it('promotes interrupted pending commands to recoverable indeterminate on reopen', () => {
    const store = openStore()
    store.begin(baseInput())
    expect(store.getByCommandId('cmd-1')?.status).toBe('pending')

    clock = '2026-08-03T17:00:10.000Z'
    const reopened = openStore()
    const receipt = reopened.getByCommandId('cmd-1')
    expect(receipt?.status).toBe('indeterminate')
    expect(receipt?.recoveryState).toBe('recoverable-indeterminate')

    // Exact re-begin must not re-execute: returns existing indeterminate receipt.
    const again = reopened.begin(baseInput())
    expect(again.kind).toBe('existing')
    if (again.kind !== 'existing') return
    expect(again.receipt.status).toBe('indeterminate')

    // Operator may complete recovery deliberately.
    clock = '2026-08-03T17:00:11.000Z'
    const resolved = reopened.complete({
      commandId: 'cmd-1',
      status: 'denied',
      errorMessage: 'abandoned after crash'
    })
    expect(resolved?.status).toBe('denied')
    expect(resolved?.recoveryState).toBeUndefined()
  })

  it('persists denied status and authority evaluation', () => {
    const store = openStore()
    store.begin(
      baseInput({
        authority: { decision: 'denied', reason: 'policy deny', policy: 'ask' }
      })
    )
    const completed = store.complete({
      commandId: 'cmd-1',
      status: 'denied',
      authority: { decision: 'denied', reason: 'user declined', policy: 'ask' }
    })
    expect(completed?.status).toBe('denied')
    expect(completed?.authority.reason).toBe('user declined')

    const reopened = openStore()
    expect(reopened.getByIdempotencyKey('idem-1')?.status).toBe('denied')
  })

  it('compacts journal into checkpoint and enforces bounded retention', () => {
    const store = openStore({ maxRecords: 3, compactAfterRecords: 2 })

    for (let i = 1; i <= 5; i += 1) {
      clock = `2026-08-03T17:00:0${i}.000Z`
      const fp = hostCommandFingerprint({
        type: 'ping',
        targetKind: 'host',
        targetId: `n-${i}`
      })
      store.begin(
        baseInput({
          commandId: `cmd-${i}`,
          idempotencyKey: `idem-${i}`,
          commandFingerprint: fp,
          target: { kind: 'host', id: `n-${i}` }
        })
      )
      store.complete({ commandId: `cmd-${i}`, status: 'succeeded' })
    }

    store.compact()
    expect(store.size).toBe(3)

    const checkpointPath = join(dataDir, HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME)
    expect(existsSync(checkpointPath)).toBe(true)
    const doc = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { records: unknown[] }
    expect(doc.records).toHaveLength(3)

    // Newest three retained (cmd-3..cmd-5).
    expect(store.getByCommandId('cmd-1')).toBeNull()
    expect(store.getByCommandId('cmd-2')).toBeNull()
    expect(store.getByCommandId('cmd-5')?.status).toBe('succeeded')

    // Reopen from checkpoint only (journal reset on compact).
    const reopened = openStore({ maxRecords: 3 })
    expect(reopened.size).toBe(3)
    expect(reopened.getByCommandId('cmd-5')?.status).toBe('succeeded')
  })

  it('drops a truncated journal tail and keeps prior durable events', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'kept' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    // Append a torn final line without trailing newline.
    writeFileSync(
      journalPath,
      `${prior}{"op":"upsert","record":{"schemaVersion":1,"commandId":"cmd-torn`
    )

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getByCommandId('cmd-1')?.status).toBe('succeeded')
    expect(reopened.getByCommandId('cmd-torn')).toBeNull()
  })

  it('skips a corrupt interior journal line without losing later valid receipts', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded' })

    const fp2 = hostCommandFingerprint({
      type: 'ping',
      targetKind: 'host',
      targetId: 'n-2'
    })
    store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-2',
        commandFingerprint: fp2,
        target: { kind: 'host', id: 'n-2' }
      })
    )
    store.complete({ commandId: 'cmd-2', status: 'failed', errorCode: 'x' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    // Inject corrupt line after the first event pair (begin+complete for cmd-1).
    const corrupted = [...lines.slice(0, 2), 'NOT-JSON', ...lines.slice(2)].join('\n') + '\n'
    writeFileSync(journalPath, corrupted)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getByCommandId('cmd-1')?.status).toBe('succeeded')
    expect(reopened.getByCommandId('cmd-2')?.status).toBe('failed')
  })

  it('does not store unrestricted argument or credential fields on the receipt', () => {
    const store = openStore()
    const begun = store.begin(baseInput())
    expect(begun.kind).toBe('created')
    if (begun.kind !== 'created') return

    const json = JSON.stringify(begun.receipt)
    expect(json).not.toMatch(/password|token|secret|authorization/i)
    expect(begun.receipt).not.toHaveProperty('args')
    expect(begun.receipt).not.toHaveProperty('toolOutput')
    expect(begun.receipt).not.toHaveProperty('hiddenReasoning')
    // Fingerprint is a digest, not raw args.
    expect(begun.receipt.commandFingerprint).toMatch(/^[a-f0-9]+$/)
  })
})
