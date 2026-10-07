/**
 * Independent Threads M4 slice 13e (design §23.12, test 1): the index's
 * refill change. A refill lands only when the index holds the thread at
 * exactly the refill's revision, and then applies as a model change would.
 * At any other revision, or with no held entry, it is set aside as
 * `stale-refill`; for a thread deleted in this incarnation it is `deleted`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOST_WARNING_PROJECTION_WINDOWED } from '../shared/hostProtocol'
import { HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE } from './HostProfileDomainProjection'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  HostPublicWindowIndex,
  type HostPublicWindowChange,
  type HostPublicWindowPublication
} from './HostPublicWindowIndex'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()
const PUBLICATION: HostPublicWindowPublication = { generatedAt: iso(0) }

function modelOf(thread: Record<string, unknown>): HostThreadRecordModelled {
  const model = modelHostThreadRecordEffects({
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
  } as unknown as HostProfileThread)
  if (model.kind !== 'modelled') throw new Error('expected a modelled thread')
  return model
}

function run(runId: string, startedAt: number, extra: Record<string, unknown> = {}) {
  return {
    runId,
    provider: 'codex',
    status: 'success',
    startedAt: iso(startedAt),
    endedAt: iso(startedAt + 1),
    ...extra
  }
}

function applyNow(index: HostPublicWindowIndex, change: HostPublicWindowChange) {
  const transaction = index.prepare([change], PUBLICATION)
  transaction.commit()
  return transaction
}

/** The wire as plain objects, for equality across two indexes. */
function plain(index: HostPublicWindowIndex): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [...index.wire()].map(([family, rows]) => [family, Object.fromEntries(rows)])
  )
}

