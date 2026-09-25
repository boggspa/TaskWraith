import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostDeltaStore,
  HOST_DELTA_JOURNAL_FILENAME,
  hostDeltaGroupSetDigest,
  type HostDeltaAppendInput,
  type HostDeltaGroupDescriptor,
  type HostDeltaStoreOptions
} from './HostDeltaStore'
import type { HostCursorPosition } from '../shared/hostProtocol'

// M4 slice 7a (design §15.1): a group is one journal line written under the
// publication lock without an fsync; it becomes visible only once a batched
// async fsync makes it durable. Nothing here calls the group API in
// production yet, so every clause is pinned at the store seam.

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-delta-group-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

const now = () => '2026-09-25T09:00:00.000Z'
const effects = (count = 2, prefix = 'thread'): HostDeltaAppendInput[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'upsert',
    family: 'thread',
    entityId: `${prefix}-${index}`,
    payload: { title: `${prefix} ${index}` }
  }))
const legacy = (entityId: string): HostDeltaAppendInput => ({
  kind: 'upsert',
  family: 'thread',
  entityId,
  payload: { title: entityId }
})

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 150): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Real fsync through the seam, recording every path it was asked to flush. */
function recordingFsync(calls: string[]): NonNullable<HostDeltaStoreOptions['groupFsync']> {
  return async (path) => {
    calls.push(path)
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
}

function journalPath(dataDir: string) {
  return join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
}
function journalSize(dataDir: string) {
  return existsSync(journalPath(dataDir)) ? statSync(journalPath(dataDir)).size : 0
}
function journalLines(dataDir: string): Array<Record<string, unknown>> {
  return readFileSync(journalPath(dataDir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
function expectNoTxn(value: unknown) {
  expect(JSON.stringify(value)).not.toContain('"txn"')
}
function position(generation: number, cursor: number): HostCursorPosition {
  return { generation, cursor }
}

describe('HostDeltaStore group append (M4 slice 7a)', () => {
  it('exposes nothing before awaitDurable resolves: position, getByCursor, since, listeners', async () => {
    const dataDir = directory()
    const fsyncs: string[] = []
    const seen: number[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: recordingFsync(fsyncs)
    })
    store.subscribe((event) => seen.push(event.position.cursor))

    const appended = store.appendGroup({ commandId: 'cmd-1', effects: effects(2) })
    expect(appended.kind).toBe('appended')
    if (appended.kind !== 'appended') return
    expect(appended.group).toMatchObject({
      commandId: 'cmd-1',
      count: 2,
      start: position(1, 1),
      end: position(1, 2),
      durable: false
    })

    // The line is on disk and the appended head moved, but nothing is visible.
    expect(journalLines(dataDir)).toHaveLength(1)
    expect(store.getAppendedPosition()).toEqual(position(1, 2))
    expect(store.getPosition()).toEqual(position(1, 0))
    expect(store.getByCursor(1)).toBeNull()
    expect(store.getByCursor(2)).toBeNull()
    expect(store.since(position(1, 0))).toEqual({
      kind: 'deltas',
      generation: 1,
      fromCursor: 0,
      toCursor: 0,
      deltas: []
    })
    expect(seen).toEqual([])
    expect(store.findGroup('cmd-1')).toMatchObject({ commandId: 'cmd-1', durable: false })
    expect(fsyncs).toEqual([])

    const durable = await store.awaitDurable()
    expect(durable).toEqual({ kind: 'durable', position: position(1, 2) })
    expect(fsyncs).toContain(journalPath(dataDir))
    expect(store.getPosition()).toEqual(position(1, 2))
    expect(store.getByCursor(1)?.envelope.entityId).toBe('thread-0')
    expect(store.getByCursor(2)?.envelope.entityId).toBe('thread-1')
    expect(seen).toEqual([1, 2])
    const since = store.since(position(1, 0))
    expect(since.kind).toBe('deltas')
    if (since.kind !== 'deltas') return
    expect(since.deltas.map((delta) => delta.cursor)).toEqual([1, 2])
    expect(since.deltas[0]?.previousCursor).toBe(0)
    expect(since.deltas[1]?.previousCursor).toBe(1)
    expect(store.findGroup('cmd-1')).toEqual({ ...appended.group, durable: true })
  })

  it('resolves awaitDurable immediately, without an fsync, when nothing is pending', async () => {
    const dataDir = directory()
    const fsyncs: string[] = []
    const store = new HostDeltaStore({ dataDir, now, groupFsync: recordingFsync(fsyncs) })
    store.append(legacy('seed'))
    await expect(store.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 1)
    })
    expect(fsyncs).toEqual([])
  })

  it('covers several groups and several waiters with one fsync', async () => {
    const dataDir = directory()
    const fsyncs: string[] = []
    const seen: number[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: recordingFsync(fsyncs)
    })
    store.append(legacy('seed'))
    store.subscribe((event) => seen.push(event.position.cursor))
    seen.length = 0

    expect(store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })).toMatchObject({
      kind: 'appended',
      group: { start: position(1, 2), end: position(1, 3) }
    })
    expect(store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })).toMatchObject({
      kind: 'appended',
      group: { start: position(1, 4), end: position(1, 4) }
    })
    expect(store.getAppendedPosition()).toEqual(position(1, 4))
    expect(store.getPosition()).toEqual(position(1, 1))

    const first = store.awaitDurable()
    const second = store.awaitDurable()
    await expect(first).resolves.toEqual({ kind: 'durable', position: position(1, 4) })
    await expect(second).resolves.toEqual({ kind: 'durable', position: position(1, 4) })
    expect(fsyncs.filter((path) => path === journalPath(dataDir))).toHaveLength(1)
    expect(seen).toEqual([2, 3, 4])
    expect(store.findGroup('a')?.durable).toBe(true)
    expect(store.findGroup('b')?.durable).toBe(true)
  })

  it('makes a waiter that arrives mid-fsync, with newer appends, wait for the next fsync', async () => {
    const dataDir = directory()
    const journal = journalPath(dataDir)
    const holds: Deferred[] = []
    const started: Deferred[] = [deferred(), deferred()]
    const seen: number[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: async (path) => {
        if (path !== journal) return
        const hold = deferred()
        holds.push(hold)
        started[holds.length - 1]?.resolve()
        await hold.promise
      }
    })
    store.append(legacy('seed'))
    store.subscribe((event) => seen.push(event.position.cursor))
    seen.length = 0

    store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
    const first = store.awaitDurable()
    await started[0]!.promise
    expect(holds).toHaveLength(1)

    // Appended while the first fsync is in flight: not covered by it.
    store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
    const second = store.awaitDurable()
    expect(await settledWithin(first)).toBe('pending')
    expect(await settledWithin(second)).toBe('pending')

    holds[0]!.resolve()
    await expect(first).resolves.toEqual({ kind: 'durable', position: position(1, 2) })
    expect(store.getPosition()).toEqual(position(1, 2))
    expect(store.getByCursor(3)).toBeNull()
    expect(seen).toEqual([2])
    expect(store.findGroup('a')?.durable).toBe(true)
    expect(store.findGroup('b')?.durable).toBe(false)

    await started[1]!.promise
    expect(holds).toHaveLength(2)
    expect(await settledWithin(second)).toBe('pending')
    holds[1]!.resolve()
    await expect(second).resolves.toEqual({ kind: 'durable', position: position(1, 3) })
    expect(store.getPosition()).toEqual(position(1, 3))
    expect(store.getByCursor(3)?.envelope.entityId).toBe('b-0')
    expect(seen).toEqual([2, 3])
    expect(store.findGroup('b')?.durable).toBe(true)
  })

  it('returns exists for a repeated commandId and writes nothing', async () => {
    const dataDir = directory()
    let writes = 0
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      batchWrite: (fd, bytes, offset, length) => {
        writes++
        return writeSync(fd, bytes, offset, length, null)
      }
    })
    const first = store.appendGroup({ commandId: 'cmd', effects: effects(2) })
    expect(first.kind).toBe('appended')
    if (first.kind !== 'appended') return
    const size = journalSize(dataDir)
    const writesAfterFirst = writes

    const again = store.appendGroup({ commandId: 'cmd', effects: effects(3, 'other') })
    expect(again).toEqual({ kind: 'exists', group: first.group })
    expect(writes).toBe(writesAfterFirst)
    expect(journalSize(dataDir)).toBe(size)
    expect(store.getAppendedPosition()).toEqual(position(1, 2))

    await store.awaitDurable()
    expect(store.appendGroup({ commandId: 'cmd', effects: [] })).toEqual({
      kind: 'exists',
      group: { ...first.group, durable: true }
    })
    expect(journalSize(dataDir)).toBe(size)
    expect(store.getPosition()).toEqual(position(1, 2))
  })

  it('rejects an invalid effect before the first byte', () => {
    const dataDir = directory()
    let writes = 0
    const store = new HostDeltaStore({
      dataDir,
      now,
      batchWrite: (fd, bytes, offset, length) => {
        writes++
        return writeSync(fd, bytes, offset, length, null)
      }
    })
    const input = effects(3)
    input[1] = { ...input[1]!, payload: { secret: 'must-not-persist' } }
    expect(store.appendGroup({ commandId: 'cmd', effects: input })).toMatchObject({
      kind: 'rejected',
      failedAtIndex: 1,
      result: { kind: 'rejected', reason: 'forbidden_payload' },
      position: position(1, 0)
    })
    expect(
      store.appendGroup({
        commandId: 'cmd',
        effects: [{ kind: 'generation-reset', family: 'snapshot-meta' }]
      })
    ).toMatchObject({
      kind: 'rejected',
      failedAtIndex: 0,
      result: { kind: 'rejected', reason: 'invalid_envelope' }
    })
    expect(writes).toBe(0)
    expect(existsSync(journalPath(dataDir))).toBe(false)
    expect(store.findGroup('cmd')).toBeNull()
    expect(store.getAppendedPosition()).toEqual(position(1, 0))
  })

  it('rejects an empty or oversized commandId before the first byte', () => {
    const dataDir = directory()
    let writes = 0
    const store = new HostDeltaStore({
      dataDir,
      now,
      batchWrite: (fd, bytes, offset, length) => {
        writes++
        return writeSync(fd, bytes, offset, length, null)
      }
    })
    for (const commandId of ['', 'x'.repeat(513)]) {
      const result = store.appendGroup({ commandId, effects: effects(1) })
      expect(result.kind).toBe('rejected')
      expect(result).toMatchObject({ position: position(1, 0) })
    }
    expect(store.appendGroup({ commandId: 'x'.repeat(512), effects: effects(1) }).kind).toBe(
      'appended'
    )
    expect(writes).toBe(1)
  })

  it('rolls a failed group write back as appendBatch does, then resets the generation (7b)', async () => {
    const dataDir = directory()
    let failNextWrite = false
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      batchWrite: (fd, bytes, offset, length) => {
        if (failNextWrite) {
          // Only the group line fails; the reset that follows goes through
          // the same seam and must succeed.
          failNextWrite = false
          throw new Error('injected group write failure')
        }
        return writeSync(fd, bytes, offset, length, null)
      }
    })
    store.append(legacy('seed'))
    const before = readFileSync(journalPath(dataDir))
    failNextWrite = true
    expect(store.appendGroup({ commandId: 'cmd', effects: effects(2) })).toMatchObject({
      kind: 'write-failed',
      rollback: 'proven',
      recovery: { kind: 'reset', position: position(2, 1) }
    })
    // The rollback restored the earlier bytes; the reset chained after them.
    expect(readFileSync(journalPath(dataDir)).subarray(0, before.length)).toEqual(before)
    expect(journalLines(dataDir).map((line) => line.op)).toEqual([
      'append',
      'generation-reset',
      'append'
    ])
    expect(store.findGroup('cmd')).toBeNull()
    expect(store.getAppendedPosition()).toEqual(position(2, 1))
    expect(store.appendGroup({ commandId: 'cmd', effects: effects(1) })).toMatchObject({
      kind: 'appended',
      group: { start: position(2, 2), end: position(2, 2) }
    })
    await store.awaitDurable()
    expect(new HostDeltaStore({ dataDir, now }).getPosition()).toEqual(position(2, 2))
  })

  it('accepts the empty group: count 0, start and end at the head, one journal line', async () => {
    const dataDir = directory()
    const seen: number[] = []
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.append(legacy('seed'))
    store.subscribe((event) => seen.push(event.position.cursor))
    seen.length = 0

    const result = store.appendGroup({ commandId: 'empty', effects: [] })
    // §15.1 leaves an empty group's pre-flush `durable` open (nothing of it
    // needs an fsync to be visible), so only its shape and positions are pinned.
    expect(result).toMatchObject({
      kind: 'appended',
      group: {
        commandId: 'empty',
        count: 0,
        setDigest: hostDeltaGroupSetDigest([]),
        start: position(1, 1),
        end: position(1, 1)
      }
    })
    expect(store.getAppendedPosition()).toEqual(position(1, 1))
    const lines = journalLines(dataDir)
    expect(lines).toHaveLength(2)
    // The contract names these fields; an empty group may carry extra anchors
    // since no record places it on reopen.
    expect(lines[1]).toMatchObject({
      op: 'group',
      commandId: 'empty',
      count: 0,
      setDigest: hostDeltaGroupSetDigest([]),
      records: []
    })

    await expect(store.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 1)
    })
    expect(seen).toEqual([])
    expect(store.findGroup('empty')?.durable).toBe(true)
    expect(store.appendGroup({ commandId: 'empty', effects: effects(1) }).kind).toBe('exists')

    if (result.kind !== 'appended') return
    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getPosition()).toEqual(position(1, 1))
    expect(reopened.findGroup('empty')).toEqual({ ...result.group, durable: true })
    expect(reopened.getRecoveryState().recoveryState).toBe('clean')
  })

  it('stores the digest of the fingerprints in cursor order and keeps txn off the wire', async () => {
    const dataDir = directory()
    const events: unknown[] = []
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.subscribe((event) => events.push(event))
    const result = store.appendGroup({ commandId: 'cmd', effects: effects(3) })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    await store.awaitDurable()

    const fingerprints = [1, 2, 3].map((cursor) => store.getByCursor(cursor)!.contentFingerprint)
    const expected = createHash('sha256').update(JSON.stringify(fingerprints), 'utf8').digest('hex')
    expect(hostDeltaGroupSetDigest(fingerprints)).toBe(expected)
    expect(result.group.setDigest).toBe(expected)
    expect(hostDeltaGroupSetDigest([...fingerprints].reverse())).not.toBe(expected)

    const [line] = journalLines(dataDir)
    expect(line).toMatchObject({ op: 'group', commandId: 'cmd', count: 3, setDigest: expected })
    const records = line!.records as Array<Record<string, unknown>>
    expect(records).toHaveLength(3)
    records.forEach((record, index) => {
      expect(Object.keys(record).sort()).toEqual(
        ['contentFingerprint', 'envelope', 'retainedBytes', 'schemaVersion', 'txn'].sort()
      )
      expect(record.txn).toEqual({ commandId: 'cmd', index })
      expect(record.contentFingerprint).toBe(fingerprints[index])
      expectNoTxn(record.envelope)
    })

    // The fingerprint is the envelope's alone: a legacy append of the same
    // effect in a fresh store fingerprints identically.
    const twin = new HostDeltaStore({ dataDir: directory(), now })
    const twinResult = twin.append(effects(3)[0]!)
    expect(twinResult.kind).toBe('appended')
    if (twinResult.kind !== 'appended') return
    expect(twinResult.record.contentFingerprint).toBe(fingerprints[0])

    for (const cursor of [1, 2, 3]) {
      const record = store.getByCursor(cursor)!
      expect(Object.keys(record).sort()).toEqual(
        ['contentFingerprint', 'envelope', 'retainedBytes', 'schemaVersion'].sort()
      )
      expectNoTxn(record)
    }
    const since = store.since(position(1, 0))
    expect(since.kind).toBe('deltas')
    expectNoTxn(since)
    expect(events).toHaveLength(3)
    expectNoTxn(events)
  })

  it('settles pending groups first, in cursor order, when a legacy append arrives', async () => {
    const dataDir = directory()
    const fsyncs: string[] = []
    const seen: Array<[number, string | undefined]> = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: recordingFsync(fsyncs)
    })
    store.subscribe((event) => seen.push([event.position.cursor, event.record.envelope.entityId]))
    store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
    store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })
    expect(seen).toEqual([])

    const appended = store.append(legacy('after'))
    expect(appended).toMatchObject({ kind: 'appended', position: position(1, 4) })
    expect(seen).toEqual([
      [1, 'a-0'],
      [2, 'a-1'],
      [3, 'b-0'],
      [4, 'after']
    ])
    expect(store.getPosition()).toEqual(position(1, 4))
    expect(store.getAppendedPosition()).toEqual(position(1, 4))
    expect(store.findGroup('a')?.durable).toBe(true)
    expect(store.findGroup('b')?.durable).toBe(true)
    // The legacy path's own synchronous fsync did the work: no async fsync.
    expect(fsyncs).toEqual([])
    await expect(store.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 4)
    })
    expect(fsyncs).toEqual([])

    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getPosition()).toEqual(position(1, 4))
    expect(reopened.since(position(1, 0))).toMatchObject({ kind: 'deltas', toCursor: 4 })
  })

  it('settles pending groups and resolves their waiters when appendBatch arrives mid-fsync', async () => {
    const dataDir = directory()
    const journal = journalPath(dataDir)
    const hold = deferred()
    const started = deferred()
    const seen: number[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: async (path) => {
        if (path !== journal) return
        started.resolve()
        await hold.promise
      }
    })
    store.subscribe((event) => seen.push(event.position.cursor))
    const group = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
    expect(group.kind).toBe('appended')
    const waiter = store.awaitDurable()
    await started.promise
    expect(await settledWithin(waiter)).toBe('pending')

    expect(store.appendBatch(effects(2, 'batch'))).toMatchObject({
      kind: 'appended',
      position: position(1, 4)
    })
    expect(seen).toEqual([1, 2, 3, 4])
    expect(store.getPosition()).toEqual(position(1, 4))
    const settled = await settledWithin(waiter)
    expect(settled).not.toBe('pending')
    expect(settled).toMatchObject({ kind: 'durable' })
    if (settled === 'pending' || settled.kind !== 'durable') return
    expect(settled.position.generation).toBe(1)
    expect(settled.position.cursor).toBeGreaterThanOrEqual(2)
    hold.resolve()
    await expect(store.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 4)
    })
  })

  it('makes a group durable, then resets, and the reset clears findGroup', () => {
    const dataDir = directory()
    const seen: Array<[number, number, string]> = []
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.subscribe((event) =>
      seen.push([event.position.generation, event.position.cursor, event.record.envelope.kind])
    )
    store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
    expect(store.findGroup('a')).not.toBeNull()

    const reset = store.resetGeneration('slice 7a fixture')
    expect(reset).toMatchObject({ kind: 'appended', position: position(2, 1) })
    expect(seen).toEqual([
      [1, 1, 'upsert'],
      [1, 2, 'upsert'],
      [2, 1, 'generation-reset']
    ])
    expect(store.findGroup('a')).toBeNull()
    expect(store.getPosition()).toEqual(position(2, 1))
    expect(store.getAppendedPosition()).toEqual(position(2, 1))

    // The old commandId is free again in the new generation.
    expect(store.appendGroup({ commandId: 'a', effects: effects(1, 'again') })).toMatchObject({
      kind: 'appended',
      group: { commandId: 'a', start: position(2, 2), end: position(2, 2), durable: false }
    })
    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getPosition()).toEqual(position(2, 2))
    expect(reopened.findGroup('a')).toMatchObject({ start: position(2, 2), durable: true })
  })

  it('fsyncs the data directory only when the group created the journal', async () => {
    if (process.platform === 'win32') return
    const created = directory()
    const createdFsyncs: string[] = []
    const store = new HostDeltaStore({
      dataDir: created,
      now,
      groupFsync: recordingFsync(createdFsyncs)
    })
    expect(existsSync(journalPath(created))).toBe(false)
    store.appendGroup({ commandId: 'first', effects: effects(1) })
    await store.awaitDurable()
    expect(createdFsyncs).toContain(journalPath(created))
    expect(createdFsyncs).toContain(created)
    expect(createdFsyncs.filter((path) => path === created)).toHaveLength(1)

    // A later flush of a journal that already existed does not touch the directory.
    createdFsyncs.length = 0
    store.appendGroup({ commandId: 'second', effects: effects(1, 'second') })
    await store.awaitDurable()
    expect(createdFsyncs).toEqual([journalPath(created)])

    const existing = directory()
    const existingFsyncs: string[] = []
    const seeded = new HostDeltaStore({
      dataDir: existing,
      now,
      groupFsync: recordingFsync(existingFsyncs)
    })
    seeded.append(legacy('seed'))
    seeded.appendGroup({ commandId: 'cmd', effects: effects(1) })
    await seeded.awaitDurable()
    expect(existingFsyncs).toEqual([journalPath(existing)])
  })

  it('resolves reset for a failed fsync and keeps append authority open (7b)', async () => {
    const dataDir = directory()
    const store = new HostDeltaStore({
      dataDir,
      now,
      groupFsync: async () => {
        throw new Error('injected group fsync failure')
      }
    })
    store.append(legacy('seed'))
    const group = store.appendGroup({ commandId: 'cmd', effects: effects(1) })
    expect(group.kind).toBe('appended')
    const first = store.awaitDurable()
    const second = store.awaitDurable()
    await expect(first).resolves.toMatchObject({
      kind: 'reset',
      position: position(2, 1),
      detail: expect.stringContaining('injected group fsync failure')
    })
    await expect(second).resolves.toMatchObject({ kind: 'reset', position: position(2, 1) })
    expect(store.getPosition()).toEqual(position(2, 1))
    expect(store.getByCursor(2)).toBeNull()
    expect(store.findGroup('cmd')).toBeNull()
    expect(store.getFailStop()).toBeNull()
    expect(store.appendGroup({ commandId: 'next', effects: effects(1) })).toMatchObject({
      kind: 'appended',
      group: { start: position(2, 2), end: position(2, 2) }
    })
    expect(store.append(legacy('next'))).toMatchObject({
      kind: 'appended',
      position: position(2, 3)
    })
  })

  it('reopens a whole group as durable records that chain with later appends', async () => {
    const dataDir = directory()
    const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
    store.append(legacy('seed'))
    const a = store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
    const b = store.appendGroup({ commandId: 'b', effects: [] })
    await store.awaitDurable()
    store.append(legacy('tail'))
    expect(a.kind).toBe('appended')
    expect(b.kind).toBe('appended')
    if (a.kind !== 'appended' || b.kind !== 'appended') return

    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    expect(reopened.getPosition()).toEqual(position(1, 4))
    expect(reopened.getAppendedPosition()).toEqual(position(1, 4))
    expect(reopened.findGroup('a')).toEqual({ ...a.group, durable: true })
    expect(reopened.findGroup('b')).toEqual({ ...b.group, durable: true })
    expect(reopened.findGroup('missing')).toBeNull()
    expect([1, 2, 3, 4].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual([
      'seed',
      'a-0',
      'a-1',
      'tail'
    ])
    for (const cursor of [2, 3]) expectNoTxn(reopened.getByCursor(cursor))
    const since = reopened.since(position(1, 1))
    expect(since).toMatchObject({ kind: 'deltas', fromCursor: 1, toCursor: 4 })
    expectNoTxn(since)
    await expect(reopened.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 4)
    })
  })

  describe('reopen skips a group line that is not whole', () => {
    async function journalWithGroup(): Promise<{
      dataDir: string
      group: HostDeltaGroupDescriptor
      lines: Array<Record<string, unknown>>
    }> {
      const dataDir = directory()
      const store = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 })
      store.append(legacy('seed'))
      const result = store.appendGroup({ commandId: 'cmd', effects: effects(2) })
      await store.awaitDurable()
      store.append(legacy('tail'))
      if (result.kind !== 'appended') throw new Error(`unexpected ${result.kind}`)
      const lines = journalLines(dataDir)
      expect(lines.map((line) => line.op)).toEqual(['append', 'group', 'append'])
      return { dataDir, group: result.group, lines }
    }

    function rewrite(dataDir: string, lines: Array<Record<string, unknown>>) {
      writeFileSync(
        journalPath(dataDir),
        lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
        'utf8'
      )
    }

    function expectSkippedWhole(dataDir: string) {
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('recovered-corrupt-interior')
      expect(reopened.findGroup('cmd')).toBeNull()
      // Neither record of the group is applied, so the tail cannot chain either.
      expect(reopened.getPosition()).toEqual(position(1, 1))
      expect(reopened.getByCursor(1)?.envelope.entityId).toBe('seed')
      expect(reopened.getByCursor(2)).toBeNull()
      expect(reopened.getByCursor(3)).toBeNull()
      expect(reopened.getByCursor(4)).toBeNull()
      return reopened
    }

    it('mismatched count', async () => {
      const { dataDir, lines } = await journalWithGroup()
      lines[1] = { ...lines[1]!, count: 1 }
      rewrite(dataDir, lines)
      expectSkippedWhole(dataDir)
    })

    it('mismatched setDigest', async () => {
      const { dataDir, lines } = await journalWithGroup()
      lines[1] = { ...lines[1]!, setDigest: hostDeltaGroupSetDigest(['0'.repeat(64)]) }
      rewrite(dataDir, lines)
      expectSkippedWhole(dataDir)
    })

    it('txn naming another command', async () => {
      const { dataDir, lines } = await journalWithGroup()
      const records = lines[1]!.records as Array<Record<string, unknown>>
      records[1] = { ...records[1]!, txn: { commandId: 'other', index: 1 } }
      rewrite(dataDir, lines)
      expectSkippedWhole(dataDir)
    })

    it('txn at the wrong index', async () => {
      const { dataDir, lines } = await journalWithGroup()
      const records = lines[1]!.records as Array<Record<string, unknown>>
      records[0] = { ...records[0]!, txn: { commandId: 'cmd', index: 1 } }
      rewrite(dataDir, lines)
      expectSkippedWhole(dataDir)
    })

    it('a record without txn', async () => {
      const { dataDir, lines } = await journalWithGroup()
      const records = lines[1]!.records as Array<Record<string, unknown>>
      const { txn: _txn, ...bare } = records[0]!
      records[0] = bare
      rewrite(dataDir, lines)
      expectSkippedWhole(dataDir)
    })

    it('and the unedited line still reopens whole (control)', async () => {
      const { dataDir, lines, group } = await journalWithGroup()
      rewrite(dataDir, lines)
      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(1, 4))
      expect(reopened.findGroup('cmd')).toEqual({ ...group, durable: true })
    })
  })

  it('leaves legacy behaviour byte-identical when no group is appended', async () => {
    const plain = directory()
    const withSeam = directory()
    const fsyncs: string[] = []
    const script = (store: HostDeltaStore) => {
      store.append(legacy('one'))
      store.appendBatch(effects(2, 'batch'))
      store.resetGeneration('legacy fixture')
      store.append(legacy('two'))
    }
    const control = new HostDeltaStore({ dataDir: plain, now, compactAfterRecords: 10000 })
    script(control)
    const subject = new HostDeltaStore({
      dataDir: withSeam,
      now,
      compactAfterRecords: 10000,
      groupFsync: recordingFsync(fsyncs)
    })
    const seen: number[] = []
    subject.subscribe((event) => seen.push(event.position.cursor))
    script(subject)

    expect(readFileSync(journalPath(withSeam))).toEqual(readFileSync(journalPath(plain)))
    expect(journalLines(withSeam).map((line) => line.op)).toEqual([
      'append',
      'append',
      'append',
      'generation-reset',
      'append',
      'append'
    ])
    expect(fsyncs).toEqual([])
    expect(seen).toEqual([1, 2, 3, 1, 2])
    expect(subject.getPosition()).toEqual(position(2, 2))
    expect(subject.getAppendedPosition()).toEqual(position(2, 2))
    expect(subject.findGroup('anything')).toBeNull()
    await expect(subject.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(2, 2)
    })
    expect(fsyncs).toEqual([])
    expect(new HostDeltaStore({ dataDir: withSeam, now }).getPosition()).toEqual(position(2, 2))
  })
})

