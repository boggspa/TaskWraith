import { describe, expect, it } from 'vitest'
import {
  DAILY_USAGE_ROLLUP_MAX_DAYS,
  buildDailyUsageTotals,
  dailyUsageDayBounds,
  dailyUsageDayKey,
  dailyUsageDayKeyRange,
  dailyUsageDayRuns,
  dailyUsageDayTokens,
  dominantProviderForDay,
  foldUsageRecordsIntoDailyRollup,
  pruneDailyUsageRollupDays,
  type DailyUsageDays,
  type DailyUsageTokenRecordLike
} from './dailyUsageRollup'

const ORDER = ['codex', 'claude', 'gemini', 'kimi', 'grok', 'cursor', 'ollama']

/** Local noon on a given day — safely inside the day in every timezone. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime()
}

function record(
  provider: string,
  timestamp: number,
  tokens: number,
  extra: Partial<DailyUsageTokenRecordLike> = {}
): DailyUsageTokenRecordLike {
  return { provider, timestamp, totalTokens: tokens, ...extra }
}

/** Whole-day observation window covering [from, to] inclusive. */
function windowOver(fromDay: number, toDay: number, month = 6, year = 2026) {
  return {
    observedFromMs: new Date(year, month - 1, fromDay, 0, 0, 0, 0).getTime(),
    observedToMs: new Date(year, month - 1, toDay, 23, 59, 59, 999).getTime(),
    now: noon(year, month, toDay)
  }
}

describe('dailyUsageDayKey / bounds', () => {
  it('keys by LOCAL calendar day, not UTC', () => {
    // 23:30 local always belongs to that local day whatever the UTC offset is.
    const late = new Date(2026, 5, 10, 23, 30, 0, 0)
    expect(dailyUsageDayKey(late.getTime())).toBe('2026-06-10')
  })

  it('round-trips a key to inclusive local-midnight bounds', () => {
    const bounds = dailyUsageDayBounds('2026-06-10')
    expect(bounds).not.toBeNull()
    expect(new Date(bounds!.startMs).getHours()).toBe(0)
    expect(new Date(bounds!.endMs).getHours()).toBe(23)
    expect(dailyUsageDayKey(bounds!.startMs)).toBe('2026-06-10')
    expect(dailyUsageDayKey(bounds!.endMs)).toBe('2026-06-10')
  })

  it('rejects malformed and non-existent days rather than rolling them over', () => {
    expect(dailyUsageDayBounds('nonsense')).toBeNull()
    expect(dailyUsageDayBounds('2026-13-01')).toBeNull()
    // Date(2026, 1, 31) silently becomes 3 March — the guard must catch it.
    expect(dailyUsageDayBounds('2026-02-31')).toBeNull()
  })

  it('emits an ordered, inclusive key range ending today', () => {
    const keys = dailyUsageDayKeyRange(noon(2026, 6, 10), 3)
    expect(keys).toEqual(['2026-06-08', '2026-06-09', '2026-06-10'])
  })

  it('spans month and year boundaries without gaps', () => {
    const keys = dailyUsageDayKeyRange(noon(2026, 1, 2), 4)
    expect(keys).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
  })
})

describe('buildDailyUsageTotals', () => {
  it('sums tokens and runs per provider per day', () => {
    const days = buildDailyUsageTotals([
      record('codex', noon(2026, 6, 10), 100),
      record('codex', noon(2026, 6, 10), 50),
      record('claude', noon(2026, 6, 10), 30),
      record('codex', noon(2026, 6, 11), 7)
    ])
    expect(days['2026-06-10'].codex).toEqual({ tokens: 150, runs: 2 })
    expect(days['2026-06-10'].claude).toEqual({ tokens: 30, runs: 1 })
    expect(days['2026-06-11'].codex).toEqual({ tokens: 7, runs: 1 })
  })

  it('honours the runCount contract of aggregated buckets', () => {
    const days = buildDailyUsageTotals([record('codex', noon(2026, 6, 10), 100, { runCount: 12 })])
    expect(days['2026-06-10'].codex).toEqual({ tokens: 100, runs: 12 })
  })

  it('falls back to component tokens when totalTokens is absent', () => {
    const days = buildDailyUsageTotals([
      {
        provider: 'claude',
        timestamp: noon(2026, 6, 10),
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3
      }
    ])
    expect(days['2026-06-10'].claude.tokens).toBe(20)
  })

  it('keeps zero-token activity markers as runs, not as spend', () => {
    const days = buildDailyUsageTotals([record('cursor', noon(2026, 6, 10), 0)])
    expect(days['2026-06-10'].cursor).toEqual({ tokens: 0, runs: 1 })
  })

  it('skips reset_hint rows and non-finite timestamps', () => {
    const days = buildDailyUsageTotals([
      record('codex', noon(2026, 6, 10), 999, { usageKind: 'reset_hint' }),
      record('codex', Number.NaN, 999)
    ])
    expect(days).toEqual({})
  })
})

