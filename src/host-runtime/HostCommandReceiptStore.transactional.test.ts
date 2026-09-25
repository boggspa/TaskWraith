import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HostCommandExecutionClass } from './HostCommandExecutionClass'
import { projectHostCommandReceipt } from './HostCommandReceiptProjection'
import {
  HostCommandReceiptStore,
  hostCommandFingerprint,
  HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME,
  HOST_COMMAND_RECEIPT_INDETERMINATE_CODES,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME,
  type HostCommandReceiptActor,
  type HostCommandReceiptBeginInput,
  type HostCommandReceiptRecord
} from './HostCommandReceiptStore'

// Independent Threads M4 slice 9 (design §17): the execution class on a
// receipt, reopen leaving transactional receipts pending, compaction moving
// out of complete(), the transactional indeterminate code, and NH-2 anchors.

const OWNER_ACTOR: HostCommandReceiptActor = {
  clientId: 'client-desktop-1',
  actorId: 'user-1',
  clientClass: 'desktop'
}

const TXN: HostCommandExecutionClass = 'txn-record-persist'
const LEGACY: HostCommandExecutionClass = 'legacy-observed'
const TXN_CODE = 'transaction_recovery_indeterminate'
const POSITION = { generation: 2, cursor: 11 }

function persistInput(
  commandId: string,
  overrides: Partial<HostCommandReceiptBeginInput> = {}
): HostCommandReceiptBeginInput {
  return {
    commandId,
    idempotencyKey: `${commandId}-key`,
    commandName: 'thread.record.persist',
    commandFingerprint: hostCommandFingerprint({
      type: 'thread.record.persist',
      targetKind: 'thread',
      targetId: 'thread-1',
      argsDigest: commandId
    }),
    actor: { ...OWNER_ACTOR },
    target: { kind: 'thread', id: 'thread-1' },
    authority: { decision: 'allowed', reason: 'policy ok', policy: 'workspace' },
    ...overrides
  }
}

type JournalUpsert = { op: 'upsert'; seq?: number; record: Record<string, unknown> }

