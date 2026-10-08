import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_CONSOLE_USAGE_ACCOUNT_ID,
  API_USAGE_REPORT_FAILURE_BACKOFF_MS,
  API_USAGE_REPORT_FRESH_TTL_MS,
  OPENAI_API_USAGE_ACCOUNT_ID,
  createApiUsageReportLane,
  utcMonthToDateRange
} from './ApiUsageReportLane'
import type { AnthropicCostReportOutcome } from './AnthropicAdminUsage'
import type { OpenAiCostReportOutcome } from './OpenAiAdminUsage'

const NOW = Date.parse('2026-10-08T01:23:45.000Z')

function anthropicOk(totalUsd: number): AnthropicCostReportOutcome {
  return {
    ok: true,
    report: {
      totalUsd,
      currency: 'USD',
      startingAt: '2026-10-01T00:00:00.000Z',
      endingAt: '2026-10-08T01:23:00.000Z',
      bucketCount: 8,
      lineItemCount: 3
    }
  }
}

function openAiOk(total: number, projectId: string | null = null): OpenAiCostReportOutcome {
  return {
    ok: true,
    report: {
      total,
      currency: 'USD',
      startTime: '2026-10-01T00:00:00.000Z',
      endTime: '2026-10-08T01:23:00.000Z',
      bucketCount: 8,
      lineItemCount: 2,
      projectId
    }
  }
}

describe('utcMonthToDateRange', () => {
  it('spans the UTC calendar month to the current minute and names the next reset', () => {
    expect(utcMonthToDateRange(NOW)).toEqual({
      startMs: Date.parse('2026-10-01T00:00:00.000Z'),
      endMs: Date.parse('2026-10-08T01:23:00.000Z'),
      nextResetAt: '2026-11-01T00:00:00.000Z'
    })
    // December rolls into next January.
    expect(utcMonthToDateRange(Date.parse('2026-12-31T23:59:59.000Z')).nextResetAt).toBe(
      '2027-01-01T00:00:00.000Z'
    )
  })
})

