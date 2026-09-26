/**
 * Independent Threads M4 slice 13f1 (design §23.15, tests 2–5): the public
 * window feeder's seed and publication switch, over a real
 * `HostPublicWindowIndex`, a real `HostDeltaStore` in a temp data directory, a
 * serial publication lock that records whether it is held, and `model` ports
 * (the live one and the seed's) served from in-memory file models.
 *
 * 2. equivalence: a seed over N files gives `wire()` equal to `seed()` of the
 *    same models, with key order; the report is exact; and while unpublished
 *    no group, `awaitDurable` or `releaseGroup` happens, while the index is
 *    still committed (`suppressed`);
 * 3. races: a live mark replaces a pending seed entry with one read; a write
 *    after its seed entry drained leaves the newest revision; a delete during
 *    the seed leaves the thread absent, and a later seed read is set aside;
 * 4. a rejecting seed read: once gives `retried` and then modelled; twice
 *    gives `abandoned`, and reads stay bounded;
 * 5. close mid-seed is prompt and `aborted`, with no further reads.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HOST_WARNING_PROJECTION_WINDOWED } from '../shared/hostProtocol'
import { HOST_DELTA_JOURNAL_FILENAME, HostDeltaStore } from './HostDeltaStore'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  HOST_PUBLIC_WINDOW_FEED_BATCH,
  HostPublicWindowFeeder,
  type HostPublicWindowFeederOptions,
  type HostPublicWindowSeedReport
} from './HostPublicWindowFeeder'
import { HostPublicWindowIndex, type HostPublicWindowWire } from './HostPublicWindowIndex'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'
import type { HostThreadRecordFileModel } from './HostThreadRecordModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()
const NOW = T0 + 86_400_000
const NOW_ISO = new Date(NOW).toISOString()
const WINDOWED_RUNS = `${HOST_WARNING_PROJECTION_WINDOWED}:runs`
/** The index's own warnings: stamped with the publication, not the data. */
const PROJECTOR_WARNING = /^projection_(rows_omitted|truncated|rows_withheld|windowed):/
const TIMEOUT = 15_000

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

/** Give a drain that scheduled nothing more a moment to prove it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

/** Waits, bounded, until the predicate holds. */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function record(thread: Record<string, unknown>): HostProfileThread {
  return {
    scope: 'global',
    title: 'Thread',
    provider: 'codex',
    archived: false,
    createdAt: 1,
    updatedAt: T0,
    persistenceRevision: 1,
    messages: [],
    runs: [],
    ...thread
  } as unknown as HostProfileThread
}

function modelOf(thread: Record<string, unknown>): HostThreadRecordModelled {
  const model = modelHostThreadRecordEffects(record(thread))
  if (model.kind !== 'modelled') throw new Error('expected a modelled thread')
  return model
}

function run(runId: string, startedAt: number) {
  return {
    runId,
    provider: 'codex',
    status: 'success',
    startedAt: iso(startedAt),
    endedAt: iso(startedAt + 1)
  }
}

function spread(
  appChatId: string,
  count: number,
  from: number,
  extra: Record<string, unknown> = {}
) {
  return {
    appChatId,
    runs: Array.from({ length: count }, (_, i) => run(`${appChatId}-${i}`, from + i)),
    ...extra
  }
}

/** The worker file model of a thread's record. */
function fileModel(model: HostThreadRecordModelled): HostThreadRecordFileModel {
  return { kind: 'modelled', revision: model.projection.revision, effects: model }
}

/** Comparable wire: the projector's own warnings carry the publication's time. */
function comparable(wire: HostPublicWindowWire): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...wire].map(([family, rows]) => [
      family,
      Object.fromEntries(
        [...rows].map(([id, row]) => [
          id,
          family === 'warning' && PROJECTOR_WARNING.test(id)
            ? { ...(row as Record<string, unknown>), at: 0 }
            : row
        ])
      )
    ])
  )
}

/** Each family's keys in wire order. */
function keyOrder(wire: HostPublicWindowWire): Record<string, string[]> {
  return Object.fromEntries([...wire].map(([family, rows]) => [family, [...rows.keys()]]))
}

