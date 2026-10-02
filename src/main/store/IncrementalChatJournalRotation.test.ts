import { describe, expect, it } from 'vitest'
import { IncrementalChatJournalRotation } from './IncrementalChatJournalRotation'

// Red-first stub returns revision zero, never enforces dependencies, and never repairs a gap.
describe('M5 journal rotation model', () => {
  it('records an acknowledgement covered entirely by the adopted checkpoint', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    model.rotate()
    model.prepare()
    model.renameCheckpoint()
    model.flushDirectory()
    model.forgetSealed()
    model.unlinkSealed()
    expect(model.acknowledge()).toBe(true)
    expect(model.acknowledged).toBe(1)
    expect(model.recover()).toEqual({ revision: 1, gap: false })
  })
  it('requires the directory fsync issued after every lazy create', () => {
    const model = new IncrementalChatJournalRotation(7)
    model.flushDirectory()
    expect(model.append()).toBe(8)
    model.flushFile(model.active!)
    expect(model.acknowledge()).toBe(false)
    model.flushDirectory()
    expect(model.acknowledge()).toBe(true)
    expect(model.recover().revision).toBe(8)
  })

  it('protects KJ8 and KJ9 through sealed-tail and directory dependencies', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    const old = model.active!
    model.rotate()
    model.append()
    const active = model.active!
    model.flushFile(active)
    model.flushDirectory()
    expect(model.acknowledge()).toBe(false)
    model.flushFile(old)
    expect(model.acknowledge()).toBe(true)
    expect(model.recover()).toEqual({ revision: 2, gap: false })
  })

  it('requires a durable covering checkpoint before forget and early unlink', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    model.rotate()
    model.prepare()
    expect(() => model.unlinkSealed()).toThrow()
    model.renameCheckpoint()
    expect(() => model.forgetSealed()).toThrow()
    model.flushDirectory()
    model.forgetSealed()
    model.unlinkSealed()
    expect(model.recover()).toEqual({ revision: 1, gap: false })
  })

  it('adoption settles only sealed-inode waiters and discharges that dependency', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    const old = model.active!
    const sealedWaiter = model.wait(old)
    model.rotate()
    model.append()
    const activeWaiter = model.wait(model.active!)
    model.prepare()
    model.renameCheckpoint()
    model.flushDirectory()
    expect(model.forgetSealed()).toEqual([sealedWaiter])
    expect(model.pendingWaiters).toEqual([activeWaiter])
    model.unlinkSealed()
    model.flushFile(model.active!)
    expect(model.acknowledge()).toBe(true)
    model.rotate() // second rotation is legal only after the first adoption
    expect(model.sealed).not.toBeNull()
  })

  it('prevents a second rotation while a sealed segment is outstanding', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    model.rotate()
    model.append()
    expect(() => model.rotate()).toThrow()
  })

  it('counts an unacknowledged writeback gap once and re-anchors the longest prefix', () => {
    const model = new IncrementalChatJournalRotation()
    model.append()
    const old = model.active!
    model.rotate()
    model.append()
    const active = model.active!
    model.flushDirectory()
    expect(model.recover({ [old]: 0, [active]: 1 })).toEqual({ revision: 0, gap: true })
    expect(model.recover()).toEqual({ revision: 0, gap: false })
    expect(model.generation).toBeGreaterThan(0)
  })

  it('enumerates independent OS writeback prefixes and checkpoint/namespace kill points', () => {
    for (const adopted of [false, true]) {
      for (const checkpointRenamed of [false, true]) {
        for (const directoryDurable of [false, true]) {
          for (let sealedPrefix = 0; sealedPrefix <= 3; sealedPrefix++) {
            for (let activePrefix = 0; activePrefix <= 2; activePrefix++) {
              const model = new IncrementalChatJournalRotation(10)
              for (let i = 0; i < 3; i++) model.append()
              const old = model.active!
              model.flushDirectory() // the original active name is durable
              model.rotate()
              for (let i = 0; i < 2; i++) model.append()
              const active = model.active!
              model.prepare()
              if (checkpointRenamed) model.renameCheckpoint()
              if (directoryDurable) model.flushDirectory()
              if (adopted && checkpointRenamed && directoryDurable) {
                model.forgetSealed()
                model.unlinkSealed()
              }
              const result = model.recover({ [old]: sealedPrefix, [active]: activePrefix })
              const checkpoint = checkpointRenamed && directoryDurable ? 13 : 10
              const expected = directoryDurable
                ? sealedPrefix === 3 || checkpoint === 13
                  ? 13 + activePrefix
                  : 10 + sealedPrefix
                : 10 + sealedPrefix
              expect(result.revision).toBe(expected)
              expect(model.recover()).toEqual({ revision: expected, gap: false })
            }
          }
        }
      }
    }
  })

  it('every dependency completion ordering preserves all acknowledged revisions', () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0]
    ]
    for (const order of orders) {
      const model = new IncrementalChatJournalRotation()
      model.append()
      const old = model.active!
      model.rotate()
      model.append()
      const active = model.active!
      const completed = new Set<number>()
      for (const step of order) {
        if (step === 0) model.flushFile(old)
        if (step === 1) model.flushDirectory()
        if (step === 2) model.flushFile(active)
        completed.add(step)
        expect(model.acknowledge()).toBe(completed.size === 3)
      }
      expect(model.acknowledged).toBe(2)
      expect(model.recover()).toEqual({ revision: 2, gap: false })
    }
  })

  it('process crashes retain page-cache writes before and after rotation/adoption', () => {
    for (const stage of ['append', 'rotate', 'prepare', 'rename', 'adopt'] as const) {
      const model = new IncrementalChatJournalRotation()
      model.append()
      if (stage !== 'append') {
        model.rotate()
        model.append()
        if (stage !== 'rotate') {
          model.prepare()
          if (stage !== 'prepare') {
            model.renameCheckpoint()
            if (stage === 'adopt') {
              model.flushDirectory()
              model.forgetSealed()
              model.unlinkSealed()
            }
          }
        }
      }
      expect(model.recover({}, 'process-crash')).toEqual({
        revision: stage === 'append' ? 1 : 2,
        gap: false
      })
    }
  })
})