describe('createApiUsageReportLane', () => {
  it('emits nothing when no key is stored and never calls a fetcher', async () => {
    const fetchAnthropic = vi.fn()
    const fetchOpenAi = vi.fn()
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => null,
      loadOpenAiKey: () => '   ',
      fetchAnthropic,
      fetchOpenAi,
      now: () => NOW
    })
    await expect(lane.read()).resolves.toEqual([])
    expect(fetchAnthropic).not.toHaveBeenCalled()
    expect(fetchOpenAi).not.toHaveBeenCalled()
  })

  it('projects each report as a fixed-account claude / codex snapshot with one API usage balance', async () => {
    const fetchAnthropic = vi.fn(async () => anthropicOk(12.34))
    const fetchOpenAi = vi.fn(async () => openAiOk(5.67, 'proj_codex'))
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => 'sk-ant-admin01-x',
      loadOpenAiKey: () => 'sk-admin-y',
      getOpenAiProjectId: () => 'proj_codex',
      fetchAnthropic,
      fetchOpenAi,
      now: () => NOW
    })
    const snapshots = await lane.read()
    expect(snapshots).toEqual([
      {
        provider: 'claude',
        source: 'anthropic-admin-usage',
        accountId: ANTHROPIC_CONSOLE_USAGE_ACCOUNT_ID,
        accountLabel: 'Console API',
        configured: true,
        fetchedAt: new Date(NOW).toISOString(),
        stale: false,
        planType: 'Console',
        windows: [],
        balances: [
          {
            id: 'claude-console-api-usage-mtd',
            label: 'API usage',
            amount: 12.34,
            unit: 'USD',
            subtitle: 'Month to date (UTC) · Anthropic Console cost report',
            resetAt: '2026-11-01T00:00:00.000Z'
          }
        ]
      },
      {
        provider: 'codex',
        source: 'openai-admin-usage',
        accountId: OPENAI_API_USAGE_ACCOUNT_ID,
        accountLabel: 'OpenAI API',
        configured: true,
        fetchedAt: new Date(NOW).toISOString(),
        stale: false,
        planType: 'API',
        windows: [],
        balances: [
          {
            id: 'codex-openai-api-usage-mtd',
            label: 'API usage',
            amount: 5.67,
            unit: 'USD',
            subtitle: 'Month to date (UTC) · OpenAI costs, project proj_codex',
            resetAt: '2026-11-01T00:00:00.000Z'
          }
        ]
      }
    ])
    // The fetchers received the month-to-date range and the project id; the
    // key is passed through and never appears on the snapshot.
    expect(fetchAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-ant-admin01-x',
        startingAt: '2026-10-01T00:00:00.000Z',
        endingAt: '2026-10-08T01:23:00.000Z'
      })
    )
    expect(fetchOpenAi).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-admin-y', projectId: 'proj_codex' })
    )
    expect(JSON.stringify(snapshots)).not.toContain('sk-')
  })

  it('serves a fresh report from cache, refetches past the TTL, and invalidates on demand', async () => {
    let clock = NOW
    const fetchAnthropic = vi.fn(async () => anthropicOk(1))
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => 'k',
      loadOpenAiKey: () => null,
      fetchAnthropic,
      fetchOpenAi: vi.fn(),
      now: () => clock
    })
    await lane.read()
    await lane.read()
    expect(fetchAnthropic).toHaveBeenCalledTimes(1)
    clock += API_USAGE_REPORT_FRESH_TTL_MS + 1
    await lane.read()
    expect(fetchAnthropic).toHaveBeenCalledTimes(2)
    lane.invalidate('anthropic')
    await lane.read()
    expect(fetchAnthropic).toHaveBeenCalledTimes(3)
  })

  it('keeps the last report (flagged stale) through a failure and backs off before retrying', async () => {
    let clock = NOW
    const outcomes: AnthropicCostReportOutcome[] = [
      anthropicOk(9.5),
      { ok: false, failure: 'rate-limited', status: 429 }
    ]
    const fetchAnthropic = vi.fn(
      async () => outcomes.shift() ?? ({ ok: false, failure: 'network' } as const)
    )
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => 'k',
      loadOpenAiKey: () => null,
      fetchAnthropic,
      fetchOpenAi: vi.fn(),
      now: () => clock
    })
    expect((await lane.read())[0].balances[0].amount).toBe(9.5)
    clock += API_USAGE_REPORT_FRESH_TTL_MS + 1
    const afterFailure = await lane.read()
    expect(afterFailure[0]).toMatchObject({ stale: true, balances: [{ amount: 9.5 }] })
    expect(afterFailure[0].error).toBeUndefined()
    expect(fetchAnthropic).toHaveBeenCalledTimes(2)
    clock += API_USAGE_REPORT_FAILURE_BACKOFF_MS - 1
    await lane.read()
    expect(fetchAnthropic).toHaveBeenCalledTimes(2)
    clock += 2
    await lane.read()
    expect(fetchAnthropic).toHaveBeenCalledTimes(3)
  })

  it('reports a configured-but-errored snapshot when the first read fails, with a reason the card can show', async () => {
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => null,
      loadOpenAiKey: () => 'sk-project-key',
      fetchAnthropic: vi.fn(),
      fetchOpenAi: vi.fn(
        async () => ({ ok: false, failure: 'unauthorized', status: 403 }) as const
      ),
      now: () => NOW
    })
    const [snapshot] = await lane.read()
    expect(snapshot).toMatchObject({
      provider: 'codex',
      accountId: OPENAI_API_USAGE_ACCOUNT_ID,
      configured: true,
      balances: []
    })
    expect(snapshot.error).toContain('HTTP 403')
    expect(snapshot.error).toContain('admin key')
  })

  it('is single-flight per provider and tolerates a throwing fetcher', async () => {
    let resolveFetch: ((value: AnthropicCostReportOutcome) => void) | null = null
    const fetchAnthropic = vi.fn(
      () =>
        new Promise<AnthropicCostReportOutcome>((resolve) => {
          resolveFetch = resolve
        })
    )
    const lane = createApiUsageReportLane({
      loadAnthropicKey: () => 'k',
      loadOpenAiKey: () => 'k2',
      fetchAnthropic,
      fetchOpenAi: vi.fn(async () => {
        throw new Error('boom')
      }),
      now: () => NOW
    })
    const first = lane.read()
    const second = lane.read()
    await new Promise((resolve) => setImmediate(resolve))
    expect(fetchAnthropic).toHaveBeenCalledTimes(1)
    resolveFetch!(anthropicOk(2))
    const [a, b] = await Promise.all([first, second])
    expect(a[0].balances[0].amount).toBe(2)
    expect(b[0].balances[0].amount).toBe(2)
    // The throwing OpenAI fetcher yields an errored snapshot, not a rejection.
    expect(a[1]).toMatchObject({ provider: 'codex', configured: true, balances: [] })
    expect(a[1].error).toContain('could not be reached')
  })
})