describe('HostCommandReceiptStore transactional receipts (M4 slice 9)', () => {
  let dataDir: string
  let clock: number
  let logs: string[]
  let scheduled: Array<() => void>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-cmd-receipts-txn-'))
    clock = Date.parse('2026-09-25T09:00:00.000Z')
    logs = []
    scheduled = []
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  const journalPath = () => join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
  const checkpointPath = () => join(dataDir, HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME)
  const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

  function readJournalUpserts(): JournalUpsert[] {
    const text = readText(journalPath())
    if (text === null) return []
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JournalUpsert)
      .filter((event) => event.op === 'upsert')
  }

  function readCheckpointRecords(): Array<Record<string, unknown>> {
    const text = readText(checkpointPath())
    expect(text).not.toBeNull()
    return (JSON.parse(text as string) as { records: Array<Record<string, unknown>> }).records
  }

  function openStore(
    options: {
      maxRecords?: number
      compactAfterRecords?: number
      scheduleCompaction?: (run: () => void) => void
      /** `false` opts into the store's own default seam (setImmediate). */
      collectScheduled?: boolean
    } = {}
  ) {
    const collect = options.collectScheduled ?? true
    return new HostCommandReceiptStore({
      dataDir,
      getPosition: () => ({ ...POSITION }),
      now: () => new Date(clock++).toISOString(),
      log: (line) => logs.push(line),
      maxRecords: options.maxRecords,
      compactAfterRecords: options.compactAfterRecords ?? 1000,
      ...(options.scheduleCompaction
        ? { scheduleCompaction: options.scheduleCompaction }
        : collect
          ? { scheduleCompaction: (run: () => void) => scheduled.push(run) }
          : {})
    })
  }

  function created(result: ReturnType<HostCommandReceiptStore['begin']>): HostCommandReceiptRecord {
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('begin did not create')
    return result.receipt
  }

  function byId(store: HostCommandReceiptStore, commandId: string): HostCommandReceiptRecord {
    const record = store.list().find((entry) => entry.commandId === commandId)
    if (!record) throw new Error(`receipt ${commandId} is not listed`)
    return record
  }

  describe('§17.1 the class on begin', () => {
    it('round-trips the class through the journal, list(), compaction and reopen', () => {
      const store = openStore()
      const receipt = created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      expect(receipt.commandClass).toBe(TXN)
      expect(receipt.status).toBe('pending')

      // Journaled with the record.
      const journaled = readJournalUpserts().find((event) => event.record.commandId === 'cmd-txn')
      expect(journaled?.record.commandClass).toBe(TXN)
      // Visible on the Host-internal listing and the actor-bound lookup.
      expect(byId(store, 'cmd-txn').commandClass).toBe(TXN)
      const found = store.getByCommandId('cmd-txn', OWNER_ACTOR)
      expect(found.kind).toBe('found')
      if (found.kind === 'found') expect(found.receipt.commandClass).toBe(TXN)

      // Survives completion, then compaction into the checkpoint.
      const completed = store.complete({ commandId: 'cmd-txn', status: 'succeeded' })
      expect(completed?.commandClass).toBe(TXN)
      store.compact()
      expect(existsSync(journalPath())).toBe(false)
      const checkpointed = readCheckpointRecords().find((row) => row.commandId === 'cmd-txn')
      expect(checkpointed?.commandClass).toBe(TXN)
      expect(byId(store, 'cmd-txn').commandClass).toBe(TXN)

      // Survives reopen from the checkpoint alone.
      const reopened = openStore()
      expect(byId(reopened, 'cmd-txn')).toMatchObject({ status: 'succeeded', commandClass: TXN })
    })

    it('a pending transactional receipt survives compaction and reopen with its class', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      store.compact()
      const reopened = openStore()
      expect(byId(reopened, 'cmd-txn')).toMatchObject({ status: 'pending', commandClass: TXN })
      expect(byId(reopened, 'cmd-txn')).not.toHaveProperty('recoveryState')
    })

    it('a receipt begun without a class carries no class key anywhere, as today', () => {
      const store = openStore()
      const receipt = created(store.begin(persistInput('cmd-plain')))
      expect(receipt).not.toHaveProperty('commandClass')
      expect(byId(store, 'cmd-plain')).not.toHaveProperty('commandClass')
      const journaled = readJournalUpserts().find((event) => event.record.commandId === 'cmd-plain')
      expect(journaled?.record).not.toHaveProperty('commandClass')
      expect(readText(journalPath())).not.toContain('commandClass')
      store.compact()
      const row = readCheckpointRecords().find((entry) => entry.commandId === 'cmd-plain')
      expect(row).not.toHaveProperty('commandClass')
      expect(byId(openStore(), 'cmd-plain')).not.toHaveProperty('commandClass')
    })

    it('every member of the closed class set is accepted and stored verbatim', () => {
      const store = openStore()
      const classes: HostCommandExecutionClass[] = [
        'txn-record-persist',
        'legacy-observed',
        'control',
        'queued-start',
        'setup'
      ]
      for (const commandClass of classes) {
        const receipt = created(store.begin(persistInput(`cmd-${commandClass}`, { commandClass })))
        expect(receipt.commandClass).toBe(commandClass)
      }
      const listed = openStore().list()
      for (const commandClass of classes) {
        expect(listed.find((r) => r.commandId === `cmd-${commandClass}`)?.commandClass).toBe(
          commandClass
        )
      }
    })

    it('an invalid class throws before any write and leaves nothing indexed', () => {
      const store = openStore()
      for (const bad of ['not-a-class', 'TXN-RECORD-PERSIST', ' txn-record-persist', '', 7, {}]) {
        expect(() =>
          store.begin(
            persistInput('cmd-bad', { commandClass: bad as unknown as HostCommandExecutionClass })
          )
        ).toThrow(/commandClass/)
      }
      expect(existsSync(journalPath())).toBe(false)
      expect(existsSync(checkpointPath())).toBe(false)
      expect(store.size).toBe(0)
      expect(store.list()).toEqual([])
      expect(store.getByCommandId('cmd-bad', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
      expect(store.getByIdempotencyKey('cmd-bad-key', OWNER_ACTOR)).toEqual({ kind: 'not_found' })
      expect(store.getAnchorCounts()).toEqual({
        pending: 0,
        indeterminate: 0,
        transactionalPending: 0
      })
      expect(store.durabilityStatus).toEqual({ kind: 'ok' })

      // The failed begin reserved nothing: the same ids are free to begin.
      const receipt = created(store.begin(persistInput('cmd-bad', { commandClass: TXN })))
      expect(receipt.commandClass).toBe(TXN)
    })

    it('an invalid class on a would-be exact replay throws without returning the receipt', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      const journalBefore = readText(journalPath())
      expect(() =>
        store.begin(
          persistInput('cmd-txn', {
            commandClass: 'bogus' as unknown as HostCommandExecutionClass
          })
        )
      ).toThrow(/commandClass/)
      expect(readText(journalPath())).toBe(journalBefore)
    })

    it('the class never reaches the wire projection', () => {
      const store = openStore()
      const pending = created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      const completed = store.complete({
        commandId: 'cmd-txn',
        status: 'succeeded',
        resultSummary: 'persisted'
      })
      expect(completed).not.toBeNull()
      for (const record of [pending, completed as HostCommandReceiptRecord]) {
        expect(record.commandClass).toBe(TXN)
        const projected = projectHostCommandReceipt(record)
        expect(projected.ok).toBe(true)
        if (!projected.ok) return
        expect(projected.value).not.toHaveProperty('commandClass')
        expect(Object.keys(projected.value)).not.toContain('commandClass')
        expect(JSON.stringify(projected.value)).not.toContain('commandClass')
        expect(JSON.stringify(projected.value)).not.toContain(TXN)
      }
    })

    it('a stored record with an unknown class string reopens unclassified and is promoted', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      created(store.begin(persistInput('cmd-tampered', { commandClass: TXN })))
      store.compact()
      const checkpoint = JSON.parse(readFileSync(checkpointPath(), 'utf8')) as {
        records: Array<Record<string, unknown>>
      }
      const tampered = checkpoint.records.find((row) => row.commandId === 'cmd-tampered')
      expect(tampered).toBeDefined()
      ;(tampered as Record<string, unknown>).commandClass = 'txn-record-persist-v2'
      writeFileSync(checkpointPath(), `${JSON.stringify(checkpoint)}\n`)

      const reopened = openStore()
      // The unknown class is read back without the field, so it is unclassified
      // and takes today's promotion.
      const promoted = byId(reopened, 'cmd-tampered')
      expect(promoted).not.toHaveProperty('commandClass')
      expect(promoted.status).toBe('indeterminate')
      expect(promoted.recoveryState).toBe('recoverable-indeterminate')
      // The genuine transactional neighbour is untouched.
      expect(byId(reopened, 'cmd-txn')).toMatchObject({ status: 'pending', commandClass: TXN })
      expect(reopened.getAnchorCounts()).toEqual({
        pending: 1,
        indeterminate: 1,
        transactionalPending: 1
      })
    })
  })

  describe('§17.2 reopen leaves transactional receipts pending', () => {
    function seedThree() {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      created(store.begin(persistInput('cmd-plain')))
      created(store.begin(persistInput('cmd-legacy', { commandClass: LEGACY })))
      return store
    }

    it('keeps a pending txn-record-persist receipt pending and promotes every other pending one', () => {
      seedThree()
      const journalBefore = readText(journalPath()) as string

      const reopened = openStore()

      const txn = byId(reopened, 'cmd-txn')
      expect(txn.status).toBe('pending')
      expect(txn.commandClass).toBe(TXN)
      expect(txn).not.toHaveProperty('recoveryState')
      expect(txn).not.toHaveProperty('errorCode')
      expect(txn).not.toHaveProperty('completedAt')

      for (const commandId of ['cmd-plain', 'cmd-legacy']) {
        const record = byId(reopened, commandId)
        expect(record.status).toBe('indeterminate')
        expect(record.recoveryState).toBe('recoverable-indeterminate')
        expect(record).not.toHaveProperty('completedAt')
      }
      // A promoted classified receipt keeps its class.
      expect(byId(reopened, 'cmd-legacy').commandClass).toBe(LEGACY)
      expect(byId(reopened, 'cmd-plain')).not.toHaveProperty('commandClass')

      // Exactly the two promotions were journaled, appended after the seed.
      const journalAfter = readText(journalPath()) as string
      expect(journalAfter.startsWith(journalBefore)).toBe(true)
      const appended = journalAfter
        .slice(journalBefore.length)
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JournalUpsert)
      expect(
        appended.map((event) => [event.op, event.record.commandId, event.record.status])
      ).toEqual(
        expect.arrayContaining([
          ['upsert', 'cmd-plain', 'indeterminate'],
          ['upsert', 'cmd-legacy', 'indeterminate']
        ])
      )
      expect(appended).toHaveLength(2)
      expect(appended.some((event) => event.record.commandId === 'cmd-txn')).toBe(false)

      // The transactional receipt is still the actor's pending receipt.
      const lookup = reopened.getByCommandId('cmd-txn', OWNER_ACTOR)
      expect(lookup.kind).toBe('found')
      if (lookup.kind === 'found') expect(lookup.receipt.status).toBe('pending')
    })

    it('a second reopen changes nothing on disk or in memory', () => {
      seedThree()
      const first = openStore()
      const listedAfterFirst = first.list()
      const journalAfterFirst = readText(journalPath())
      const checkpointAfterFirst = readText(checkpointPath())

      const second = openStore()
      expect(second.list()).toEqual(listedAfterFirst)
      expect(readText(journalPath())).toBe(journalAfterFirst)
      expect(readText(checkpointPath())).toBe(checkpointAfterFirst)
      expect(byId(second, 'cmd-txn')).toMatchObject({ status: 'pending', commandClass: TXN })
      expect(second.getAnchorCounts()).toEqual({
        pending: 1,
        indeterminate: 2,
        transactionalPending: 1
      })
    })

    it('the same instance reopening also leaves the transactional receipt pending', () => {
      const store = seedThree()
      store.reopen()
      expect(byId(store, 'cmd-txn')).toMatchObject({ status: 'pending', commandClass: TXN })
      expect(byId(store, 'cmd-plain').status).toBe('indeterminate')
      expect(byId(store, 'cmd-legacy').status).toBe('indeterminate')
    })

    it('a transactional receipt promoted through the journal is left pending on reopen of a checkpoint', () => {
      const store = seedThree()
      store.compact()
      expect(existsSync(journalPath())).toBe(false)
      const reopened = openStore()
      expect(byId(reopened, 'cmd-txn')).toMatchObject({ status: 'pending', commandClass: TXN })
      expect(byId(reopened, 'cmd-plain').status).toBe('indeterminate')
      expect(byId(reopened, 'cmd-legacy').status).toBe('indeterminate')
    })

    it('a still-pending transactional receipt can be completed after reopen', () => {
      seedThree()
      const reopened = openStore()
      const completed = reopened.complete({ commandId: 'cmd-txn', status: 'succeeded' })
      expect(completed).toMatchObject({ status: 'succeeded', commandClass: TXN })
      expect(byId(openStore(), 'cmd-txn')).toMatchObject({ status: 'succeeded', commandClass: TXN })
    })
  })

  describe('§17.3 compaction moves out of complete()', () => {
    it('complete() never compacts synchronously; the scheduled run compacts later', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      expect(scheduled).toHaveLength(0)

      const completed = store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(completed?.status).toBe('succeeded')
      // Due (two journal records), yet nothing compacted on the commit path.
      expect(existsSync(checkpointPath())).toBe(false)
      expect(readJournalUpserts()).toHaveLength(2)
      expect(scheduled).toHaveLength(1)

      scheduled[0]!()
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(readCheckpointRecords().map((row) => [row.commandId, row.status])).toEqual([
        ['cmd-a', 'succeeded']
      ])
      expect(byId(store, 'cmd-a').status).toBe('succeeded')
      expect(store.durabilityStatus).toEqual({ kind: 'ok' })
      // The journal count reset: the next record starts a fresh journal.
      created(store.begin(persistInput('cmd-b')))
      expect(readJournalUpserts()).toHaveLength(1)
    })

    it('several completes in one turn schedule one compaction', () => {
      const store = openStore({ compactAfterRecords: 4 })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      created(store.begin(persistInput('cmd-b')))
      created(store.begin(persistInput('cmd-c')))
      expect(scheduled).toHaveLength(0)

      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      store.complete({ commandId: 'cmd-b', status: 'failed', errorCode: 'boom' })
      store.complete({ commandId: 'cmd-c', status: 'cancelled' })
      expect(scheduled).toHaveLength(1)
      expect(existsSync(checkpointPath())).toBe(false)
      expect(readJournalUpserts()).toHaveLength(6)

      scheduled[0]!()
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(
        readCheckpointRecords()
          .map((row) => row.status)
          .sort()
      ).toEqual(['cancelled', 'failed', 'succeeded'])

      // Once the scheduled run has happened, a later due complete schedules again.
      for (const id of ['cmd-d', 'cmd-e', 'cmd-f', 'cmd-g']) {
        created(store.begin(persistInput(id)))
      }
      // The fourth begin compacted inline; complete() below makes it due again
      // only once the journal refills.
      const scheduledBefore = scheduled.length
      created(store.begin(persistInput('cmd-h')))
      created(store.begin(persistInput('cmd-i')))
      created(store.begin(persistInput('cmd-j')))
      store.complete({ commandId: 'cmd-h', status: 'succeeded' })
      store.complete({ commandId: 'cmd-i', status: 'succeeded' })
      expect(scheduled.length).toBe(scheduledBefore + 1)
    })

    it('a complete that is not due schedules nothing', () => {
      const store = openStore({ compactAfterRecords: 1000 })
      created(store.begin(persistInput('cmd-a')))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(scheduled).toHaveLength(0)
      expect(existsSync(checkpointPath())).toBe(false)
    })

    it('the scheduled run compacts nothing extra when compaction already happened inline', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a')))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(scheduled).toHaveLength(1)
      // An inline-compacting begin lands before the scheduled turn.
      created(store.begin(persistInput('cmd-b')))
      expect(existsSync(checkpointPath())).toBe(true)
      const recordsBefore = store.list()
      expect(existsSync(journalPath())).toBe(false)
      expect(() => scheduled[0]!()).not.toThrow()
      // Whether or not the late run rewrites the checkpoint, nothing is lost.
      expect(store.list()).toEqual(recordsBefore)
      expect(
        readCheckpointRecords()
          .map((row) => row.commandId)
          .sort()
      ).toEqual(['cmd-a', 'cmd-b'])
      expect(existsSync(journalPath())).toBe(false)
      expect(store.durabilityStatus).toEqual({ kind: 'ok' })
    })

    it('defaults the seam to setImmediate: nothing synchronous, compacted by the next turn', async () => {
      const store = openStore({ compactAfterRecords: 2, collectScheduled: false })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(existsSync(checkpointPath())).toBe(false)
      expect(readJournalUpserts()).toHaveLength(2)
      // Microtasks run before immediates: still not compacted.
      await Promise.resolve()
      expect(existsSync(checkpointPath())).toBe(false)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(byId(store, 'cmd-a')).toMatchObject({ status: 'succeeded', commandClass: TXN })
    })

    it('begin still compacts inline', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a')))
      expect(existsSync(checkpointPath())).toBe(false)
      created(store.begin(persistInput('cmd-b', { commandClass: TXN })))
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(scheduled).toHaveLength(0)
      expect(
        readCheckpointRecords()
          .map((row) => row.commandId)
          .sort()
      ).toEqual(['cmd-a', 'cmd-b'])
    })

    it("a begin conflict's retention pin still compacts inline", () => {
      const store = openStore({ maxRecords: 2, compactAfterRecords: 3 })
      created(store.begin(persistInput('cmd-owner')))
      store.complete({ commandId: 'cmd-owner', status: 'succeeded' })
      expect(scheduled).toHaveLength(0)
      const conflict = store.begin(
        persistInput('cmd-attempt', {
          idempotencyKey: 'cmd-owner-key',
          commandFingerprint: 'f'.repeat(64)
        })
      )
      expect(conflict.kind).toBe('conflict')
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(scheduled).toHaveLength(0)
      expect(
        readCheckpointRecords()
          .map((row) => row.commandId)
          .sort()
      ).toEqual(['cmd-attempt', 'cmd-owner'])
    })

    it('updatePhase still compacts inline', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a', { commandName: 'composer.send' })))
      const updated = store.updatePhase('cmd-a', 'queued')
      expect(updated.kind).toBe('updated')
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(scheduled).toHaveLength(0)
    })

    it('markIndeterminate still compacts inline', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      const marked = store.markIndeterminate({
        commandId: 'cmd-a',
        position: POSITION,
        errorCode: TXN_CODE
      })
      expect(marked.kind).toBe('marked')
      expect(existsSync(checkpointPath())).toBe(true)
      expect(existsSync(journalPath())).toBe(false)
      expect(scheduled).toHaveLength(0)
      expect(readCheckpointRecords()[0]).toMatchObject({
        commandId: 'cmd-a',
        status: 'indeterminate',
        commandClass: TXN
      })
    })

    it('a failed scheduled compaction is logged, and the receipt stays complete', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(scheduled).toHaveLength(1)
      const journalBefore = readText(journalPath())

      // The checkpoint rename cannot land on a directory.
      mkdirSync(checkpointPath())
      writeFileSync(join(checkpointPath(), 'occupied'), 'x')
      logs.length = 0

      expect(() => scheduled[0]!()).not.toThrow()
      expect(logs.some((line) => /compaction/i.test(line) && /EISDIR/.test(line))).toBe(true)
      // The witness is untouched: journal intact, receipt terminal, writes still allowed.
      expect(readText(journalPath())).toBe(journalBefore)
      expect(byId(store, 'cmd-a')).toMatchObject({ status: 'succeeded', commandClass: TXN })
      expect(store.durabilityStatus).toEqual({ kind: 'ok' })
      expect(store.complete({ commandId: 'cmd-a', status: 'succeeded' })?.status).toBe('succeeded')
      created(store.begin(persistInput('cmd-b')))

      // An explicit compact() still throws to its caller.
      expect(() => store.compact()).toThrow(/EISDIR/)

      // A fresh reopen sees the durable journal, not a half-written checkpoint.
      rmSync(checkpointPath(), { recursive: true, force: true })
      const reopened = openStore()
      expect(byId(reopened, 'cmd-a')).toMatchObject({ status: 'succeeded', commandClass: TXN })
      expect(byId(reopened, 'cmd-b').status).toBe('indeterminate')
    })

    it('a scheduled run after the store became unavailable does not throw out of the callback', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a', { commandClass: TXN })))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(scheduled).toHaveLength(1)

      // A checkpoint that exists but is not a document blocks write authority.
      writeFileSync(checkpointPath(), 'not json\n')
      store.reopen()
      expect(store.durabilityStatus).toEqual({ kind: 'unavailable', code: 'checkpoint_unreadable' })
      const journalBefore = readText(journalPath())
      const checkpointBefore = readText(checkpointPath())
      logs.length = 0

      expect(() => scheduled[0]!()).not.toThrow()
      expect(readText(journalPath())).toBe(journalBefore)
      expect(readText(checkpointPath())).toBe(checkpointBefore)
      expect(store.durabilityStatus).toEqual({ kind: 'unavailable', code: 'checkpoint_unreadable' })
      // The last durable view is still readable.
      expect(byId(store, 'cmd-a')).toMatchObject({ status: 'succeeded', commandClass: TXN })
    })

    it('a scheduled run whose seam fires twice compacts once and stays clean', () => {
      const store = openStore({ compactAfterRecords: 2 })
      created(store.begin(persistInput('cmd-a')))
      store.complete({ commandId: 'cmd-a', status: 'succeeded' })
      expect(scheduled).toHaveLength(1)
      scheduled[0]!()
      const recordsAfter = readCheckpointRecords()
      expect(() => scheduled[0]!()).not.toThrow()
      expect(readCheckpointRecords()).toEqual(recordsAfter)
      expect(store.list().map((row) => row.status)).toEqual(['succeeded'])
      expect(existsSync(journalPath())).toBe(false)
      expect(store.durabilityStatus).toEqual({ kind: 'ok' })
    })
  })

  describe('§17.4 the transactional indeterminate code', () => {
    it('is a member of the closed code set', () => {
      expect(HOST_COMMAND_RECEIPT_INDETERMINATE_CODES.has(TXN_CODE)).toBe(true)
    })

    it('marks a pending transactional receipt, keeping its class and no completedAt', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      const marked = store.markIndeterminate({
        commandId: 'cmd-txn',
        position: { generation: 3, cursor: 40 },
        errorCode: TXN_CODE
      })
      expect(marked.kind).toBe('marked')
      if (marked.kind !== 'marked') return
      expect(marked.receipt).toMatchObject({
        status: 'indeterminate',
        recoveryState: 'recoverable-indeterminate',
        errorCode: TXN_CODE,
        commandClass: TXN,
        generation: 3,
        cursor: 40
      })
      expect(marked.receipt).not.toHaveProperty('completedAt')
      const journaled = readJournalUpserts().filter((event) => event.record.commandId === 'cmd-txn')
      expect(journaled).toHaveLength(2)
      expect(journaled[1]!.record).toMatchObject({
        status: 'indeterminate',
        errorCode: TXN_CODE,
        commandClass: TXN
      })
      expect(byId(openStore(), 'cmd-txn')).toMatchObject({
        status: 'indeterminate',
        errorCode: TXN_CODE,
        commandClass: TXN
      })
    })

    it('marks a transactional receipt that reopen left pending (the recovery driver path)', () => {
      const seed = openStore()
      created(seed.begin(persistInput('cmd-txn', { commandClass: TXN })))
      const reopened = openStore()
      expect(byId(reopened, 'cmd-txn').status).toBe('pending')
      const marked = reopened.markIndeterminate({
        commandId: 'cmd-txn',
        position: POSITION,
        errorCode: TXN_CODE
      })
      expect(marked.kind).toBe('marked')
      expect(byId(reopened, 'cmd-txn')).toMatchObject({
        status: 'indeterminate',
        recoveryState: 'recoverable-indeterminate',
        errorCode: TXN_CODE,
        commandClass: TXN
      })
      // Later complete() still resolves it, as for any recoverable-indeterminate receipt.
      const completed = reopened.complete({ commandId: 'cmd-txn', status: 'failed' })
      expect(completed).toMatchObject({ status: 'failed', commandClass: TXN })
      expect(completed).not.toHaveProperty('recoveryState')
    })

    it('leaves an already-indeterminate receipt untouched with no rewrite', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      created(store.begin(persistInput('cmd-plain')))
      const first = store.markIndeterminate({
        commandId: 'cmd-txn',
        position: { generation: 3, cursor: 40 },
        errorCode: 'deferred_receipt_uncertain'
      })
      expect(first.kind).toBe('marked')
      // A reopen-promoted receipt is indeterminate too.
      const reopened = openStore()
      expect(byId(reopened, 'cmd-plain').status).toBe('indeterminate')
      const journalBefore = readText(journalPath())

      for (const commandId of ['cmd-txn', 'cmd-plain']) {
        const before = byId(reopened, commandId)
        const again = reopened.markIndeterminate({
          commandId,
          position: { generation: 9, cursor: 999 },
          errorCode: TXN_CODE
        })
        expect(again.kind).toBe('already_indeterminate')
        if (again.kind !== 'already_indeterminate') return
        expect(again.receipt).toEqual(before)
        expect(byId(reopened, commandId)).toEqual(before)
      }
      expect(byId(reopened, 'cmd-txn').errorCode).toBe('deferred_receipt_uncertain')
      expect(byId(reopened, 'cmd-plain')).not.toHaveProperty('errorCode')
      expect(readText(journalPath())).toBe(journalBefore)
    })

    it('refuses the code on a terminal receipt without writing', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      store.complete({ commandId: 'cmd-txn', status: 'succeeded' })
      const journalBefore = readText(journalPath())
      expect(
        store.markIndeterminate({ commandId: 'cmd-txn', position: POSITION, errorCode: TXN_CODE })
      ).toEqual({ kind: 'terminal_refused', status: 'succeeded' })
      expect(readText(journalPath())).toBe(journalBefore)
    })
  })

  describe('§17.5 NH-2 anchors', () => {
    const counts = (pending: number, indeterminate: number, transactionalPending: number) => ({
      pending,
      indeterminate,
      transactionalPending
    })

    it('counts pending, indeterminate and transactional-pending receipts', () => {
      const store = openStore()
      expect(store.getAnchorCounts()).toEqual(counts(0, 0, 0))

      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      expect(store.getAnchorCounts()).toEqual(counts(1, 0, 1))
      created(store.begin(persistInput('cmd-plain')))
      created(store.begin(persistInput('cmd-legacy', { commandClass: LEGACY })))
      expect(store.getAnchorCounts()).toEqual(counts(3, 0, 1))

      // Marking moves a transactional anchor out of transactionalPending, not out of anchors.
      expect(
        store.markIndeterminate({ commandId: 'cmd-txn', position: POSITION, errorCode: TXN_CODE })
          .kind
      ).toBe('marked')
      expect(store.getAnchorCounts()).toEqual(counts(2, 1, 0))

      // Only complete() retires an anchor.
      store.complete({ commandId: 'cmd-plain', status: 'succeeded' })
      expect(store.getAnchorCounts()).toEqual(counts(1, 1, 0))
      store.complete({ commandId: 'cmd-txn', status: 'failed' })
      expect(store.getAnchorCounts()).toEqual(counts(1, 0, 0))
      store.complete({ commandId: 'cmd-legacy', status: 'cancelled' })
      expect(store.getAnchorCounts()).toEqual(counts(0, 0, 0))
    })

    it('does not count terminal, conflict or exact-replay rows', () => {
      const store = openStore()
      created(store.begin(persistInput('cmd-owner', { commandClass: TXN })))
      expect(store.begin(persistInput('cmd-owner', { commandClass: TXN })).kind).toBe('existing')
      expect(store.getAnchorCounts()).toEqual(counts(1, 0, 1))
      const conflict = store.begin(
        persistInput('cmd-attempt', {
          idempotencyKey: 'cmd-owner-key',
          commandFingerprint: 'e'.repeat(64),
          commandClass: TXN
        })
      )
      expect(conflict.kind).toBe('conflict')
      expect(store.getAnchorCounts()).toEqual(counts(1, 0, 1))
      store.complete({ commandId: 'cmd-owner', status: 'succeeded' })
      expect(store.getAnchorCounts()).toEqual(counts(0, 0, 0))
      expect(store.size).toBe(2)
    })

    it('reopen keeps the transactional pending anchor and moves the others to indeterminate', () => {
      const seed = openStore()
      created(seed.begin(persistInput('cmd-txn', { commandClass: TXN })))
      created(seed.begin(persistInput('cmd-plain')))
      created(seed.begin(persistInput('cmd-legacy', { commandClass: LEGACY })))
      expect(seed.getAnchorCounts()).toEqual(counts(3, 0, 1))

      const reopened = openStore()
      expect(reopened.getAnchorCounts()).toEqual(counts(1, 2, 1))
      // The total anchor count is unchanged by reopen: pending receipts were already counted.
      expect(openStore().getAnchorCounts()).toEqual(counts(1, 2, 1))
    })

    it('the ceiling is maxRecords: begin answers capacity_refused and counts hold', () => {
      const store = openStore({ maxRecords: 2 })
      created(store.begin(persistInput('cmd-txn', { commandClass: TXN })))
      created(store.begin(persistInput('cmd-plain')))
      expect(store.getAnchorCounts()).toEqual(counts(2, 0, 1))
      expect(store.begin(persistInput('cmd-more', { commandClass: TXN }))).toEqual({
        kind: 'capacity_refused'
      })
      expect(store.getAnchorCounts()).toEqual(counts(2, 0, 1))
      // Reopen keeps every anchor: still at the ceiling, still refused.
      const reopened = openStore({ maxRecords: 2 })
      expect(reopened.getAnchorCounts()).toEqual(counts(1, 1, 1))
      expect(reopened.begin(persistInput('cmd-more', { commandClass: TXN }))).toEqual({
        kind: 'capacity_refused'
      })
      // Only complete() opens a slot.
      reopened.complete({ commandId: 'cmd-txn', status: 'succeeded' })
      expect(reopened.getAnchorCounts()).toEqual(counts(0, 1, 0))
      expect(reopened.begin(persistInput('cmd-more', { commandClass: TXN })).kind).toBe('created')
      expect(reopened.getAnchorCounts()).toEqual(counts(1, 1, 1))
    })

    it('returns a fresh object each call', () => {
      const store = openStore()
      const a = store.getAnchorCounts()
      a.pending = 99
      expect(store.getAnchorCounts()).toEqual(counts(0, 0, 0))
    })
  })
})
