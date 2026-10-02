import { describe, expect, it } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'

describe('pool owner attribution', () => {
  it('records async owner attempts and hard-bound fallbacks while directory offsets remain mutation counts', () => {
    let now = 0
    const completions: (() => void)[] = []
    const pool = new MainDurabilityFlusher({
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => {
        const complete = () => done()
        completions.push(complete)
        return { joinSync: complete }
      },
      fsyncSync: () => {},
      close: () => {}
    })
    const prompt = pool.open(1, 1, 1, 0, 'catalogue')
    pool.noteWrite(prompt, 8, 'prompt')
    expect(pool.ownerSnapshot().catalogue.asyncFsyncs).toBe(1)
    completions.shift()!()
    const directory = pool.open(1, 2, 2, 0, 'directory')
    pool.noteWrite(directory, 1, 'soft')
    now = 5000
    pool.noteWrite(directory, 2, 'soft')
    expect(pool.ownerSnapshot().directory).toMatchObject({
      directoryMutations: 2,
      writtenBytes: 0,
      dirtyBytes: 0,
      hardBoundFsyncs: 1,
      syncFsyncs: 1
    })
    expect(pool.counters.hardBoundFsyncs).toBe(1)
  })
  it('attributes actual strict/dependency syscalls to physical owners and copies snapshots', () => {
    const calls: number[] = []
    const pool = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => ({ joinSync: () => done() }),
      fsyncSync: (fd) => {
        calls.push(fd)
      },
      close: () => {}
    })
    const detail = pool.open(1, 1, 1, 0, 'detail')
    const journal = pool.open(1, 2, 2, 0, 'journal')
    pool.noteWrite(detail, 20, 'soft')
    pool.noteWrite(journal, 10, 'sync', { after: [{ file: detail, offset: 20 }] })
    expect(calls).toEqual([1, 2])
    const snapshot = pool.ownerSnapshot()
    expect(snapshot.detail).toMatchObject({
      writtenBytes: 20,
      dependencySyncFsyncs: 1,
      syncFsyncs: 1,
      dirtyBytes: 0
    })
    expect(snapshot.journal).toMatchObject({ writtenBytes: 10, strictFsyncs: 1, syncFsyncs: 1 })
    snapshot.detail.errors = 99
    expect(pool.ownerSnapshot().detail.errors).toBe(0)
    expect(Object.values(pool.ownerSnapshot()).reduce((sum, row) => sum + row.syncFsyncs, 0)).toBe(
      pool.counters.syncFsyncs
    )
  })
  it('counts actual failed owner fsync and its recovery escalation without changing policy', () => {
    let failed = true
    const pool = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => ({ joinSync: () => done() }),
      fsyncSync: () => {
        if (failed) throw new Error('disk')
      },
      close: () => {}
    })
    const file = pool.open(1, 1, 1, 0, 'run-events')
    expect(() => pool.noteWrite(file, 5, 'sync')).toThrow('disk')
    failed = false
    pool.noteWrite(file, 8, 'soft')
    expect(pool.ownerSnapshot()['run-events']).toMatchObject({
      errors: 1,
      escalations: 1,
      syncFsyncs: 2,
      writtenBytes: 8
    })
  })
})
