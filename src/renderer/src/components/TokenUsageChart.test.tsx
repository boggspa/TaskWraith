import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import {
  buildProviderFilteredTokenUsageChartData,
  buildTokenUsageChartData,
  TokenUsageChart
} from './TokenUsageChart'

const record = (overrides: Partial<UsageRecord>): UsageRecord =>
  ({
    id: overrides.id || 'usage-1',
    timestamp: overrides.timestamp ?? new Date(2026, 5, 15, 12).getTime(),
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'model-1',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  }) as UsageRecord

describe('buildTokenUsageChartData', () => {
  it('buckets usage into local-day token bars and tracks dominant provider', () => {
    const now = new Date(2026, 5, 15, 12)
    const data = buildTokenUsageChartData(
      [
        record({
          id: 'today',
          timestamp: new Date(2026, 5, 15, 9).getTime(),
          provider: 'codex',
          totalTokens: 100
        }),
        record({
          id: 'yesterday',
          timestamp: new Date(2026, 5, 14, 11).getTime(),
          provider: 'claude',
          inputTokens: 40,
          outputTokens: 35
        }),
        record({
          id: 'old',
          timestamp: new Date(2026, 5, 10, 12).getTime(),
          provider: 'gemini',
          totalTokens: 999
        }),
        record({
          id: 'reset',
          timestamp: new Date(2026, 5, 15, 10).getTime(),
          usageKind: 'reset_hint',
          totalTokens: 500
        })
      ],
      now,
      3
    )

    expect(data.days).toHaveLength(3)
    expect(data.days.map((day) => day.tokens)).toEqual([0, 75, 100])
    expect(data.days.map((day) => day.dominantProvider)).toEqual([null, 'claude', 'codex'])
    expect(data.totalTokens).toBe(175)
    expect(data.maxTokens).toBe(100)
  })

  it('filters bars by provider while preserving the all-provider total', () => {
    const now = new Date(2026, 5, 15, 12)
    const data = buildProviderFilteredTokenUsageChartData(
      [
        record({
          id: 'codex',
          timestamp: new Date(2026, 5, 15, 9).getTime(),
          provider: 'codex',
          totalTokens: 100
        }),
        record({
          id: 'claude',
          timestamp: new Date(2026, 5, 15, 10).getTime(),
          provider: 'claude',
          totalTokens: 40
        })
      ],
      now,
      1,
      'codex'
    )

    expect(data.days).toHaveLength(1)
    expect(data.days[0].tokens).toBe(100)
    expect(data.days[0].dominantProvider).toBe('codex')
    expect(data.maxTokens).toBe(100)
    expect(data.totalTokens).toBe(140)
  })
})

describe('TokenUsageChart', () => {
  it('renders provider isolation controls when requested', () => {
    const html = renderToStaticMarkup(
      <TokenUsageChart title="TaskWraith Tokens" records={[]} showProviderFilter />
    )

    for (const label of ['All', 'Codex', 'Claude', 'Gemini', 'Kimi', 'Grok', 'Cursor', 'Ollama']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('TaskWraith Tokens provider filter')
    expect(html).toContain('token-usage-chart--with-provider-filter')
  })
})
