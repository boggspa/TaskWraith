import { describe, expect, it } from 'vitest'
import {
  MAX_CONCURRENT_FANOUT_WAVES,
  UNATTRIBUTED_FANOUT_WAVE_ID,
  openFanoutWaves,
  refuseForConcurrentFanouts
} from './EnsembleFanoutConcurrency'
import type { FanoutWaveLane } from './EnsembleFanoutConcurrency'

function lane(
  laneId: string,
  status: FanoutWaveLane['status'],
  waveId?: string,
  label?: string
): FanoutWaveLane {
  return { laneId, status, waveId, label }
}

describe('openFanoutWaves', () => {
  it('counts a wave once however many lanes it carries', () => {
    // The whole point of the cap: it bounds fan-out CALLS, not participants.
    // A twenty-seat review wave is one wave.
    const lanes = Array.from({ length: 20 }, (_, i) =>
      lane(`lane-${i}`, 'running', 'wave-review', 'Reader fan-out')
    )
    const open = openFanoutWaves(lanes)
    expect(open).toHaveLength(1)
    expect(open[0].waveId).toBe('wave-review')
    expect(open[0].openLaneIds).toHaveLength(20)
  })

  it('ignores waves whose lanes have all settled', () => {
    const open = openFanoutWaves([
      lane('a', 'completed', 'wave-1'),
      lane('b', 'failed', 'wave-1'),
      lane('c', 'cancelled', 'wave-1')
    ])
    expect(open).toEqual([])
  })

  it('keeps a wave open while any single lane is still in flight', () => {
    for (const status of ['pending', 'running', 'blocked', 'awaiting-approval'] as const) {
      const open = openFanoutWaves([lane('a', 'completed', 'w'), lane('b', status, 'w')])
      expect(open.map((w) => w.waveId)).toEqual(['w'])
      expect(open[0].openLaneIds).toEqual(['b'])
    }
  })

  it('separates concurrent waves', () => {
    const open = openFanoutWaves([
      lane('a', 'running', 'wave-review', 'Reader fan-out'),
      lane('b', 'running', 'wave-work', 'Work fan-out')
    ])
    expect(open.map((w) => w.waveId)).toEqual(['wave-review', 'wave-work'])
    expect(open.map((w) => w.label)).toEqual(['Reader fan-out', 'Work fan-out'])
  })

  it('pools lanes with no wave id into ONE bucket, never one bucket each', () => {
    // Over-counting here would be far worse than under-counting: a single
    // legacy twenty-lane wave read as twenty waves would refuse every dispatch
    // from then on. Every current dispatch path stamps a wave id, so this is a
    // floor for old rounds, not a live case.
    const open = openFanoutWaves([lane('a', 'running'), lane('b', 'running'), lane('c', 'running')])
    expect(open).toHaveLength(1)
    expect(open[0].waveId).toBe(UNATTRIBUTED_FANOUT_WAVE_ID)
  })
})

describe('refuseForConcurrentFanouts', () => {
  const wave = (id: string, label: string, lanes: number) =>
    openFanoutWaves(
      Array.from({ length: lanes }, (_, i) => lane(`${id}-lane-${i}`, 'running', id, label))
    )[0]

  it('allows the first fan-out', () => {
    expect(refuseForConcurrentFanouts([], 'ensemble_fanout')).toBeNull()
  })

  it('allows a second concurrent fan-out', () => {
    expect(
      refuseForConcurrentFanouts([wave('w1', 'Reader fan-out', 20)], 'ensemble_fanout')
    ).toBeNull()
  })

  it('allows a third concurrent fan-out', () => {
    expect(
      refuseForConcurrentFanouts(
        [wave('w1', 'Reader fan-out', 3), wave('w2', 'Work fan-out', 1)],
        'ensemble_fanout'
      )
    ).toBeNull()
  })

  it('refuses the fourth', () => {
    const refusal = refuseForConcurrentFanouts(
      [
        wave('w1', 'Reader fan-out', 3),
        wave('w2', 'Work fan-out', 1),
        wave('w3', 'Review fan-out', 2)
      ],
      'ensemble_fanout'
    )
    expect(refusal).not.toBeNull()
    expect(refusal?.error).toBe('too_many_concurrent_fanouts')
  })

  it('names the open waves and points the caller at ensemble_await', () => {
    // What a Boss actually READS decides whether it awaits or thrashes.
    const refusal = refuseForConcurrentFanouts(
      [
        wave('w1', 'Reader fan-out', 3),
        wave('w2', 'Work fan-out', 1),
        wave('w3', 'Audit fan-out', 2)
      ],
      'ensemble_fanout_all'
    )
    const message = refusal?.message ?? ''
    expect(message).toContain('ensemble_fanout_all')
    expect(message).toContain('ensemble_await')
    expect(message).toContain('Reader fan-out')
    expect(message).toContain('Work fan-out')
    // It must not read as a participant cap, or a Boss will shrink its roster
    // to get unblocked — the exact opposite of the intent.
    expect(message).toMatch(/not on participants/i)
    expect(message).toMatch(/do not drop seats/i)
  })

  it('is the cap the owner asked for', () => {
    expect(MAX_CONCURRENT_FANOUT_WAVES).toBe(3)
  })

  it('refuses again at more than the cap, never silently allows an overshoot', () => {
    const waves = [
      wave('w1', 'A', 1),
      wave('w2', 'B', 1),
      wave('w3', 'C', 1),
      wave('w4', 'D', 1)
    ]
    expect(refuseForConcurrentFanouts(waves, 'ensemble_fanout')?.error).toBe(
      'too_many_concurrent_fanouts'
    )
  })
})
