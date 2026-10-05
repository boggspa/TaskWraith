import { describe, expect, it } from 'vitest'
import { ThreadOwnershipLineage } from '../host/ThreadOwnershipLineage'
import {
  HostCompatibilityPublicationFence,
  type HostCompatibilityPublicationPause
} from './HostCompatibilityPublicationFence'

interface RecordRef {
  readonly label: string
}

function fixture() {
  const ledger = new ThreadOwnershipLineage()
  ledger.connectionChanged({})
  const lineage = ledger.reanchorFromConfirmedHost('thread', {
    revision: 7,
    compatibilitySequence: 10
  })
  const fence = new HostCompatibilityPublicationFence<RecordRef>('thread', ledger)
  let revision = 7
  let sequence = 10
  const stage = (label: string) => {
    const record = Object.freeze({ label })
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: revision,
        headRevision: ++revision,
        compatibilitySequence: ++sequence
      })
    ).toBe(true)
    const target = ledger.capturePublicationTarget('thread')!
    const retention = fence.stage(record, target)
    return { record, target, retention }
  }
  const select = (base: number, pause?: HostCompatibilityPublicationPause) => {
    const selection = fence.select(base, pause)
    expect(selection).not.toBeNull()
    return selection!
  }
  return { ledger, lineage, fence, stage, select }
}