/** What an index seeded with every full model publishes. */
function fresh(models: readonly HostThreadRecordModelled[]): HostPublicWindowIndex {
  const index = new HostPublicWindowIndex()
  index.seed(
    models.map((model) => ({ kind: 'model' as const, model })),
    { generatedAt: NOW_ISO }
  )
  return index
}

type Source = () => HostThreadRecordFileModel | Promise<HostThreadRecordFileModel>

interface Harness {
  index: HostPublicWindowIndex
  deltas: HostDeltaStore
  feeder: HostPublicWindowFeeder
  /** Every port call the feeder made, in order. */
  events: string[]
  /** Thread ids the feeder asked the LIVE model port for, in order. */
  modelled: string[]
  /** Thread ids the feeder asked the SEED model for, in order. */
  seedReads: string[]
  /** Whether the publication lock was held when each seed read was requested. */
  seedReadsUnderLock: boolean[]
  preparedUnderLock: boolean[]
  /** What both model ports answer; a thread without a source is absent. */
  sources: Map<string, Source>
  /** Called before each seed read; may return a promise to hold it. */
  seams: { beforeSeed: (threadId: string) => Promise<void> | void }
  serve(model: HostThreadRecordModelled): void
  /** The seed model port, as the composition would pass it. */
  seedModel(threadId: string): Promise<HostThreadRecordFileModel>
  wireThreadIds(): string[]
  wireThreadTitle(threadId: string): string | null
  wireRunIds(): string[]
  runsWarning(): { message: string } | null
  /** Feed group ids in the journal, in order. */
  journalFeedGroups(): string[]
  /** Every delta record appended, as `kind:family:entityId`, in cursor order. */
  appended(): string[]
  /** Port calls on the delta store, in order. */
  deltaEvents(): string[]
}

function harness(options: { band?: number; publishing?: boolean } = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-public-window-seed-'))
  roots.push(dataDir)
  mkdirSync(dataDir, { recursive: true })
  const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
  const deltas = new HostDeltaStore({
    dataDir,
    now: () => NOW_ISO,
    compactAfterRecords: 100_000
  })
  const index = new HostPublicWindowIndex(options.band ? { band: options.band } : {})
  const events: string[] = []
  const modelled: string[] = []
  const seedReads: string[] = []
  const seedReadsUnderLock: boolean[] = []
  const preparedUnderLock: boolean[] = []
  const sources = new Map<string, Source>()
  const seams: Harness['seams'] = { beforeSeed: () => undefined }
  let lockHeld = false
  let tail: Promise<unknown> = Promise.resolve()
  const publicationLock: HostPublicWindowFeederOptions['publicationLock'] = <T>(
    work: () => Promise<T> | T
  ): Promise<T> => {
    const running = tail.then(async () => {
      lockHeld = true
      events.push('lock:enter')
      try {
        return await work()
      } finally {
        events.push('lock:exit')
        lockHeld = false
      }
    })
    tail = running.then(
      () => undefined,
      () => undefined
    )
    return running
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
    deltas: {
      appendGroup: (input) => {
        events.push(`deltas:appendGroup(${input.commandId})`)
        return deltas.appendGroup(input)
      },
      awaitDurable: () => {
        events.push('deltas:awaitDurable')
        return deltas.awaitDurable()
      },
      getPosition: () => deltas.getPosition(),
      releaseGroup: (commandId) => {
        events.push(`deltas:releaseGroup(${commandId})`)
        return deltas.releaseGroup(commandId)
      }
    },
    model: async (threadId) => {
      events.push(`model(${threadId})`)
      modelled.push(threadId)
      // Yield, as the worker does, so the lock's state is observed across a turn.
      await new Promise((resolve) => setImmediate(resolve))
      const source = sources.get(threadId)
      if (!source) return { kind: 'absent' }
      return source()
    },
    now: () => NOW,
    ...(options.publishing === undefined ? {} : { publishing: options.publishing })
  })
  const appended = (): string[] => {
    const rows: string[] = []
    const position = deltas.getPosition()
    for (let cursor = 1; cursor <= position.cursor; cursor += 1) {
      const stored = deltas.getByCursor(cursor)
      if (!stored) continue
      rows.push(`${stored.envelope.kind}:${stored.envelope.family}:${stored.envelope.entityId}`)
    }
    return rows
  }
  return {
    index,
    deltas,
    feeder,
    events,
    modelled,
    seedReads,
    seedReadsUnderLock,
    preparedUnderLock,
    sources,
    seams,
    serve: (model) => {
      sources.set(model.threadId, () => fileModel(model))
    },
    seedModel: async (threadId) => {
      events.push(`seed(${threadId})`)
      seedReads.push(threadId)
      seedReadsUnderLock.push(lockHeld)
      await new Promise((resolve) => setImmediate(resolve))
      await seams.beforeSeed(threadId)
      const source = sources.get(threadId)
      if (!source) return { kind: 'absent' }
      return source()
    },
    wireThreadIds: () => [...index.wire().get('thread')!.keys()].sort(),
    wireThreadTitle: (threadId) => {
      const row = index.wire().get('thread')?.get(threadId) as { title?: string } | undefined
      return row?.title ?? null
    },
    wireRunIds: () => [...index.wire().get('run')!.keys()].sort(),
    runsWarning: () =>
      (index.wire().get('warning')!.get(WINDOWED_RUNS) as { message: string }) ?? null,
    journalFeedGroups: () => {
      if (!existsSync(journal)) return []
      return readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { op: string; commandId?: string })
        .filter((event) => event.op === 'group' && event.commandId?.startsWith('feed:'))
        .map((event) => event.commandId!)
    },
    appended,
    deltaEvents: () => events.filter((event) => event.startsWith('deltas:'))
  }
}

