import { describe, expect, it, vi } from 'vitest'
import { buildMistralWebReport, createMistralWebUsageLane } from './MistralWebUsage'
import type { MistralWebSubscriptionResult } from './MistralWebSubscriptionClient'

const SUMMARY: MistralWebSubscriptionResult = {
  planName: 'Pro',
  apiSpent: 0.28,
  apiAllowance: 25.5,
  vibeSpent: 21.3,
  vibeAllowance: 255,
  currency: 'EUR',
  periodEnd: new Date('2026-08-22T12:00:00.000Z')
}

/** Deterministic FX for tests: EUR at the static-table rate, USD passthrough. */
const convert = (amount: number, currency?: string): number =>
  currency === 'EUR' ? amount / 0.92 : amount

const NOW = new Date('2026-08-18T12:00:00.000Z')

describe('buildMistralWebReport', () => {
  it('meters the VIBE bar and carries the API bar as display-only apiUsage', () => {
    const report = buildMistralWebReport(SUMMARY, NOW, convert)
    expect(report).not.toBeNull()
    // Spend/ceiling are the Vibe Code budget — the pool this seat spends from.
    expect(report?.spentUsd).toBeCloseTo(21.3 / 0.92, 6)
    expect(report?.allowanceUsd).toBeCloseTo(255 / 0.92, 6)
    expect(report?.fetchedAt).toBe('2026-08-18T12:00:00.000Z')
    expect(report?.periodEnd).toBe('2026-08-22T12:00:00.000Z')
    expect(report?.declared).toEqual({ spent: 21.3, currency: 'EUR' })
    // The API bar rides along verbatim, never merged into the metered figures.
    expect(report?.apiUsage?.spentUsd).toBeCloseTo(0.28 / 0.92, 6)
    expect(report?.apiUsage?.allowanceUsd).toBeCloseTo(25.5 / 0.92, 6)
    expect(report?.apiUsage?.declared).toEqual({ spent: 0.28, allowance: 25.5, currency: 'EUR' })
  })

  it('returns null when the page carried no Vibe figure — nothing to meter against', () => {
    expect(buildMistralWebReport({ currency: 'EUR', apiSpent: 0.28 }, NOW, convert)).toBeNull()
  })

  it('tolerates a Vibe-only page and a missing allowance', () => {
    const report = buildMistralWebReport({ currency: 'USD', vibeSpent: 3 }, NOW, convert)
    expect(report?.spentUsd).toBe(3)
    expect(report?.allowanceUsd).toBeUndefined()
    expect(report?.apiUsage).toBeUndefined()
  })
})

describe('createMistralWebUsageLane', () => {
  function lane(overrides: {
    cookieStatus?: string
    fetchResults?: Array<MistralWebSubscriptionResult | null>
  }) {
    let nowMs = NOW.getTime()
    const fetchSubscription = vi.fn(
      async () => (overrides.fetchResults ?? [SUMMARY]).shift() ?? null
    )
    const setReport = vi.fn(async (_report: unknown, _options?: unknown) => {})
    const created = createMistralWebUsageLane({
      loadCookie: () =>
        overrides.cookieStatus === undefined || overrides.cookieStatus === 'ok'
          ? { status: 'ok', value: 'session=abc' }
          : { status: overrides.cookieStatus },
      setReport,
      fetchSubscription,
      convertToUsd: convert,
      now: () => new Date(nowMs)
    })
    return {
      lane: created,
      setReport,
      fetchSubscription,
      advance: (ms: number) => {
        nowMs += ms
      },
      settle: () => new Promise((resolve) => setImmediate(resolve))
    }
  }

  it('absorbs a fetched reading as a cycle-starting report, at most once per TTL', async () => {
    const t = lane({ fetchResults: [SUMMARY, SUMMARY] })
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)
    expect(t.setReport).toHaveBeenCalledTimes(1)
    expect(t.setReport.mock.calls[0][1]).toEqual({ startCycleIfMissing: true })

    // Within the TTL nothing refetches.
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)

    // Past the TTL it does.
    t.advance(5 * 60 * 1000 + 1)
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(2)
  })

  it('retries a failed read on the shorter backoff', async () => {
    const t = lane({ fetchResults: [null, SUMMARY] })
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.setReport).not.toHaveBeenCalled()

    // Still inside the failure backoff: no refetch.
    t.advance(30 * 1000)
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(1)

    t.advance(31 * 1000)
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).toHaveBeenCalledTimes(2)
    expect(t.setReport).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a stored session', async () => {
    const t = lane({ cookieStatus: 'missing' })
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).not.toHaveBeenCalled()
  })

  it('absorbSummary records the import immediately and satisfies the next TTL window', async () => {
    const t = lane({})
    await t.lane.absorbSummary(SUMMARY)
    expect(t.setReport).toHaveBeenCalledTimes(1)

    // The import counts as a fresh read — the next poll must not refetch.
    t.lane.maybeRefresh()
    await t.settle()
    expect(t.fetchSubscription).not.toHaveBeenCalled()
  })
})