const titled = (title: string, persistenceRevision: number, runs = 1) =>
  modelOf({
    appChatId: 'x',
    title,
    persistenceRevision,
    runs: Array.from({ length: runs }, (_, i) => run(`x-${i}`, i))
  })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 + 86_400_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('HostPublicWindowIndex: the refill change (M4 slice 13e, test 1)', () => {
  it('lands at the held revision, exactly as the same model change would', () => {
    const refilled = new HostPublicWindowIndex()
    const modelled = new HostPublicWindowIndex()
    for (const index of [refilled, modelled]) {
      applyNow(index, { kind: 'model', model: titled('held', 2, 1) })
    }
    // The same revision, read again from the file, now with a second run
    // (the model the index holds may have been cut or trimmed).
    const again = titled('held', 2, 2)
    const viaRefill = applyNow(refilled, { kind: 'refill', model: again })
    const viaModel = applyNow(modelled, { kind: 'model', model: again })
    expect(viaRefill.ignored).toEqual([])
    expect(viaRefill.effects).toEqual(viaModel.effects)
    expect(viaRefill.complete).toBe(viaModel.complete)
    expect(viaRefill.refill).toEqual(viaModel.refill)
    expect(plain(refilled)).toEqual(plain(modelled))
    expect(refilled.wire().get('run')!.has('x-1')).toBe(true)
  })

  it('is stale-refill at an older revision, and at a newer one', () => {
    const index = new HostPublicWindowIndex()
    applyNow(index, { kind: 'model', model: titled('second', 2) })
    const before = plain(index)
    for (const model of [titled('first', 1), titled('third', 3)]) {
      const stale = applyNow(index, { kind: 'refill', model })
      expect(stale.ignored).toEqual([{ threadId: 'x', reason: 'stale-refill' }])
      expect(stale.effects).toEqual([])
      expect(stale.complete).toBe(true)
    }
    expect(plain(index)).toEqual(before)
    expect(index.wire().get('thread')!.get('x')).toMatchObject({ title: 'second' })
    // A model at the newer revision is not a refill: it lands as today.
    expect(applyNow(index, { kind: 'model', model: titled('third', 3) }).ignored).toEqual([])
    expect(index.wire().get('thread')!.get('x')).toMatchObject({ title: 'third' })
  })

  it('is stale-refill with no held entry, at any revision', () => {
    const index = new HostPublicWindowIndex()
    applyNow(index, { kind: 'model', model: modelOf({ appChatId: 'other' }) })
    for (const revision of [0, 1, 7]) {
      const stale = applyNow(index, { kind: 'refill', model: titled('unheld', revision) })
      expect(stale.ignored).toEqual([{ threadId: 'x', reason: 'stale-refill' }])
      expect(stale.effects).toEqual([])
    }
    expect(index.wire().get('thread')!.has('x')).toBe(false)
    // Set aside, it holds nothing: a model at that revision lands as new.
    expect(applyNow(index, { kind: 'model', model: titled('now held', 1) }).ignored).toEqual([])
    expect(index.wire().get('thread')!.get('x')).toMatchObject({ title: 'now held' })
  })

  it('is deleted for a thread deleted in this incarnation, even at the revision it held', () => {
    const index = new HostPublicWindowIndex()
    applyNow(index, { kind: 'model', model: titled('held', 2) })
    applyNow(index, { kind: 'delete', threadId: 'x' })
    for (const model of [titled('held', 2), titled('older', 1), titled('newer', 3)]) {
      const gone = applyNow(index, { kind: 'refill', model })
      expect(gone.ignored).toEqual([{ threadId: 'x', reason: 'deleted' }])
      expect(gone.effects).toEqual([])
    }
    expect(index.wire().get('thread')!.has('x')).toBe(false)
    expect(index.wire().get('run')!.has('x-0')).toBe(false)
    // A delete of a thread never held closes it for refills too.
    applyNow(index, { kind: 'delete', threadId: 'never' })
    expect(
      applyNow(index, { kind: 'refill', model: modelOf({ appChatId: 'never' }) }).ignored
    ).toEqual([{ threadId: 'never', reason: 'deleted' }])
  })

  it('fills a short window from the band, and clears the runs window warning', () => {
    const index = new HostPublicWindowIndex({ band: 5 })
    const olderRuns = Array.from({ length: 10 }, (_, i) => run(`older-${i}`, i))
    const older = modelOf({ appChatId: 'older', runs: olderRuns })
    const newer = modelOf({
      appChatId: 'newer',
      runs: Array.from({ length: 1_800 }, (_, i) => run(`newer-${i}`, 1_000 + i))
    })
    index.seed(
      [
        { kind: 'model', model: older },
        { kind: 'model', model: newer }
      ],
      PUBLICATION
    )
    const short = applyNow(index, { kind: 'delete', threadId: 'newer' })
    expect(short).toMatchObject({ complete: false, refill: ['older'] })
    expect(index.wire().get('run')!.size).toBe(5)
    // The warning stays up while the window is short; its text does not change.
    expect(
      index.wire().get('warning')!.get(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)
    ).toMatchObject({ message: HOST_PROFILE_RUN_WINDOW_WARNING_MESSAGE })

    // A refill read at another revision leaves the window short.
    const stale = applyNow(index, {
      kind: 'refill',
      model: modelOf({ appChatId: 'older', persistenceRevision: 2, runs: olderRuns })
    })
    expect(stale).toMatchObject({
      complete: false,
      refill: ['older'],
      ignored: [{ threadId: 'older', reason: 'stale-refill' }]
    })
    expect(index.wire().get('run')!.size).toBe(5)

    const refilled = applyNow(index, { kind: 'refill', model: older })
    expect(refilled).toMatchObject({ complete: true, refill: [], ignored: [] })
    expect(
      refilled.effects.filter((effect) => effect.family === 'run' && effect.kind === 'tombstone')
    ).toEqual([])
    expect(index.wire().get('run')!.size).toBe(10)
    expect(index.wire().get('warning')!.has(`${HOST_WARNING_PROJECTION_WINDOWED}:runs`)).toBe(false)
  })
})
