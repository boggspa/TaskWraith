import { describe, expect, it } from 'vitest'
import {
  accumulate,
  applyAnchor,
  applyReport,
  clearAnchor,
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
  it("seeds from the plan's observed allowance before anything has been observed", () => {
    const e = estimateQuota(startCycle(T0), 'pro', T0)
    // Pro's VIBE CODE budget, read off admin.mistral.ai on 2026-08-06: €255.
    // NOT the €25.50 "Included monthly usage" bar this seed used to carry — as
    // of ~3 Aug 2026 Vibe stopped debiting that pool entirely (see the module
    // header), so metering against it under-read the real ceiling ~10x.
    expect(e.estimatedCeilingUsd).toBeCloseTo(278, 6)
    expect(e.confidence).toBe('seeded')
    expect(e.usedPercent).toBe(0)
    expect(e.band).toBe('quiet')
  })

  it('seeds an unknown plan LOW (as Free), so the default case warns early', () => {
    // The plan is undetectable from the lane, so `unknown` is where most users
    // sit. Seeding it at Pro's ceiling would now meter a Free seat against 30x
    // its allowance — late warnings are the failure this seed exists to avoid.
    // Free's own Vibe Code budget is UNOBSERVED, so this deliberately keeps the
    // old €8.50 shared-pool figure: it is a floor, and erring low warns early.
    expect(estimateQuota(startCycle(T0), 'unknown', T0).estimatedCeilingUsd).toBeCloseTo(9.25, 6)
    expect(estimateQuota(startCycle(T0), 'free', T0).estimatedCeilingUsd).toBeCloseTo(9.25, 6)
  })

  it('walks the bands as spend climbs', () => {
    const at = (usd: number) => estimateQuota(cycleWith(usd), 'pro', T0).band
    // Fractions of Pro's $278 ceiling: 20% / 50% / 80% / 100% are the edges.
    expect(at(10)).toBe('quiet')
    expect(at(70)).toBe('moderate')
    expect(at(160)).toBe('heavy')
    expect(at(240)).toBe('near-limit')
    expect(at(300)).toBe('exceeded')
  })

  it('clamps the percentage rather than reporting over 100', () => {
    expect(estimateQuota(cycleWith(1000), 'pro', T0).usedPercent).toBe(100)
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
    expect(estimateQuota(cycleWith(160), 'pro', T0).label).toContain('Used quite a bit this month')
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
    expect(estimateQuota(broken, 'pro', T0).estimatedCeilingUsd).toBeCloseTo(278, 6)
  })
})

describe('end-to-end calibration', () => {
  it('converges from a seeded guess to a measured ceiling over two cycles', () => {
    // Cycle 1: $310.00 of use, no wall. The $278 seed says over; reality didn't
    // agree, and an untouched cycle is evidence the ceiling is at least what was
    // spent.
    let c = startCycle(T0)
    for (let i = 0; i < 100; i++) c = accumulate(c, { costUsd: 3.1, totalTokens: 200_000 })
    expect(c.spentUsd).toBeCloseTo(310, 2)
    expect(estimateQuota(c, 'pro', T0).band).toBe('exceeded')
    c = rolloverIfElapsed(c, new Date('2026-08-02T00:00:00.000Z'))
    expect(c.learnedCeilingUsd).toBeCloseTo(387.5, 2)

    // Cycle 2: $248.00 of spend. Against the SEED that is 89% and would have
    // cried "near-limit"; against the learned $387.50 ceiling it is 64% — heavy,
    // but not alarming. Calibration earning its keep by being less alarmist.
    for (let i = 0; i < 80; i++) c = accumulate(c, { costUsd: 3.1, totalTokens: 200_000 })
    expect(c.spentUsd).toBeCloseTo(248, 2)
    expect(estimateQuota({ ...c, learnedCeilingUsd: undefined }, 'pro', T0).band).toBe('near-limit')
    const mid = estimateQuota(c, 'pro', new Date('2026-08-10T00:00:00.000Z'))
    expect(mid.band).toBe('heavy')
    expect(mid.confidence).toBe('calibrating')

    // Then a real wall lands, and the estimate becomes a measurement.
    c = recordLimitEvent(c)
    const after = estimateQuota(c, 'pro', new Date('2026-08-11T00:00:00.000Z'))
    expect(after.confidence).toBe('learned')
    expect(after.estimatedCeilingUsd).toBeCloseTo(248, 2)
    expect(after.label).not.toContain('(estimated)')
  })
})

