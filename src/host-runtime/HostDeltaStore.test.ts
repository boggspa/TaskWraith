import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOST_PROJECTION_VERSION } from '../shared/hostProtocol'

import {
  HOST_DELTA_MAX_PAYLOAD_BYTES,
  HostDeltaStore,
  HOST_DELTA_CHECKPOINT_FILENAME,
  HOST_DELTA_FORBIDDEN_PAYLOAD_CODE,
  HOST_DELTA_JOURNAL_FILENAME,
  prepareHostDeltaPayload,
  type HostDeltaStoredRecord
} from './HostDeltaStore'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync)
  }
})

describe('HostDeltaStore', () => {
  let dataDir: string
  let clock: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'host-deltas-'))
    clock = '2026-08-03T17:00:00.000Z'
  })

  afterEach(() => {
    vi.mocked(closeSync).mockReset()
    vi.mocked(fsyncSync).mockReset()
    vi.mocked(openSync).mockReset()
    vi.mocked(readFileSync).mockReset()
    vi.mocked(renameSync).mockReset()
    vi.mocked(unlinkSync).mockReset()
    vi.mocked(writeFileSync).mockReset()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function openStore(options?: {
    maxRecords?: number
    maxBytes?: number
    compactAfterRecords?: number
    batchWrite?: ConstructorParameters<typeof HostDeltaStore>[0]['batchWrite']
    batchFsync?: ConstructorParameters<typeof HostDeltaStore>[0]['batchFsync']
    batchTruncate?: ConstructorParameters<typeof HostDeltaStore>[0]['batchTruncate']
    log?: (line: string) => void
  }) {
    return new HostDeltaStore({
      dataDir,
      now: () => clock,
      maxRecords: options?.maxRecords,
      maxBytes: options?.maxBytes,
      compactAfterRecords: options?.compactAfterRecords,
      batchWrite: options?.batchWrite,
      batchFsync: options?.batchFsync,
      batchTruncate: options?.batchTruncate,
      log: options?.log
    })
  }

  it('appends ordered deltas with monotonic cursors within a generation', () => {
    const store = openStore()
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })

    const a1 = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'one' }
    })
    expect(a1.kind).toBe('appended')
    if (a1.kind !== 'appended') return
    expect(a1.record.envelope.cursor).toBe(1)
    expect(a1.record.envelope.previousCursor).toBe(0)
    expect(a1.record.envelope.generation).toBe(1)
    expect(a1.position).toEqual({ generation: 1, cursor: 1 })

    const a2 = store.append({
      kind: 'tombstone',
      family: 'thread',
      entityId: 't1'
    })
    expect(a2.kind).toBe('appended')
    if (a2.kind !== 'appended') return
    expect(a2.record.envelope.cursor).toBe(2)
    expect(a2.record.envelope.previousCursor).toBe(1)
    expect(a2.record.envelope.tombstone).toBe(true)
  })

  it('notifies append subscribers after durable commit with isolated clones', () => {
    const store = openStore()
    const seen: Array<{ entityId?: string; generation: number; cursor: number }> = []
    const unsubscribeMutator = store.subscribe((event) => {
      event.record.envelope.entityId = 'listener-mutated'
      throw new Error('broken projection client')
    })
    const unsubscribeObserver = store.subscribe((event) => {
      seen.push({
        entityId: event.record.envelope.entityId,
        generation: event.position.generation,
        cursor: event.position.cursor
      })
    })

    const first = store.append({ kind: 'upsert', family: 'thread', entityId: 'thread-1' })
    expect(first.kind).toBe('appended')
    expect(seen).toEqual([{ entityId: 'thread-1', generation: 1, cursor: 1 }])
    expect(store.getByCursor(1)?.envelope.entityId).toBe('thread-1')

    unsubscribeMutator()
    const reset = store.resetGeneration('test reset')
    expect(reset.kind).toBe('appended')
    expect(seen.at(-1)).toEqual({ entityId: undefined, generation: 2, cursor: 1 })

    unsubscribeObserver()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'thread-2' })
    expect(seen).toHaveLength(2)
  })

  it.each(['append', 'reset'] as const)(
    'preserves the last durable position after native %s fsync fails',
    (operation) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const seen: number[] = []
      store.subscribe((event) => seen.push(event.position.cursor))
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error('native fsync failed')
      })

      expect(() =>
        operation === 'reset'
          ? store.resetGeneration('reset')
          : store.append({ kind: 'tombstone', family: 'thread', entityId: 'seed' })
      ).toThrow('native fsync failed')
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(store.getByCursor(1)?.envelope.entityId).toBe('seed')
      expect(store.getByCursor(2)).toBeNull()
      expect(seen).toEqual([])
    }
  )

  it.each(['append', 'reset'] as const)(
    'keeps %s invisible until journal fsync succeeds',
    (operation) => {
      openStore().append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const seen: Array<{ generation: number; cursor: number }> = []
      let fsyncs = 0
      const store: HostDeltaStore = openStore({
        batchFsync: (descriptor) => {
          fsyncs += 1
          expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
          expect(store.getByCursor(1)?.envelope.entityId).toBe('seed')
          expect(store.getByCursor(2)).toBeNull()
          expect(seen).toEqual([])
          fsyncSync(descriptor)
        }
      })
      store.subscribe((event) => seen.push(event.position))

      const result =
        operation === 'reset'
          ? store.resetGeneration('reset')
          : store.append({ kind: 'tombstone', family: 'thread', entityId: 'seed' })
      const position =
        operation === 'reset' ? { generation: 2, cursor: 1 } : { generation: 1, cursor: 2 }
      expect(result).toMatchObject({ kind: 'appended', position })
      expect(fsyncs).toBe(1)
      expect(seen).toEqual([position])
      expect(openStore().getPosition()).toEqual(position)
    }
  )

  it.each([
    ['append', 'write'],
    ['append', 'fsync'],
    ['reset', 'write'],
    ['reset', 'fsync']
  ] as const)(
    'rolls back a failed %s %s without publishing or consuming a cursor',
    (operation, fault) => {
      openStore().append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const before = readFileSync(journal)
      let writes = 0
      let failFsync = fault === 'fsync'
      const store = openStore({
        batchWrite: (descriptor, bytes, offset, length) => {
          writes += 1
          if (fault === 'write' && writes === 1) {
            // For resets, leave the complete fence but none of its envelope.
            const count = operation === 'reset' ? bytes.indexOf(10) + 1 : Math.min(17, length)
            return writeSync(descriptor, bytes, offset, count, null)
          }
          if (fault === 'write' && writes === 2) throw new Error('injected journal write failure')
          return writeSync(descriptor, bytes, offset, length, null)
        },
        batchFsync: (descriptor) => {
          if (failFsync) {
            failFsync = false
            throw new Error('injected journal fsync failure')
          }
          fsyncSync(descriptor)
        }
      })
      const seen: Array<{ generation: number; cursor: number }> = []
      store.subscribe((event) => seen.push(event.position))
      const mutate = () =>
        operation === 'reset'
          ? store.resetGeneration('reset')
          : store.append({ kind: 'remove', family: 'thread', entityId: 'seed' })

      expect(mutate).toThrow(`injected journal ${fault} failure`)
      expect(readFileSync(journal)).toEqual(before)
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(store.getByCursor(1)?.envelope.entityId).toBe('seed')
      expect(store.getByCursor(2)).toBeNull()
      expect(seen).toEqual([])
      expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 1 })

      const position =
        operation === 'reset' ? { generation: 2, cursor: 1 } : { generation: 1, cursor: 2 }
      expect(mutate()).toMatchObject({ kind: 'appended', position })
      expect(seen).toEqual([position])
      expect(openStore().getPosition()).toEqual(position)
    }
  )

  it.each(['append', 'reset'] as const)(
    'blocks authority after an uncertain %s until a fresh store recovers disk',
    (operation) => {
      openStore().append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const store = openStore({
        batchFsync: () => {
          throw new Error('injected fsync failure')
        },
        batchTruncate: () => {
          throw new Error('injected rollback failure')
        }
      })
      const seen: number[] = []
      store.subscribe((event) => seen.push(event.position.cursor))
      expect(() =>
        operation === 'reset'
          ? store.resetGeneration('uncertain reset')
          : store.append({ kind: 'upsert', family: 'thread', entityId: 'uncertain' })
      ).toThrow('injected fsync failure')
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(store.getByCursor(1)?.envelope.entityId).toBe('seed')
      expect(store.getByCursor(2)).toBeNull()
      expect(seen).toEqual([])
      expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow(
        'authority is blocked'
      )
      expect(() => store.appendBatch([])).toThrow('authority is blocked')
      expect(() => store.resetGeneration()).toThrow('authority is blocked')
      expect(() => store.compact()).toThrow('authority is blocked')
      store.reopen()
      expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow(
        'authority is blocked'
      )
      expect(seen).toEqual([])

      // This is process-reopen recovery of visible bytes, not proof of power-loss durability.
      const recovered = openStore()
      const position =
        operation === 'reset' ? { generation: 2, cursor: 1 } : { generation: 1, cursor: 2 }
      expect(recovered.getPosition()).toEqual(position)
      expect(
        recovered.append({ kind: 'upsert', family: 'thread', entityId: 'next' })
      ).toMatchObject({
        kind: 'appended',
        position: { ...position, cursor: position.cursor + 1 }
      })
      expect(openStore().getPosition()).toEqual(recovered.getPosition())
    }
  )

  it.each(['append', 'reset'] as const)(
    'repairs an uncertain partial %s before a fresh authority can append',
    (operation) => {
      openStore().append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      let writes = 0
      const store = openStore({
        batchWrite: (descriptor, bytes, offset, length) => {
          writes += 1
          if (writes === 1) {
            const count = operation === 'reset' ? bytes.indexOf(10) + 1 : Math.min(17, length)
            return writeSync(descriptor, bytes, offset, count, null)
          }
          throw new Error('partial write failed')
        },
        batchTruncate: () => {
          throw new Error('rollback failed')
        }
      })
      expect(() =>
        operation === 'reset'
          ? store.resetGeneration('incomplete reset')
          : store.append({ kind: 'remove', family: 'thread', entityId: 'seed' })
      ).toThrow('partial write failed')
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow(
        'authority is blocked'
      )

      const recovered = openStore()
      expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(recovered.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
      expect(
        recovered.append({ kind: 'upsert', family: 'thread', entityId: 'recovered' })
      ).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 2 }
      })
      const reopened = openStore()
      expect(reopened.getPosition()).toEqual(recovered.getPosition())
      expect(reopened.getByCursor(2)?.envelope.entityId).toBe('recovered')
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    }
  )

  it.each(['fence prefix', 'fence only', 'envelope prefix', 'missing final newline'] as const)(
    'discards a persisted reset %s before publishing or appending in a fresh store',
    (cut) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'seed-\u00e9' })
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const before = readFileSync(journal)
      store.resetGeneration('interrupted reset')
      const resetBytes = readFileSync(journal).subarray(before.length)
      const fenceLength = resetBytes.indexOf(10) + 1
      const length =
        cut === 'fence prefix'
          ? 17
          : cut === 'fence only'
            ? fenceLength
            : cut === 'envelope prefix'
              ? fenceLength + 17
              : resetBytes.length - 1
      writeFileSync(journal, Buffer.concat([before, resetBytes.subarray(0, length)]))

      const recovered = openStore()
      expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 1 })
      expect(recovered.getByCursor(1)?.envelope.entityId).toBe('seed-\u00e9')
      expect(recovered.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
      expect(readFileSync(journal)).toEqual(before)
      expect(
        recovered.append({ kind: 'remove', family: 'thread', entityId: 'seed-\u00e9' })
      ).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 2 }
      })
      const reopened = openStore()
      expect(reopened.getPosition()).toEqual(recovered.getPosition())
      expect(reopened.getByCursor(2)?.envelope.kind).toBe('remove')
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    }
  )

  it.each(['ordinary append', 'corrupt line'] as const)(
    'preserves a legacy reset followed by a complete %s and its acknowledged chain',
    (following) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'old-generation' })
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const before = readFileSync(journal, 'utf8')
      const legacyDir = join(dataDir, 'legacy')
      const legacy = new HostDeltaStore({
        dataDir: legacyDir,
        initialGeneration: 2,
        now: () => clock
      })
      legacy.append({ kind: 'upsert', family: 'thread', entityId: 'legacy-one' })
      legacy.append({ kind: 'upsert', family: 'thread', entityId: 'legacy-two' })
      const fence = JSON.stringify({
        op: 'generation-reset',
        previousGeneration: 1,
        generation: 2,
        at: clock
      })
      const legacyJournal = readFileSync(join(legacyDir, HOST_DELTA_JOURNAL_FILENAME), 'utf8')
      const corruptLine = following === 'corrupt line' ? 'NOT-JSON\n' : ''
      writeFileSync(journal, `${before}${fence}\n${corruptLine}${legacyJournal}`)
      const beforeReopen = readFileSync(journal)

      const recovered = openStore()
      expect(recovered.getPosition()).toEqual({ generation: 2, cursor: 2 })
      expect(recovered.getByCursor(1)?.envelope.entityId).toBe('legacy-one')
      expect(recovered.getByCursor(2)?.envelope.entityId).toBe('legacy-two')
      expect(recovered.getRecoveryState().recoveryWarnings).toContain(
        'preserved legacy generation reset without its reset envelope'
      )
      expect(readFileSync(journal)).toEqual(beforeReopen)
      expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
        kind: 'appended',
        position: { generation: 2, cursor: 3 }
      })
      expect(openStore().getPosition()).toEqual({ generation: 2, cursor: 3 })
    }
  )

  it.each([HOST_DELTA_CHECKPOINT_FILENAME, HOST_DELTA_JOURNAL_FILENAME])(
    'rejects reopening when %s cannot be read and keeps every mutation blocked',
    (filename) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'checkpoint-record' })
      store.compact()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'journal-record' })
      const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const beforeCheckpoint = readFileSync(checkpoint)
      const beforeJournal = readFileSync(journal)
      const realRead = vi.mocked(readFileSync).getMockImplementation()!
      const failure = Object.assign(new Error('injected recovery read failure'), { code: 'EACCES' })
      vi.mocked(readFileSync).mockImplementation((...args) => {
        if (args[0] === join(dataDir, filename)) throw failure
        return realRead(...args)
      })

      expect(() => openStore()).toThrow(failure)
      expect(() => store.reopen()).toThrow(failure)
      vi.mocked(readFileSync).mockReset()
      expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow(
        'authority is blocked'
      )
      expect(() => store.appendBatch([])).toThrow('authority is blocked')
      expect(() => store.resetGeneration()).toThrow('authority is blocked')
      expect(() => store.compact()).toThrow('authority is blocked')
      store.reopen()
      expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow(
        'authority is blocked'
      )
      expect(readFileSync(checkpoint)).toEqual(beforeCheckpoint)
      expect(readFileSync(journal)).toEqual(beforeJournal)
      const recovered = openStore()
      expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 2 })
      expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 3 }
      })
      expect(openStore().getPosition()).toEqual(recovered.getPosition())
    }
  )

  it.each([
    'malformed JSON',
    'non-object root',
    'unsupported schema',
    'invalid generation',
    'invalid cursor',
    'invalid records field'
  ] as const)('fails closed on a present checkpoint with %s', (fault) => {
    const store = openStore()
    for (const entityId of ['one', 'two', 'three']) {
      store.append({ kind: 'upsert', family: 'thread', entityId })
    }
    store.compact()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'four' })
    const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const validCheckpoint = readFileSync(checkpoint)
    const validJournal = readFileSync(journal)
    const doc = JSON.parse(validCheckpoint.toString('utf8')) as {
      schemaVersion: number
      generation: number
      cursor: number
      lowestRetainedCursor: number
      records: HostDeltaStoredRecord[]
    }
    const invalid = {
      'malformed JSON': '{',
      'non-object root': 'null',
      'unsupported schema': JSON.stringify({ ...doc, schemaVersion: 999 }),
      'invalid generation': JSON.stringify({ ...doc, generation: 0 }),
      'invalid cursor': JSON.stringify({ ...doc, cursor: -1 }),
      'invalid records field': JSON.stringify({ ...doc, records: null })
    }[fault]
    writeFileSync(checkpoint, invalid)

    expect(() => openStore()).toThrow()
    expect(() => store.reopen()).toThrow()
    expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow('authority is blocked')
    expect(() => store.appendBatch([])).toThrow('authority is blocked')
    expect(() => store.resetGeneration()).toThrow('authority is blocked')
    expect(() => store.compact()).toThrow('authority is blocked')
    expect(readFileSync(checkpoint, 'utf8')).toBe(invalid)
    expect(readFileSync(journal)).toEqual(validJournal)

    writeFileSync(checkpoint, validCheckpoint)
    store.reopen()
    expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow('authority is blocked')
    const recovered = openStore()
    expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 4 })
    expect(recovered.getByCursor(1)?.envelope.entityId).toBe('one')
    expect(recovered.getByCursor(4)?.envelope.entityId).toBe('four')
    expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 5 }
    })
    expect(openStore().getPosition()).toEqual(recovered.getPosition())
  })

  it.each([
    { fault: 'old projection version', retained: [] },
    { fault: 'old protocol version', retained: [] },
    { fault: 'mixed projection versions', retained: [3] },
    { fault: 'malformed record', retained: [2, 3] },
    { fault: 'wrong generation', retained: [] },
    { fault: 'missing head record', retained: [] },
    { fault: 'duplicate cursor', retained: [3] },
    { fault: 'incorrect retained boundary', retained: [1, 2, 3] },
    { fault: 'gap in retained chain', retained: [3] },
    { fault: 'invalid previous cursor', retained: [] },
    { fault: 'empty retention', retained: [] }
  ])('preserves the checkpoint head and a usable suffix after $fault', ({ fault, retained }) => {
    const store = openStore()
    for (const entityId of ['one', 'two', 'three']) {
      store.append({ kind: 'upsert', family: 'thread', entityId })
    }
    store.compact()
    const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const doc = JSON.parse(readFileSync(checkpoint, 'utf8')) as {
      generation: number
      cursor: number
      lowestRetainedCursor: number
      records: HostDeltaStoredRecord[]
    }
    const changed: Record<string, unknown> = {
      'old projection version': {
        ...doc,
        records: doc.records.map((record) => ({
          ...record,
          envelope: { ...record.envelope, projectionVersion: 0 }
        }))
      },
      'old protocol version': {
        ...doc,
        records: doc.records.map((record) => ({
          ...record,
          envelope: { ...record.envelope, protocolVersion: 0 }
        }))
      },
      'mixed projection versions': {
        ...doc,
        records: doc.records.map((record) =>
          record.envelope.cursor === 3
            ? record
            : {
                ...record,
                envelope: { ...record.envelope, projectionVersion: 0 }
              }
        )
      },
      'malformed record': { ...doc, records: [null, ...doc.records.slice(1)] },
      'wrong generation': {
        ...doc,
        records: doc.records.map((record) => ({
          ...record,
          envelope: { ...record.envelope, generation: 2 }
        }))
      },
      'missing head record': { ...doc, records: doc.records.slice(0, -1) },
      'duplicate cursor': { ...doc, records: [...doc.records, doc.records[1]] },
      'incorrect retained boundary': { ...doc, lowestRetainedCursor: 2 },
      'gap in retained chain': { ...doc, records: [doc.records[0], doc.records[2]] },
      'invalid previous cursor': {
        ...doc,
        records: doc.records.map((record) =>
          record.envelope.cursor !== 3
            ? record
            : {
                ...record,
                envelope: { ...record.envelope, previousCursor: 0 }
              }
        )
      },
      'empty retention': { ...doc, lowestRetainedCursor: 0, records: [] }
    }
    writeFileSync(checkpoint, JSON.stringify(changed[fault]))

    const recovered = openStore()
    expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(recovered.getRecoveryState()).toMatchObject({
      recoveryState: 'degraded-checkpoint',
      size: retained.length,
      lowestRetainedCursor: retained[0] ?? 0
    })
    for (const cursor of [1, 2, 3]) {
      expect(recovered.getByCursor(cursor) !== null).toBe(retained.includes(cursor))
    }
    if (retained.length < 3) {
      expect(recovered.since({ generation: 1, cursor: 0 })).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
    }
    const suffix = recovered.since({ generation: 1, cursor: retained.length ? retained[0] - 1 : 3 })
    expect(suffix.kind).toBe('deltas')
    if (suffix.kind === 'deltas')
      expect(suffix.deltas.map((record) => record.cursor)).toEqual(retained)

    recovered.compact()
    const roundtrip = openStore()
    expect(roundtrip.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(roundtrip.size).toBe(retained.length)
    if (retained.length < 3) {
      expect(roundtrip.since({ generation: 1, cursor: 0 })).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
    }
    expect(roundtrip.append({ kind: 'remove', family: 'thread' })).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 4 },
      record: { envelope: { previousCursor: 3 } }
    })
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 4 })
  })

  it('replays the journal after an incompatible checkpoint without reissuing its head cursor', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'old-projection' })
    store.compact()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'current-projection' })
    const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const journalBytes = readFileSync(journal)
    const doc = JSON.parse(readFileSync(checkpoint, 'utf8')) as { records: HostDeltaStoredRecord[] }
    writeFileSync(
      checkpoint,
      JSON.stringify({
        ...doc,
        records: doc.records.map((record) => ({
          ...record,
          envelope: { ...record.envelope, projectionVersion: 0 }
        }))
      })
    )

    const recovered = openStore()
    expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 2 })
    expect(recovered.getByCursor(1)).toBeNull()
    expect(recovered.getByCursor(2)?.envelope.entityId).toBe('current-projection')
    expect(readFileSync(journal)).toEqual(journalBytes)
    expect(recovered.since({ generation: 1, cursor: 0 })).toMatchObject({
      kind: 'full_resnapshot_required',
      reason: 'retention_gap'
    })
    expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 3 }
    })
    expect(openStore().getPosition()).toEqual(recovered.getPosition())
  })

  it('reports malformed checkpoint JSON without exposing its contents in errors or diagnostics', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'durable' })
    store.compact()
    const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const checkpointBytes = readFileSync(checkpoint)
    const diagnosticLines: string[] = []
    const marker = 'checkpoint-private-fixture-text'
    writeFileSync(checkpoint, `${marker}: invalid JSON`)
    let thrown: unknown
    try {
      openStore({ log: (line) => diagnosticLines.push(line) })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('Host delta checkpoint malformed JSON')
    expect((thrown as Error).cause).toBeUndefined()
    expect(String((thrown as Error).stack)).not.toContain(marker)
    expect(diagnosticLines.join('\n')).not.toContain(marker)
    expect(() => store.reopen()).toThrow('Host delta checkpoint malformed JSON')
    expect(() => store.append({ kind: 'remove', family: 'thread' })).toThrow('authority is blocked')
    expect(readFileSync(checkpoint, 'utf8')).toBe(`${marker}: invalid JSON`)
    writeFileSync(checkpoint, checkpointBytes)
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a newly created journal invisible until its directory is synced',
    () => {
      const store = openStore()
      const realFsync = vi.mocked(fsyncSync).getMockImplementation()!
      const seen: number[] = []
      const syncs: string[] = []
      let failDirectory = true
      store.subscribe((event) => seen.push(event.position.cursor))
      vi.mocked(fsyncSync).mockImplementation((descriptor) => {
        const directory = fstatSync(descriptor).isDirectory()
        syncs.push(directory ? 'directory' : 'journal')
        expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
        expect(seen).toEqual([])
        if (directory && failDirectory) {
          failDirectory = false
          throw new Error('directory fsync failed')
        }
        realFsync(descriptor)
      })

      expect(() => store.append({ kind: 'upsert', family: 'thread', entityId: 'one' })).toThrow(
        'directory fsync failed'
      )
      expect(syncs).toEqual(['journal', 'directory', 'journal', 'directory'])
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
      expect(seen).toEqual([])
      expect(openStore().getPosition()).toEqual(store.getPosition())
      expect(store.append({ kind: 'upsert', family: 'thread', entityId: 'retry' })).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 1 }
      })
      expect(seen).toEqual([1])
      expect(openStore().getByCursor(1)?.envelope.entityId).toBe('retry')
    }
  )

  it.each(['append', 'reset'] as const)(
    'returns the committed %s position even when a listener appends again',
    (operation) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const position =
        operation === 'reset' ? { generation: 2, cursor: 1 } : { generation: 1, cursor: 2 }
      const seen: Array<{ generation: number; cursor: number }> = []
      store.subscribe((event) => {
        seen.push(event.position)
        if (event.position.cursor === position.cursor) {
          store.append({ kind: 'upsert', family: 'thread', entityId: 'listener' })
        }
      })

      const result =
        operation === 'reset'
          ? store.resetGeneration('reset')
          : store.append({ kind: 'remove', family: 'thread', entityId: 'seed' })
      const finalPosition = { ...position, cursor: position.cursor + 1 }
      expect(result).toMatchObject({ kind: 'appended', position })
      expect(store.getPosition()).toEqual(finalPosition)
      expect(seen).toEqual([position, finalPosition])
      expect(openStore().getPosition()).toEqual(finalPosition)
    }
  )

  it.each(['append', 'reset'] as const)(
    'reports %s committed when checkpoint rename and diagnostics fail',
    (operation) => {
      openStore().append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
      const store = openStore({
        compactAfterRecords: 1,
        log: () => {
          throw new Error('diagnostic failure')
        }
      })
      // A directory at the destination makes the real checkpoint rename fail.
      const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
      mkdirSync(checkpoint)
      const seen: Array<{ generation: number; cursor: number }> = []
      store.subscribe((event) => seen.push(event.position))
      const result =
        operation === 'reset'
          ? store.resetGeneration('reset')
          : store.append({ kind: 'upsert', family: 'thread', entityId: 'committed' })
      const position =
        operation === 'reset' ? { generation: 2, cursor: 1 } : { generation: 1, cursor: 2 }
      expect(result).toMatchObject({ kind: 'appended', position })
      expect(store.getPosition()).toEqual(position)
      expect(seen).toEqual([position])
      rmSync(checkpoint, { recursive: true })
      expect(openStore().getPosition()).toEqual(position)
      expect(store.append({ kind: 'remove', family: 'thread' })).toMatchObject({
        kind: 'appended',
        position: { ...position, cursor: position.cursor + 1 }
      })
      expect(existsSync(checkpoint)).toBe(true)
      expect(openStore().getPosition()).toEqual(store.getPosition())
    }
  )

  it.each(['write', 'open', 'fsync', 'close', 'rename'] as const)(
    'cleans a failed checkpoint %s without losing durable state or replacing its error',
    (stage) => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'checkpoint' })
      store.compact()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'journal' })
      const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const beforeCheckpoint = readFileSync(checkpoint)
      const beforeJournal = readFileSync(journal)
      const failure = new Error(`checkpoint ${stage} failed`)
      const realWrite = vi.mocked(writeFileSync).getMockImplementation()!
      const realClose = vi.mocked(closeSync).getMockImplementation()!
      const closesBefore = vi.mocked(closeSync).mock.calls.length
      const fail = () => {
        throw failure
      }
      if (stage === 'write') {
        vi.mocked(writeFileSync).mockImplementationOnce((path) => {
          realWrite(path, '{"partial":', { mode: 0o600 })
          throw failure
        })
      } else if (stage === 'open') {
        vi.mocked(openSync).mockImplementationOnce(fail)
      } else if (stage === 'fsync') {
        vi.mocked(fsyncSync).mockImplementationOnce(fail)
      } else if (stage === 'close') {
        vi.mocked(closeSync).mockImplementationOnce((descriptor) => {
          realClose(descriptor)
          throw failure
        })
      } else {
        vi.mocked(renameSync).mockImplementationOnce(fail)
      }

      let thrown: unknown
      try {
        store.compact()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      if (stage === 'close') expect(vi.mocked(closeSync).mock.calls.length - closesBefore).toBe(1)
      expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
      expect(readFileSync(checkpoint)).toEqual(beforeCheckpoint)
      expect(readFileSync(journal)).toEqual(beforeJournal)
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 2 })
      const recovered = openStore()
      expect(recovered.getByCursor(1)?.envelope.entityId).toBe('checkpoint')
      expect(recovered.getByCursor(2)?.envelope.entityId).toBe('journal')
      expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 3 }
      })
      expect(openStore().getPosition()).toEqual(recovered.getPosition())
    }
  )

  it('preserves the checkpoint fsync error when descriptor and temporary-file cleanup also fail', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'thread', entityId: 'durable' })
    const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const beforeJournal = readFileSync(journal)
    const failure = new Error('original checkpoint fsync failure')
    const realClose = vi.mocked(closeSync).getMockImplementation()!
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw failure
    })
    vi.mocked(closeSync).mockImplementationOnce((descriptor) => {
      realClose(descriptor)
      throw new Error('cleanup close failed')
    })
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error('cleanup unlink failed')
    })

    let thrown: unknown
    try {
      store.compact()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
    expect(readFileSync(journal)).toEqual(beforeJournal)
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(openStore().getByCursor(1)?.envelope.entityId).toBe('durable')
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a checkpoint directory-sync failure when closing the directory also fails',
    () => {
      const store = openStore()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'checkpoint' })
      store.compact()
      store.append({ kind: 'upsert', family: 'thread', entityId: 'journal' })
      const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
      const beforeJournal = readFileSync(journal)
      const realFsync = vi.mocked(fsyncSync).getMockImplementation()!
      const realClose = vi.mocked(closeSync).getMockImplementation()!
      const failure = new Error('checkpoint directory fsync failed')
      vi.mocked(fsyncSync).mockImplementation((descriptor) => {
        if (fstatSync(descriptor).isDirectory()) throw failure
        realFsync(descriptor)
      })
      vi.mocked(closeSync).mockImplementation((descriptor) => {
        const directory = fstatSync(descriptor).isDirectory()
        realClose(descriptor)
        if (directory) throw new Error('directory close failed')
      })

      let thrown: unknown
      try {
        store.compact()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
      expect(readFileSync(journal)).toEqual(beforeJournal)
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 2 })
      vi.mocked(fsyncSync).mockReset()
      vi.mocked(closeSync).mockReset()
      const recovered = openStore()
      expect(recovered.getPosition()).toEqual(store.getPosition())
      expect(recovered.getByCursor(1)?.envelope.entityId).toBe('checkpoint')
      expect(recovered.getByCursor(2)?.envelope.entityId).toBe('journal')
      expect(recovered.append({ kind: 'remove', family: 'thread' })).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor: 3 }
      })
      expect(openStore().getPosition()).toEqual(recovered.getPosition())
    }
  )

  it('accepts an empty checkpoint and starts the first durable cursor after reopen', () => {
    const store = openStore()
    store.compact()
    const recovered = openStore()
    expect(recovered.getPosition()).toEqual({ generation: 1, cursor: 0 })
    expect(recovered.append({ kind: 'upsert', family: 'thread', entityId: 'first' })).toMatchObject(
      {
        kind: 'appended',
        position: { generation: 1, cursor: 1 }
      }
    )
    expect(openStore().getPosition()).toEqual(recovered.getPosition())
  })

  it('does not accumulate temporary checkpoints across repeated automatic compaction failures', () => {
    const store = openStore({ compactAfterRecords: 1 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'seed' })
    const checkpoint = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    const beforeCheckpoint = readFileSync(checkpoint)
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error('rename refused')
    })

    for (let cursor = 2; cursor <= 4; cursor += 1) {
      expect(
        store.append({ kind: 'upsert', family: 'thread', entityId: `record-${cursor}` })
      ).toMatchObject({
        kind: 'appended',
        position: { generation: 1, cursor }
      })
      expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
      expect(readFileSync(checkpoint)).toEqual(beforeCheckpoint)
      expect(openStore().getPosition()).toEqual({ generation: 1, cursor })
    }
    expect(seen).toEqual([2, 3, 4])
    vi.mocked(renameSync).mockReset()
    store.compact()
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 4 })
    expect(readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps checkpoint retention and generation authoritative when journal removal fails', () => {
    const store = openStore({ maxRecords: 2, compactAfterRecords: 1000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'old' })
    store.resetGeneration('new generation')
    store.append({ kind: 'upsert', family: 'thread', entityId: 'one' })
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error('journal removal failed')
    })

    expect(store.append({ kind: 'upsert', family: 'thread', entityId: 'two' })).toMatchObject({
      kind: 'appended',
      position: { generation: 2, cursor: 3 }
    })
    expect(seen).toEqual([3])
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(true)
    const reopened = openStore({ maxRecords: 2, compactAfterRecords: 1000 })
    expect(reopened.getPosition()).toEqual({ generation: 2, cursor: 3 })
    expect(reopened.getByCursor(1)).toBeNull()
    expect(reopened.size).toBe(2)
    expect(reopened.since({ generation: 2, cursor: 0 })).toMatchObject({
      kind: 'full_resnapshot_required',
      reason: 'retention_gap'
    })
    expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    expect(reopened.append({ kind: 'remove', family: 'thread' })).toMatchObject({
      kind: 'appended',
      position: { generation: 2, cursor: 4 }
    })
    expect(openStore().getPosition()).toEqual(reopened.getPosition())
  })

  it('batch-publishes one durable ordered chain before memory or listeners can observe it', () => {
    const seen: number[] = []
    let fsyncs = 0
    const store: HostDeltaStore = openStore({
      batchFsync: (descriptor) => {
        fsyncs += 1
        expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
        expect(seen).toEqual([])
        fsyncSync(descriptor)
      }
    })
    store.subscribe((event) => seen.push(event.position.cursor))

    const result = store.appendBatch([
      { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
      { kind: 'remove', family: 'thread', entityId: 'one' },
      { kind: 'upsert', family: 'thread', entityId: 'two', payload: { id: 'two' } }
    ])

    expect(result).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 3 }
    })
    if (result.kind !== 'appended') return
    expect(result.results.map((entry) => entry.position.cursor)).toEqual([1, 2, 3])
    expect(fsyncs).toBe(1)
    expect(seen).toEqual([1, 2, 3])
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 3 })
  })

  it('rejects a bad middle batch entry before writing any prefix', () => {
    const store = openStore()
    const result = store.appendBatch([
      { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
      { kind: 'generation-reset', family: 'snapshot-meta' },
      { kind: 'remove', family: 'thread', entityId: 'one' }
    ])

    expect(result).toMatchObject({ kind: 'rejected', failedAtIndex: 1 })
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 0 })
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)
  })

  it('rolls a short-write failure back to the exact prior length before reusing the next cursor', () => {
    openStore().append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'seed',
      payload: { id: 'seed' }
    })
    let writes = 0
    const store = openStore({
      batchWrite: (descriptor, bytes, offset, length) => {
        writes += 1
        if (writes === 1) {
          const count = Math.min(17, length)
          return writeSync(descriptor, bytes, offset, count, null)
        }
        if (writes === 2) throw new Error('injected batch write failure')
        return writeSync(descriptor, bytes, offset, length, null)
      }
    })
    const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const beforeBytes = statSync(journal).size
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))

    expect(
      store.appendBatch([
        { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
        { kind: 'upsert', family: 'thread', entityId: 'two', payload: { id: 'two' } }
      ])
    ).toMatchObject({ kind: 'write-failed', rollback: 'proven' })
    expect(statSync(journal).size).toBe(beforeBytes)
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(seen).toEqual([])

    expect(
      store.appendBatch([
        { kind: 'upsert', family: 'thread', entityId: 'retry', payload: { id: 'retry' } }
      ])
    ).toMatchObject({ kind: 'appended', position: { generation: 1, cursor: 2 } })
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 2 })
  })

  it('rolls a short write back through a separate read/write descriptor, never the append handle', () => {
    // libuv opens O_APPEND handles without FILE_WRITE_DATA, so an ftruncate on
    // the 'a+' append descriptor is refused on Windows. Pin that the rollback
    // truncate and its fsync run on a distinct descriptor that is closed after.
    openStore().append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'seed',
      payload: { id: 'seed' }
    })
    let writes = 0
    let appendDescriptor: number | null = null
    const truncated: number[] = []
    const fsynced: number[] = []
    const store = openStore({
      batchWrite: (descriptor, bytes, offset, length) => {
        writes += 1
        appendDescriptor = descriptor
        if (writes === 1) return writeSync(descriptor, bytes, offset, Math.min(17, length), null)
        throw new Error('injected batch write failure')
      },
      batchTruncate: (descriptor, length) => {
        truncated.push(descriptor)
        ftruncateSync(descriptor, length)
      },
      batchFsync: (descriptor) => {
        fsynced.push(descriptor)
        fsyncSync(descriptor)
      }
    })
    const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const beforeBytes = statSync(journal).size

    expect(
      store.appendBatch([
        { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } }
      ])
    ).toMatchObject({ kind: 'write-failed', rollback: 'proven' })
    expect(appendDescriptor).not.toBeNull()
    expect(truncated).toHaveLength(1)
    expect(truncated[0]).not.toBe(appendDescriptor)
    expect(fsynced).toEqual([truncated[0]])
    expect(() => fstatSync(truncated[0])).toThrow()
    expect(statSync(journal).size).toBe(beforeBytes)
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
  })

  it('poisons append, reset, compact, and reopen after an unprovable batch rollback', () => {
    let writes = 0
    const store = openStore({
      batchWrite: (descriptor, bytes, offset, length) => {
        writes += 1
        if (writes === 1) {
          const count = Math.min(17, length)
          return writeSync(descriptor, bytes, offset, count, null)
        }
        throw new Error('injected batch write failure')
      },
      batchTruncate: () => {
        throw new Error('injected rollback failure')
      }
    })
    expect(
      store.appendBatch([
        { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } }
      ])
    ).toMatchObject({ kind: 'write-failed', rollback: 'uncertain' })
    expect(() => store.append({ kind: 'remove', family: 'thread', entityId: 'one' })).toThrow(
      'append authority is blocked'
    )
    expect(() => store.resetGeneration('unsafe')).toThrow('append authority is blocked')
    expect(() => store.compact()).toThrow('append authority is blocked')
    expect(() => store.reopen()).toThrow('injected rollback failure')
    expect(() => store.append({ kind: 'remove', family: 'thread', entityId: 'one' })).toThrow(
      'append authority is blocked'
    )
  })

  it('reports a durable batch committed when later compaction and logging fail', () => {
    const store = openStore({
      compactAfterRecords: 1,
      log: () => {
        throw new Error('log failed')
      }
    })
    ;(store as unknown as { maybeCompact(): void }).maybeCompact = () => {
      throw new Error('injected compaction failure')
    }
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))
    const result = store.appendBatch([
      { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
      { kind: 'upsert', family: 'thread', entityId: 'two', payload: { id: 'two' } }
    ])

    expect(result).toMatchObject({ kind: 'appended', position: { generation: 1, cursor: 2 } })
    expect(seen).toEqual([1, 2])
    expect(openStore().getPosition()).toEqual({ generation: 1, cursor: 2 })
  })

  it('drains batch and reentrant single-append notifications in cursor order', () => {
    const store = openStore()
    const seen: number[] = []
    store.subscribe((event) => {
      seen.push(event.position.cursor)
      if (event.position.cursor === 1) {
        store.append({
          kind: 'upsert',
          family: 'thread',
          entityId: 'listener',
          payload: { id: 'listener' }
        })
      }
    })
    const result = store.appendBatch([
      { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
      { kind: 'upsert', family: 'thread', entityId: 'two', payload: { id: 'two' } }
    ])

    expect(result).toMatchObject({ kind: 'appended', position: { generation: 1, cursor: 2 } })
    expect(store.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(seen).toEqual([1, 2, 3])
  })

  it('keeps delivering a committed batch when both a listener and its logger throw', () => {
    const store = openStore({
      log: () => {
        throw new Error('logger failed')
      }
    })
    store.subscribe(() => {
      throw new Error('listener failed')
    })
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))

    const result = store.appendBatch([
      { kind: 'upsert', family: 'thread', entityId: 'one', payload: { id: 'one' } },
      { kind: 'upsert', family: 'thread', entityId: 'two', payload: { id: 'two' } }
    ])

    expect(result).toMatchObject({ kind: 'appended', position: { generation: 1, cursor: 2 } })
    expect(seen).toEqual([1, 2])
  })

  it('returns deltas since a client cursor and empty when caught up', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'run', entityId: 'r1' })
    store.append({ kind: 'upsert', family: 'run', entityId: 'r2' })
    store.append({ kind: 'remove', family: 'run', entityId: 'r1' })

    const from0 = store.since({ generation: 1, cursor: 0 })
    expect(from0.kind).toBe('deltas')
    if (from0.kind !== 'deltas') return
    expect(from0.deltas).toHaveLength(3)
    expect(from0.deltas[0]?.previousCursor).toBe(0)
    expect(from0.deltas[2]?.cursor).toBe(3)

    const mid = store.since({ generation: 1, cursor: 1 })
    expect(mid.kind).toBe('deltas')
    if (mid.kind !== 'deltas') return
    expect(mid.deltas).toHaveLength(2)
    expect(mid.deltas[0]?.cursor).toBe(2)

    const caughtUp = store.since({ generation: 1, cursor: 3 })
    expect(caughtUp.kind).toBe('deltas')
    if (caughtUp.kind !== 'deltas') return
    expect(caughtUp.deltas).toHaveLength(0)
  })

  it('requires full resnapshot on generation mismatch and retention gap', () => {
    const store = openStore({ maxRecords: 2, compactAfterRecords: 1 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'b' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'c' })
    store.compact()

    // Newest two retained; cursor 1 dropped → client at 0 cannot get continuous chain from 1.
    const gap = store.since({ generation: 1, cursor: 0 })
    // If lowest retained is 2, cursor 1 missing → retention_gap
    expect(gap.kind).toBe('full_resnapshot_required')
    if (gap.kind !== 'full_resnapshot_required') return
    expect(gap.reason).toBe('retention_gap')

    const genMismatch = store.since({ generation: 99, cursor: 0 })
    expect(genMismatch.kind).toBe('full_resnapshot_required')
    if (genMismatch.kind !== 'full_resnapshot_required') return
    expect(['generation_mismatch', 'generation_reset']).toContain(genMismatch.reason)
  })

  it('durably resets generation and clears prior generation deltas', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'mission', entityId: 'm1' })
    store.append({ kind: 'upsert', family: 'mission', entityId: 'm2' })

    clock = '2026-08-03T17:00:10.000Z'
    const reset = store.resetGeneration('discontinuity')
    expect(reset.kind).toBe('appended')
    if (reset.kind !== 'appended') return
    expect(reset.record.envelope.kind).toBe('generation-reset')
    expect(reset.position).toEqual({ generation: 2, cursor: 1 })

    // Prior generation cannot be served.
    const old = store.since({ generation: 1, cursor: 2 })
    expect(old.kind).toBe('full_resnapshot_required')
    if (old.kind !== 'full_resnapshot_required') return
    expect(old.reason).toBe('generation_reset')

    const fresh = store.since({ generation: 2, cursor: 0 })
    expect(fresh.kind).toBe('deltas')
    if (fresh.kind !== 'deltas') return
    expect(fresh.deltas).toHaveLength(1)
    expect(fresh.deltas[0]?.kind).toBe('generation-reset')
  })

  it('reopens after simulated Host restart and recovers deltas/tombstones', () => {
    const store = openStore()
    store.append({ kind: 'upsert', family: 'thread', entityId: 't1', payload: { n: 1 } })
    store.append({ kind: 'tombstone', family: 'thread', entityId: 't1' })
    store.append({ kind: 'upsert', family: 'warning', entityId: 'w1' })

    const reopened = openStore()
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(reopened.getByCursor(2)?.envelope.tombstone).toBe(true)
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('t1')

    const since = reopened.since({ generation: 1, cursor: 1 })
    expect(since.kind).toBe('deltas')
    if (since.kind !== 'deltas') return
    expect(since.deltas).toHaveLength(2)
  })

  it('treats exact duplicate cursor content as idempotent and rejects conflicts', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    const first = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: { title: 'same' },
      at: '2026-08-03T17:00:00.000Z'
    })
    expect(first.kind).toBe('appended')
    if (first.kind !== 'appended') return

    // Simulate replaying the exact journal append by reopening and attempting same chain.
    // Conflicting content at an already-stored cursor is rejected on reopen path;
    // append always mints next cursor, so conflict is exercised via journal replay.
    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    const conflictLine = JSON.stringify({
      op: 'append',
      record: {
        schemaVersion: 1,
        contentFingerprint: 'deadbeef',
        retainedBytes: 10,
        envelope: {
          protocolVersion: 2,
          projectionVersion: HOST_PROJECTION_VERSION,
          generation: 1,
          cursor: 1,
          previousCursor: 0,
          kind: 'upsert',
          family: 'thread',
          entityId: 'DIFFERENT',
          at: '2026-08-03T17:00:00.000Z'
        }
      }
    })
    writeFileSync(journalPath, `${prior}${conflictLine}\n`)

    const reopened = openStore({ compactAfterRecords: 1000 })
    // Original retained; conflict ignored with recovery warning.
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('t1')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-corrupt-interior')

    // Exact duplicate journal line is idempotent.
    const exactDup = JSON.stringify({
      op: 'append',
      record: first.record
    })
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${exactDup}\n`)
    const again = openStore({ compactAfterRecords: 1000 })
    expect(again.getByCursor(1)?.envelope.entityId).toBe('t1')
    expect(again.getPosition().cursor).toBe(1)
  })

  it('drops truncated journal tail and keeps prior durable deltas', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'keep' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'also' })

    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const prior = readFileSync(journalPath, 'utf8')
    writeFileSync(
      journalPath,
      `${prior}{"op":"append","record":{"schemaVersion":1,"envelope":{"cursor":3`
    )

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getPosition().cursor).toBe(2)
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('keep')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
  })

  it('skips corrupt interior journal lines without losing later valid deltas', () => {
    const store = openStore({ compactAfterRecords: 1000 })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'a' })
    store.append({ kind: 'upsert', family: 'thread', entityId: 'b' })

    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)
    const corrupted = [lines[0], 'NOT-JSON', ...lines.slice(1)].join('\n') + '\n'
    writeFileSync(journalPath, corrupted)

    const reopened = openStore({ compactAfterRecords: 1000 })
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('a')
    expect(reopened.getByCursor(2)?.envelope.entityId).toBe('b')
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-corrupt-interior')
  })

  it('compacts journal into checkpoint and enforces bounded retention', () => {
    const store = openStore({ maxRecords: 3, compactAfterRecords: 2 })
    for (let i = 1; i <= 5; i += 1) {
      clock = `2026-08-03T17:00:0${i}.000Z`
      store.append({ kind: 'upsert', family: 'thread', entityId: `t${i}` })
    }
    store.compact()
    expect(store.size).toBe(3)

    const checkpointPath = join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    expect(existsSync(checkpointPath)).toBe(true)
    const doc = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { records: unknown[] }
    expect(doc.records).toHaveLength(3)

    // Newest three: cursors 3,4,5
    expect(store.getByCursor(1)).toBeNull()
    expect(store.getByCursor(2)).toBeNull()
    expect(store.getByCursor(5)?.envelope.entityId).toBe('t5')

    const reopened = openStore({ maxRecords: 3 })
    expect(reopened.size).toBe(3)
    expect(reopened.getPosition().cursor).toBe(5)
    expect(reopened.getByCursor(5)?.envelope.entityId).toBe('t5')
  })

  it('accepts compact metadata and rejects nested/case-variant forbidden keys before persist', () => {
    const store = openStore()
    const ok = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 't1',
      payload: {
        title: 'ok',
        note: 'mentions password token secret only in prose',
        id: 'thread-1',
        count: 2,
        sha256: 'abc',
        byteLength: 12,
        filename: 'readme.md',
        additions: 3,
        deletions: 1
      }
    })
    expect(ok.kind).toBe('appended')

    const cases: Array<{ payload: unknown; needle: string }> = [
      { payload: { API_KEY: 'sk-live' }, needle: 'API_KEY' },
      { payload: { nested: { Authorization: 'Bearer x' } }, needle: 'Authorization' },
      { payload: { meta: [{ Thinking: 'hidden' }] }, needle: 'Thinking' },
      { payload: { toolOutput: { stdout: 'secret_token=1' } }, needle: 'toolOutput' },
      { payload: { diff: '--- a\n+++ b\n' }, needle: 'diff' },
      { payload: { patchBody: '@@ -1 +1 @@' }, needle: 'patchBody' },
      { payload: { messages: [{ role: 'user', text: 'hi' }] }, needle: 'messages' },
      { payload: { fileContent: 'FULL FILE' }, needle: 'fileContent' }
    ]

    for (const item of cases) {
      const rejected = store.append({
        kind: 'upsert',
        family: 'thread',
        entityId: 'forbidden',
        payload: item.payload
      })
      expect(rejected.kind).toBe('rejected')
      if (rejected.kind !== 'rejected') return
      expect(rejected.reason).toBe('forbidden_payload')
      expect(rejected.code).toBe(HOST_DELTA_FORBIDDEN_PAYLOAD_CODE)
      expect(rejected.detail).toContain(item.needle)
      expect(store.getPosition()).toEqual({ generation: 1, cursor: 1 })
    }

    const journal = readFileSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME), 'utf8')
    expect(journal).not.toMatch(/sk-live|Bearer x|secret_token=1|FULL FILE|--- a/)
    expect(existsSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME))).toBe(false)

    const prepared = prepareHostDeltaPayload({ nested: { access_token: 'x' } })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.code).toBe(HOST_DELTA_FORBIDDEN_PAYLOAD_CODE)
  })

  it('rejects under-limit forbidden payloads and never writes them to journal/checkpoint', () => {
    const store = openStore({ compactAfterRecords: 1 })
    const rejected = store.append({
      kind: 'upsert',
      family: 'warning',
      entityId: 'w1',
      payload: { credential: 'under-limit-secret' }
    })
    expect(rejected.kind).toBe('rejected')
    if (rejected.kind !== 'rejected') return
    expect(rejected.reason).toBe('forbidden_payload')
    expect(store.getPosition().cursor).toBe(0)
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)

    const ok = store.append({
      kind: 'upsert',
      family: 'warning',
      entityId: 'w2',
      payload: { title: 'safe' }
    })
    expect(ok.kind).toBe('appended')
    store.compact()
    const checkpoint = readFileSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME), 'utf8')
    expect(checkpoint).not.toMatch(/under-limit-secret/)
    expect(checkpoint).not.toMatch(/"credential"/i)
    // compact resets the journal; if a fresh journal exists it must stay clean too
    const journalPath = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
    if (existsSync(journalPath)) {
      expect(readFileSync(journalPath, 'utf8')).not.toMatch(/under-limit-secret/)
    }
  })

  it('persists oversized safe payloads as length+digest only and reopens without raw prefix', () => {
    const store = openStore()
    // Past the row cap: carried rows stop there, and the privacy stub takes over.
    const bigNote = 'n'.repeat(HOST_DELTA_MAX_PAYLOAD_BYTES + 1)
    const result = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'big',
      payload: { title: 'safe-oversize', note: bigNote }
    })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    const payload = result.record.envelope.payload as {
      _truncated?: boolean
      byteLength?: number
      sha256?: string
      preview?: string
      note?: string
    }
    expect(payload).toEqual({
      _truncated: true,
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(payload.preview).toBeUndefined()
    expect(payload.note).toBeUndefined()
    expect(JSON.stringify(result.record)).not.toContain(bigNote.slice(0, 64))

    const reopened = openStore()
    const again = reopened.getByCursor(1)?.envelope.payload as {
      _truncated?: boolean
      byteLength?: number
      sha256?: string
      preview?: string
    }
    expect(again).toEqual({
      _truncated: true,
      byteLength: payload.byteLength,
      sha256: payload.sha256
    })
    expect(again.preview).toBeUndefined()
    const durable = readFileSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME), 'utf8')
    expect(durable).not.toContain(bigNote.slice(0, 64))
    expect(durable).not.toMatch(/"preview"/)
  })

  it('rejects oversized payloads that also contain forbidden keys before any persist', () => {
    const store = openStore()
    const rejected = store.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'big-forbidden',
      payload: { transcript: 't'.repeat(9000) }
    })
    expect(rejected.kind).toBe('rejected')
    if (rejected.kind !== 'rejected') return
    expect(rejected.reason).toBe('forbidden_payload')
    expect(rejected.code).toBe(HOST_DELTA_FORBIDDEN_PAYLOAD_CODE)
    expect(store.getPosition().cursor).toBe(0)
    expect(existsSync(join(dataDir, HOST_DELTA_JOURNAL_FILENAME))).toBe(false)
  })
})