// Independent review of slices 7a-8 (design §18): each case is the probe that
// found the defect.
describe('HostDeltaStore group durability, review fixes', () => {
  it('never reports an empty group durable, or resolves awaitDurable, before an fsync covers its line', async () => {
    const dataDir = directory()
    const fsyncs: string[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      groupFsync: recordingFsync(fsyncs)
    })
    const result = store.appendGroup({ commandId: 'empty', effects: [] })
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    // Its line is written but not flushed, although no cursor moved.
    expect(result.group.durable).toBe(false)
    expect(store.findGroup('empty')?.durable).toBe(false)

    await expect(store.awaitDurable()).resolves.toMatchObject({ kind: 'durable' })
    expect(fsyncs).toContain(journalPath(dataDir))
    expect(store.findGroup('empty')?.durable).toBe(true)
  })

  it('notifies every record an inline compact() makes durable, even ones retention cuts', () => {
    const dataDir = directory()
    const store = new HostDeltaStore({ dataDir, now, maxRecords: 2, compactAfterRecords: 10000 })
    const seen: number[] = []
    store.subscribe((event) => seen.push(event.position.cursor))
    store.appendGroup({ commandId: 'four', effects: effects(4) })
    expect(seen).toEqual([])

    store.compact()

    // Retention kept only the newest two, but all four are durable in the
    // checkpoint's head: listeners must not see a chain gap.
    expect(seen).toEqual([1, 2, 3, 4])
    expect(store.getPosition()).toEqual(position(1, 4))
  })
})
