import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  contextTokensOdometer,
  estimateLiveOutputTokensFromChars,
  LiveThreadTokenTally,
  type LiveThreadTokenTallyProps
} from './LiveThreadTokenTally'
import { formatContextTokens } from '../lib/contextWindows'
import type { ChatTokenTally } from '../lib/threadTokenTally'

function tally(overrides: Partial<ChatTokenTally> = {}): ChatTokenTally {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    explicitCostUsd: 0,
    estimatedCostUsd: 0,
    peakMemoryRssGb: 0,
    ...overrides
  }
}

function render(overrides: Partial<LiveThreadTokenTallyProps>): string {
  const props: LiveThreadTokenTallyProps = {
    baseTally: tally({ inputTokens: 5000, outputTokens: 0, totalTokens: 5000 }),
    currency: 'USD',
    model: 'claude-sonnet-5',
    overestimatePercent: 0,
    provider: 'claude',
    providerRates: {},
    running: true,
    liveOutputTokens: 1200,
    activeRunId: null,
    title: 'Thread usage',
    ...overrides
  }
  return renderToStaticMarkup(createElement(LiveThreadTokenTally, props))
}

describe('estimateLiveOutputTokensFromChars', () => {
  it('approximates four streamed characters per token', () => {
    expect(estimateLiveOutputTokensFromChars(0)).toBe(0)
    expect(estimateLiveOutputTokensFromChars(1)).toBe(1)
    expect(estimateLiveOutputTokensFromChars(4)).toBe(1)
    expect(estimateLiveOutputTokensFromChars(5)).toBe(2)
  })

  it('ignores invalid or negative lengths', () => {
    expect(estimateLiveOutputTokensFromChars(-10)).toBe(0)
    expect(estimateLiveOutputTokensFromChars(Number.NaN)).toBe(0)
  })
})

describe('contextTokensOdometer', () => {
  it('renders sub-1k values as bare integers', () => {
    expect(contextTokensOdometer(0)).toEqual({
      value: 0,
      decimalPlaces: 0,
      suffix: '',
      label: '0'
    })
    expect(contextTokensOdometer(999)).toEqual({
      value: 999,
      decimalPlaces: 0,
      suffix: '',
      label: '999'
    })
  })

  it('rolls thousands as whole "k" units', () => {
    const k = contextTokensOdometer(1500)
    expect(k).toEqual({ value: 2, decimalPlaces: 0, suffix: 'k', label: '2k' })
  })

  it('rolls millions with one decimal below 10M and whole units above', () => {
    expect(contextTokensOdometer(1_500_000)).toEqual({
      value: 15,
      decimalPlaces: 1,
      suffix: 'M',
      label: '1.5M'
    })
    expect(contextTokensOdometer(12_000_000)).toEqual({
      value: 12,
      decimalPlaces: 0,
      suffix: 'M',
      label: '12M'
    })
  })

  it('coerces invalid input to zero', () => {
    expect(contextTokensOdometer(Number.NaN).value).toBe(0)
    expect(contextTokensOdometer(-42).value).toBe(0)
  })

  it('reads identically to formatContextTokens across magnitudes', () => {
    // The odometer split must round exactly like the idle text formatter so the
    // "out" figure does not shift when a run starts / stops.
    for (const n of [0, 42, 999, 1000, 1500, 8499, 999_000, 1_500_000, 12_000_000]) {
      const od = contextTokensOdometer(n)
      const rendered =
        od.decimalPlaces > 0
          ? `${(od.value / 10 ** od.decimalPlaces).toFixed(od.decimalPlaces)}${od.suffix}`
          : `${od.value}${od.suffix}`
      expect(rendered).toBe(formatContextTokens(n))
    }
  })
})

describe('LiveThreadTokenTally render', () => {
  it('rolls the live "out" figure through a DigitOdometer while running', () => {
    const html = render({ running: true, liveOutputTokens: 1200 })
    expect(html).toContain('composer-thread-token-tally')
    expect(html).toContain('is-live')
    expect(html).toContain('5k in / ') // 5000 sealed input, no live snapshot in SSR
    expect(html).toContain('digit-odometer')
    expect(html).toContain('composer-thread-token-out')
    expect(html).toContain(' out')
  })

  it('shows a plain-text number (no odometer) when idle', () => {
    const html = render({
      running: false,
      baseTally: tally({ inputTokens: 5000, outputTokens: 1200, totalTokens: 6200 })
    })
    expect(html).not.toContain('digit-odometer')
    expect(html).toContain('5k in / ')
    expect(html).toContain('1k out')
  })

  it('renders nothing when there is no usage at all', () => {
    const html = render({ running: false, baseTally: tally(), liveOutputTokens: 0 })
    expect(html).toBe('')
  })
})
