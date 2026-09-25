/**
 * Independent Threads M4 slice 13e (design §23.12, tests 2–5): refills through
 * the public window feeder, over a real `HostPublicWindowIndex` with a small
 * band (so a delete leaves the window short), a real `HostDeltaStore` in a
 * temp data directory, a serial publication lock that records whether it is
 * held, and a `model` port served from in-memory file models.
 *
 * 2. absorb: a delete that leaves the window short publishes one group whose
 *    effects equal a fresh full diff; no `still loading` warning is ever
 *    published; every refill read happens with the publication lock free;
 * 3. failure: each of throw, absent, invalid, refused and a newer revision
 *    publishes short and schedules exactly one retry; a retry that succeeds
 *    completes the window; a second failure abandons, and reads are bounded;
 * 4. dedupe: repeated `refill(t)` gives one read; a pending model mark
 *    supersedes the refill with no file read; a deleted thread is never read;
 * 5. more exhausted threads than the absorb bound still complete, over
 *    several drains.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HOST_WARNING_PROJECTION_WINDOWED } from '../shared/hostProtocol'
import { HOST_DELTA_JOURNAL_FILENAME, HostDeltaStore } from './HostDeltaStore'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  HOST_PUBLIC_WINDOW_ABSORB_ROUNDS,
  HostPublicWindowFeeder,
  type HostPublicWindowFeederOptions
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

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

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
  /** Thread ids the feeder asked a model for, in order. */
  modelled: string[]
  /** Whether the publication lock was held when each model was requested. */
  modelledUnderLock: boolean[]
  preparedUnderLock: boolean[]
  /** What `model(threadId)` answers; a thread without a source is absent. */
  sources: Map<string, Source>
  serve(model: HostThreadRecordModelled): void
  seed(models: readonly HostThreadRecordModelled[]): void
  wireRunIds(): string[]
  /** The run window's warning row, or null. */
  runsWarning(): { message: string } | null
  /** Feed group ids in the journal, in order. */
  journalFeedGroups(): string[]
  /** Every delta record appended, as `kind:family:entityId`, in cursor order. */
  appended(): string[]
  /** Whether a `still loading` warning was ever appended to the deltas. */
  stillLoadingPublished(): boolean
}

function harness(band: number): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-public-window-refill-'))
  roots.push(dataDir)
  mkdirSync(dataDir, { recursive: true })
  const journal = join(dataDir, HOST_DELTA_JOURNAL_FILENAME)
  const deltas = new HostDeltaStore({
    dataDir,
    now: () => NOW_ISO,
    compactAfterRecords: 100_000
  })
  const index = new HostPublicWindowIndex({ band })
  const events: string[] = []
  const modelled: string[] = []
  const modelledUnderLock: boolean[] = []
  const preparedUnderLock: boolean[] = []
  const sources = new Map<string, Source>()
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
      awaitDurable: () => deltas.awaitDurable(),
      getPosition: () => deltas.getPosition(),
      releaseGroup: (commandId) => deltas.releaseGroup(commandId)
    },
    model: async (threadId) => {
      events.push(`model(${threadId})`)
      modelled.push(threadId)
      modelledUnderLock.push(lockHeld)
      // Yield, as the worker does, so the lock's state is observed across a turn.
      await new Promise((resolve) => setImmediate(resolve))
      const source = sources.get(threadId)
      if (!source) return { kind: 'absent' }
      return source()
    },
    now: () => NOW
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
    modelledUnderLock,
    preparedUnderLock,
    sources,
    serve: (model) => {
      sources.set(model.threadId, () => fileModel(model))
    },
    seed: (models) => {
      index.seed(
        models.map((model) => ({ kind: 'model' as const, model })),
        { generatedAt: NOW_ISO }
      )
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
    stillLoadingPublished: () => {
      const position = deltas.getPosition()
      for (let cursor = 1; cursor <= position.cursor; cursor += 1) {
        const stored = deltas.getByCursor(cursor)
        if (!stored || stored.envelope.family !== 'warning') continue
        const payload = stored.envelope.payload as { message?: string } | undefined
        if (payload?.message?.includes('still loading')) return true
      }
      return false
    }
  }
}

/** Ten old runs the band keeps five of, under 1,800 newer ones: deleting `newer` leaves the window short. */
function shortWindow(band = 5) {
  const h = harness(band)
  const older = modelOf(spread('older', 10, 0))
  const newer = modelOf(spread('newer', 1_800, 1_000))
  h.seed([older, newer])
  h.serve(older)
  h.serve(newer)
  expect(h.index.wire().get('run')!.size).toBe(1_800)
  return { h, older, newer }
}

