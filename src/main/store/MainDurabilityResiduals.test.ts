import { describe, expect, it } from 'vitest'
import { MainDurabilityResiduals, observeResidual } from './MainDurabilityResiduals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import type { ChatRecord } from './types'

describe('residual window evidence', () => {
  it('counts actual first baseline verification and preserves save behavior when telemetry throws', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'residual-persistence-'))
    const collector = new MainDurabilityResiduals('epoch')
    const observer = collector.enroll(['baselineVerifies'])
    const persistence = createIncrementalChatPersistence({
      journal: createIncrementalChatJournal(root),
      residualObserver: (counter) => {
        observer(counter)
        throw new Error('diagnostic failure')
      }
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'first',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    try {
      persistence.persist(first, { ...first, title: 'second', persistenceRevision: 2 }, 'normal')
      expect(collector.snapshot('window').counters.baselineVerifies).toBe(1)
      expect(persistence.replay('chat').record?.title).toBe('second')
      expect(collector.snapshot('window').counters.conflictRecoveryReanchors).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('computes cumulative deltas without resetting other windows and leaves missing sources null', () => {
    let time = 1
    const collector = new MainDurabilityResiduals('process-epoch', () => time)
    const observe = collector.enroll(['baselineVerifies'])
    const first = collector.snapshot('beside')
    observe('baselineVerifies')
    time = 2
    const second = collector.snapshot('beside')
    observe('baselineVerifies')
    time = 3
    expect(collector.delta(first, 'beside').counters.baselineVerifies).toBe(2)
    expect(collector.delta(second, 'beside').counters.baselineVerifies).toBe(1)
    expect(collector.delta(first, 'beside').complete).toBe(false)
    expect(collector.delta(first, 'beside').counters.acknowledgedRevisionGapReanchors).toBeNull()
  })
  it('refuses identity/label/clock and cumulative-regression mistakes', () => {
    let time = 1
    const collector = new MainDurabilityResiduals('epoch', () => time)
    collector.enroll(['baselineVerifies'])
    const baseline = collector.snapshot('window')
    expect(() => collector.delta({ ...baseline, identity: 'other' }, 'window')).toThrow()
    expect(() => collector.delta(baseline, 'other')).toThrow()
    expect(() =>
      collector.delta(
        { ...baseline, counters: { ...baseline.counters, baselineVerifies: 2 } },
        'window'
      )
    ).toThrow('not issued')
    time = 0
    expect(() => collector.snapshot('window')).toThrow()
  })
  it('issues frozen private baselines and rejects foreign copies and invalid clocks', () => {
    const collector = new MainDurabilityResiduals('epoch', () => 1)
    const baseline = collector.snapshot('window')
    expect(Object.isFrozen(baseline)).toBe(true)
    expect(Object.isFrozen(baseline.counters)).toBe(true)
    expect(() => {
      baseline.at = NaN
    }).toThrow()
    expect(() => {
      baseline.counters.baselineVerifies = 4
    }).toThrow()
    for (const at of [NaN, Infinity, -1]) {
      expect(() => collector.delta({ ...baseline, at }, 'window')).toThrow('not issued')
      expect(() => new MainDurabilityResiduals('epoch', () => at).snapshot('window')).toThrow()
    }
    const foreign = new MainDurabilityResiduals('epoch', () => 1).snapshot('window')
    expect(() => collector.delta(foreign, 'window')).toThrow('not issued')
  })
  it('enrolls atomically and does not borrow mutable caller membership', () => {
    const collector = new MainDurabilityResiduals('epoch', () => 1)
    expect(() => collector.enroll(['baselineVerifies', 'invalid'] as never)).toThrow()
    expect(collector.snapshot('window').counters.baselineVerifies).toBeNull()
    const names: import('./MainDurabilityResiduals').ResidualCounter[] = ['baselineVerifies']
    const observe = collector.enroll(names)
    names.push('preparationRefusals')
    expect(() => observe('preparationRefusals')).toThrow('not enrolled')
    names.length = 0
    observe('baselineVerifies')
    expect(collector.snapshot('window').counters.baselineVerifies).toBe(1)
  })
  it.each(['counter', 'sequence', 'negative', 'unsafe'])(
    'invalidates overflow or corrupted current %s evidence',
    (kind) => {
      const collector = new MainDurabilityResiduals('epoch', () => 1)
      const observe = collector.enroll(['baselineVerifies'])
      const baseline = collector.snapshot('window')
      // Fault injection reaches private storage, never the public enrollment API.
      const state = collector as unknown as { sequence: number; counts: Map<string, number> }
      if (kind === 'counter') state.counts.set('baselineVerifies', Number.MAX_SAFE_INTEGER)
      else if (kind === 'sequence') state.sequence = Number.MAX_SAFE_INTEGER
      else if (kind === 'negative') state.sequence = -1
      else state.counts.set('baselineVerifies', Number.MAX_SAFE_INTEGER + 1)
      expect(() => observe('baselineVerifies')).toThrow('unqualified')
      expect(() => collector.snapshot('window')).toThrow('unqualified')
      expect(() => collector.delta(baseline, 'window')).toThrow('unqualified')
    }
  )
  it('contains observer failures rather than interrupting persistence', () => {
    expect(() =>
      observeResidual(() => {
        throw new Error('telemetry detached')
      }, 'baselineVerifies')
    ).not.toThrow()
  })
})
