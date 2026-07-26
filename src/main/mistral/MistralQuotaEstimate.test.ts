import { describe, expect, it } from 'vitest'
import {
  accumulate,
  estimateQuota,
  recordLimitEvent,
  rolloverIfElapsed,
  startCycle,
  type MistralQuotaCycle
} from './MistralQuotaEstimate'

const T0 = new Date('2026-07-01T00:00:00.000Z')

function cycleWith(spentUsd: number, extra: Partial<MistralQuotaCycle> = {}): MistralQuotaCycle {
  return { ...startCycle(T0), spentUsd, ...extra }
}

describe('startCycle', () => {
  it('zeroes the counters but carries a learned ceiling across the boundary', () => {
    const prior = { ...startCycle(T0), spentUsd: 12, turns: 4, learnedCeilingUsd: 21 }
    const next = startCycle(new Date('2026-08-01T00:00:00.000Z'), prior)
    expect(next.spentUsd).toBe(0)
    expect(next.turns).toBe(0)
    expect(next.sawLimitEvent).toBe(false)
    // The whole point of learning is that it survives the reset.
    expect(next.learnedCeilingUsd).toBe(21)
  })

  it('omits the ceiling entirely when nothing has been learned', () => {
    expect(startCycle(T0).learnedCeilingUsd).toBeUndefined()
  })
})

describe('accumulate', () => {
  it('sums cost and tokens across turns', () => {
    let c = startCycle(T0)
    c = accumulate(c, { costUsd: 0.31, totalTokens: 202_146 })
    c = accumulate(c, { costUsd: 0.012, totalTokens: 114_983 })
    expect(c.spentUsd).toBeCloseTo(0.322, 6)
    expect(c.totalTokens).toBe(317_129)
    expect(c.turns).toBe(2)
  })

  it('counts a zero-priced turn without fabricating spend', () => {
    // The local llamacpp model is priced at 0, so ACP omits `cost` entirely.
    // The turn still happened and must still count.
    const c = accumulate(startCycle(T0), { costUsd: 0, totalTokens: 5_000 })
    expect(c.spentUsd).toBe(0)
    expect(c.totalTokens).toBe(5_000)
    expect(c.turns).toBe(1)
  })

  it('ignores NaN and negative inputs rather than poisoning the total', () => {
    let c = accumulate(startCycle(T0), { costUsd: Number.NaN, totalTokens: Number.NaN })
    c = accumulate(c, { costUsd: -5, totalTokens: -1 })
    expect(c.spentUsd).toBe(0)
    expect(c.totalTokens).toBe(0)
    expect(c.turns).toBe(2)
  })
})

describe('recordLimitEvent', () => {
  it('adopts the spend at the wall as the learned ceiling', () => {
    const c = recordLimitEvent(cycleWith(9.4))
    expect(c.learnedCeilingUsd).toBe(9.4)
    expect(c.sawLimitEvent).toBe(true)
  })

  it('REFUSES to learn a ceiling from a trivially small spend', () => {
    // Vibe raises the same RateLimitError for the dynamic per-minute throttle as
    // for an exhausted monthly budget. A throttle at $0.02 must never collapse
    // the ceiling to $0.02 — that would band every later turn as "exceeded".
    const c = recordLimitEvent(cycleWith(0.02))
    expect(c.learnedCeilingUsd).toBeUndefined()
    expect(c.sawLimitEvent).toBe(true)
  })
})

describe('rolloverIfElapsed', () => {
  it('does nothing inside the cycle', () => {
    const c = cycleWith(3)
    expect(rolloverIfElapsed(c, new Date('2026-07-20T00:00:00.000Z'))).toBe(c)
  })

  it('resets once a month has passed', () => {
    const rolled = rolloverIfElapsed(cycleWith(3), new Date('2026-08-02T00:00:00.000Z'))
    expect(rolled.spentUsd).toBe(0)
    expect(rolled.cycleStartedAt).toBe('2026-08-02T00:00:00.000Z')
  })

  it('raises the ceiling when a cycle ended untouched — the seed was too low', () => {
    // Spent $20 across the month and never hit a wall, so the real ceiling is at
    // least $20 and probably more.
    const rolled = rolloverIfElapsed(cycleWith(20), new Date('2026-08-02T00:00:00.000Z'))
    expect(rolled.learnedCeilingUsd).toBeCloseTo(25, 6)
  })

  it('does not lower an already-learned ceiling on a quiet cycle', () => {
    const quiet = cycleWith(2, { learnedCeilingUsd: 30 })
    const rolled = rolloverIfElapsed(quiet, new Date('2026-08-02T00:00:00.000Z'))
    expect(rolled.learnedCeilingUsd).toBe(30)
  })

  it('recovers from a corrupt cycle timestamp instead of throwing', () => {
    const bad = { ...startCycle(T0), cycleStartedAt: 'not-a-date' }
    const rolled = rolloverIfElapsed(bad, T0)
    expect(rolled.cycleStartedAt).toBe(T0.toISOString())
  })
})