const olderKept = ['older-5', 'older-6', 'older-7', 'older-8', 'older-9']
const olderAll = Array.from({ length: 10 }, (_, i) => `older-${i}`).sort()

/** Give a drain that scheduled nothing more a moment to prove it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('HostPublicWindowFeeder: refills (M4 slice 13e)', () => {
  describe('2. absorb', () => {
    it('a delete that leaves the window short publishes one complete group, the refill read with the lock free', async () => {
      const { h, older } = shortWindow()
      h.feeder.mark('newer', 'deleted')
      await h.feeder.idle()

      // One group, whose wire equals a fresh index over the surviving model.
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.wireRunIds()).toEqual(olderAll)
      expect(comparable(h.index.wire())).toEqual(comparable(fresh([older]).wire()))
      expect(h.runsWarning()).toBeNull()
      expect(h.stillLoadingPublished()).toBe(false)
      // The group carries the tombstones and the refilled runs together: the
      // window held only `newer`, so all ten of `older` enter it at once.
      const appended = h.appended()
      expect(appended.filter((row) => row.startsWith('tombstone:run:'))).toHaveLength(1_800)
      expect(appended.filter((row) => row.startsWith('upsert:run:older-'))).toHaveLength(10)
      expect(appended.some((row) => row.startsWith('upsert:warning:'))).toBe(false)

      // The prepare that named the exhausted thread was aborted; the read
      // happened outside the lock; the second prepare published.
      expect(h.modelled).toEqual(['older'])
      expect(h.modelledUnderLock).toEqual([false])
      expect(h.preparedUnderLock).toEqual([true, true])
      expect(h.events).toEqual([
        'lock:enter',
        'index:prepare(delete)',
        'lock:exit',
        'model(older)',
        'lock:enter',
        'index:prepare(delete,refill)',
        'deltas:appendGroup(feed:1)',
        'lock:exit'
      ])
      expect(h.feeder.counters()).toMatchObject({
        drained: 1,
        refills: 1,
        refillReads: 1,
        refillFailures: 0,
        refillsScheduled: 0,
        refillsAbandoned: 0,
        absorbRounds: 1,
        ignored: 0
      })
      expect(h.feeder.stopped).toBeNull()
    })

    it('absorbs alongside the drain’s other changes, and a refill of an unchanged thread spends no group', async () => {
      const { h, older } = shortWindow()
      const third = modelOf(spread('third', 3, 5_000))
      h.serve(third)
      h.feeder.mark('newer', 'deleted')
      h.feeder.mark('third', 'record')
      await h.feeder.idle()
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(comparable(h.index.wire())).toEqual(comparable(fresh([older, third]).wire()))
      expect(h.stillLoadingPublished()).toBe(false)
      expect(h.modelled).toEqual(['third', 'older'])
      expect(h.modelledUnderLock).toEqual([false, false])

      // An explicit refill of a thread the window already holds whole: one
      // read, it lands, nothing changes on the wire, no group.
      h.feeder.refill(['older'])
      await h.feeder.idle()
      expect(h.modelled).toEqual(['third', 'older', 'older'])
      expect(h.journalFeedGroups()).toEqual(['feed:1'])
      expect(h.feeder.counters()).toMatchObject({
        drained: 1,
        refills: 2,
        refillReads: 2,
        refillsScheduled: 1,
        refillFailures: 0
      })
    })
  })

  describe('3. failure', () => {
    type Kind = 'throw' | 'absent' | 'invalid' | 'refused' | 'newer-revision'
    const failing = (kind: Kind, older: HostThreadRecordModelled): Source => {
      switch (kind) {
        case 'throw':
          return () => {
            throw new Error('worker died')
          }
        case 'absent':
          return () => ({ kind: 'absent' })
        case 'invalid':
          return () => ({ kind: 'invalid' })
        case 'refused':
          return () => ({
            kind: 'modelled',
            revision: 1,
            effects: {
              kind: 'refused',
              threadId: 'older',
              errorCode: 'thread_record_persist_failed'
            }
          })
        case 'newer-revision':
          // The file is already a revision ahead of what the index holds (SF-3).
          return () =>
            fileModel(
              modelOf({
                ...spread('older', 10, 0),
                persistenceRevision: older.projection.revision + 1
              })
            )
      }
    }

    for (const kind of ['throw', 'absent', 'invalid', 'refused', 'newer-revision'] as Kind[]) {
      it(`${kind}: publishes short and schedules exactly one retry; a second failure abandons`, async () => {
        const { h, older } = shortWindow()
        h.sources.set('older', failing(kind, older))
        h.feeder.mark('newer', 'deleted')
        await h.feeder.idle()
        await settle()

        // The short window was published: five kept runs and the still-loading warning.
        expect(h.journalFeedGroups()).toEqual(['feed:1'])
        expect(h.wireRunIds()).toEqual(olderKept)
        expect(h.runsWarning()?.message).toContain('still loading')
        expect(h.stillLoadingPublished()).toBe(true)
        // One absorb read, one retry, nothing more: the thread is abandoned.
        expect(h.modelled).toEqual(['older', 'older'])
        expect(h.modelledUnderLock).toEqual([false, false])
        // The short group was appended before the retry's read.
        const appendedAt = h.events.indexOf('deltas:appendGroup(feed:1)')
        expect(appendedAt).toBeGreaterThan(h.events.indexOf('model(older)'))
        expect(appendedAt).toBeLessThan(h.events.lastIndexOf('model(older)'))
        expect(h.feeder.counters()).toMatchObject({
          drained: 1,
          refills: 0,
          refillReads: 2,
          refillFailures: 2,
          refillsScheduled: 1,
          refillsAbandoned: 1,
          absorbRounds: 1
        })
        expect(h.feeder.stopped).toBeNull()

        // Abandoned until the thread's next mark: a mark resets the retry and
        // the thread is read once more (as a file model, not a refill).
        await settle()
        expect(h.modelled).toHaveLength(2)
        h.serve(older)
        h.feeder.mark('older', 'record')
        await h.feeder.idle()
        expect(h.modelled).toEqual(['older', 'older', 'older'])
        expect(h.wireRunIds()).toEqual(olderAll)
        expect(h.runsWarning()).toBeNull()
        expect(comparable(h.index.wire())).toEqual(comparable(fresh([older]).wire()))
      })

      it(`${kind}: a retry that succeeds completes the window`, async () => {
        const { h, older } = shortWindow()
        let attempts = 0
        const failure = failing(kind, older)
        h.sources.set('older', () => {
          attempts += 1
          return attempts === 1 ? failure() : fileModel(older)
        })
        h.feeder.mark('newer', 'deleted')
        await h.feeder.idle()
        await settle()

        expect(h.modelled).toEqual(['older', 'older'])
        expect(h.modelledUnderLock).toEqual([false, false])
        // Short first, then the retry's group completes it.
        expect(h.journalFeedGroups()).toEqual(['feed:1', 'feed:2'])
        expect(h.stillLoadingPublished()).toBe(true)
        expect(h.wireRunIds()).toEqual(olderAll)
        expect(h.runsWarning()).toBeNull()
        expect(comparable(h.index.wire())).toEqual(comparable(fresh([older]).wire()))
        const appended = h.appended()
        expect(appended.filter((row) => row === `upsert:warning:${WINDOWED_RUNS}`)).toHaveLength(1)
        expect(appended.filter((row) => row === `tombstone:warning:${WINDOWED_RUNS}`)).toHaveLength(
          1
        )
        expect(h.feeder.counters()).toMatchObject({
          drained: 2,
          refills: 1,
          refillReads: 2,
          refillFailures: 1,
          refillsScheduled: 1,
          refillsAbandoned: 0,
          absorbRounds: 1
        })
      })
    }

    it('reads stay bounded: a thread that keeps failing is read twice per short drain, never more', async () => {
      const { h, older } = shortWindow()
      h.sources.set('older', failing('throw', older))
      h.feeder.mark('newer', 'deleted')
      await h.feeder.idle()
      await settle()
      expect(h.modelled).toEqual(['older', 'older'])
      // Another explicit refill after the abandon: one attempt, one retry, again bounded.
      h.feeder.refill(['older'])
      await h.feeder.idle()
      await settle()
      expect(h.modelled).toHaveLength(4)
      expect(h.feeder.counters()).toMatchObject({
        refillReads: 4,
        refillFailures: 4,
        refillsAbandoned: 2
      })
      expect(h.wireRunIds()).toEqual(olderKept)
    })
  })

  describe('4. dedupe', () => {
    it('repeated refill(t) before the drain gives one read', async () => {
      const { h } = shortWindow()
      h.feeder.refill(['older', 'older'])
      h.feeder.refill(['older'])
      h.feeder.refill(['older', 'newer'])
      await h.feeder.idle()
      expect(h.modelled.sort()).toEqual(['newer', 'older'])
      expect(h.feeder.counters()).toMatchObject({
        refillReads: 2,
        refills: 2,
        refillsScheduled: 2,
        refillFailures: 0,
        drained: 0
      })
      expect(h.journalFeedGroups()).toEqual([])
    })

    it('a pending model mark supersedes the refill: no file read, the mark’s model lands', async () => {
      const { h } = shortWindow()
      const retitled = record({ ...spread('older', 10, 0), title: 'Retitled' })
      // Marked first, then refilled: the pending change is at least as good.
      h.feeder.mark('older', 'record', retitled)
      h.feeder.refill(['older'])
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.index.wire().get('thread')!.get('older')).toMatchObject({ title: 'Retitled' })
      expect(h.feeder.counters()).toMatchObject({ refillReads: 0, refillsScheduled: 0, eager: 1 })

      // Refilled first, then marked: the later mark replaces the pending refill.
      const again = record({ ...spread('older', 10, 0), title: 'Again' })
      h.feeder.refill(['older'])
      h.feeder.mark('older', 'record', again)
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.index.wire().get('thread')!.get('older')).toMatchObject({ title: 'Again' })
      expect(h.feeder.counters()).toMatchObject({ refillReads: 0, eager: 2 })
    })

    it('a deleted thread is never read: not by refill(), nor when the index names it', async () => {
      const { h } = shortWindow()
      h.feeder.mark('older', 'deleted')
      h.feeder.refill(['older'])
      await h.feeder.idle()
      expect(h.modelled).toEqual([])
      expect(h.index.wire().get('thread')!.has('older')).toBe(false)

      // After the delete, refill() of it is a no-op, before or after a drain.
      h.feeder.refill(['older'])
      await h.feeder.idle()
      await settle()
      expect(h.modelled).toEqual([])
      expect(h.feeder.counters()).toMatchObject({ refillReads: 0, refillsScheduled: 0 })
    })
  })

  describe('5. more exhausted threads than the absorb bound', () => {
    it('completes over several drains, reading each thread once', async () => {
      const band = 5
      const h = harness(band)
      const smalls = Array.from({ length: 20 }, (_, i) =>
        modelOf({
          appChatId: `small-${String(i).padStart(2, '0')}`,
          runs: Array.from({ length: 3 }, (_, j) => run(`small-${i}-${j}`, j * 100 + i))
        })
      )
      const big = modelOf(spread('big', 1_800, 100_000))
      h.seed([...smalls, big])
      for (const model of smalls) h.serve(model)
      h.serve(big)
      expect(h.index.wire().get('run')!.size).toBe(1_800)
      expect(h.index.diagnostics().keptRuns).toBe(1_800 + band)

      h.feeder.mark('big', 'deleted')
      await h.feeder.idle()
      await settle()

      expect(comparable(h.index.wire())).toEqual(comparable(fresh(smalls).wire()))
      expect(h.wireRunIds()).toHaveLength(60)
      expect(h.runsWarning()).toBeNull()
      // Every small thread read exactly once, always with the lock free.
      expect([...h.modelled].sort()).toEqual(smalls.map((model) => model.threadId).sort())
      expect(h.modelledUnderLock.every((held) => held === false)).toBe(true)
      expect(h.modelledUnderLock).toHaveLength(20)
      const counters = h.feeder.counters()
      expect(counters).toMatchObject({
        refills: 20,
        refillReads: 20,
        refillFailures: 0,
        refillsAbandoned: 0
      })
      // More than one drain: the bound was hit, the short window published,
      // and the rest scheduled and absorbed later.
      expect(counters.drained).toBeGreaterThan(1)
      expect(counters.refillsScheduled).toBeGreaterThanOrEqual(1)
      expect(counters.absorbRounds).toBeGreaterThan(HOST_PUBLIC_WINDOW_ABSORB_ROUNDS)
      expect(counters.absorbRounds).toBeLessThanOrEqual(
        HOST_PUBLIC_WINDOW_ABSORB_ROUNDS * counters.drained
      )
      expect(h.journalFeedGroups()).toHaveLength(counters.drained)
      expect(h.stillLoadingPublished()).toBe(true)
      expect(
        h.appended().filter((row) => row === `tombstone:warning:${WINDOWED_RUNS}`)
      ).toHaveLength(1)
      expect(h.feeder.stopped).toBeNull()
    }, 30_000)
  })
})
