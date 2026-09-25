import { existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HostDeltaStore,
  HOST_DELTA_JOURNAL_FILENAME,
  type HostDeltaAppendInput,
  type HostDeltaStoreOptions
} from './HostDeltaStore'
import type { HostCursorPosition } from '../shared/hostProtocol'

// M4 slice 7b (design §15.4): a failed group fsync, or a failed group write
// with a proven rollback, drops everything not yet durable and resets the
// generation (RR-7). If that reset itself fails, or a rollback is uncertain,
// the store fail-stops (§13 SF-2): every entry point is blocked for the
// instance, `reopen()` does not lift it, and no dropped record is ever
// notified. Every clause is pinned at the store seam; nothing in production
// calls the group API until slice 12.

const BLOCKED = 'Host delta append authority is blocked'
const RESET_REASON = 'group durability failed'

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-delta-group-failure-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

const now = () => '2026-09-25T12:00:00.000Z'
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

function journalPath(dataDir: string) {
  return join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
}
function journalLines(dataDir: string): Array<Record<string, unknown>> {
  if (!existsSync(journalPath(dataDir))) return []
  return readFileSync(journalPath(dataDir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
function journalOps(dataDir: string) {
  return journalLines(dataDir).map((line) => line.op)
}
function position(generation: number, cursor: number): HostCursorPosition {
  return { generation, cursor }
}

type Seen = [generation: number, cursor: number, kind: string]
function record(store: HostDeltaStore): Seen[] {
  const seen: Seen[] = []
  store.subscribe((event) =>
    seen.push([event.position.generation, event.position.cursor, event.record.envelope.kind])
  )
  return seen
}
const RESET_EVENT: Seen = [2, 1, 'generation-reset']

/**
 * The first journal fsync through the seam is held until `hold` settles
 * (reject it to fail the fsync); every later call succeeds at once. The
 * directory fsync always succeeds.
 */
function heldFirstFsync(
  journal: string,
  hold: Deferred,
  started: Deferred
): NonNullable<HostDeltaStoreOptions['groupFsync']> {
  let calls = 0
  return async (path) => {
    if (path !== journal) return
    calls += 1
    if (calls === 1) {
      started.resolve()
      await hold.promise
    }
  }
}

/** A journal fsync seam that throws while `armed()` and succeeds otherwise. */
function armableFsync(
  journal: string,
  armed: () => boolean
): NonNullable<HostDeltaStoreOptions['groupFsync']> {
  return async (path) => {
    if (path === journal && armed()) throw new Error('injected group fsync failure')
  }
}

function expectBlocked(store: HostDeltaStore) {
  expect(() => store.appendGroup({ commandId: 'blocked', effects: effects(1) })).toThrow(BLOCKED)
  expect(() => store.append(legacy('blocked'))).toThrow(BLOCKED)
  expect(() => store.appendBatch(effects(1, 'blocked'))).toThrow(BLOCKED)
  expect(() => store.resetGeneration('blocked')).toThrow(BLOCKED)
  expect(() => store.compact()).toThrow(BLOCKED)
}

function expectResetEnvelope(store: HostDeltaStore) {
  const reset = store.getByCursor(1)
  expect(reset?.envelope).toMatchObject({
    kind: 'generation-reset',
    family: 'snapshot-meta',
    generation: 2,
    cursor: 1,
    previousCursor: 0,
    payload: { reason: RESET_REASON }
  })
}

describe('HostDeltaStore group failure (M4 slice 7b)', () => {
  describe('a failed group fsync resets the generation', () => {
    it('resolves reset for every waiter, including a group appended mid-flight, and a later group works', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const failStops: string[] = []
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started),
        onFailStop: (detail) => failStops.push(detail)
      })
      store.append(legacy('seed'))
      const seen = record(store)

      expect(store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 2), end: position(1, 3) }
      })
      const first = store.awaitDurable()
      await started.promise

      // Appended while the failing fsync is in flight: dropped with the rest.
      expect(store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 4), end: position(1, 4) }
      })
      const second = store.awaitDurable()
      expect(await settledWithin(first)).toBe('pending')
      expect(await settledWithin(second)).toBe('pending')

      hold.reject(new Error('injected group fsync failure'))
      await expect(first).resolves.toEqual({
        kind: 'reset',
        position: position(2, 1),
        detail: expect.stringContaining('injected group fsync failure')
      })
      await expect(second).resolves.toEqual({
        kind: 'reset',
        position: position(2, 1),
        detail: expect.stringContaining('injected group fsync failure')
      })

      // Everything not durable left memory; only the reset was ever notified.
      expect(store.findGroup('a')).toBeNull()
      expect(store.findGroup('b')).toBeNull()
      expect(store.getPosition()).toEqual(position(2, 1))
      expect(store.getAppendedPosition()).toEqual(position(2, 1))
      expect(seen).toEqual([RESET_EVENT])
      expectResetEnvelope(store)
      for (const cursor of [2, 3, 4]) expect(store.getByCursor(cursor)).toBeNull()
      expect(store.since(position(1, 1))).toEqual({
        kind: 'full_resnapshot_required',
        reason: 'generation_reset',
        generation: 2,
        cursor: 1,
        clientGeneration: 1,
        clientCursor: 1
      })
      expect(store.since(position(2, 0))).toMatchObject({
        kind: 'deltas',
        generation: 2,
        toCursor: 1,
        deltas: [{ kind: 'generation-reset', cursor: 1 }]
      })
      expect(journalOps(dataDir)).toEqual([
        'append',
        'group',
        'group',
        'generation-reset',
        'append'
      ])
      expect(journalLines(dataDir)[3]).toMatchObject({
        op: 'generation-reset',
        previousGeneration: 1,
        generation: 2,
        reason: RESET_REASON
      })

      // Not a fail-stop: authority stays open and the next group lands in gen 2.
      expect(store.getFailStop()).toBeNull()
      expect(failStops).toEqual([])
      expect(store.appendGroup({ commandId: 'a', effects: effects(1, 'again') })).toMatchObject({
        kind: 'appended',
        group: { commandId: 'a', start: position(2, 2), end: position(2, 2), durable: false }
      })
      await expect(store.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(2, 2)
      })
      expect(store.findGroup('a')?.durable).toBe(true)
      expect(seen).toEqual([RESET_EVENT, [2, 2, 'upsert']])
      expect(store.getByCursor(2)?.envelope.entityId).toBe('again-0')
    })

    it('stands after a reopen, with the old generation groups gone', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      let failing = true
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: armableFsync(journal, () => failing)
      })
      store.append(legacy('seed'))
      store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })
      store.appendGroup({ commandId: 'b', effects: [] })
      await expect(store.awaitDurable()).resolves.toMatchObject({
        kind: 'reset',
        position: position(2, 1)
      })
      failing = false

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(2, 1))
      expect(reopened.getAppendedPosition()).toEqual(position(2, 1))
      expect(reopened.findGroup('a')).toBeNull()
      expect(reopened.findGroup('b')).toBeNull()
      expectResetEnvelope(reopened)
      expect(reopened.getByCursor(2)).toBeNull()
      expect(reopened.getFailStop()).toBeNull()
      expect(reopened.since(position(1, 3))).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'generation_reset',
        generation: 2,
        cursor: 1
      })
      await expect(reopened.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(2, 1)
      })

      // The old commandIds are free again in the new generation.
      expect(reopened.appendGroup({ commandId: 'a', effects: effects(1, 'again') })).toMatchObject({
        kind: 'appended',
        group: { start: position(2, 2), end: position(2, 2) }
      })
      await expect(reopened.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(2, 2)
      })
    })

    it('resolves durable, with no reset, when a legacy fsync already covered the failed one', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const failStops: string[] = []
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started),
        onFailStop: (detail) => failStops.push(detail)
      })
      store.append(legacy('seed'))
      const seen = record(store)
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      const waiter = store.awaitDurable()
      await started.promise
      expect(await settledWithin(waiter)).toBe('pending')

      // The legacy append's synchronous fsync makes the group durable first.
      expect(store.append(legacy('after'))).toMatchObject({
        kind: 'appended',
        position: position(1, 3)
      })
      // The waiter covers what was appended before it was called: the group.
      await expect(waiter).resolves.toEqual({ kind: 'durable', position: position(1, 2) })

      hold.reject(new Error('injected group fsync failure'))
      // Let the rejected flush settle before checking that nothing happened.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(store.getPosition()).toEqual(position(1, 3))
      expect(store.getAppendedPosition()).toEqual(position(1, 3))
      expect(store.findGroup('a')).toEqual(expect.objectContaining({ durable: true }))
      expect(seen).toEqual([
        [1, 2, 'upsert'],
        [1, 3, 'upsert']
      ])
      expect(journalOps(dataDir)).toEqual(['append', 'group', 'append'])
      expect(store.getFailStop()).toBeNull()
      expect(failStops).toEqual([])

      expect(store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 4), end: position(1, 4) }
      })
      await expect(store.awaitDurable()).resolves.toEqual({
        kind: 'durable',
        position: position(1, 4)
      })
      expect(seen).toEqual([
        [1, 2, 'upsert'],
        [1, 3, 'upsert'],
        [1, 4, 'upsert']
      ])
    })
  })

  describe('a failed reset fail-stops the store', () => {
    /**
     * Seeds a store with one durable legacy record and one pending group,
     * subscribes a listener, then arms the given seam so only the reset that
     * follows the failing fsync can hit it. The group's own write went through
     * the seam before arming.
     */
    function pendingGroupWithArmedSeam(seam: 'batchWrite' | 'batchFsync') {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      let armed = false
      const failStops: string[] = []
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: armableFsync(journal, () => true),
        onFailStop: (detail) => failStops.push(detail),
        batchWrite: (descriptor, bytes, offset, length) => {
          if (seam === 'batchWrite' && armed) throw new Error('injected reset write failure')
          return writeSync(descriptor, bytes, offset, length, null)
        },
        batchFsync: (descriptor) => {
          if (seam === 'batchFsync' && armed) throw new Error('injected reset fsync failure')
          // Real durability is not under test; the seam only decides the verdict.
          void descriptor
        }
      })
      store.append(legacy('seed'))
      const seen = record(store)
      expect(store.appendGroup({ commandId: 'a', effects: effects(2, 'a') })).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 2), end: position(1, 3) }
      })
      const linesBefore = journalOps(dataDir)
      armed = true
      return { dataDir, store, seen, failStops, linesBefore }
    }

    function expectFailStopped(
      fixture: ReturnType<typeof pendingGroupWithArmedSeam>,
      detailFragment: string
    ) {
      const { store, seen, failStops, dataDir, linesBefore } = fixture
      expect(store.getFailStop()).toEqual({ detail: expect.stringContaining(detailFragment) })
      expect(failStops).toEqual([expect.stringContaining(detailFragment)])
      expectBlocked(store)
      // Still exactly once after every blocked entry point was tried.
      expect(failStops).toHaveLength(1)

      // No dropped record was ever notified, and none is readable.
      expect(seen).toEqual([])
      expect(store.getPosition()).toEqual(position(1, 1))
      expect(store.getByCursor(2)).toBeNull()
      expect(store.getByCursor(3)).toBeNull()
      expect(store.findGroup('a')).toBeNull()
      expect(journalOps(dataDir)).not.toContain('generation-reset')
      expect(journalOps(dataDir).slice(0, linesBefore.length)).toEqual(linesBefore)

      // reopen() on the instance does not lift the fail-stop.
      store.reopen()
      expect(store.getFailStop()).toEqual({ detail: expect.stringContaining(detailFragment) })
      expectBlocked(store)
      expect(failStops).toHaveLength(1)
      expect(seen).toEqual([])
    }

    it('when the reset write fails: every waiter resolves fail-stopped, onFailStop once, all entry points blocked', async () => {
      const fixture = pendingGroupWithArmedSeam('batchWrite')
      const first = fixture.store.awaitDurable()
      const second = fixture.store.awaitDurable()
      await expect(first).resolves.toEqual({
        kind: 'fail-stopped',
        detail: expect.stringContaining('injected reset write failure')
      })
      await expect(second).resolves.toEqual({
        kind: 'fail-stopped',
        detail: expect.stringContaining('injected reset write failure')
      })
      expectFailStopped(fixture, 'injected reset write failure')
    })

    it('when the reset fsync fails: every waiter resolves fail-stopped, onFailStop once, all entry points blocked', async () => {
      const fixture = pendingGroupWithArmedSeam('batchFsync')
      const first = fixture.store.awaitDurable()
      const second = fixture.store.awaitDurable()
      await expect(first).resolves.toEqual({
        kind: 'fail-stopped',
        detail: expect.stringContaining('injected reset fsync failure')
      })
      await expect(second).resolves.toEqual({
        kind: 'fail-stopped',
        detail: expect.stringContaining('injected reset fsync failure')
      })
      expectFailStopped(fixture, 'injected reset fsync failure')
    })

    it('a new store instance on the same directory is the only way on', async () => {
      const fixture = pendingGroupWithArmedSeam('batchWrite')
      await expect(fixture.store.awaitDurable()).resolves.toMatchObject({ kind: 'fail-stopped' })

      // Boot recovery: the group line is whole on disk, so it reopens durable
      // in generation 1 and authority is open.
      const recovered = new HostDeltaStore({ dataDir: fixture.dataDir, now })
      expect(recovered.getFailStop()).toBeNull()
      expect(recovered.getPosition()).toEqual(position(1, 3))
      expect(recovered.findGroup('a')).toMatchObject({ durable: true })
      expect(recovered.append(legacy('after'))).toMatchObject({
        kind: 'appended',
        position: position(1, 4)
      })
    })
  })

  describe('a failed group write', () => {
    it('with a proven rollback resets the generation, and an earlier pending group resolves reset', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const failStops: string[] = []
      let failNextWrite = false
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started),
        onFailStop: (detail) => failStops.push(detail),
        batchWrite: (descriptor, bytes, offset, length) => {
          if (failNextWrite) {
            // Only the group line fails; the reset that follows must succeed.
            failNextWrite = false
            throw new Error('injected group write failure')
          }
          return writeSync(descriptor, bytes, offset, length, null)
        }
      })
      store.append(legacy('seed'))
      const seen = record(store)
      const before = readFileSync(journal)

      expect(store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })).toMatchObject({
        kind: 'appended',
        group: { start: position(1, 2), end: position(1, 2) }
      })
      const earlier = store.awaitDurable()
      await started.promise
      expect(await settledWithin(earlier)).toBe('pending')
      const afterGroupA = readFileSync(journal)

      failNextWrite = true
      const failed = store.appendGroup({ commandId: 'b', effects: effects(2, 'b') })
      expect(failed).toMatchObject({
        kind: 'write-failed',
        detail: expect.stringContaining('injected group write failure'),
        rollback: 'proven',
        recovery: { kind: 'reset', position: position(2, 1) }
      })
      expect(failNextWrite).toBe(false)

      // The rollback left the earlier bytes intact; the reset chained after them.
      const after = readFileSync(journal)
      expect(after.subarray(0, afterGroupA.length)).toEqual(afterGroupA)
      expect(after.subarray(0, before.length)).toEqual(before)
      expect(journalOps(dataDir)).toEqual(['append', 'group', 'generation-reset', 'append'])
      expect(journalLines(dataDir)[2]).toMatchObject({
        op: 'generation-reset',
        previousGeneration: 1,
        generation: 2,
        reason: RESET_REASON
      })

      // The earlier pending group was dropped and its waiter resolved reset.
      await expect(earlier).resolves.toEqual({
        kind: 'reset',
        position: position(2, 1),
        detail: expect.any(String)
      })
      expect(store.findGroup('a')).toBeNull()
      expect(store.findGroup('b')).toBeNull()
      expect(store.getPosition()).toEqual(position(2, 1))
      expect(store.getAppendedPosition()).toEqual(position(2, 1))
      expect(seen).toEqual([RESET_EVENT])
      expectResetEnvelope(store)
      expect(store.getFailStop()).toBeNull()
      expect(failStops).toEqual([])

      // Authority stays open: a later group lands in generation 2, and the
      // stale in-flight fsync landing afterwards changes nothing.
      expect(store.appendGroup({ commandId: 'b', effects: effects(1, 'again') })).toMatchObject({
        kind: 'appended',
        group: { start: position(2, 2), end: position(2, 2) }
      })
      const later = store.awaitDurable()
      hold.resolve()
      await expect(later).resolves.toEqual({ kind: 'durable', position: position(2, 2) })
      expect(store.getPosition()).toEqual(position(2, 2))
      expect(seen).toEqual([RESET_EVENT, [2, 2, 'upsert']])
      expect(store.getFailStop()).toBeNull()

      const reopened = new HostDeltaStore({ dataDir, now })
      expect(reopened.getRecoveryState().recoveryState).toBe('clean')
      expect(reopened.getPosition()).toEqual(position(2, 2))
      expect(reopened.findGroup('a')).toBeNull()
      expect(reopened.findGroup('b')).toMatchObject({ start: position(2, 2), durable: true })
    })

    it('with a proven rollback and nothing pending resets at once', () => {
      const dataDir = directory()
      let failNextWrite = false
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        batchWrite: (descriptor, bytes, offset, length) => {
          if (failNextWrite) {
            failNextWrite = false
            throw new Error('injected group write failure')
          }
          return writeSync(descriptor, bytes, offset, length, null)
        }
      })
      store.append(legacy('seed'))
      const seen = record(store)
      failNextWrite = true
      expect(store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })).toMatchObject({
        kind: 'write-failed',
        rollback: 'proven',
        recovery: { kind: 'reset', position: position(2, 1) }
      })
      expect(seen).toEqual([RESET_EVENT])
      expect(store.getPosition()).toEqual(position(2, 1))
      expect(store.getFailStop()).toBeNull()
      expect(journalOps(dataDir)).toEqual(['append', 'generation-reset', 'append'])
    })

    it('with an uncertain rollback fail-stops at once, with no reset written', async () => {
      const dataDir = directory()
      const journal = journalPath(dataDir)
      const hold = deferred()
      const started = deferred()
      const failStops: string[] = []
      let failWrite = false
      let failTruncate = false
      const store = new HostDeltaStore({
        dataDir,
        now,
        compactAfterRecords: 10000,
        groupFsync: heldFirstFsync(journal, hold, started),
        onFailStop: (detail) => failStops.push(detail),
        // Each fault fires once, so a reset written afterwards would succeed:
        // only the uncertain-rollback rule stops the store here.
        batchWrite: (descriptor, bytes, offset, length) => {
          if (failWrite) {
            failWrite = false
            throw new Error('injected group write failure')
          }
          return writeSync(descriptor, bytes, offset, length, null)
        },
        batchTruncate: () => {
          if (failTruncate) {
            failTruncate = false
            throw new Error('injected rollback failure')
          }
        }
      })
      store.append(legacy('seed'))
      const seen = record(store)
      store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
      const earlier = store.awaitDurable()
      await started.promise
      const before = readFileSync(journal)

      failWrite = true
      failTruncate = true
      expect(store.appendGroup({ commandId: 'b', effects: effects(1, 'b') })).toMatchObject({
        kind: 'write-failed',
        detail: expect.stringContaining('injected group write failure'),
        rollback: 'uncertain',
        recovery: { kind: 'fail-stopped' }
      })
      expect(store.getFailStop()).toEqual({ detail: expect.any(String) })
      expect(failStops).toHaveLength(1)
      expectBlocked(store)
      expect(failStops).toHaveLength(1)

      // No reset line was written after bytes that may be torn.
      expect(readFileSync(journal)).toEqual(before)
      expect(journalOps(dataDir)).toEqual(['append', 'group'])

      // The earlier pending waiter resolves fail-stopped; no dropped record
      // reaches a listener, even once the stale fsync lands.
      await expect(earlier).resolves.toMatchObject({ kind: 'fail-stopped' })
      hold.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen).toEqual([])
      expect(store.getPosition()).toEqual(position(1, 1))
      expect(store.getByCursor(2)).toBeNull()
      expect(store.findGroup('a')).toBeNull()
      expect(store.findGroup('b')).toBeNull()
      expect(failStops).toHaveLength(1)
      store.reopen()
      expectBlocked(store)
    })
  })

  it('never answers durable once the store has fail-stopped', async () => {
    const dataDir = directory()
    let failTruncate = false
    let failWrite = false
    const store = new HostDeltaStore({
      dataDir,
      now,
      batchWrite: (descriptor, bytes, offset, length) => {
        if (failWrite) {
          failWrite = false
          throw new Error('injected group write failure')
        }
        return writeSync(descriptor, bytes, offset, length, null)
      },
      batchTruncate: () => {
        if (failTruncate) {
          failTruncate = false
          throw new Error('injected rollback failure')
        }
      }
    })
    store.append(legacy('seed'))
    failWrite = true
    failTruncate = true
    const failed = store.appendGroup({ commandId: 'cmd', effects: effects(1) })
    expect(failed).toMatchObject({ kind: 'write-failed', recovery: { kind: 'fail-stopped' } })

    // Nothing is pending any more, but the caller whose group failed must not
    // be told its effects are durable.
    await expect(store.awaitDurable()).resolves.toMatchObject({ kind: 'fail-stopped' })
  })

  it('reports no fail-stop on a healthy store and after an ordinary reset', async () => {
    const dataDir = directory()
    const failStops: string[] = []
    const store = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      onFailStop: (detail) => failStops.push(detail)
    })
    expect(store.getFailStop()).toBeNull()
    store.append(legacy('seed'))
    store.appendGroup({ commandId: 'a', effects: effects(1, 'a') })
    await expect(store.awaitDurable()).resolves.toEqual({
      kind: 'durable',
      position: position(1, 2)
    })
    expect(store.resetGeneration('ordinary')).toMatchObject({
      kind: 'appended',
      position: position(2, 1)
    })
    expect(store.getFailStop()).toBeNull()
    expect(failStops).toEqual([])
  })
})
