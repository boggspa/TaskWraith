/**
 * Independent Threads M4 slice 13c1 (design §23.6, tests 2–6, and slice 13c2's
 * test 6 in place of 13c1's test 7): the public window feeder over a real
 * `HostPublicWindowIndex`, a real `HostDeltaStore`
 * in a temp data directory (with its journal write and group fsync seams), a
 * real serial publication lock, and `model` = the in-process file model over
 * a real `HostProfileDomainStore` profile. Seams wrap the real ports and
 * record the order of calls; nothing is stubbed away.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HostCursorPosition } from '../shared/hostProtocol'
import { HOST_DELTA_JOURNAL_FILENAME, HostDeltaStore } from './HostDeltaStore'
import { createHostCommitGate } from './HostCommitGate'
import {
  decodeHostProfileThread,
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore
} from './HostProfileDomainStore'
import { HostPublicWindowIndex } from './HostPublicWindowIndex'
import { modelHostThreadRecordEffects } from './HostThreadRecordEffectModel'
import { modelHostThreadRecordFile, type HostThreadRecordFileModel } from './HostThreadRecordModel'
import {
  HOST_PUBLIC_WINDOW_FEED_BATCH,
  HostPublicWindowFeeder,
  type HostPublicWindowFeederOptions
} from './HostPublicWindowFeeder'

const NOW = 1_760_000_000_000
const NOW_ISO = new Date(NOW).toISOString()
const STARTED_AT = NOW_ISO
const RESET_POSITION: HostCursorPosition = { generation: 2, cursor: 1 }

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 50): Promise<T | 'pending'> {
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

interface Seams {
  failWrite: () => boolean
  failGroupFsync: () => boolean
  /** Called before each real model; may return a promise to hold it. */
  beforeModel: (threadId: string) => Promise<void> | void
  /** Replaces the real model for a thread when it returns non-null. */
  modelOverride: (threadId: string) => HostThreadRecordFileModel | null
  /** When true, the next appendGroup answers `rejected` without writing. */
  rejectAppend: () => boolean
}

interface Harness {
  profilePath: string
  dataDir: string
  store: HostProfileDomainStore
  deltas: HostDeltaStore
  index: HostPublicWindowIndex
  feeder: HostPublicWindowFeeder
  seams: Seams
  failStops: string[]
  /** Every port call the feeder made, in order. */
  events: string[]
  /** Thread ids the feeder asked a model for, in order. */
  modelled: string[]
  /** Whether the publication lock was held when each model was requested. */
  modelledUnderLock: boolean[]
  /** Whether the lock was held at each index.prepare and appendGroup. */
  preparedUnderLock: boolean[]
  appendedUnderLock: boolean[]
  /** `durable` of the group as the feeder released it. */
  releasedDurable: Array<boolean | null>
  /** Feed group ids in the journal, in order (`op: 'group'` lines). */
  journalFeedGroups(): string[]
  seed(title?: string): string
  wireIds(family: 'thread' | 'run'): string[]
  wireThreadTitle(threadId: string): string | null
  chatPath(threadId: string): string
}