describe('HostCompatibilityPublicationFence custody', () => {
  it('retains and confirms a first bootstrap record at sequence and revision zero', () => {
    const ledger = new ThreadOwnershipLineage()
    ledger.replaceUnconfirmed('new', { headRevision: 0, compatibilitySequence: 0 })
    const fence = new HostCompatibilityPublicationFence<object>('new', ledger)
    const record = Object.freeze({})
    const target = ledger.capturePublicationTarget('new')!
    expect(fence.stage(record, target)).toMatchObject({ retained: { record }, displaced: [] })
    const pause = fence.pause()
    expect(pause.prefixSequence).toBe(0)
    expect(fence.prefixConfirmed(pause)).toBeNull()
    const selected = fence.select(0, pause)!
    expect(selected).not.toBeNull()
    expect(selected.entry.record).toBe(record)
    expect(fence.submitted(selected, pause)).toBe(true)
    expect(fence.settle(selected, { kind: 'succeeded', revision: 0 })).toMatchObject({
      kind: 'confirmed'
    })
    expect(fence.prefixConfirmed(pause)).toMatchObject({ revision: 0, compatibilitySequence: 0 })
  })

  it('freezes pending A before a later B can coalesce it away', () => {
    const f = fixture()
    const a = f.stage('A')
    const pause = f.fence.pause()
    const b = f.stage('B')
    expect(pause.prefixSequence).toBe(a.target.compatibilitySequence)
    expect(f.fence.select(7)).toBeNull()
    const selected = f.select(7, pause)
    expect(selected.entry.record).toBe(a.record)
    expect(f.fence.submitted(selected, pause)).toBe(true)
    expect(f.fence.settle(selected, { kind: 'succeeded', revision: 8 })).toMatchObject({
      kind: 'confirmed'
    })
    expect(f.fence.prefixConfirmed(pause)?.revision).toBe(8)
    expect(f.fence.select(8, pause)).toBeNull()
    const resumed = f.fence.resume(pause)
    expect(resumed).toMatchObject({ kind: 'resumed', retained: { record: b.record } })
    expect(f.select(8).entry.record).toBe(b.record)
  })

  it('drains submitted A then frozen B while C remains the local head', () => {
    const f = fixture()
    const a = f.stage('A')
    const flightA = f.select(7)
    expect(f.fence.submitted(flightA)).toBe(true)
    const b = f.stage('B')
    const pause = f.fence.pause()
    const c = f.stage('C')
    expect(f.fence.snapshot()).toMatchObject({
      retainedRecords: 3,
      cutoff: 12,
      frozenSequence: 12,
      latestSequence: 13
    })
    expect(f.fence.select(7, pause)).toBeNull()
    expect(f.fence.settle(flightA, { kind: 'succeeded', revision: 8 })).toMatchObject({
      kind: 'confirmed'
    })
    expect(f.fence.prefixConfirmed(pause)).toBeNull()
    expect(f.fence.select(8)).toBeNull()
    const flightB = f.select(8, pause)
    expect(flightB.entry.record).toBe(b.record)
    expect(flightB.attempt.targetToken).toBe(b.target)
    expect(flightB.attempt.revision).toBe(9)
    expect(f.fence.submitted(flightB, pause)).toBe(true)
    expect(f.fence.settle(flightB, { kind: 'succeeded', revision: 9 })).toMatchObject({
      kind: 'confirmed'
    })
    expect(f.fence.prefixConfirmed(pause)?.publicationAttempt).toBe(flightB.attempt)
    expect(f.ledger.captureCandidate('thread')).toMatchObject({
      confirmedHostRevision: 9,
      headRevision: 10,
      compatibilitySequence: 13
    })
    expect(f.fence.resume(pause)).toMatchObject({
      kind: 'resumed',
      retained: { record: c.record },
      displaced: []
    })
    expect(f.select(9).entry.record).toBe(c.record)
    expect(a.record.label).toBe('A')
  })

  it('hands back every superseded reference for obligation merging and retains at most three', () => {
    const f = fixture()
    f.stage('A')
    const flight = f.select(7)
    f.fence.submitted(flight)
    const b = f.stage('B')
    const pause = f.fence.pause()
    let prior: RecordRef | undefined
    for (let index = 0; index < 500; index += 1) {
      const next = f.stage(`later-${index}`)
      expect(next.retention.displaced.map((entry) => entry.record)).toEqual(prior ? [prior] : [])
      expect(next.retention.retained?.record).toBe(next.record)
      expect(f.fence.snapshot().retainedRecords).toBe(3)
      prior = next.record
    }
    const resumed = f.fence.resume(pause)
    expect(resumed.kind).toBe('resumed')
    if (resumed.kind !== 'resumed') throw new Error('not resumed')
    expect(resumed.displaced.map((entry) => entry.record)).toEqual([b.record])
    expect(resumed.retained?.record).toBe(prior)
    expect(resumed.flight?.selection).toBe(flight)
    expect(f.fence.snapshot().retainedRecords).toBe(2)
  })

  it('withdraws pre-enqueue custody on resume and rejects its late detail completion', () => {
    const f = fixture()
    const a = f.stage('A')
    const selected = f.select(7)
    const b = f.stage('B')
    const pause = f.fence.pause()
    const c = f.stage('C')
    expect(f.fence.submitted(selected)).toBe(false)
    const resumed = f.fence.resume(pause)
    expect(resumed.kind).toBe('resumed')
    if (resumed.kind !== 'resumed') throw new Error('not resumed')
    expect(resumed.withdrawn).toBe(selected)
    expect(resumed.withdrawn?.attempt.expectedRevision).toBe(7)
    expect(resumed.displaced.map((entry) => entry.record)).toEqual([a.record, b.record])
    expect(resumed.retained?.record).toBe(c.record)
    expect(f.fence.submitted(selected, pause)).toBe(false)
    expect(f.fence.settle(selected, { kind: 'not_committed' })).toEqual({ kind: 'stale' })
    expect(f.ledger.snapshot().activePublications).toBe(0)
    const latest = f.select(7)
    expect(latest.entry.record).toBe(c.record)
    expect(latest.attempt).not.toBe(selected.attempt)
  })

  it.each(['submitted', 'uncertain'] as const)(
    'resume retains %s custody until definite settlement',
    (custody) => {
      const f = fixture()
      f.stage('A')
      const flight = f.select(7)
      f.fence.submitted(flight)
      if (custody === 'uncertain') f.fence.settle(flight, { kind: 'uncertain' })
      const b = f.stage('B')
      const pause = f.fence.pause()
      const resumed = f.fence.resume(pause)
      expect(resumed).toMatchObject({
        kind: 'resumed',
        withdrawn: null,
        flight: { selection: flight, custody }
      })
      expect(f.ledger.snapshot().activePublications).toBe(1)
      expect(f.fence.select(7)).toBeNull()
      expect(f.fence.settle(flight, { kind: 'uncertain' })).toEqual({ kind: 'uncertain' })
      expect(f.fence.snapshot().retainedRecords).toBe(2)
      expect(f.fence.settle(flight, { kind: 'not_committed' })).toMatchObject({
        kind: 'retryable',
        retained: { record: b.record },
        displaced: [flight.entry]
      })
      expect(f.select(7).entry.record).toBe(b.record)
    }
  )

  it('allows an exact prefix detail completion only with the current pause token', () => {
    const f = fixture()
    f.stage('A')
    const selected = f.select(7)
    const pause = f.fence.pause()
    expect(f.fence.submitted(selected)).toBe(false)
    expect(f.fence.submitted({ ...selected }, pause)).toBe(false)
    expect(f.fence.submitted(selected, { ...pause })).toBe(false)
    expect(f.fence.submitted(selected, pause)).toBe(true)
    expect(f.fence.submitted(selected, pause)).toBe(false)
    expect(f.fence.settle({ ...selected }, { kind: 'succeeded', revision: 8 })).toEqual({
      kind: 'stale'
    })
    expect(f.fence.settle(selected, { kind: 'succeeded', revision: 8 })).toMatchObject({
      kind: 'confirmed'
    })
  })

  it('cannot confirm an operation before it crossed enqueue or from an unexpected revision', () => {
    const f = fixture()
    f.stage('A')
    const selected = f.select(7)
    const pause = f.fence.pause()
    expect(f.fence.settle(selected, { kind: 'succeeded', revision: 8 })).toEqual({ kind: 'stale' })
    expect(f.ledger.snapshot().confirmedThreads).toBe(1)
    f.fence.submitted(selected, pause)
    expect(f.fence.settle(selected, { kind: 'succeeded', revision: 99 })).toEqual({
      kind: 'reanchor_required'
    })
    expect(f.fence.prefixConfirmed(pause)).toBeNull()
    expect(f.ledger.requiresReanchor('thread')).toBe(true)
    f.fence.resume(pause)
    expect(f.fence.snapshot().blocked).toBe(true)
    expect(f.fence.select(7)).toBeNull()
  })

  it('retains newer frozen B after definite failure of A, returning A’s obligations', () => {
    const f = fixture()
    const a = f.stage('A')
    const flight = f.select(7)
    f.fence.submitted(flight)
    const b = f.stage('B')
    const pause = f.fence.pause()
    const c = f.stage('C')
    const failed = f.fence.settle(flight, { kind: 'not_committed' })
    expect(failed).toMatchObject({
      kind: 'retryable',
      retained: { record: b.record },
      displaced: [{ record: a.record }]
    })
    const retry = f.select(7, pause)
    expect(retry.entry.record).toBe(b.record)
    expect(f.fence.submitted(flight, pause)).toBe(false)
    expect(f.fence.settle(flight, { kind: 'succeeded', revision: 8 })).toEqual({ kind: 'stale' })
    f.fence.submitted(retry, pause)
    f.fence.settle(retry, { kind: 'succeeded', revision: 9 })
    expect(f.fence.prefixConfirmed(pause)?.revision).toBe(9)
    expect(f.fence.resume(pause)).toMatchObject({ kind: 'resumed', retained: { record: c.record } })
  })

  it('repeated resume has no duplicate custody transfer and cannot release a newer pause', () => {
    const f = fixture()
    f.stage('A')
    const first = f.fence.pause()
    expect(f.fence.pause()).toBe(first)
    expect(f.fence.resume({ ...first })).toEqual({ kind: 'stale' })
    expect(f.fence.resume(first).kind).toBe('resumed')
    expect(f.fence.resume(first)).toEqual({ kind: 'already_resumed' })
    const second = f.fence.pause()
    expect(second).not.toBe(first)
    expect(f.fence.resume(first)).toEqual({ kind: 'already_resumed' })
    expect(f.fence.snapshot().paused).toBe(true)
    expect(f.fence.select(7, first)).toBeNull()
    expect(f.fence.select(7, second)).not.toBeNull()
  })

  it('ordinary callbacks and superseded selections cannot bypass a later pause', () => {
    const f = fixture()
    f.stage('A')
    const late = () => f.fence.select(7)
    const pause = f.fence.pause()
    f.stage('B')
    expect(late()).toBeNull()
    const selected = f.select(7, pause)
    f.fence.resume(pause)
    const newer = f.fence.pause()
    expect(late()).toBeNull()
    expect(f.fence.submitted(selected, pause)).toBe(false)
    expect(f.fence.select(7, pause)).toBeNull()
    expect(f.select(7, newer).entry.record.label).toBe('B')
  })

  it('does not inspect or freeze the record and returns stale/duplicate incoming custody', () => {
    const f = fixture()
    const target = f.ledger.capturePublicationTarget('thread')!
    const record = new Proxy({} as RecordRef, {
      get() {
        throw new Error('opaque record read')
      },
      ownKeys() {
        throw new Error('opaque record enumerated')
      },
      preventExtensions() {
        throw new Error('opaque record frozen')
      }
    })
    const staged = f.fence.stage(record, target)
    expect(staged.retained?.record).toBe(record)
    const duplicate = Object.freeze({ label: 'duplicate obligation envelope' })
    const again = f.fence.stage(duplicate, target)
    expect(again.retained?.record).toBe(record)
    expect(again.displaced[0].record).toBe(duplicate)
    const selected = f.select(7)
    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected.entry)).toBe(true)
    expect(selected.entry.record).toBe(record)
  })

  it('a replaced lineage invalidates old prefix proof and late selection handoff', () => {
    const f = fixture()
    f.stage('A')
    const selected = f.select(7)
    const pause = f.fence.pause()
    f.ledger.reanchorFromConfirmedHost('thread', { revision: 8, compatibilitySequence: 11 })
    expect(f.fence.submitted(selected, pause)).toBe(false)
    expect(f.fence.prefixConfirmed(pause)).toBeNull()
    expect(() =>
      f.fence.stage({ label: 'replacement' }, f.ledger.capturePublicationTarget('thread')!)
    ).toThrow('lineage changed')
    expect(f.fence.resume(pause).kind).toBe('resumed')
    expect(f.fence.select(8)).toBeNull()
  })

  it('rejects foreign targets and never calls a copied target genuine', () => {
    const f = fixture()
    const a = f.stage('A')
    expect(() => f.fence.stage({ label: 'foreign' }, { ...a.target, threadId: 'other' })).toThrow()
    const other = fixture()
    const copied = { ...other.ledger.capturePublicationTarget('thread')! }
    other.fence.stage({ label: 'untrusted' }, copied)
    expect(other.fence.select(7)).toBeNull()
    expect(other.fence.snapshot().retainedRecords).toBe(1)
  })

  it('keeps successful normal publication explicit when no pause is requested', () => {
    const f = fixture()
    const a = f.stage('A')
    const b = f.stage('B')
    expect(b.retention.displaced[0].record).toBe(a.record)
    expect(f.ledger.snapshot().activePublications).toBe(0)
    const selected = f.select(7)
    expect(selected.entry.record).toBe(b.record)
    f.fence.submitted(selected)
    f.fence.settle(selected, { kind: 'succeeded', revision: 9 })
    expect(f.fence.snapshot()).toMatchObject({ paused: false, retainedRecords: 0, blocked: false })
    expect(f.fence.settle(selected, { kind: 'not_committed' })).toEqual({ kind: 'stale' })
  })

  it('an empty pause creates no synthetic Host confirmation', () => {
    const f = fixture()
    const pause = f.fence.pause()
    expect(f.fence.prefixConfirmed(pause)).toBeNull()
    expect(f.fence.select(7, pause)).toBeNull()
    expect(f.fence.resume(pause)).toMatchObject({
      kind: 'resumed',
      retained: null,
      displaced: [],
      flight: null,
      withdrawn: null
    })
  })
})
