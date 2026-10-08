import { describe, expect, it, vi } from 'vitest'
import { OPENAI_COSTS_URL, fetchOpenAiCostReport, parseOpenAiCostPage } from './OpenAiAdminUsage'

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const START = Date.parse('2026-10-01T00:00:00.000Z')
const END = Date.parse('2026-10-08T01:00:00.000Z')

/** Shape as Limit Counter decodes it live: amount.value in dollars. */
function page(results: Array<Record<string, unknown>>, next?: string) {
  return {
    object: 'page',
    data: [
      { object: 'bucket', start_time: START / 1000, end_time: START / 1000 + 86_400, results },
      { object: 'bucket', start_time: START / 1000 + 86_400, end_time: START / 1000 + 172_800 }
    ],
    has_more: Boolean(next),
    next_page: next ?? null
  }
}

describe('fetchOpenAiCostReport', () => {
  it('sends a bearer admin key with unix-second bounds and sums dollar amounts', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      expect(`${parsed.origin}${parsed.pathname}`).toBe(OPENAI_COSTS_URL)
      expect(parsed.searchParams.get('start_time')).toBe(String(START / 1000))
      expect(parsed.searchParams.get('end_time')).toBe(String(END / 1000))
      expect(parsed.searchParams.get('bucket_width')).toBe('1d')
      expect(parsed.searchParams.get('limit')).toBe('31')
      expect(parsed.searchParams.get('project_ids')).toBe('proj_codex')
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer sk-admin-secret')
      return response(
        page([
          {
            object: 'organization.costs.result',
            amount: { value: 4.25, currency: 'usd' },
            line_item: 'gpt-5-codex, input',
            project_id: 'proj_codex'
          },
          { amount: { value: '1.5', currency: 'usd' }, line_item: 'gpt-5-codex, output' }
        ])
      )
    })
    const outcome = await fetchOpenAiCostReport({
      apiKey: 'sk-admin-secret',
      startTimeMs: START,
      endTimeMs: END,
      projectId: ' proj_codex ',
      fetchImpl
    })
    expect(outcome).toEqual({
      ok: true,
      report: {
        total: 5.75,
        currency: 'USD',
        startTime: '2026-10-01T00:00:00.000Z',
        endTime: '2026-10-08T01:00:00.000Z',
        bucketCount: 2,
        lineItemCount: 2,
        projectId: 'proj_codex'
      }
    })
  })

  it('omits project_ids when none is configured and paginates on next_page', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      expect(parsed.searchParams.has('project_ids')).toBe(false)
      const cursor = parsed.searchParams.get('page')
      return cursor
        ? response(page([{ amount: { value: 1 } }]))
        : response(page([{ amount: { value: 2 } }], 'cursor_1'))
    })
    const outcome = await fetchOpenAiCostReport({
      apiKey: 'k',
      startTimeMs: START,
      endTimeMs: END,
      fetchImpl
    })
    expect(outcome.ok && outcome.report).toMatchObject({
      total: 3,
      currency: 'USD',
      projectId: null
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('maps failures to typed outcomes and fails closed on unreadable or mixed-currency amounts', async () => {
    const base = { apiKey: 'k', startTimeMs: START, endTimeMs: END }
    await expect(
      fetchOpenAiCostReport({ ...base, fetchImpl: async () => response({}, 401) })
    ).resolves.toEqual({ ok: false, failure: 'unauthorized', status: 401 })
    await expect(
      fetchOpenAiCostReport({ ...base, fetchImpl: async () => response({}, 429) })
    ).resolves.toEqual({ ok: false, failure: 'rate-limited', status: 429 })
    await expect(
      fetchOpenAiCostReport({ ...base, fetchImpl: async () => response({}, 502) })
    ).resolves.toEqual({ ok: false, failure: 'http', status: 502 })
    await expect(
      fetchOpenAiCostReport({
        ...base,
        fetchImpl: async () => {
          throw new Error('offline')
        }
      })
    ).resolves.toEqual({ ok: false, failure: 'network' })
    await expect(fetchOpenAiCostReport({ ...base, apiKey: '' })).resolves.toEqual({
      ok: false,
      failure: 'no-key'
    })
    await expect(
      fetchOpenAiCostReport({
        ...base,
        fetchImpl: async () => response(page([{ amount: { value: 'lots' } }]))
      })
    ).resolves.toEqual({ ok: false, failure: 'parse' })
    expect(
      parseOpenAiCostPage(
        page([{ amount: { value: 1, currency: 'usd' } }, { amount: { value: 1, currency: 'eur' } }])
      )
    ).toBeNull()
    expect(parseOpenAiCostPage(page([{ line_item: 'no amount' }]))).toBeNull()
    expect(parseOpenAiCostPage({ data: [] })).toEqual({
      total: 0,
      currency: null,
      bucketCount: 0,
      lineItemCount: 0,
      nextPage: null
    })
  })
})
