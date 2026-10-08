import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_ADMIN_API_VERSION,
  ANTHROPIC_COST_REPORT_URL,
  fetchAnthropicCostReport,
  parseAnthropicCostReportPage
} from './AnthropicAdminUsage'

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const RANGE = { startingAt: '2026-10-01T00:00:00Z', endingAt: '2026-10-08T01:00:00Z' }

/** Shape per the Usage & Cost Admin API docs: USD, decimal-string cents. */
function page(results: Array<Record<string, unknown>>, next?: string) {
  return {
    data: [
      { starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z', results },
      { starting_at: '2026-10-02T00:00:00Z', ending_at: '2026-10-03T00:00:00Z', results: [] }
    ],
    has_more: Boolean(next),
    next_page: next ?? null
  }
}

describe('fetchAnthropicCostReport', () => {
  it('sends the admin key and version header and sums decimal-string cents into USD', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      expect(`${parsed.origin}${parsed.pathname}`).toBe(ANTHROPIC_COST_REPORT_URL)
      expect(parsed.searchParams.get('starting_at')).toBe(RANGE.startingAt)
      expect(parsed.searchParams.get('ending_at')).toBe(RANGE.endingAt)
      const headers = init?.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('sk-ant-admin01-secret')
      expect(headers['anthropic-version']).toBe(ANTHROPIC_ADMIN_API_VERSION)
      expect(headers['user-agent']).toContain('TaskWraith')
      return response(
        page([
          {
            currency: 'USD',
            amount: '1234.5',
            description: 'Claude Opus 5.5 Usage - Input Tokens'
          },
          { currency: 'USD', amount: '65.5', description: 'Web Search Usage' }
        ])
      )
    })
    const outcome = await fetchAnthropicCostReport({
      apiKey: 'sk-ant-admin01-secret',
      ...RANGE,
      fetchImpl
    })
    expect(outcome).toEqual({
      ok: true,
      report: {
        totalUsd: 13,
        currency: 'USD',
        startingAt: RANGE.startingAt,
        endingAt: RANGE.endingAt,
        bucketCount: 2,
        lineItemCount: 2
      }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows next_page cursors and stops at the page cap', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const cursor = new URL(url).searchParams.get('page')
      if (!cursor) return response(page([{ amount: '100' }], 'page_2'))
      if (cursor === 'page_2') return response(page([{ amount: '50' }], 'page_3'))
      return response(page([{ amount: '25' }], 'page_4'))
    })
    const outcome = await fetchAnthropicCostReport({
      apiKey: 'k',
      ...RANGE,
      fetchImpl,
      maxPages: 3
    })
    expect(outcome.ok && outcome.report.totalUsd).toBe(1.75)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps auth, rate-limit, other HTTP and network failures to typed outcomes', async () => {
    await expect(
      fetchAnthropicCostReport({ apiKey: 'k', ...RANGE, fetchImpl: async () => response({}, 401) })
    ).resolves.toEqual({ ok: false, failure: 'unauthorized', status: 401 })
    await expect(
      fetchAnthropicCostReport({ apiKey: 'k', ...RANGE, fetchImpl: async () => response({}, 403) })
    ).resolves.toEqual({ ok: false, failure: 'unauthorized', status: 403 })
    await expect(
      fetchAnthropicCostReport({ apiKey: 'k', ...RANGE, fetchImpl: async () => response({}, 429) })
    ).resolves.toEqual({ ok: false, failure: 'rate-limited', status: 429 })
    await expect(
      fetchAnthropicCostReport({ apiKey: 'k', ...RANGE, fetchImpl: async () => response({}, 500) })
    ).resolves.toEqual({ ok: false, failure: 'http', status: 500 })
    await expect(
      fetchAnthropicCostReport({
        apiKey: 'k',
        ...RANGE,
        fetchImpl: async () => {
          throw new Error('offline')
        }
      })
    ).resolves.toEqual({ ok: false, failure: 'network' })
    await expect(fetchAnthropicCostReport({ apiKey: '  ', ...RANGE })).resolves.toEqual({
      ok: false,
      failure: 'no-key'
    })
  })

  it('fails closed on an unreadable amount or non-USD line rather than reporting zero', async () => {
    await expect(
      fetchAnthropicCostReport({
        apiKey: 'k',
        ...RANGE,
        fetchImpl: async () => response(page([{ amount: 'twelve dollars' }]))
      })
    ).resolves.toEqual({ ok: false, failure: 'parse' })
    await expect(
      fetchAnthropicCostReport({
        apiKey: 'k',
        ...RANGE,
        fetchImpl: async () => response('not json')
      })
    ).resolves.toEqual({ ok: false, failure: 'parse' })
    expect(parseAnthropicCostReportPage(page([{ amount: '5', currency: 'EUR' }]))).toBeNull()
    expect(parseAnthropicCostReportPage({ data: 'nope' })).toBeNull()
    // Buckets with no results are fine — an empty month is a real $0.00.
    expect(parseAnthropicCostReportPage({ data: [{ results: [] }] })).toEqual({
      cents: 0,
      bucketCount: 1,
      lineItemCount: 0,
      nextPage: null
    })
  })
})