describe('foldUsageRecordsIntoDailyRollup', () => {
  it('REPLACES a fully-observed day rather than adding to it', () => {
    // The core invariant: without it, every scan doubles the day's total.
    const first = foldUsageRecordsIntoDailyRollup(
      {},
      [record('codex', noon(2026, 6, 10), 100)],
      windowOver(9, 11)
    )
    const second = foldUsageRecordsIntoDailyRollup(
      first,
      [record('codex', noon(2026, 6, 10), 100)],
      windowOver(9, 11)
    )
    expect(first['2026-06-10'].codex.tokens).toBe(100)
    expect(second['2026-06-10'].codex.tokens).toBe(100)
    expect(second).toEqual(first)
  })

  it('KEEPS days outside the observed window — this is the 365-day tail', () => {
    const base: DailyUsageDays = {
      '2026-01-05': { codex: { tokens: 4242, runs: 9 } }
    }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('codex', noon(2026, 6, 10), 100)],
      windowOver(9, 11)
    )
    expect(folded['2026-01-05'].codex.tokens).toBe(4242)
    expect(folded['2026-06-10'].codex.tokens).toBe(100)
  })

  it('KEEPS a stored day the incoming set says nothing about', () => {
    // Absence from `incoming` is not evidence of absence in the world: the
    // scan's records reach only as far back as the provider logs go.
    const base: DailyUsageDays = { '2026-06-10': { codex: { tokens: 500, runs: 2 } } }
    const folded = foldUsageRecordsIntoDailyRollup(base, [], windowOver(9, 11))
    expect(folded['2026-06-10'].codex.tokens).toBe(500)
  })

  it('KEEPS a provider the incoming set never mentions, on an observed day', () => {
    // The deep backfill is external-only and cannot see TaskWraith's journal,
    // so folding it must not erase ollama/mistral/pi from every day it covers.
    const base: DailyUsageDays = {
      '2026-06-10': { codex: { tokens: 500, runs: 2 }, ollama: { tokens: 90, runs: 3 } }
    }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('codex', noon(2026, 6, 10), 700)],
      windowOver(9, 11)
    )
    expect(folded['2026-06-10'].codex.tokens).toBe(700)
    expect(folded['2026-06-10'].ollama).toEqual({ tokens: 90, runs: 3 })
  })

  it('still lets an observed provider be corrected DOWNWARDS', () => {
    // The one thing per-provider replace must preserve: a dedupe fix has to be
    // able to lower a total, or every correction is one-way.
    const base: DailyUsageDays = { '2026-06-10': { codex: { tokens: 900, runs: 9 } } }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('codex', noon(2026, 6, 10), 100)],
      windowOver(9, 11)
    )
    expect(folded['2026-06-10'].codex).toEqual({ tokens: 100, runs: 1 })
  })

  it('MAX-merges the partial boundary day instead of shrinking it', () => {
    // A rolling `sinceMs` always slices its oldest day, so the incoming total
    // for that day is short by construction. Replacing would lose the morning.
    const base: DailyUsageDays = { '2026-06-09': { codex: { tokens: 900, runs: 5 } } }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('codex', new Date(2026, 5, 9, 18, 0, 0, 0).getTime(), 200)],
      {
        // Window opens midday on the 9th: that day is only partly observed.
        observedFromMs: new Date(2026, 5, 9, 12, 0, 0, 0).getTime(),
        observedToMs: new Date(2026, 5, 11, 23, 59, 59, 999).getTime(),
        now: noon(2026, 6, 11)
      }
    )
    expect(folded['2026-06-09'].codex.tokens).toBe(900)
  })

  it('lets a partial boundary day grow when the scan sees more', () => {
    const base: DailyUsageDays = { '2026-06-09': { codex: { tokens: 100, runs: 1 } } }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('codex', new Date(2026, 5, 9, 18, 0, 0, 0).getTime(), 750)],
      {
        observedFromMs: new Date(2026, 5, 9, 12, 0, 0, 0).getTime(),
        observedToMs: new Date(2026, 5, 11, 23, 59, 59, 999).getTime(),
        now: noon(2026, 6, 11)
      }
    )
    expect(folded['2026-06-09'].codex.tokens).toBe(750)
  })

  it('merges a boundary day per provider, not per day total', () => {
    const base: DailyUsageDays = {
      '2026-06-09': { codex: { tokens: 900, runs: 5 }, claude: { tokens: 10, runs: 1 } }
    }
    const folded = foldUsageRecordsIntoDailyRollup(
      base,
      [record('claude', new Date(2026, 5, 9, 18, 0, 0, 0).getTime(), 640)],
      {
        observedFromMs: new Date(2026, 5, 9, 12, 0, 0, 0).getTime(),
        observedToMs: new Date(2026, 5, 11, 23, 59, 59, 999).getTime(),
        now: noon(2026, 6, 11)
      }
    )
    expect(folded['2026-06-09'].codex.tokens).toBe(900)
    expect(folded['2026-06-09'].claude.tokens).toBe(640)
  })

  it('is idempotent across repeated folds of a wider backfill window', () => {
    const backfill = {
      observedFromMs: new Date(2026, 0, 1, 0, 0, 0, 0).getTime(),
      observedToMs: new Date(2026, 5, 11, 23, 59, 59, 999).getTime(),
      now: noon(2026, 6, 11)
    }
    const records = [
      record('codex', noon(2026, 1, 5), 4242),
      record('claude', noon(2026, 6, 10), 100)
    ]
    const once = foldUsageRecordsIntoDailyRollup({}, records, backfill)
    const twice = foldUsageRecordsIntoDailyRollup(once, records, backfill)
    expect(twice).toEqual(once)
  })

  it('prunes to the retention ceiling while folding', () => {
    const base: DailyUsageDays = {}
    for (const key of dailyUsageDayKeyRange(noon(2026, 6, 10), DAILY_USAGE_ROLLUP_MAX_DAYS + 40)) {
      base[key] = { codex: { tokens: 1, runs: 1 } }
    }
    const folded = foldUsageRecordsIntoDailyRollup(base, [], {
      observedFromMs: noon(2026, 6, 10),
      observedToMs: noon(2026, 6, 10),
      now: noon(2026, 6, 10)
    })
    expect(Object.keys(folded).length).toBe(DAILY_USAGE_ROLLUP_MAX_DAYS)
  })
})

