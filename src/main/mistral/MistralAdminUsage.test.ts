import { describe, expect, it, vi } from 'vitest'
import {
  fetchMistralAdminUsage,
  meterSpendFrom,
  parseMistralAdminUsage,
  readCategoryCost,
  type MistralAdminFetch
} from './MistralAdminUsage'

/**
 * The Admin API is Preview + Enterprise-only, so these tests are written against
 * the DOCUMENTED shape rather than a captured live body — see the module header.
 * They therefore lean hard on the fail-closed contract: the parser's job is to
 * refuse rather than to guess, because a fabricated zero on a quota meter reads
 * as "you have spent nothing", which is the worst possible wrong answer.
 */

function ok(body: unknown): MistralAdminFetch {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

function status(code: number): MistralAdminFetch {
  return () => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({}) })
}

describe('readCategoryCost', () => {
  it('reads a bare number', () => {
    expect(readCategoryCost(1.23)).toBe(1.23)
    expect(readCategoryCost(0)).toBe(0)
  })

  it('reads a cost out of an object under any documented-plausible field name', () => {
    expect(readCategoryCost({ cost: 2 })).toBe(2)
    expect(readCategoryCost({ amount: 3 })).toBe(3)
    expect(readCategoryCost({ total_cost: 4 })).toBe(4)
    expect(readCategoryCost({ totalCost: 5 })).toBe(5)
  })

  it('returns null — never 0 — for anything it cannot identify', () => {
    expect(readCategoryCost(undefined)).toBeNull()
    expect(readCategoryCost(null)).toBeNull()
    expect(readCategoryCost('1.23')).toBeNull()
    expect(readCategoryCost({ tokens: 1000 })).toBeNull()
    expect(readCategoryCost(Number.NaN)).toBeNull()
    expect(readCategoryCost(-1)).toBeNull()
  })
})

describe('parseMistralAdminUsage', () => {
  it('reads categories, currency and period from a flat body', () => {
    const parsed = parseMistralAdminUsage({
      chat: 1.5,
      vibe_usage: 2.25,
      ocr: 0.25,
      currency: 'EUR',
      start_date: '2026-07-01',
      end_date: '2026-07-31'
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.totalSpend).toBeCloseTo(4, 6)
    expect(parsed!.vibeSpend).toBeCloseTo(2.25, 6)
    expect(parsed!.currency).toBe('EUR')
    expect(parsed!.periodStart).toBe('2026-07-01')
    expect(parsed!.periodEnd).toBe('2026-07-31')
  })

  it('finds categories nested under an envelope, since the docs do not say which', () => {
    const parsed = parseMistralAdminUsage({
      currency: 'USD',
      usage: { chat: { cost: 1 }, vibe_usage: { cost: 3 } }
    })
    expect(parsed!.totalSpend).toBeCloseTo(4, 6)
    expect(parsed!.vibeSpend).toBeCloseTo(3, 6)
  })

  it('prefers an explicit period total over summing what it recognised', () => {
    // The total accounts for categories this parser may not know about.
    const parsed = parseMistralAdminUsage({ chat: 1, vibe_usage: 2, total: 9.5 })
    expect(parsed!.totalSpend).toBeCloseTo(9.5, 6)
    expect(parsed!.vibeSpend).toBeCloseTo(2, 6)
  })

  it('returns null for a body with no identifiable figure at all', () => {
    // THE fail-closed case. Returning {totalSpend: 0} here would render as
    // "nothing spent this month" against a real allowance.
    expect(parseMistralAdminUsage({ message: 'no data' })).toBeNull()
    expect(parseMistralAdminUsage({ usage: { unknown_category: 5 } })).toBeNull()
    expect(parseMistralAdminUsage(null)).toBeNull()
    expect(parseMistralAdminUsage('nope')).toBeNull()
    expect(parseMistralAdminUsage([])).toBeNull()
  })

  it('does not invent a currency it was not given', () => {
    expect(parseMistralAdminUsage({ chat: 1 })!.currency).toBeUndefined()
  })

  it('keeps a genuine zero when the vendor actually reported one', () => {
    const parsed = parseMistralAdminUsage({ chat: 0, vibe_usage: 0, currency: 'EUR' })
    expect(parsed).not.toBeNull()
    expect(parsed!.totalSpend).toBe(0)
  })
})

describe('meterSpendFrom', () => {
  it('meters the PERIOD TOTAL, because the allowance is a shared pool', () => {
    // Studio and raw-API spend draw on the same budget that stops the Vibe seat,
    // so metering vibe_usage alone would under-report the real wall.
    const usage = parseMistralAdminUsage({ chat: 5, vibe_usage: 2, currency: 'EUR' })!
    expect(meterSpendFrom(usage)).toBeCloseTo(7, 6)
    expect(usage.vibeSpend).toBeCloseTo(2, 6)
  })
})

describe('fetchMistralAdminUsage', () => {
  const KEY = 'admin-key'

  it('reports no-key without making a request — the normal non-Enterprise state', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchMistralAdminUsage({ apiKey: '  ', fetchImpl: fetchImpl as never })
    expect(result).toEqual({ ok: false, failure: 'no-key' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends x-api-key (not a bearer token) and the current UTC period', async () => {
    const fetchImpl = vi.fn(ok({ vibe_usage: 1, currency: 'EUR' }))
    await fetchMistralAdminUsage({
      apiKey: KEY,
      now: new Date('2026-07-27T00:00:00.000Z'),
      fetchImpl: fetchImpl as never
    })
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.mistral.ai/v1/admin/usage?month=7&year=2026')
    expect(init.headers['x-api-key']).toBe(KEY)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('maps 401/403 to unauthorized — the expected answer for a non-admin key', async () => {
    for (const code of [401, 403]) {
      const result = await fetchMistralAdminUsage({
        apiKey: KEY,
        fetchImpl: status(code) as never
      })
      expect(result).toEqual({ ok: false, failure: 'unauthorized', status: code })
    }
  })

  it('distinguishes rate-limiting from other HTTP failures', async () => {
    expect(await fetchMistralAdminUsage({ apiKey: KEY, fetchImpl: status(429) as never })).toEqual({
      ok: false,
      failure: 'rate-limited',
      status: 429
    })
    expect(await fetchMistralAdminUsage({ apiKey: KEY, fetchImpl: status(500) as never })).toEqual({
      ok: false,
      failure: 'http-error',
      status: 500
    })
  })

  it('never throws on a network failure', async () => {
    const boom: MistralAdminFetch = () => Promise.reject(new Error('ENOTFOUND'))
    await expect(
      fetchMistralAdminUsage({ apiKey: KEY, fetchImpl: boom as never })
    ).resolves.toEqual({ ok: false, failure: 'unreachable' })
  })

  it('reports unparseable rather than a zero when a 200 body makes no sense', async () => {
    const result = await fetchMistralAdminUsage({
      apiKey: KEY,
      fetchImpl: ok({ message: 'nothing here' }) as never
    })
    expect(result).toEqual({ ok: false, failure: 'unparseable', status: 200 })
  })

  it('surfaces a parsed reading on success', async () => {
    const result = await fetchMistralAdminUsage({
      apiKey: KEY,
      fetchImpl: ok({ vibe_usage: 3.27, chat: 0, currency: 'EUR', end_date: '2026-07-31' }) as never
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.usage.totalSpend).toBeCloseTo(3.27, 6)
      expect(result.usage.currency).toBe('EUR')
    }
  })
})