function harness(
  options: { band?: number; gate?: HostPublicWindowFeederOptions['gate'] } = {}
): Harness {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-public-window-feeder-'))
  roots.push(profilePath)
  const dataDir = join(profilePath, 'host-data')
  mkdirSync(dataDir)
  const seams: Seams = {
    failWrite: () => false,
    failGroupFsync: () => false,
    beforeModel: () => undefined,
    modelOverride: () => null,
    rejectAppend: () => false
  }
  const failStops: string[] = []
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW,
    idFactory: () => `thread-${String(++sequence).padStart(3, '0')}`
  })
  const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
  const deltas = new HostDeltaStore({
    dataDir,
    now: () => NOW_ISO,
    compactAfterRecords: 100_000,
    batchWrite: (descriptor, bytes, offset, length) => {
      if (seams.failWrite()) throw new Error('injected journal write failure')
      return writeSync(descriptor, bytes, offset, length, null)
    },
    groupFsync: async (path) => {
      if (path === journal && seams.failGroupFsync()) {
        throw new Error('injected group fsync failure')
      }
    },
    onFailStop: (detail) => failStops.push(detail)
  })
  const index = new HostPublicWindowIndex(options.band ? { band: options.band } : {})
  const events: string[] = []
  const modelled: string[] = []
  const modelledUnderLock: boolean[] = []
  const preparedUnderLock: boolean[] = []
  const appendedUnderLock: boolean[] = []
  const releasedDurable: Array<boolean | null> = []
  let lockHeld = false
  let tail: Promise<unknown> = Promise.resolve()
  const publicationLock: HostPublicWindowFeederOptions['publicationLock'] = <T>(
    work: () => Promise<T> | T
  ): Promise<T> => {
    const run = tail.then(async () => {
      lockHeld = true
      events.push('lock:enter')
      try {
        return await work()
      } finally {
        events.push('lock:exit')
        lockHeld = false
      }
    })
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  const feeder = new HostPublicWindowFeeder({
    index: {
      prepare: (changes, publication) => {
        events.push(`index:prepare(${changes.map((c) => c.kind).join(',')})`)
        preparedUnderLock.push(lockHeld)
        return index.prepare(changes, publication)
      }
    },
    publicationLock,
    gate: options.gate,
    deltas: {
      appendGroup: (input) => {
        events.push(`deltas:appendGroup(${input.commandId})`)
        appendedUnderLock.push(lockHeld)
        if (seams.rejectAppend()) {
          const position = deltas.getAppendedPosition()
          return {
            kind: 'rejected',
            failedAtIndex: 0,
            result: {
              kind: 'rejected',
              reason: 'invalid_envelope',
              detail: `injected rejection of ${input.commandId}`,
              position
            },
            position
          }
        }
        return deltas.appendGroup(input)
      },
      awaitDurable: () => {
        events.push('deltas:awaitDurable')
        return deltas.awaitDurable()
      },
      getPosition: () => deltas.getPosition(),
      releaseGroup: (commandId) => {
        events.push(`deltas:releaseGroup(${commandId})`)
        releasedDurable.push(deltas.findGroup(commandId)?.durable ?? null)
        return deltas.releaseGroup(commandId)
      }
    },
    model: async (threadId) => {
      events.push(`model(${threadId})`)
      modelled.push(threadId)
      modelledUnderLock.push(lockHeld)
      await seams.beforeModel(threadId)
      return seams.modelOverride(threadId) ?? modelHostThreadRecordFile({ profilePath, threadId })
    },
    now: () => NOW
  })
  const chatPath = (threadId: string): string =>
    join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  return {
    profilePath,
    dataDir,
    store,
    deltas,
    index,
    feeder,
    seams,
    failStops,
    events,
    modelled,
    modelledUnderLock,
    preparedUnderLock,
    appendedUnderLock,
    releasedDurable,
    journalFeedGroups: () => {
      if (!existsSync(journal)) return []
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { op: string; commandId?: string })
        .filter((event) => event.op === 'group' && event.commandId?.startsWith('feed:'))
        .map((event) => event.commandId!)
    },
    seed: (title = 'Seeded') => {
      const created = store.createThread({ scope: 'global', title })
      const threadId = created.appChatId
      store.configureThread({ threadId, providerId: 'codex' })
      store.updateRun({
        threadId,
        runId: `run-${threadId}`,
        status: 'running',
        provider: 'codex',
        phase: 'streaming',
        startedAt: STARTED_AT
      })
      store.updateRun({
        threadId,
        runId: `run-${threadId}`,
        status: 'completed',
        endedAt: STARTED_AT
      })
      return threadId
    },
    wireIds: (family) => [...(index.wire().get(family)?.keys() ?? [])].sort(),
    wireThreadTitle: (threadId) => {
      const row = index.wire().get('thread')?.get(threadId) as { title?: string } | undefined
      return row?.title ?? null
    },
    chatPath
  }
}