describe('pruneDailyUsageRollupDays', () => {
  it('keeps the newest days and drops the oldest', () => {
    const days: DailyUsageDays = {
      '2026-06-08': { codex: { tokens: 1, runs: 1 } },
      '2026-06-09': { codex: { tokens: 2, runs: 1 } },
      '2026-06-10': { codex: { tokens: 3, runs: 1 } }
    }
    const pruned = pruneDailyUsageRollupDays(days, noon(2026, 6, 10), 2)
    expect(Object.keys(pruned).sort()).toEqual(['2026-06-09', '2026-06-10'])
  })

  it('drops future-dated days so a clock roll-back cannot strand them', () => {
    const days: DailyUsageDays = {
      '2026-06-10': { codex: { tokens: 3, runs: 1 } },
      '2027-01-01': { codex: { tokens: 9, runs: 1 } }
    }
    const pruned = pruneDailyUsageRollupDays(days, noon(2026, 6, 10), 400)
    expect(Object.keys(pruned)).toEqual(['2026-06-10'])
  })

  it('drops unparseable keys', () => {
    const days = { garbage: { codex: { tokens: 1, runs: 1 } } } as unknown as DailyUsageDays
    expect(pruneDailyUsageRollupDays(days, noon(2026, 6, 10), 400)).toEqual({})
  })
})

describe('day totals and dominance', () => {
  it('sums tokens and runs across providers', () => {
    const totals = { codex: { tokens: 100, runs: 2 }, claude: { tokens: 40, runs: 3 } }
    expect(dailyUsageDayTokens(totals)).toBe(140)
    expect(dailyUsageDayRuns(totals)).toBe(5)
    expect(dailyUsageDayTokens(undefined)).toBe(0)
    expect(dailyUsageDayRuns(undefined)).toBe(0)
  })

  it('gives the accent to the provider with the most tokens', () => {
    const totals = { codex: { tokens: 100, runs: 2 }, claude: { tokens: 900, runs: 1 } }
    expect(dominantProviderForDay(totals, ORDER)).toBe('claude')
  })

  it('breaks an exact tie by the declared order, not by object key order', () => {
    const totals = { grok: { tokens: 500, runs: 1 }, codex: { tokens: 500, runs: 1 } }
    expect(dominantProviderForDay(totals, ORDER)).toBe('codex')
  })

  it('lets an unranked provider win outright so a new seat is never invisible', () => {
    const totals = { codex: { tokens: 10, runs: 1 }, mistral: { tokens: 4000, runs: 1 } }
    expect(dominantProviderForDay(totals, ORDER)).toBe('mistral')
  })

  it('falls back to run counts on a token-less activity day', () => {
    const totals = { cursor: { tokens: 0, runs: 7 }, codex: { tokens: 0, runs: 1 } }
    expect(dominantProviderForDay(totals, ORDER)).toBe('cursor')
  })

  it('returns null for an empty or absent day', () => {
    expect(dominantProviderForDay({}, ORDER)).toBeNull()
    expect(dominantProviderForDay(undefined, ORDER)).toBeNull()
  })
})