describe('estimateQuota', () => {
  it('seeds from the plan price before anything has been observed', () => {
    const e = estimateQuota(startCycle(T0), 'pro', T0)
    expect(e.estimatedCeilingUsd).toBeCloseTo(14.99, 6)
    expect(e.confidence).toBe('seeded')
    expect(e.usedPercent).toBe(0)
    expect(e.band).toBe('quiet')
  })

  it('treats an unknown plan as Pro rather than refusing to meter', () => {
    expect(estimateQuota(startCycle(T0), 'unknown', T0).estimatedCeilingUsd).toBeCloseTo(14.99, 6)
  })

  it('walks the bands as spend climbs', () => {
    const at = (usd: number) => estimateQuota(cycleWith(usd), 'pro', T0).band
    expect(at(1)).toBe('quiet')
    expect(at(4)).toBe('moderate')
    expect(at(9)).toBe('heavy')
    expect(at(13)).toBe('near-limit')
    expect(at(20)).toBe('exceeded')
  })

  it('clamps the percentage rather than reporting over 100', () => {
    expect(estimateQuota(cycleWith(100), 'pro', T0).usedPercent).toBe(100)
  })

  it('prefers a learned ceiling over the price anchor', () => {
    const learned = cycleWith(9, { learnedCeilingUsd: 45, sawLimitEvent: true })
    const e = estimateQuota(learned, 'pro', T0)
    expect(e.estimatedCeilingUsd).toBe(45)
    expect(e.confidence).toBe('learned')
    // $9 of a $45 ceiling is moderate, where $9 of the $14.99 seed was heavy.
    expect(e.band).toBe('moderate')
  })

  it('hedges the label until a real limit event has been seen', () => {
    expect(estimateQuota(cycleWith(9), 'pro', T0).label).toContain('(estimated)')
    const learned = cycleWith(9, { learnedCeilingUsd: 12, sawLimitEvent: true })
    expect(estimateQuota(learned, 'pro', T0).label).not.toContain('(estimated)')
  })

  it('reports the plain-language band the sidebar renders', () => {
    expect(estimateQuota(cycleWith(9), 'pro', T0).label).toContain('Used quite a bit this month')
  })

  it('moves from seeded to calibrating once turns have been observed', () => {
    const c = accumulate(startCycle(T0), { costUsd: 0.01, totalTokens: 100 })
    expect(estimateQuota(c, 'pro', T0).confidence).toBe('calibrating')
  })

  it('projects the reset a month from the cycle start, not from now', () => {
    const e = estimateQuota(cycleWith(1), 'pro', new Date('2026-07-25T00:00:00.000Z'))
    expect(e.cycleResetsAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('survives a zero or negative stored ceiling by falling back to the seed', () => {
    const broken = cycleWith(3, { learnedCeilingUsd: 0 })
    expect(estimateQuota(broken, 'pro', T0).estimatedCeilingUsd).toBeCloseTo(14.99, 6)
  })
})

describe('end-to-end calibration', () => {
  it('converges from a seeded guess to a measured ceiling over two cycles', () => {
    // Cycle 1: heavy use, no wall. The seed was too low.
    let c = startCycle(T0)
    for (let i = 0; i < 60; i++) c = accumulate(c, { costUsd: 0.31, totalTokens: 200_000 })
    expect(estimateQuota(c, 'pro', T0).band).toBe('exceeded') // seed says over; reality disagrees
    c = rolloverIfElapsed(c, new Date('2026-08-02T00:00:00.000Z'))
    expect(c.learnedCeilingUsd).toBeCloseTo(23.25, 2)

    // Cycle 2: $12.40 of spend. Against the SEED that was 83% and would have
    // cried "near-limit"; against the learned $23.25 ceiling it is 53% — heavy,
    // but not alarming. Calibration earning its keep by being less alarmist.
    for (let i = 0; i < 40; i++) c = accumulate(c, { costUsd: 0.31, totalTokens: 200_000 })
    expect(c.spentUsd).toBeCloseTo(12.4, 2)
    expect(estimateQuota({ ...c, learnedCeilingUsd: undefined }, 'pro', T0).band).toBe('near-limit')
    const mid = estimateQuota(c, 'pro', new Date('2026-08-10T00:00:00.000Z'))
    expect(mid.band).toBe('heavy')
    expect(mid.confidence).toBe('calibrating')

    // Then a real wall lands, and the estimate becomes a measurement.
    c = recordLimitEvent(c)
    const after = estimateQuota(c, 'pro', new Date('2026-08-11T00:00:00.000Z'))
    expect(after.confidence).toBe('learned')
    expect(after.estimatedCeilingUsd).toBeCloseTo(12.4, 2)
    expect(after.label).not.toContain('(estimated)')
  })
})