const exactReport = (
  overrides: Partial<HostPublicWindowSeedReport> = {}
): HostPublicWindowSeedReport => ({
  requested: 0,
  modelled: 0,
  absent: 0,
  invalid: 0,
  refused: 0,
  retried: 0,
  abandoned: [],
  aborted: false,
  ms: expect.any(Number) as unknown as number,
  ...overrides
})

describe('HostPublicWindowFeeder: the seed and the switch (M4 slice 13f1)', () => {
  describe('publication switch', () => {
    it(
      'publishing defaults to true; unpublished, a drain commits the index and appends no group; startPublishing turns it on for good',
      async () => {
        expect(harness().feeder.publishing).toBe(true)
        expect(harness({ publishing: true }).feeder.publishing).toBe(true)
        const h = harness({ publishing: false })
        expect(h.feeder.publishing).toBe(false)

        const a = modelOf(spread('a', 3, 0, { title: 'A' }))
        const b = modelOf(spread('b', 2, 100, { title: 'B' }))
        h.serve(a)
        h.serve(b)
        h.feeder.mark('a', 'record')
        await h.feeder.idle()
        // The index holds `a`; nothing reached the delta store.
        expect(h.wireThreadIds()).toEqual(['a'])
        expect(h.wireRunIds()).toEqual(['a-0', 'a-1', 'a-2'])
        expect(h.deltaEvents()).toEqual([])
        expect(h.journalFeedGroups()).toEqual([])
        expect(h.deltas.getPosition().cursor).toBe(0)
        expect(h.preparedUnderLock).toEqual([true])
        expect(h.feeder.counters()).toMatchObject({ suppressed: 1, drained: 0, rejected: 0 })
        expect(h.feeder.stopped).toBeNull()
        // The transaction was settled: another prepare can open.
        expect(() => h.index.prepare([], { generatedAt: NOW_ISO }).abort()).not.toThrow()

        h.feeder.startPublishing()
        expect(h.feeder.publishing).toBe(true)
        h.feeder.startPublishing()
        expect(h.feeder.publishing).toBe(true)
        // Published from here on: `b` lands as one group, released once
        // durable, and it carries only `b`'s diff: `a` was already held.
        h.feeder.mark('b', 'record')
        await h.feeder.idle()
        expect(h.wireThreadIds()).toEqual(['a', 'b'])
        expect(h.journalFeedGroups()).toHaveLength(1)
        const appended = h.appended()
        expect(appended).toContain('upsert:thread:b')
        expect(appended.filter((row) => row.startsWith('upsert:run:b-'))).toHaveLength(2)
        expect(appended).not.toContain('upsert:thread:a')
        expect(appended.filter((row) => row.startsWith('upsert:run:a-'))).toHaveLength(0)
        expect(h.deltaEvents()).toEqual([
          expect.stringMatching(/^deltas:appendGroup\(feed:\d+\)$/),
          'deltas:awaitDurable',
          expect.stringMatching(/^deltas:releaseGroup\(feed:\d+\)$/)
        ])
        expect(h.feeder.counters()).toMatchObject({ suppressed: 1, drained: 1 })
      },
      TIMEOUT
    )

    it(
      'unpublished, a short window is still absorbed and a failed refill still retried: refills stay scheduled',
      async () => {
        const band = 5
        const h = harness({ band, publishing: false })
        const older = modelOf(spread('older', 10, 0))
        const newer = modelOf(spread('newer', 1_800, 1_000))
        h.index.seed(
          [
            { kind: 'model', model: older },
            { kind: 'model', model: newer }
          ],
          { generatedAt: NOW_ISO }
        )
        h.serve(newer)
        let attempts = 0
        h.sources.set('older', () => {
          attempts += 1
          if (attempts === 1) throw new Error('worker died')
          return fileModel(older)
        })
        expect(h.index.wire().get('run')!.size).toBe(1_800)

        h.feeder.mark('newer', 'deleted')
        await h.feeder.idle()
        await settle()

        // The absorb read failed, the short window was committed (not
        // published), the retry was scheduled and its drain completed the
        // window: still nothing reached the delta store.
        expect(h.modelled).toEqual(['older', 'older'])
        expect(h.wireRunIds()).toEqual(Array.from({ length: 10 }, (_, i) => `older-${i}`).sort())
        expect(h.runsWarning()).toBeNull()
        expect(comparable(h.index.wire())).toEqual(comparable(fresh([older]).wire()))
        expect(h.deltaEvents()).toEqual([])
        expect(h.deltas.getPosition().cursor).toBe(0)
        expect(h.feeder.counters()).toMatchObject({
          suppressed: 2,
          drained: 0,
          refills: 1,
          refillReads: 2,
          refillFailures: 1,
          refillsScheduled: 1,
          refillsAbandoned: 0,
          absorbRounds: 1
        })
        expect(h.feeder.stopped).toBeNull()
      },
      TIMEOUT
    )
  })

  describe('2. seed equivalence', () => {
    it(
      'a seed over N files gives wire() equal to seed() of the same models, with key order; the report is exact; nothing is published',
      async () => {
        const h = harness({ publishing: false })
        const models = [
          modelOf(spread('m-c', 4, 300, { title: 'C', persistenceRevision: 7 })),
          modelOf(spread('m-a', 2, 100, { title: 'A', persistenceRevision: 2 })),
          modelOf(spread('m-e', 1, 500, { title: 'E' })),
          modelOf(spread('m-b', 6, 200, { title: 'B', persistenceRevision: 3 })),
          modelOf(spread('m-d', 0, 0, { title: 'D' }))
        ]
        for (const model of models) h.serve(model)
        const ids = models.map((model) => model.threadId)

        const report = await h.feeder.seed(ids, h.seedModel)
        expect(report).toEqual(exactReport({ requested: 5, modelled: 5 }))
        expect(report.ms).toBeGreaterThanOrEqual(0)
        // The seed resolves once the drain that took its last thread has
        // committed: the index already holds every seeded thread, so a switch
        // that follows can never publish before the seed's last commit.
        expect(h.preparedUnderLock).toEqual([true])

        const expected = fresh(models)
        expect(comparable(h.index.wire())).toEqual(comparable(expected.wire()))
        expect(keyOrder(h.index.wire())).toEqual(keyOrder(expected.wire()))
        expect(h.index.diagnostics()).toEqual(expected.diagnostics())
        expect(h.wireThreadIds()).toEqual([...ids].sort())
        expect(h.wireThreadTitle('m-b')).toBe('B')

        // Every id read exactly once, through the seed's model and with the
        // lock free; the live model port was never asked.
        expect(h.seedReads).toEqual(ids)
        expect(h.seedReadsUnderLock).toEqual([false, false, false, false, false])
        expect(h.modelled).toEqual([])
        // One drain: the index committed under the lock, no group, no
        // durability wait, no anchor release.
        expect(h.deltaEvents()).toEqual([])
        expect(h.journalFeedGroups()).toEqual([])
        expect(h.deltas.getPosition().cursor).toBe(0)
        expect(h.preparedUnderLock).toEqual([true])
        expect(h.feeder.counters()).toMatchObject({
          suppressed: 1,
          drained: 0,
          rejected: 0,
          ignored: 0,
          failures: 0
        })
        expect(h.feeder.stopped).toBeNull()
        expect(h.feeder.publishing).toBe(false)
        await settle()
        expect(h.seedReads).toHaveLength(5)
      },
      TIMEOUT
    )

    it(
      `more ids than one drain takes (${HOST_PUBLIC_WINDOW_FEED_BATCH}) seed over several drains, each unpublished`,
      async () => {
        const h = harness({ publishing: false })
        const models = Array.from({ length: 40 }, (_, i) =>
          modelOf(spread(`t-${String(i).padStart(2, '0')}`, 2, i * 10))
        )
        for (const model of models) h.serve(model)
        const ids = models.map((model) => model.threadId)
        const report = await h.feeder.seed(ids, h.seedModel)
        expect(report).toEqual(exactReport({ requested: 40, modelled: 40 }))
        // Committed before it resolved: no idle() needed.
        expect(comparable(h.index.wire())).toEqual(comparable(fresh(models).wire()))
        expect(h.seedReads).toEqual(ids)
        expect(h.deltaEvents()).toEqual([])
        expect(h.feeder.counters()).toMatchObject({ suppressed: 2, drained: 0 })
        expect(h.preparedUnderLock).toEqual([true, true])
        // The first drain read the first 32 before its lock; the rest after it.
        const firstLock = h.events.indexOf('lock:enter')
        expect(h.events.slice(0, firstLock).filter((e) => e.startsWith('seed('))).toHaveLength(32)
      },
      TIMEOUT
    )

    it(
      'absent, invalid and refused seed reads are counted and leave nothing in the index',
      async () => {
        const h = harness({ publishing: false })
        const good = [modelOf(spread('g-1', 2, 0)), modelOf(spread('g-2', 3, 100))]
        for (const model of good) h.serve(model)
        h.sources.set('bad-invalid', () => ({ kind: 'invalid' }))
        h.sources.set('bad-refused', () => ({
          kind: 'modelled',
          revision: 1,
          effects: {
            kind: 'refused',
            threadId: 'bad-refused',
            errorCode: 'thread_record_persist_failed'
          }
        }))
        const ids = ['g-1', 'bad-absent', 'bad-invalid', 'g-2', 'bad-refused']
        const report = await h.feeder.seed(ids, h.seedModel)
        expect(report).toEqual(
          exactReport({ requested: 5, modelled: 2, absent: 1, invalid: 1, refused: 1 })
        )
        await h.feeder.idle()
        expect(h.seedReads).toEqual(ids)
        expect(comparable(h.index.wire())).toEqual(comparable(fresh(good).wire()))
        expect(h.wireThreadIds()).toEqual(['g-1', 'g-2'])
        expect(h.deltaEvents()).toEqual([])
        await settle()
        expect(h.seedReads).toHaveLength(5)
      },
      TIMEOUT
    )

    it(
      'an empty seed resolves at once with nothing requested',
      async () => {
        const h = harness({ publishing: false })
        const report = await settledWithin(h.feeder.seed([], h.seedModel))
        expect(report).toEqual(exactReport())
        expect(h.seedReads).toEqual([])
        expect(h.events).toEqual([])
      },
      TIMEOUT
    )
  })

  describe('3. races', () => {
    it(
      'a live mark already pending when the seed starts covers its thread: the seed never reads it',
      async () => {
        const h = harness({ publishing: false })
        h.serve(modelOf(spread('a', 2, 0, { title: 'File A', persistenceRevision: 1 })))
        h.serve(modelOf(spread('b', 2, 100, { title: 'B' })))
        // Marked before the seed exists: the seed leaves that entry alone.
        h.feeder.mark(
          'a',
          'record',
          record({ ...spread('a', 2, 0), title: 'Live A', persistenceRevision: 2 })
        )
        const report = await h.feeder.seed(['a', 'b'], h.seedModel)
        expect(report).toEqual(exactReport({ requested: 2, modelled: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['b'])
        expect(h.wireThreadTitle('a')).toBe('Live A')
        expect(h.feeder.counters()).toMatchObject({ eager: 1 })
      },
      TIMEOUT
    )

    it(
      'a live mark replaces a pending seed entry: one read, through the mark, and the mark’s model lands',
      async () => {
        const h = harness({ publishing: false })
        const seeded = modelOf(spread('a', 2, 0, { title: 'Seeded A', persistenceRevision: 1 }))
        const b = modelOf(spread('b', 2, 100, { title: 'B' }))
        h.serve(seeded)
        h.serve(b)

        // Marked with the record before the drain takes the seed entry: the
        // eager model replaces it, and `a` is never read by the seed.
        const pending = h.feeder.seed(['a', 'b'], h.seedModel)
        h.feeder.mark(
          'a',
          'record',
          record({ ...spread('a', 2, 0), title: 'Live A', persistenceRevision: 2 })
        )
        const report = await pending
        expect(report).toEqual(exactReport({ requested: 2, modelled: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['b'])
        expect(h.modelled).toEqual([])
        expect(h.wireThreadTitle('a')).toBe('Live A')
        expect(h.wireThreadIds()).toEqual(['a', 'b'])
        expect(h.feeder.counters()).toMatchObject({ eager: 1, ignored: 0 })

        // A file mark (no record) replaces the seed entry too: one read,
        // through the live model port, none through the seed's.
        const c = modelOf(spread('c', 1, 200, { title: 'C' }))
        const d = modelOf(spread('d', 1, 300, { title: 'D' }))
        h.serve(c)
        h.serve(d)
        const again = h.feeder.seed(['c', 'd'], h.seedModel)
        h.feeder.mark('c', 'record')
        expect(await again).toEqual(exactReport({ requested: 2, modelled: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['b', 'd'])
        expect(h.modelled).toEqual(['c'])
        expect(h.wireThreadIds()).toEqual(['a', 'b', 'c', 'd'])
        expect(h.deltaEvents()).toEqual([])
      },
      TIMEOUT
    )

    it(
      'a write after its seed entry drained leaves the newest revision, and an older one after that is set aside',
      async () => {
        const h = harness({ publishing: false })
        const rev1 = modelOf(spread('a', 2, 0, { title: 'Revision 1', persistenceRevision: 1 }))
        h.serve(rev1)
        // Hold the seed read: the entry is taken into the drain, and the
        // write arrives while it is in flight.
        const hold = deferred()
        h.seams.beforeSeed = () => hold.promise
        const pending = h.feeder.seed(['a'], h.seedModel)
        await until(() => h.seedReads.length === 1)
        const rev2 = record({ ...spread('a', 2, 0), title: 'Revision 2', persistenceRevision: 2 })
        h.feeder.mark('a', 'record', rev2)
        expect(await settledWithin(pending)).toBe('pending')
        hold.resolve()
        expect(await pending).toEqual(exactReport({ requested: 1, modelled: 1 }))
        await h.feeder.idle()
        // The seed's revision 1 landed first, then the write's revision 2.
        expect(h.wireThreadTitle('a')).toBe('Revision 2')
        expect(h.seedReads).toEqual(['a'])
        expect(h.feeder.counters()).toMatchObject({ suppressed: 2, ignored: 0, eager: 1 })

        // A write after the seed drained: the newest revision wins.
        h.feeder.mark(
          'a',
          'record',
          record({ ...spread('a', 2, 0), title: 'Revision 3', persistenceRevision: 3 })
        )
        await h.feeder.idle()
        expect(h.wireThreadTitle('a')).toBe('Revision 3')
        // An older model after that is set aside (SF-3): the newest stays.
        h.feeder.mark('a', 'record', rev2)
        await h.feeder.idle()
        expect(h.wireThreadTitle('a')).toBe('Revision 3')
        expect(h.feeder.counters()).toMatchObject({ ignored: 1 })
        expect(h.deltaEvents()).toEqual([])
      },
      TIMEOUT
    )

    it(
      'a seed read returning a revision ahead of a pending live mark leaves the newest: the equal or older mark re-diffs to nothing',
      async () => {
        const h = harness({ publishing: false })
        // The file is already at revision 2 when the seed reads it.
        h.serve(modelOf(spread('a', 2, 0, { title: 'File at 2', persistenceRevision: 2 })))
        const hold = deferred()
        h.seams.beforeSeed = () => hold.promise
        const pending = h.feeder.seed(['a'], h.seedModel)
        await until(() => h.seedReads.length === 1)
        // A live mark at revision 1 arrives while the seed read is in flight.
        h.feeder.mark(
          'a',
          'record',
          record({ ...spread('a', 2, 0), title: 'Mark at 1', persistenceRevision: 1 })
        )
        hold.resolve()
        expect(await pending).toEqual(exactReport({ requested: 1, modelled: 1 }))
        await h.feeder.idle()
        expect(h.wireThreadTitle('a')).toBe('File at 2')
        expect(h.feeder.counters()).toMatchObject({ ignored: 1 })
      },
      TIMEOUT
    )

    it(
      'a delete during the seed leaves the thread absent: a pending seed entry is replaced, an in-flight read is undone by the delete, and a later seed read is set aside',
      async () => {
        const h = harness({ publishing: false })
        const a = modelOf(spread('a', 2, 0))
        const b = modelOf(spread('b', 2, 100))
        const c = modelOf(spread('c', 2, 200))
        h.serve(a)
        h.serve(b)
        h.serve(c)

        // `b` deleted before the drain takes its seed entry: never read.
        const first = h.feeder.seed(['a', 'b'], h.seedModel)
        h.feeder.mark('b', 'deleted')
        expect(await first).toEqual(exactReport({ requested: 2, modelled: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['a'])
        expect(h.wireThreadIds()).toEqual(['a'])

        // `c` deleted while its seed read is in flight: the read lands, the
        // delete follows in the next drain, and the thread ends absent.
        const hold = deferred()
        h.seams.beforeSeed = (threadId) => (threadId === 'c' ? hold.promise : undefined)
        const second = h.feeder.seed(['c'], h.seedModel)
        await until(() => h.seedReads.length === 2)
        h.feeder.mark('c', 'deleted')
        hold.resolve()
        expect(await second).toEqual(exactReport({ requested: 1, modelled: 1 }))
        await h.feeder.idle()
        expect(h.wireThreadIds()).toEqual(['a'])
        expect(h.wireRunIds()).toEqual(['a-0', 'a-1'])
        h.seams.beforeSeed = () => undefined

        // A later seed of the deleted threads (a listing that still names
        // them): deletes are sticky for the incarnation, so, as `refill()`
        // does, the seed never reads them, and the index never holds them.
        const third = h.feeder.seed(['b', 'c', 'a'], h.seedModel)
        expect(await third).toEqual(exactReport({ requested: 3, modelled: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['a', 'c', 'a'])
        expect(h.wireThreadIds()).toEqual(['a'])
        expect(h.wireRunIds()).toEqual(['a-0', 'a-1'])
        expect(h.deltaEvents()).toEqual([])
        expect(h.feeder.stopped).toBeNull()
      },
      TIMEOUT
    )
  })

  describe('4. a rejecting seed read', () => {
    it(
      'rejecting once gives retried and then modelled; the thread lands',
      async () => {
        const h = harness({ publishing: false })
        const a = modelOf(spread('a', 2, 0, { title: 'A' }))
        const b = modelOf(spread('b', 2, 100, { title: 'B' }))
        h.serve(b)
        let attempts = 0
        h.sources.set('a', () => {
          attempts += 1
          if (attempts === 1) throw new Error('worker died')
          return fileModel(a)
        })
        const report = await h.feeder.seed(['a', 'b'], h.seedModel)
        expect(report).toEqual(exactReport({ requested: 2, modelled: 2, retried: 1 }))
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['a', 'b', 'a'])
        expect(comparable(h.index.wire())).toEqual(comparable(fresh([a, b]).wire()))
        expect(h.deltaEvents()).toEqual([])
        await settle()
        expect(h.seedReads).toHaveLength(3)
      },
      TIMEOUT
    )

    it(
      'rejecting twice abandons the thread: two reads, never more, absent until its next write',
      async () => {
        const h = harness({ publishing: false })
        const a = modelOf(spread('a', 2, 0, { title: 'A' }))
        const b = modelOf(spread('b', 2, 100, { title: 'B' }))
        h.serve(b)
        h.sources.set('a', () => {
          throw new Error('worker died')
        })
        const report = await h.feeder.seed(['a', 'b'], h.seedModel)
        expect(report).toEqual(
          exactReport({ requested: 2, modelled: 1, retried: 1, abandoned: ['a'] })
        )
        await h.feeder.idle()
        expect(h.seedReads).toEqual(['a', 'b', 'a'])
        expect(h.wireThreadIds()).toEqual(['b'])
        await settle()
        expect(h.seedReads).toHaveLength(3)
        expect(h.feeder.stopped).toBeNull()

        // Its next write lands as any mark does.
        h.serve(a)
        h.feeder.mark('a', 'record')
        await h.feeder.idle()
        expect(h.modelled).toEqual(['a'])
        expect(h.seedReads).toHaveLength(3)
        expect(comparable(h.index.wire())).toEqual(comparable(fresh([a, b]).wire()))
        expect(h.deltaEvents()).toEqual([])
      },
      TIMEOUT
    )
  })

  describe('5. close mid-seed', () => {
    it(
      'is prompt and aborted, drops the pending seed entries, and reads nothing more',
      async () => {
        const h = harness({ publishing: false })
        const models = Array.from({ length: 40 }, (_, i) =>
          modelOf(spread(`t-${String(i).padStart(2, '0')}`, 1, i * 10))
        )
        for (const model of models) h.serve(model)
        const ids = models.map((model) => model.threadId)
        // The first drain's reads are in flight; the first of them is held.
        const hold = deferred()
        h.seams.beforeSeed = (threadId) => (threadId === ids[0] ? hold.promise : undefined)
        const pending = h.feeder.seed(ids, h.seedModel)
        await until(() => h.seedReads.length === HOST_PUBLIC_WINDOW_FEED_BATCH)
        expect(await settledWithin(pending)).toBe('pending')

        const closing = h.feeder.close()
        // Prompt: the seed resolves at close, before the drain in flight
        // finishes (close itself waits for that drain).
        expect(await settledWithin(closing)).toBe('pending')
        const report = await settledWithin(pending)
        expect(report).toMatchObject({
          requested: 40,
          aborted: true,
          retried: 0,
          abandoned: [],
          absent: 0,
          invalid: 0,
          refused: 0
        })
        expect(report).not.toBe('pending')
        if (report === 'pending') return
        // The reads in flight may or may not be accounted by then.
        expect(report.modelled).toBeLessThanOrEqual(HOST_PUBLIC_WINDOW_FEED_BATCH)
        hold.resolve()
        await closing
        // The drain in flight finished without another read; the 8 pending
        // entries were dropped. Whatever the aborted seed left in the index
        // is at most that batch, and none of it was published.
        expect(h.seedReads).toEqual(ids.slice(0, HOST_PUBLIC_WINDOW_FEED_BATCH))
        const held = h.wireThreadIds()
        expect(
          held.every((threadId) => ids.indexOf(threadId) < HOST_PUBLIC_WINDOW_FEED_BATCH)
        ).toBe(true)
        expect(held).not.toContain('t-39')
        await settle()
        expect(h.seedReads).toHaveLength(HOST_PUBLIC_WINDOW_FEED_BATCH)
        expect(h.deltaEvents()).toEqual([])
        expect(h.feeder.counters()).toMatchObject({ drained: 0 })

        // A seed after close is refused: aborted at once, nothing read.
        const late = await settledWithin(h.feeder.seed(['t-39'], h.seedModel))
        expect(late).toEqual(exactReport({ requested: 1, aborted: true }))
        expect(h.seedReads).toHaveLength(HOST_PUBLIC_WINDOW_FEED_BATCH)
      },
      TIMEOUT
    )

    it(
      'with no drain in flight, close resolves the seed at once as aborted',
      async () => {
        const h = harness({ publishing: false })
        h.serve(modelOf(spread('a', 1, 0)))
        // Seed and close in the same turn: the drain has not started.
        const pending = h.feeder.seed(['a'], h.seedModel)
        const closing = h.feeder.close()
        await closing
        expect(await settledWithin(pending)).toEqual(exactReport({ requested: 1, aborted: true }))
        await settle()
        expect(h.seedReads).toEqual([])
        expect(h.wireThreadIds()).toEqual([])
      },
      TIMEOUT
    )
  })
})
