import { describe, expect, it } from 'vitest'
import { quotaPeriodForWindow, quotaPeriodRowLabel } from './quotaPeriods'
import type { ModelUsageProviderId, UsageWindowAggregate } from './usageAggregateTypes'

const window = (
  label: string,
  extra: Partial<UsageWindowAggregate> = {}
): UsageWindowAggregate => ({
  id: 'quota',
  label,
  runs: 0,
  totalTokens: 0,
  limitLabel: '20% used',
  usedPercent: 20,
  ...extra
})

describe('quota period grouping', () => {
  it('collapses overlapping provider words without shortening distinct meter names', () => {
    expect(quotaPeriodRowLabel('MiMo Token Plan', 'Plan Quota')).toBe('MiMo Token Plan Quota')
    expect(quotaPeriodRowLabel('Meta API', 'API usage')).toBe('Meta API usage')
    expect(quotaPeriodRowLabel('Kimi', 'Weekly')).toBe('Kimi Weekly')
  })

  it.each([
    ['codex', 'Spark 5H', 'fiveHour'],
    ['claude', 'Session', 'fiveHour'],
    ['ollama', 'Session usage', 'fiveHour'],
    ['meta', 'Current usage', 'fiveHour'],
    ['antigravity', 'Claude/GPT 5-hour', 'fiveHour'],
    ['devin', 'Daily quota (Chris)', 'daily'],
    ['gemini', '24h', 'daily'],
    ['codex', 'Spark Weekly', 'weekly'],
    ['claude', 'Fable', 'weekly'],
    ['codex', 'Luna Reserve', 'weekly'],
    ['qwen', '7-Day Quota', 'weekly'],
    ['meta', 'Weekly limit', 'weekly'],
    ['kimi', 'Monthly', 'monthlyAndApi'],
    ['cursor', 'Auto + Composer', 'monthlyAndApi'],
    ['mistral', 'Vibe Code usage', 'monthlyAndApi'],
    ['deepseek', 'Credit used', 'monthlyAndApi']
  ] as const)('places %s %s in %s', (provider, label, expected) => {
    expect(quotaPeriodForWindow(provider, window(label))).toBe(expected)
  })

  it('uses explicit period labels before generic provider window kinds', () => {
    expect(quotaPeriodForWindow('qwen', window('7-Day Quota', { windowKind: 'monthly' }))).toBe(
      'weekly'
    )
    expect(quotaPeriodForWindow('muse', window('Spark', { windowKind: 'monthly' }))).toBe(
      'monthlyAndApi'
    )
  })

  it('falls back to structured periods and durations without changing the source window', () => {
    const source = window('Limit', {
      limitWindowSeconds: 86_400,
      remainingPercent: 80,
      valueText: '$1.25'
    })
    const original = structuredClone(source)
    expect(quotaPeriodForWindow('devin', source)).toBe('daily')
    expect(source).toEqual(original)
    expect(quotaPeriodForWindow('kimi', window('Limit', { windowKind: 'session' }))).toBe(
      'fiveHour'
    )
    expect(quotaPeriodForWindow('kimi', window('Limit', { limitWindowSeconds: 604_800 }))).toBe(
      'weekly'
    )
    for (const provider of ['deepseek', 'cerebras', 'openrouter'] as ModelUsageProviderId[]) {
      expect(quotaPeriodForWindow(provider, window('Credit used', { windowKind: 'custom' }))).toBe(
        'monthlyAndApi'
      )
    }
    expect(quotaPeriodForWindow('gemini', window('Model quota', { windowKind: 'custom' }))).toBe(
      'daily'
    )
  })
})
