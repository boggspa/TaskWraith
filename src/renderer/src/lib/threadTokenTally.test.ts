import { describe, expect, it } from 'vitest'
import type { ChatRun } from '../../../main/store/types'
import { buildChatTokenTally, formatTallySuffix, tallyCostUsd } from './threadTokenTally'
import type { RendererProviderRates } from './providerRateEstimate'

function run(stats: Record<string, unknown>, overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'r1',
    provider: 'ollama',
    startedAt: '2026-01-01T00:00:00.000Z',
    stats,
    ...overrides
  } as ChatRun
}

const RATES: RendererProviderRates = {
  codex: [
    {
      modelId: 'gpt-5.5',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cachedInputUsdPerMillion: 0.5
    }
  ]
}

describe('buildChatTokenTally', () => {
  it('tracks the latest Ollama peak RAM across runs', () => {
    const tally = buildChatTokenTally([
      run({ inputTokens: 100, outputTokens: 20, ollamaMemoryPeakRssGb: 2.4 }),
      run({ inputTokens: 50, outputTokens: 10, ollamaMemoryPeakRssGb: 17.2 })
    ])
    expect(tally.inputTokens).toBe(150)
    expect(tally.outputTokens).toBe(30)
    expect(tally.peakMemoryRssGb).toBeCloseTo(17.2)
  })

  it('adds provider-rate estimates for completed runs with no explicit cost', () => {
    const tally = buildChatTokenTally(
      [
        run(
          {
            input_tokens: 1_000_000,
            output_tokens: 100_000
          },
          { provider: 'codex', actualModel: 'gpt-5.5' }
        )
      ],
      { providerRates: RATES }
    )

    expect(tally.explicitCostUsd).toBe(0)
    expect(tally.estimatedCostUsd).toBeCloseTo(8, 6)
    expect(tallyCostUsd(tally)).toBeCloseTo(8, 6)
  })

  it('does not estimate over provider-reported cost', () => {
    const tally = buildChatTokenTally(
      [
        run(
          {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cost_usd: 1.23
          },
          { provider: 'codex', actualModel: 'gpt-5.5' }
        )
      ],
      { providerRates: RATES }
    )

    expect(tally.explicitCostUsd).toBeCloseTo(1.23, 6)
    expect(tally.estimatedCostUsd).toBe(0)
    expect(tallyCostUsd(tally)).toBeCloseTo(1.23, 6)
  })

  it('prices cache reads once at the cached input rate', () => {
    const tally = buildChatTokenTally(
      [
        run(
          {
            input_tokens: 1_000_000,
            cache_read_input_tokens: 4_000_000,
            output_tokens: 0
          },
          { provider: 'codex', requestedModel: 'cli-default' }
        )
      ],
      { providerRates: RATES }
    )

    expect(tally.inputTokens).toBe(5_000_000)
    expect(tally.estimatedCostUsd).toBeCloseTo(7, 6)
  })

  it('prices historical Codex cache-subset stats without adding aliases again', () => {
    const tally = buildChatTokenTally(
      [
        run(
          {
            input_tokens: 1_000_000,
            cachedInputTokens: 800_000,
            cached_input_tokens: 800_000,
            output_tokens: 0
          },
          { provider: 'codex', actualModel: 'gpt-5.5' }
        )
      ],
      { providerRates: RATES }
    )

    expect(tally.inputTokens).toBe(1_000_000)
    expect(tally.totalTokens).toBe(1_000_000)
    expect(tally.estimatedCostUsd).toBeCloseTo(1.4, 6)
  })
})

describe('formatTallySuffix', () => {
  it('shows compact peak RAM for Ollama instead of currency', () => {
    const suffix = formatTallySuffix(
      'ollama',
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        explicitCostUsd: 0,
        peakMemoryRssGb: 17.2
      },
      'GBP',
      0
    )
    expect(suffix).toBe(' · 17.2GB')
  })

  it('keeps currency suffix for non-Ollama providers', () => {
    const suffix = formatTallySuffix(
      'codex',
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        explicitCostUsd: 1.79,
        peakMemoryRssGb: 0
      },
      'GBP',
      0
    )
    expect(suffix).toContain('£')
  })

  it('marks estimated cost with a leading tilde', () => {
    const suffix = formatTallySuffix(
      'codex',
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        explicitCostUsd: 0,
        estimatedCostUsd: 1.79,
        peakMemoryRssGb: 0
      },
      'GBP',
      0
    )
    expect(suffix).toContain('~£')
  })

  it('shows cost and peak RAM together for ensemble/guest dual telemetry', () => {
    const suffix = formatTallySuffix(
      'codex',
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        explicitCostUsd: 1.79,
        peakMemoryRssGb: 41.4
      },
      'GBP',
      0,
      { dualCostAndRam: true }
    )
    expect(suffix).toContain('£')
    expect(suffix).toContain('41.4GB')
  })
})
