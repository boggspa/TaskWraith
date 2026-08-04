import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HostCommandReceiptStore,
  hostCommandFingerprint,
  HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME,
  type HostCommandReceiptActor,
  type HostCommandReceiptBeginInput,
  type HostCommandReceiptPosition
} from './HostCommandReceiptStore'

const OWNER_ACTOR: HostCommandReceiptActor = {
  clientId: 'client-tui-1',
  actorId: 'user-1',
  clientClass: 'tui'
}

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
    commandName: 'composer.send',
    commandFingerprint: fingerprint,
    actor: { ...OWNER_ACTOR },
    target: { kind: 'thread', id: 'thread-1' },
    authority: { decision: 'allowed', reason: 'policy ok', policy: 'workspace' },
    ...overrides
  }
}

describe('HostCommandReceiptStore', () => {
  let dataDir: string
  let clock: string
  let position: HostCommandReceiptPosition

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-cmd-receipts-'))
    clock = '2026-08-03T17:00:00.000Z'
    position = { generation: 1, cursor: 0 }
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: { maxRecords?: number; compactAfterRecords?: number }) {
    return new HostCommandReceiptStore({
      dataDir,
      getPosition: () => ({ ...position }),
      now: () => clock,
      maxRecords: options?.maxRecords,
      compactAfterRecords: options?.compactAfterRecords
    })
  }

  function expectFound(
    result: ReturnType<HostCommandReceiptStore['getByCommandId']>,
    status?: string
  ) {
    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return null
    if (status) expect(result.receipt.status).toBe(status)
    return result.receipt
  }

  it('requires an injected getPosition callback', () => {
    expect(
      () =>
        new HostCommandReceiptStore({
          dataDir,
          // @ts-expect-error intentional missing getPosition
          getPosition: undefined
        })
    ).toThrow(/getPosition/)
  })

  it('persists pending then terminal receipts with name, exact actor, and delta position', () => {
    position = { generation: 3, cursor: 7 }
    const store = openStore()
    const begun = store.begin(baseInput())
    expect(begun.kind).toBe('created')
    if (begun.kind !== 'created') return

    expect(begun.receipt.status).toBe('pending')
    expect(begun.receipt.commandName).toBe('composer.send')
    expect(begun.receipt.generation).toBe(3)
    expect(begun.receipt.cursor).toBe(7)
    expect(begun.receipt.actor).toEqual(OWNER_ACTOR)
    expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'pending')
    expectFound(store.getByIdempotencyKey('idem-1', OWNER_ACTOR))

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
    // Position is mint-time; completion does not invent a new journal.
    expect(completed?.generation).toBe(3)
    expect(completed?.cursor).toBe(7)
  })

  it('refreshes position at terminal completion and preserves it through reopen/compaction', () => {
    position = { generation: 3, cursor: 7 }
    const store = openStore()
    store.begin(baseInput())

    const completed = store.complete({
      commandId: 'cmd-1',
      status: 'succeeded',
      position: { generation: 3, cursor: 42 }
    })
    expect(completed?.generation).toBe(3)
    expect(completed?.cursor).toBe(42)

    store.compact()
    const reopened = openStore()
    const durable = expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expect(durable?.generation).toBe(3)
    expect(durable?.cursor).toBe(42)
  })

  it('preserves the begin position when completion omits a refreshed position', () => {
    position = { generation: 3, cursor: 7 }
    const store = openStore()
    store.begin(baseInput())

    const completed = store.complete({ commandId: 'cmd-1', status: 'succeeded' })
    expect(completed?.generation).toBe(3)
    expect(completed?.cursor).toBe(7)
  })

  it.each([
    { generation: -1, cursor: 42 },
    { generation: 3, cursor: 1.5 }
  ])('rejects invalid completion position without journal mutation', (invalidPosition) => {
    const store = openStore()
    store.begin(baseInput())
    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const before = readFileSync(journalPath, 'utf8')

    expect(() =>
      store.complete({
        commandId: 'cmd-1',
        status: 'succeeded',
        position: invalidPosition
      })
    ).toThrow(/generation|cursor/)

    expect(readFileSync(journalPath, 'utf8')).toBe(before)
    const pending = expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'pending')
    expect(pending?.generation).toBe(1)
    expect(pending?.cursor).toBe(0)
  })

  it('returns the original receipt for an exact repeated command from the same actor', () => {
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

  it('denies exact replay and lookup across actors without exposing the body', () => {
    const store = openStore()
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'secret-ok' })

    const other: HostCommandReceiptActor = {
      clientId: 'client-other',
      actorId: 'user-other',
      clientClass: 'desktop'
    }
    const denied = store.begin(baseInput({ actor: other }))
    expect(denied.kind).toBe('actor_denied')
    expect(denied).not.toHaveProperty('receipt')
    expect(JSON.stringify(denied)).not.toMatch(/secret-ok/)

    expect(store.getByCommandId('cmd-1', other)).toEqual({ kind: 'actor_mismatch' })
    expect(store.getByIdempotencyKey('idem-1', other)).toEqual({ kind: 'actor_mismatch' })
    expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
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
        actor: { clientId: 'client-attacker', clientClass: 'tui', actorId: 'user-x' },
        target: { kind: 'thread', id: 'thread-other' }
      })
    )
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') return
    expect(conflict.reason).toBe('idempotency_key_command_mismatch')
    // Cross-actor conflict must not expose the original body.
    expect(conflict.existing).toBeUndefined()
    expect(conflict.requestedFingerprint).toBe(otherFp)
    expect(conflict.receipt?.status).toBe('conflict')
    expect(conflict.receipt?.commandId).toBe('cmd-2')
    expect(conflict.receipt?.commandName).toBe('composer.send')
    expect(conflict.receipt?.conflictCommandId).toBe('cmd-1')
    expect(conflict.receipt?.errorCode).toBe('idempotency_key_command_mismatch')
    expect(conflict.receipt?.commandFingerprint).toBe(otherFp)
    expect(conflict.receipt?.actor.clientId).toBe('client-attacker')
    expect(conflict.receipt?.target?.id).toBe('thread-other')
    expect(conflict.receipt?.authority.decision).toBe('denied')
    expect(conflict.receipt?.authority.reason).toBe('idempotency_key_command_mismatch')

    const durable = expectFound(
      store.getByCommandId('cmd-2', {
        clientId: 'client-attacker',
        actorId: 'user-x',
        clientClass: 'tui'
      }),
      'conflict'
    )
    expect(durable?.conflictCommandId).toBe('cmd-1')
    expectFound(store.getByIdempotencyKey('idem-1', OWNER_ACTOR), 'pending')

    const json = JSON.stringify(durable)
    expect(json).not.toMatch(/args|toolOutput|hiddenReasoning|DIFFERENT/)
  })

  it('includes existing on same-actor fingerprint conflict', () => {
    const store = openStore()
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'owner' })

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'SAME-ACTOR-CONFLICT'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp
      })
    )
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') return
    expect(conflict.existing?.commandId).toBe('cmd-1')
    expect(conflict.existing?.resultSummary).toBe('owner')
    expect(conflict.receipt?.status).toBe('conflict')
  })

  it('persists fixed denied conflict authority even when caller supplied allowed', () => {
    const store = openStore()
    store.begin(baseInput())

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'ATTACK'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-attack',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp,
        authority: { decision: 'allowed', reason: 'spoofed grant', policy: 'workspace' }
      })
    )
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict') return
    expect(conflict.receipt?.authority.decision).toBe('denied')
    expect(conflict.receipt?.authority.reason).toBe('idempotency_key_command_mismatch')
    expect(conflict.receipt?.authority.reason).not.toBe('spoofed grant')
    expect(conflict.receipt?.authority.policy).toBeUndefined()

    const reopened = openStore()
    const attack = expectFound(reopened.getByCommandId('cmd-attack', OWNER_ACTOR), 'conflict')
    expect(attack?.authority.decision).toBe('denied')
    expect(attack?.authority.reason).toBe('idempotency_key_command_mismatch')
  })

  it('at maxRecords=1 retains original owner over conflict and blocks fresh pending mint', () => {
    const store = openStore({ maxRecords: 1, compactAfterRecords: 1000 })
    const first = store.begin(baseInput())
    expect(first.kind).toBe('created')
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'owner' })

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'CONFLICT-AT-BOUND'
    })
    const conflict = store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp
      })
    )
    expect(conflict.kind).toBe('conflict')

    store.compact()
    expect(store.size).toBe(1)
    expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expect(store.getByCommandId('cmd-2', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
    expectFound(store.getByIdempotencyKey('idem-1', OWNER_ACTOR), 'succeeded')

    const again = store.begin(baseInput())
    expect(again.kind).toBe('existing')
    if (again.kind !== 'existing') return
    expect(again.receipt.commandId).toBe('cmd-1')
    expect(again.receipt.status).toBe('succeeded')

    const reopened = openStore({ maxRecords: 1 })
    expect(reopened.size).toBe(1)
    expectFound(reopened.getByIdempotencyKey('idem-1', OWNER_ACTOR))
    expect(reopened.getByCommandId('cmd-2', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
    const replay = reopened.begin(baseInput())
    expect(replay.kind).toBe('existing')
    if (replay.kind !== 'existing') return
    expect(replay.receipt.status).toBe('succeeded')
  })

  it('compact-journal replay does not erase live owner when removing a conflict', () => {
    const store = openStore({ maxRecords: 10, compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded' })

    const otherFp = hostCommandFingerprint({
      type: 'composer.send',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: 'JOURNAL-COMPACT-CONFLICT'
    })
    store.begin(
      baseInput({
        commandId: 'cmd-2',
        idempotencyKey: 'idem-1',
        commandFingerprint: otherFp
      })
    )
    expectFound(store.getByCommandId('cmd-2', OWNER_ACTOR), 'conflict')
    expectFound(store.getByIdempotencyKey('idem-1', OWNER_ACTOR))

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const compactEvent = JSON.stringify({
      op: 'compact',
      retainedCommandIds: ['cmd-1'],
      at: '2026-08-03T17:00:50.000Z'
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${compactEvent}\n`)

    const reopened = openStore({ maxRecords: 10, compactAfterRecords: 1000 })
    expect(reopened.getByCommandId('cmd-2', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
    expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expectFound(reopened.getByIdempotencyKey('idem-1', OWNER_ACTOR), 'succeeded')
  })

  it('rejects malformed commandFingerprint that is not exact 64 lowercase hex', () => {
    const store = openStore()
    expect(() =>
      store.begin(
        baseInput({
          commandFingerprint: 'not-a-sha256'
        })
      )
    ).toThrow(/64-char lowercase hex SHA-256/)

    expect(() =>
      store.begin(
        baseInput({
          commandFingerprint: 'a'.repeat(63)
        })
      )
    ).toThrow(/64-char lowercase hex SHA-256/)

    expect(() =>
      store.begin(
        baseInput({
          commandFingerprint: 'a'.repeat(65)
        })
      )
    ).toThrow(/64-char lowercase hex SHA-256/)

    expect(() =>
      store.begin(
        baseInput({
          commandFingerprint: 'g'.repeat(64)
        })
      )
    ).toThrow(/64-char lowercase hex SHA-256/)
  })

  it('rejects begin without exact actor identity', () => {
    const store = openStore()
    expect(() =>
      store.begin(
        baseInput({
          actor: { clientId: 'client-only' }
        })
      )
    ).toThrow(/actor\.actorId/)
    expect(() =>
      store.begin(
        baseInput({
          actor: { clientId: 'client-1', actorId: 'a1', clientClass: 'bogus' as 'tui' }
        })
      )
    ).toThrow(/actor\.clientClass/)
  })

  it('skips legacy/malformed fingerprint records on reopen honestly', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const badFp = 'deadbeef'
    const malformed = JSON.stringify({
      op: 'upsert',
      record: {
        schemaVersion: 1,
        commandId: 'cmd-bad-fp',
        idempotencyKey: 'idem-bad-fp',
        commandFingerprint: badFp,
        status: 'succeeded',
        actor: { clientId: 'client-tui-1' },
        target: { kind: 'host', id: 'n' },
        authority: { decision: 'allowed' },
        createdAt: '2026-08-03T17:00:20.000Z',
        updatedAt: '2026-08-03T17:00:20.000Z',
        completedAt: '2026-08-03T17:00:20.000Z'
      }
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${malformed}\n`)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expect(reopened.getByCommandId('cmd-bad-fp', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
  })

  it('retains incomplete legacy rows without inventing identity/position; access fails closed', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const legacy = JSON.stringify({
      op: 'upsert',
      record: {
        schemaVersion: 1,
        commandId: 'cmd-legacy',
        idempotencyKey: 'idem-legacy',
        commandFingerprint: 'c'.repeat(64),
        status: 'succeeded',
        // Pre-4A shape: clientId only, no name/position.
        actor: { clientId: 'client-legacy' },
        target: { kind: 'thread', id: 't-legacy' },
        authority: { decision: 'allowed' },
        createdAt: '2026-08-03T16:00:00.000Z',
        updatedAt: '2026-08-03T16:00:00.000Z',
        completedAt: '2026-08-03T16:00:00.000Z'
      }
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${legacy}\n`)

    const reopened = openStore({ compactAfterRecords: 1000 })
    // Retained on disk / in list — not silently deleted.
    const listed = reopened.list().find((r) => r.commandId === 'cmd-legacy')
    expect(listed).toBeTruthy()
    expect(listed?.commandName).toBeUndefined()
    expect(listed?.generation).toBeUndefined()
    expect(listed?.cursor).toBeUndefined()
    expect(listed?.actor.actorId).toBeUndefined()
    // Actor-bound access fails closed without inventing.
    expect(
      reopened.getByCommandId('cmd-legacy', {
        clientId: 'client-legacy',
        actorId: 'invented',
        clientClass: 'tui'
      })
    ).toEqual({ kind: 'incomplete' })
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

    const again = store.complete({ commandId: 'cmd-1', status: 'cancelled' })
    expect(again?.status).toBe('cancelled')
    expect(again?.completedAt).toBe(clock)

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
    expect(conflict.existing?.commandId).toBe('cmd-1')
    expect(conflict.existing?.status).toBe('succeeded')
    expect(conflict.receipt).toBeUndefined()

    expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expect(expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR))?.resultSummary).toBe('kept')
    expectFound(store.getByIdempotencyKey('idem-1', OWNER_ACTOR))
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

    const reopened = openStore({ maxRecords: 10, compactAfterRecords: 1000 })
    expectFound(reopened.getByCommandId('cmd-2', OWNER_ACTOR), 'conflict')
    expect(expectFound(reopened.getByCommandId('cmd-2', OWNER_ACTOR))?.conflictCommandId).toBe(
      'cmd-1'
    )
    expectFound(reopened.getByIdempotencyKey('idem-1', OWNER_ACTOR), 'succeeded')

    reopened.compact()
    expectFound(reopened.getByCommandId('cmd-2', OWNER_ACTOR), 'conflict')
    expectFound(reopened.getByIdempotencyKey('idem-1', OWNER_ACTOR))

    const fromCheckpoint = openStore({ maxRecords: 10 })
    const conflictReceipt = expectFound(
      fromCheckpoint.getByCommandId('cmd-2', OWNER_ACTOR),
      'conflict'
    )
    expect(conflictReceipt?.errorCode).toBe('idempotency_key_command_mismatch')
    expectFound(fromCheckpoint.getByIdempotencyKey('idem-1', OWNER_ACTOR))
  })

  it('reopens after simulated Host restart and preserves terminal receipts', () => {
    const store = openStore()
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'failed', errorCode: 'timeout' })

    const reopened = openStore()
    const receipt = expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'failed')
    expect(receipt?.errorCode).toBe('timeout')
    expect(receipt?.idempotencyKey).toBe('idem-1')
    expect(receipt?.commandName).toBe('composer.send')
    expect(receipt?.generation).toBe(1)
    expect(receipt?.recoveryState).toBeUndefined()
  })

  it('promotes interrupted pending commands to recoverable indeterminate on reopen', () => {
    const store = openStore()
    store.begin(baseInput())
    expectFound(store.getByCommandId('cmd-1', OWNER_ACTOR), 'pending')

    clock = '2026-08-03T17:00:10.000Z'
    const reopened = openStore()
    const receipt = expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'indeterminate')
    expect(receipt?.recoveryState).toBe('recoverable-indeterminate')

    const again = reopened.begin(baseInput())
    expect(again.kind).toBe('existing')
    if (again.kind !== 'existing') return
    expect(again.receipt.status).toBe('indeterminate')

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
    expectFound(reopened.getByIdempotencyKey('idem-1', OWNER_ACTOR), 'denied')
  })

  it('compacts journal into checkpoint and enforces bounded retention', () => {
    const store = openStore({ maxRecords: 3, compactAfterRecords: 2 })

    for (let i = 1; i <= 5; i += 1) {
      clock = `2026-08-03T17:00:0${i}.000Z`
      position = { generation: 1, cursor: i }
      const fp = hostCommandFingerprint({
        type: 'ping',
        targetKind: 'host',
        targetId: `n-${i}`
      })
      store.begin(
        baseInput({
          commandId: `cmd-${i}`,
          idempotencyKey: `idem-${i}`,
          commandName: 'ping',
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

    expect(store.getByCommandId('cmd-1', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
    expect(store.getByCommandId('cmd-2', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
    expectFound(store.getByCommandId('cmd-5', OWNER_ACTOR), 'succeeded')

    const reopened = openStore({ maxRecords: 3 })
    expect(reopened.size).toBe(3)
    expectFound(reopened.getByCommandId('cmd-5', OWNER_ACTOR), 'succeeded')
  })

  it('drops a truncated journal tail and keeps prior durable events', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.begin(baseInput())
    store.complete({ commandId: 'cmd-1', status: 'succeeded', resultSummary: 'kept' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    writeFileSync(
      journalPath,
      `${prior}{"op":"upsert","record":{"schemaVersion":1,"commandId":"cmd-torn`
    )

    const reopened = openStore({ compactAfterRecords: 1000 })
    expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expect(reopened.getByCommandId('cmd-torn', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
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
        commandName: 'ping',
        commandFingerprint: fp2,
        target: { kind: 'host', id: 'n-2' }
      })
    )
    store.complete({ commandId: 'cmd-2', status: 'failed', errorCode: 'x' })

    const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    const corrupted = [...lines.slice(0, 2), 'NOT-JSON', ...lines.slice(2)].join('\n') + '\n'
    writeFileSync(journalPath, corrupted)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expectFound(reopened.getByCommandId('cmd-1', OWNER_ACTOR), 'succeeded')
    expectFound(reopened.getByCommandId('cmd-2', OWNER_ACTOR), 'failed')
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
    expect(begun.receipt.commandFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
})