describe('HostPublicWindowFeeder (M4 slice 13c1)', () => {
  it('models outside the gate and waits for an observer before publishing', async () => {
    const gate = createHostCommitGate()
    const observer = await gate.enter('observer', { label: 'legacy-window' })
    if (!observer.ok) throw new Error('observer refused')
    const h = harness({ gate })
    const threadId = h.seed()
    h.feeder.mark(threadId, 'record')
    try {
      expect(await settledWithin(h.feeder.idle())).toBe('pending')
      expect(h.modelled).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual([])
      expect(gate.snapshot().waiting).toBe(1)
      observer.lease.release()
      await h.feeder.idle()
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(gate.snapshot().modes.committer.entered).toBe(1)
      expect(gate.snapshot().holders).toEqual([])
    } finally {
      observer.lease.release()
      await h.feeder.close()
      gate.close()
    }
  })

  describe('2. a record write lands in the index through one group', () => {
    it('marks, models outside the lock, publishes under it, releases the group once durable', async () => {
      const h = harness()
      const threadId = h.seed('Configured')
      expect(h.wireIds('thread')).toEqual([])

      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()

      // The index holds the thread's rows, and they are the file's model.
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.wireIds('run')).toEqual([`run-${threadId}`])
      expect(h.wireThreadTitle(threadId)).toBe('Configured')
      const expected = modelHostThreadRecordEffects(
        decodeHostProfileThread(JSON.parse(readFileSync(h.chatPath(threadId), 'utf8')))
      )
      expect(expected.kind).toBe('modelled')

      // One group, feed:1, whose records are the index's effects, at the store's head.
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.deltas.getPosition().cursor).toBeGreaterThan(0)
      const stored: string[] = []
      for (let cursor = 1; cursor <= h.deltas.getPosition().cursor; cursor += 1) {
        const record = h.deltas.getByCursor(cursor)
        expect(record).not.toBeNull()
        stored.push(`${record!.envelope.family}:${record!.envelope.entityId}`)
      }
      expect(stored).toContain(`thread:${threadId}`)
      expect(stored).toContain(`run:run-${threadId}`)
      // Released after durable: the anchor is gone, and it was durable when released.
      expect(h.deltas.findGroup('feed:1')).toBeNull()
      expect(h.releasedDurable).toEqual([true])

      // Order: model outside the lock; prepare and append inside; durable, then release.
      expect(h.events).toEqual([
        `model(${threadId})`,
        'lock:enter',
        'index:prepare(model)',
        'deltas:appendGroup(feed:1)',
        'lock:exit',
        'deltas:awaitDurable',
        'deltas:releaseGroup(feed:1)'
      ])
      expect(h.modelledUnderLock).toEqual([false])
      expect(h.preparedUnderLock).toEqual([true])
      expect(h.appendedUnderLock).toEqual([true])
      expect(h.feeder.counters()).toMatchObject({ drained: 1, absent: 0, invalid: 0, ignored: 0 })
      expect(h.feeder.stopped).toBeNull()
      expect(h.failStops).toEqual([])
    })

    it('a second write of the same thread publishes only the diff, as a second group', async () => {
      const h = harness()
      const threadId = h.seed('First')
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      const head = h.deltas.getPosition().cursor
      h.store.configureThread({ threadId, title: 'Second' })
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.wireThreadTitle(threadId)).toBe('Second')
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
      const appended: string[] = []
      for (let cursor = head + 1; cursor <= h.deltas.getPosition().cursor; cursor += 1) {
        const record = h.deltas.getByCursor(cursor)!
        appended.push(
          `${record.envelope.kind}:${record.envelope.family}:${record.envelope.entityId}`
        )
      }
      expect(appended).toEqual([`upsert:thread:${threadId}`])
      expect(h.feeder.counters().drained).toBe(2)
    })

    it('a model that throws counts a failure, drops the mark and the feeder carries on', async () => {
      const h = harness()
      const threadId = h.seed('Fragile')
      let throwing = true
      h.seams.beforeModel = () => {
        if (throwing) throw new Error('worker died')
      }
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({ failures: 1, drained: 0 })
      expect(h.wireIds('thread')).toEqual([])
      expect(h.journalFeedGroups()).toEqual([])
      throwing = false
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.feeder.counters()).toMatchObject({ failures: 1, drained: 1 })
      expect(h.feeder.stopped).toBeNull()
    })
  })

  describe('3. the delete', () => {
    it('removes the thread’s rows through a group of tombstones, without a model', async () => {
      const h = harness()
      const threadId = h.seed('Doomed')
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.wireIds('run')).toEqual([`run-${threadId}`])
      const head = h.deltas.getPosition().cursor
      h.modelled.length = 0

      const revision = h.store.threadRecordState(threadId)!.revision
      const deletedBytes = readFileSync(h.chatPath(threadId))
      expect(h.store.deleteThreadRecord({ threadId, expectedRevision: revision })).toBe(true)
      h.feeder.mark(threadId, 'deleted')
      await h.feeder.idle()

      expect(h.wireIds('thread')).toEqual([])
      expect(h.wireIds('run')).toEqual([])
      expect(h.modelled).toEqual([])
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
      const tombstones: string[] = []
      for (let cursor = head + 1; cursor <= h.deltas.getPosition().cursor; cursor += 1) {
        const record = h.deltas.getByCursor(cursor)!
        expect(record.envelope.kind).toBe('tombstone')
        tombstones.push(`${record.envelope.family}:${record.envelope.entityId}`)
      }
      expect(tombstones.length).toBeGreaterThan(0)
      expect(tombstones).toContain(`thread:${threadId}`)
      expect(tombstones).toContain(`run:run-${threadId}`)
      expect(h.deltas.findGroup('feed:2')).toBeNull()
      expect(h.releasedDurable).toEqual([true, true])
      // Final for the incarnation: a record reappearing under the same id
      // (a source that still lists the thread) is set aside by the index.
      writeFileSync(h.chatPath(threadId), deletedBytes, { mode: 0o600 })
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([threadId])
      expect(h.wireIds('thread')).toEqual([])
      expect(h.feeder.counters()).toMatchObject({ ignored: 1, absent: 0 })
    })

    it('a write-failed group answered with a reset still commits the delete', async () => {
      const h = harness()
      const threadId = h.seed('Reset')
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([threadId])
      const revision = h.store.threadRecordState(threadId)!.revision
      h.store.deleteThreadRecord({ threadId, expectedRevision: revision })

      let armed = true
      h.seams.failWrite = () => {
        if (!armed) return false
        // Only the group line fails; the reset that follows must succeed.
        armed = false
        return true
      }
      h.feeder.mark(threadId, 'deleted')
      await h.feeder.idle()

      expect(armed).toBe(false)
      expect(h.deltas.getPosition()).toEqual(RESET_POSITION)
      expect(h.deltas.getFailStop()).toBeNull()
      expect(h.failStops).toEqual([])
      // The delete landed through the reset: the index no longer holds the thread.
      expect(h.wireIds('thread')).toEqual([])
      expect(h.wireIds('run')).toEqual([])
      expect(h.deltas.findGroup('feed:2')).toBeNull()
      expect(h.feeder.counters()).toMatchObject({ resets: 1, drained: 2 })
      expect(h.feeder.stopped).toBeNull()
      // The index is not left with a transaction open.
      expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()
    })

    it('a durability reset (failed group fsync) counts a reset and keeps the index committed', async () => {
      const h = harness()
      const threadId = h.seed('Fsync')
      let failing = true
      h.seams.failGroupFsync = () => failing
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      failing = false
      expect(h.deltas.getPosition()).toEqual(RESET_POSITION)
      expect(h.deltas.getFailStop()).toBeNull()
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.feeder.counters()).toMatchObject({ resets: 1, drained: 1 })
      expect(h.feeder.stopped).toBeNull()
    })

    it('a fail-stop stops the feeder: the index is aborted and later marks are refused', async () => {
      const h = harness()
      const threadId = h.seed('Stopped')
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      const revision = h.store.threadRecordState(threadId)!.revision
      h.store.deleteThreadRecord({ threadId, expectedRevision: revision })

      // The group line fails and so does the reset after it.
      h.seams.failWrite = () => true
      h.feeder.mark(threadId, 'deleted')
      await h.feeder.idle()

      expect(h.deltas.getFailStop()).not.toBeNull()
      expect(h.failStops).toHaveLength(1)
      expect(h.feeder.stopped).not.toBeNull()
      expect(typeof h.feeder.stopped).toBe('string')
      // The index transaction was aborted: the thread is still published.
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()
      expect(h.feeder.counters().drained).toBe(1)

      h.seams.failWrite = () => false
      const other = h.seed('After the stop')
      h.modelled.length = 0
      h.feeder.mark(other, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.wireIds('thread')).toEqual([threadId])
    })

    it('a group the delta store rejects is counted, the index aborted, and the feeder continues', async () => {
      const h = harness()
      const threadId = h.seed('Rejected')
      let rejecting = true
      h.seams.rejectAppend = () => rejecting
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.events).toContain('deltas:appendGroup(feed:1)')
      expect(h.feeder.counters()).toMatchObject({ rejected: 1, drained: 0 })
      expect(h.wireIds('thread')).toEqual([])
      expect(h.journalFeedGroups()).toEqual([])
      expect(h.feeder.stopped).toBeNull()
      expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()

      rejecting = false
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual(['feed:2'])
      expect(h.feeder.counters()).toMatchObject({ rejected: 1, drained: 1 })
    })
  })

  describe('4. coalescing', () => {
    it('ten marks of one thread in one turn give one model and one group', async () => {
      const h = harness()
      const threadId = h.seed('Ten')
      for (let i = 0; i < 10; i += 1) h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.feeder.counters().drained).toBe(1)
    })

    it('marks arriving during a drain are drained next, as one more model', async () => {
      const h = harness()
      const threadId = h.seed('Held')
      const hold = deferred()
      let holds = 0
      h.seams.beforeModel = () => {
        holds += 1
        return holds === 1 ? hold.promise : undefined
      }
      h.feeder.mark(threadId, 'record')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(h.modelled).toEqual([threadId])
      const idle = h.feeder.idle()
      expect(await settledWithin(idle)).toBe('pending')

      h.store.configureThread({ threadId, title: 'Held then renamed' })
      for (let i = 0; i < 10; i += 1) h.feeder.mark(threadId, 'record')
      expect(h.modelled).toHaveLength(1)
      hold.resolve()
      await idle

      expect(h.modelled).toEqual([threadId, threadId])
      // The held model read the file after the rename, so feed:1 already
      // carries it; the second model changes nothing on the wire and spends
      // no group.
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.wireThreadTitle(threadId)).toBe('Held then renamed')
      expect(h.feeder.counters().drained).toBe(1)
    })

    it('the latest kind wins, except that deleted is sticky', async () => {
      const h = harness()
      const a = h.seed('A')
      const b = h.seed('B')
      for (const id of [a, b]) h.feeder.mark(id, 'record')
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([a, b].sort())
      h.modelled.length = 0

      // A: deleted then record: the delete stands, no model is asked.
      h.feeder.mark(a, 'deleted')
      h.feeder.mark(a, 'record')
      // B: record then deleted: the delete stands too.
      h.feeder.mark(b, 'record')
      h.feeder.mark(b, 'deleted')
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.wireIds('thread')).toEqual([])
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
    })

    it(`a drain takes at most ${HOST_PUBLIC_WINDOW_FEED_BATCH} threads: forty marks give two groups`, async () => {
      const h = harness()
      expect(HOST_PUBLIC_WINDOW_FEED_BATCH).toBe(32)
      const ids = Array.from({ length: 40 }, (_, i) => h.seed(`Thread ${i}`))
      for (const id of ids) h.feeder.mark(id, 'record')
      await h.feeder.idle()
      expect(h.modelled).toHaveLength(40)
      expect(new Set(h.modelled).size).toBe(40)
      expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
      expect(h.wireIds('thread')).toEqual([...ids].sort())
      expect(h.feeder.counters().drained).toBe(2)
      // The first group carried the first 32 in mark order; the second the rest.
      const lockEnters = h.events.filter((event) => event === 'lock:enter')
      expect(lockEnters).toHaveLength(2)
      const firstLock = h.events.indexOf('lock:enter')
      const modelsBeforeFirstLock = h.events
        .slice(0, firstLock)
        .filter((e) => e.startsWith('model('))
      expect(modelsBeforeFirstLock).toHaveLength(32)
    }, 15_000)
  })

  describe('5. ordering against the transaction', () => {
    it('a feed of an older revision after a newer commit is ignored; the index keeps the newer model', async () => {
      const h = harness()
      const threadId = h.seed('Older on disk')
      // The transaction committed a newer model to the index (its own feed).
      const onDisk = JSON.parse(readFileSync(h.chatPath(threadId), 'utf8')) as {
        persistenceRevision: number
      }
      const newer = modelHostThreadRecordEffects(
        decodeHostProfileThread({
          ...onDisk,
          persistenceRevision: onDisk.persistenceRevision + 3,
          title: 'Newer in the index'
        })
      )
      expect(newer.kind).toBe('modelled')
      if (newer.kind !== 'modelled') return
      const transaction = h.index.prepare([{ kind: 'model', model: newer }], {
        generatedAt: NOW_ISO
      })
      expect(transaction.effects.length).toBeGreaterThan(0)
      transaction.commit()
      expect(h.wireThreadTitle(threadId)).toBe('Newer in the index')

      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([threadId])
      expect(h.feeder.counters().ignored).toBe(1)
      expect(h.wireThreadTitle(threadId)).toBe('Newer in the index')
      expect(h.feeder.stopped).toBeNull()
      // Nothing changed, so the group carries no records.
      expect(h.deltas.getPosition().cursor).toBe(0)
    })

    it('a feed at the same revision is not ignored, and spends no group when nothing changed', async () => {
      const h = harness()
      const threadId = h.seed('Same revision')
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.feeder.counters().ignored).toBe(0)
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([threadId, threadId])
      expect(h.feeder.counters()).toMatchObject({ ignored: 0, drained: 1 })
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
    })
  })

  describe('6. absent and invalid are skipped and counted', () => {
    it('absent: deleted before modelling', async () => {
      const h = harness()
      const threadId = h.seed('Vanishing')
      const kept = h.seed('Kept')
      h.seams.beforeModel = (id) => {
        if (id === threadId) rmSync(h.chatPath(threadId))
      }
      h.feeder.mark(threadId, 'record')
      h.feeder.mark(kept, 'record')
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({ absent: 1, invalid: 0, drained: 1 })
      expect(h.wireIds('thread')).toEqual([kept])
      expect(h.feeder.stopped).toBeNull()
    })

    it('invalid: an unreadable record, alongside a good one in the same drain', async () => {
      const h = harness()
      const kept = h.seed('Kept')
      writeFileSync(h.chatPath('garbage'), 'not json at all', { mode: 0o600 })
      h.feeder.mark('garbage', 'record')
      h.feeder.mark(kept, 'record')
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({ absent: 0, invalid: 1, drained: 1 })
      expect(h.wireIds('thread')).toEqual([kept])
    })

    it('refused: a modelled result whose effects are refused is skipped and counted', async () => {
      const h = harness()
      const threadId = h.seed('Refused')
      h.seams.modelOverride = (id) =>
        id === threadId
          ? {
              kind: 'modelled',
              revision: 1,
              effects: { kind: 'refused', threadId, errorCode: 'thread_record_persist_failed' }
            }
          : null
      h.feeder.mark(threadId, 'record')
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({ refused: 1, drained: 0 })
      expect(h.wireIds('thread')).toEqual([])
      expect(h.journalFeedGroups()).toEqual([])
    })

    it('a drain of only skipped threads appends no group', async () => {
      const h = harness()
      h.feeder.mark('nobody', 'record')
      await h.feeder.idle()
      expect(h.feeder.counters()).toMatchObject({ absent: 1, drained: 0 })
      expect(h.journalFeedGroups()).toEqual([])
      expect(h.events.filter((event) => event.startsWith('deltas:'))).toEqual([])
    })
  })

  describe("7. 'run' marks feed (13c2 test 6, replacing 13c1's 'ignored' placeholder)", () => {
    it('a run mark carrying the written record is modelled at mark and lands without a worker model', async () => {
      const h = harness()
      const threadId = h.seed('Streaming')
      const written = h.store.appendTranscript({ threadId, role: 'user', content: 'hello' })
      h.feeder.mark(threadId, 'run', written)
      expect(h.feeder.counters()).toMatchObject({ eager: 1, drained: 0 })
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.wireIds('run')).toEqual([`run-${threadId}`])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.releasedDurable).toEqual([true])
      expect(h.feeder.counters()).toEqual({
        drained: 1,
        absent: 0,
        invalid: 0,
        refused: 0,
        ignored: 0,
        rejected: 0,
        resets: 0,
        failures: 0,
        eager: 1,
        eagerMs: expect.any(Number),
        refills: 0,
        refillReads: 0,
        refillFailures: 0,
        refillsScheduled: 0,
        refillsAbandoned: 0,
        absorbRounds: 0,
        suppressed: 0
      })
      expect(h.feeder.counters().eagerMs).toBeGreaterThanOrEqual(0)
    })

    it('a run mark without the record models the file at drain, as a record mark does', async () => {
      const h = harness()
      const threadId = h.seed('Streaming from file')
      h.store.appendTranscript({ threadId, role: 'user', content: 'hello' })
      h.feeder.mark(threadId, 'run')
      await h.feeder.idle()
      expect(h.modelled).toEqual([threadId])
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.feeder.counters()).toMatchObject({ drained: 1, eager: 0, failures: 0 })
    })

    it('a record mark carrying the record is modelled at mark too; the latest mark wins and deleted stays sticky', async () => {
      const h = harness()
      const threadId = h.seed('Marked twice')
      const configured = h.store.configureThread({ threadId, title: 'Configured with record' })
      h.feeder.mark(threadId, 'record')
      h.feeder.mark(threadId, 'record', configured)
      await h.feeder.idle()
      // The later, eager mark replaced the file mark: no worker model was asked.
      expect(h.modelled).toEqual([])
      expect(h.wireThreadTitle(threadId)).toBe('Configured with record')
      expect(h.feeder.counters()).toMatchObject({ eager: 1, drained: 1 })

      const revision = h.store.threadRecordState(threadId)!.revision
      expect(h.store.deleteThreadRecord({ threadId, expectedRevision: revision })).toBe(true)
      h.feeder.mark(threadId, 'deleted')
      h.feeder.mark(threadId, 'run', configured)
      await h.feeder.idle()
      expect(h.wireIds('thread')).toEqual([])
      // The eager mark after the delete was refused: nothing was modelled for it.
      expect(h.feeder.counters()).toMatchObject({ eager: 1, drained: 2 })
    })
  })

  describe('close', () => {
    it('awaits the running drain and refuses marks after it', async () => {
      const h = harness()
      const threadId = h.seed('Closing')
      const hold = deferred()
      h.seams.beforeModel = () => hold.promise
      h.feeder.mark(threadId, 'record')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(h.modelled).toEqual([threadId])
      const closing = h.feeder.close()
      expect(await settledWithin(closing)).toBe('pending')
      hold.resolve()
      await closing
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.releasedDurable).toEqual([true])

      const late = h.seed('Too late')
      h.modelled.length = 0
      h.feeder.mark(late, 'record')
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.wireIds('thread')).toEqual([threadId])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
    })

    it('with nothing marked, close resolves at once', async () => {
      const h = harness()
      expect(await settledWithin(h.feeder.close())).toBeUndefined()
    })
  })
})