// ── Vendor sources: the console anchor and the Admin API report ──────────────
// These are the two paths by which a REAL Mistral figure reaches the meter.
// Everything above this line is the fallback that runs when neither exists.

describe('applyAnchor — the user reads their own console', () => {
  const READING = {
    // The observed 2026-08-06 Pro console: the VIBE CODE budget bar, €255.
    // Converted to USD by the renderer before it ever reaches this module.
    allowanceUsd: 278,
    spentUsd: 0.31,
    observedAt: '2026-07-27T12:00:00.000Z',
    cycleResetsAt: '2026-07-31T00:00:00.000Z',
    declared: { allowance: 255, spent: 0.28, currency: 'EUR' }
  }

  it('outranks the plan seed for BOTH halves and stops hedging the label', () => {
    const anchored = applyAnchor(cycleWith(0.05), READING)
    const e = estimateQuota(anchored, 'pro', T0)
    expect(e.estimatedCeilingUsd).toBeCloseTo(278, 6)
    expect(e.spentUsd).toBeCloseTo(0.31, 6)
    expect(e.confidence).toBe('anchored')
    expect(e.ceilingConfidence).toBe('anchored')
    expect(e.vendorReported).toBe(true)
    expect(e.label).not.toContain('(estimated)')
  })

  it('keeps the raw vendor figure and currency as provenance', () => {
    const e = estimateQuota(applyAnchor(startCycle(T0), READING), 'pro', T0)
    expect(e.spentSource.declared).toEqual({ amount: 0.28, currency: 'EUR' })
    expect(e.ceilingSource.declared).toEqual({ amount: 255, currency: 'EUR' })
    expect(e.spentSource.asOf).toBe('2026-07-27T12:00:00.000Z')
  })

  it('does NOT double-count spend the reading already covered', () => {
    // $4 was accumulated locally before the user read their console. The console
    // said $0.31 — it already accounts for those turns (badly, but it is the
    // vendor's number). Adding $4 on top would be counting them twice.
    const anchored = applyAnchor(cycleWith(4), READING)
    expect(anchored.anchor?.localSpentUsdAtAnchor).toBe(4)
    expect(estimateQuota(anchored, 'pro', T0).spentUsd).toBeCloseTo(0.31, 6)
  })

  it('accumulates turns that land AFTER the reading on top of it', () => {
    let c = applyAnchor(cycleWith(4), READING)
    c = accumulate(c, { costUsd: 0.5, totalTokens: 1000 })
    c = accumulate(c, { costUsd: 0.25, totalTokens: 1000 })
    // 0.31 from the console + 0.75 observed since. The pre-anchor $4 stays out.
    const estimate = estimateQuota(c, 'pro', T0)
    expect(estimate.spentUsd).toBeCloseTo(1.06, 6)
    expect(estimate.locallyEstimatedSinceReadingUsd).toBeCloseTo(0.75, 6)
    expect(estimate.confidence).toBe('anchored')
    // The console baseline is real, but the combined total is now mixed with a
    // local projection and must visibly regain its estimate hedge.
    expect(estimate.vendorReported).toBe(false)
    expect(estimate.label).toContain('(estimated)')
  })

  it('never goes backwards if local accumulation is somehow below the watermark', () => {
    const anchored = applyAnchor(cycleWith(4), READING)
    // A rolled-back / re-decoded cycle with a lower local total must not
    // subtract from the vendor reading.
    const rewound = { ...anchored, spentUsd: 1 }
    expect(estimateQuota(rewound, 'pro', T0).spentUsd).toBeCloseTo(0.31, 6)
  })

  it('uses the real reset date instead of guessing a month from first sighting', () => {
    // THE bug this fixes: the cycle started when TaskWraith first saw the seat
    // (1 Jul), so the old model projected 1 Aug. Mistral bills on the account
    // anniversary — the console said 31 Jul.
    const naive = estimateQuota(cycleWith(1), 'pro', T0)
    expect(naive.cycleResetsAt).toBe('2026-08-01T00:00:00.000Z')
    const anchored = estimateQuota(applyAnchor(cycleWith(1), READING), 'pro', T0)
    expect(anchored.cycleResetsAt).toBe('2026-07-31T00:00:00.000Z')
  })

  it('rolls a past reset forward month by month rather than reporting a stale date', () => {
    const c = applyAnchor(startCycle(T0), READING)
    const e = estimateQuota(c, 'pro', new Date('2026-10-05T00:00:00.000Z'))
    expect(e.cycleResetsAt).toBe('2026-10-31T00:00:00.000Z')
  })

  it('falls back to a month from now when the stored reset is unusable', () => {
    const c = { ...startCycle(T0), knownResetAt: 'not-a-date' }
    const e = estimateQuota(c, 'pro', new Date('2026-09-10T00:00:00.000Z'))
    // Derived from the cycle start, not from the junk value.
    expect(e.cycleResetsAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('clearAnchor returns the meter to local accumulation', () => {
    const anchored = applyAnchor(cycleWith(4), READING)
    const cleared = clearAnchor(anchored)
    expect(cleared.anchor).toBeUndefined()
    const e = estimateQuota(cleared, 'pro', T0)
    expect(e.spentUsd).toBeCloseTo(4, 6)
    expect(e.confidence).not.toBe('anchored')
    // The allowance was plan knowledge, not a per-cycle observation — it stays.
    expect(e.estimatedCeilingUsd).toBeCloseTo(278, 6)
  })

  it('carries the allowance and advances the reset across a rollover, dropping the reading', () => {
    const anchored = applyAnchor(cycleWith(2), READING)
    const rolled = rolloverIfElapsed(anchored, new Date('2026-08-05T00:00:00.000Z'))
    // The reading described July. Re-showing it against August's burn would lie.
    expect(rolled.anchor).toBeUndefined()
    // The allowance and the billing anniversary are plan facts and survive.
    expect(rolled.knownAllowanceUsd).toBeCloseTo(278, 6)
    expect(rolled.knownResetAt).toBe('2026-08-31T00:00:00.000Z')
    const e = estimateQuota(rolled, 'pro', new Date('2026-08-05T00:00:00.000Z'))
    expect(e.estimatedCeilingUsd).toBeCloseTo(278, 6)
    expect(e.spentUsd).toBe(0)
    // A carried vendor allowance is still a vendor figure, but the SPEND is
    // back to local accumulation — so the reading as a whole is not measured.
    expect(e.ceilingConfidence).toBe('anchored')
    expect(e.vendorReported).toBe(false)
  })
})

describe('applyReport — the Admin API answered', () => {
  const REPORT = {
    spentUsd: 3.27,
    fetchedAt: '2026-07-27T12:00:00.000Z',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    declared: { spent: 3.0, currency: 'EUR' }
  }

  it('outranks a console anchor for spend', () => {
    const c = applyReport(
      applyAnchor(cycleWith(1), {
        allowanceUsd: 278,
        spentUsd: 0.31,
        observedAt: '2026-07-20T00:00:00.000Z'
      }),
      REPORT
    )
    const e = estimateQuota(c, 'pro', T0)
    expect(e.spentUsd).toBeCloseTo(3.27, 6)
    expect(e.confidence).toBe('reported')
    expect(e.spentSource.declared).toEqual({ amount: 3, currency: 'EUR' })
  })

  it('leaves the ceiling to weaker sources when the response carries no entitlement', () => {
    // The documented usage endpoint reports CONSUMPTION only. Reported spend
    // against a seeded ceiling is the normal, expected combination.
    const e = estimateQuota(applyReport(startCycle(T0), REPORT), 'pro', T0)
    expect(e.confidence).toBe('reported')
    expect(e.ceilingConfidence).toBe('seeded')
    expect(e.estimatedCeilingUsd).toBeCloseTo(278, 6)
    // Half-measured is not measured: the label must still hedge.
    expect(e.vendorReported).toBe(false)
    expect(e.label).toContain('(estimated)')
  })

  it('uses the entitlement when the response does carry one', () => {
    const e = estimateQuota(applyReport(startCycle(T0), { ...REPORT, allowanceUsd: 50 }), 'pro', T0)
    expect(e.estimatedCeilingUsd).toBe(50)
    expect(e.ceilingConfidence).toBe('reported')
    expect(e.vendorReported).toBe(true)
    expect(e.label).not.toContain('(estimated)')
  })

  it('adds locally observed turns after an Admin report without double-counting earlier turns', () => {
    let c = applyReport(cycleWith(4), { ...REPORT, allowanceUsd: 50 })
    expect(c.report?.localSpentUsdAtReport).toBe(4)
    c = accumulate(c, { costUsd: 0.5, totalTokens: 1000 })
    const e = estimateQuota(c, 'pro', T0)
    expect(e.spentUsd).toBeCloseTo(3.77, 6)
    expect(e.locallyEstimatedSinceReadingUsd).toBeCloseTo(0.5, 6)
    expect(e.confidence).toBe('reported')
    expect(e.vendorReported).toBe(false)
    expect(e.label).toContain('(estimated)')
  })

  it('is not overridden by a recorded limit event', () => {
    // A wall tells us where we stopped; the vendor tells us what it charged.
    // The vendor wins.
    const c = recordLimitEvent(applyReport(cycleWith(9), REPORT))
    expect(estimateQuota(c, 'pro', T0).confidence).toBe('reported')
  })

  it('still lets a limit event upgrade a merely-accumulating spend reading', () => {
    const c = recordLimitEvent(cycleWith(9))
    expect(estimateQuota(c, 'pro', T0).confidence).toBe('learned')
  })
})

describe('billing-anniversary arithmetic', () => {
  const anniversary = (resetIso: string, nowIso: string): string =>
    estimateQuota({ ...startCycle(T0), knownResetAt: resetIso }, 'pro', new Date(nowIso))
      .cycleResetsAt

  it('keeps a month-end anniversary pinned to month end instead of drifting', () => {
    // 31 Jul → 31 Aug → (no 31 Sep) → 30 Sep → 31 Oct. Stepping month-by-month
    // from the previous RESULT would clamp to the 30th and never recover.
    expect(anniversary('2026-07-31T00:00:00.000Z', '2026-08-15T00:00:00.000Z')).toBe(
      '2026-08-31T00:00:00.000Z'
    )
    expect(anniversary('2026-07-31T00:00:00.000Z', '2026-09-15T00:00:00.000Z')).toBe(
      '2026-09-30T00:00:00.000Z'
    )
    expect(anniversary('2026-07-31T00:00:00.000Z', '2026-10-15T00:00:00.000Z')).toBe(
      '2026-10-31T00:00:00.000Z'
    )
  })

  it('does the arithmetic in UTC so the host timezone cannot shift the hour', () => {
    // setMonth() is local-time: on a BST machine it moved a midnight-UTC reset
    // to 01:00 UTC and slid the date with it.
    expect(anniversary('2026-07-31T00:00:00.000Z', '2027-01-15T00:00:00.000Z')).toBe(
      '2027-01-31T00:00:00.000Z'
    )
  })

  it('leaves a still-future anniversary exactly where it is', () => {
    expect(anniversary('2026-07-31T00:00:00.000Z', '2026-07-27T00:00:00.000Z')).toBe(
      '2026-07-31T00:00:00.000Z'
    )
  })

  it('rolls the cycle over ON the anniversary, not a month after first sighting', () => {
    // The regression this whole path exists for: cycleStartedAt is 1 Jul, so the
    // old model would not roll until 1 Aug. The real cycle ended on the 31st.
    const c = { ...cycleWith(3), knownResetAt: '2026-07-31T00:00:00.000Z' }
    expect(rolloverIfElapsed(c, new Date('2026-07-30T00:00:00.000Z'))).toBe(c)
    const rolled = rolloverIfElapsed(c, new Date('2026-07-31T12:00:00.000Z'))
    expect(rolled.spentUsd).toBe(0)
    expect(rolled.knownResetAt).toBe('2026-08-31T00:00:00.000Z')
  })
})
