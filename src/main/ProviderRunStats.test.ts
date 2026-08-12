import { describe, expect, it } from 'vitest'
import {
  codexUsageToStats,
  cursorCostRateModel,
  cursorUsageToStats,
  extractProviderUsage,
  geminiUsageMetadataToStats,
  mergeProviderUsage
} from './ProviderRunStats'
import { TASKWRAITH_CONTEXT_USAGE_KEY } from '../shared/contextUsage'

describe('ProviderRunStats', () => {
  it('normalizes Codex token snapshots into canonical run stats', () => {
    expect(
      codexUsageToStats(
        {
          last: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          modelContextWindow: 200_000
        },
        1500
      )
    ).toMatchObject({
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      totalTokenLimit: 200_000,
      duration_ms: 1500
    })
  })

  it('preserves Codex last-invocation context beside its canonical counters', () => {
    expect(
      codexUsageToStats({
        last: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
        total: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }
      })
    ).toMatchObject({
      [TASKWRAITH_CONTEXT_USAGE_KEY]: {
        contextTokens: 100,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })
  })

  it('keeps a Codex provider snapshot receipt time stable when terminal stats re-project it', () => {
    const providerSnapshot = {
      last: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
      total: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }
    }
    const live = codexUsageToStats(providerSnapshot, 0, 100)
    const terminal = codexUsageToStats(providerSnapshot, 500, 300)
    const nextProviderSnapshot = codexUsageToStats(
      {
        last: { inputTokens: 30, outputTokens: 5, totalTokens: 35 }
      },
      0,
      400
    )

    expect(live[TASKWRAITH_CONTEXT_USAGE_KEY]).toMatchObject({ observedAt: 100 })
    expect(terminal[TASKWRAITH_CONTEXT_USAGE_KEY]).toMatchObject({ observedAt: 100 })
    expect(nextProviderSnapshot[TASKWRAITH_CONTEXT_USAGE_KEY]).toMatchObject({
      observedAt: 400
    })
  })

  it('recognizes Codex cachedInputTokens as a subset of canonical input', () => {
    expect(
      codexUsageToStats({
        last: {
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 10,
          totalTokens: 110
        }
      })
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cachedInputTokens: 40,
      _taskwraith_input_includes_cache: true
    })
  })

  it('recognizes the Codex snake_case cached-input subset alias', () => {
    expect(
      codexUsageToStats({
        last: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 10,
          total_tokens: 110
        }
      })
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cache_read_input_tokens: 40,
      _taskwraith_input_includes_cache: true
    })
  })

  it('normalizes Cursor fresh and cached input into cache-inclusive canonical totals', () => {
    expect(
      cursorUsageToStats(
        {
          inputTokens: 8_129,
          outputTokens: 834,
          cacheReadTokens: 29_056,
          cacheWriteTokens: 12
        },
        900
      )
    ).toMatchObject({
      input_tokens: 37_197,
      output_tokens: 834,
      total_tokens: 38_031,
      cache_read_input_tokens: 29_056,
      cache_creation_input_tokens: 12,
      duration_ms: 900,
      _taskwraith_input_includes_cache: true
    })
  })

  it('stamps Cursor Grok 4.6 usage with its standard or Fast cost-rate row', () => {
    expect(cursorCostRateModel('grok-4.6')).toBe('grok-4.6')
    expect(cursorCostRateModel('grok-4.6', true)).toBe('grok-4.6-fast')
    expect(cursorCostRateModel('cursor-grok-4.6-xhigh-fast')).toBe('grok-4.6-fast')
    expect(cursorCostRateModel('cursor-grok-4.6-high', true)).toBe('grok-4.6-fast')
    expect(cursorCostRateModel('grok-4.5', true)).toBeUndefined()
    expect(cursorCostRateModel('composer-2.5-fast', true)).toBeUndefined()

    expect(
      cursorUsageToStats(
        { inputTokens: 20, outputTokens: 5 },
        100,
        cursorCostRateModel('grok-4.6', true)
      )
    ).toMatchObject({
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      _taskwraith_cost_rate_model: 'grok-4.6-fast'
    })
  })

  it('extracts and canonicalizes Claude-style usage payloads', () => {
    expect(
      extractProviderUsage('claude', {
        message: {
          usage: {
            input_tokens: 17,
            output_tokens: 9
          }
        }
      })
    ).toMatchObject({
      input_tokens: 17,
      output_tokens: 9,
      total_tokens: 26
    })
  })

  it('preserves cache-separate inputs and marks canonical input as cache-inclusive', () => {
    expect(
      extractProviderUsage('claude', {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 3,
          output_tokens: 2
        }
      })
    ).toMatchObject({
      input_tokens: 17,
      output_tokens: 2,
      total_tokens: 19,
      _taskwraith_input_includes_cache: true
    })
  })

  it('does not add cache fields again after stats are already canonicalized', () => {
    expect(
      extractProviderUsage('claude', {
        stats: {
          input_tokens: 17,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 3,
          output_tokens: 2,
          _taskwraith_input_includes_cache: true
        }
      })
    ).toMatchObject({
      input_tokens: 17,
      output_tokens: 2,
      total_tokens: 19,
      _taskwraith_input_includes_cache: true
    })
  })

  it('honors the legacy cache-inclusive marker and promotes it to the current marker', () => {
    expect(
      extractProviderUsage('claude', {
        stats: {
          input_tokens: 17,
          cache_read_input_tokens: 7,
          output_tokens: 2,
          _agentbench_input_includes_cache: true
        }
      })
    ).toMatchObject({
      input_tokens: 17,
      output_tokens: 2,
      total_tokens: 19,
      _agentbench_input_includes_cache: true,
      _taskwraith_input_includes_cache: true
    })
  })

  it('extracts and canonicalizes Kimi input_other payloads', () => {
    expect(
      extractProviderUsage('kimi', {
        params: {
          token_usage: {
            input_other: 31,
            output_tokens: 11
          }
        }
      })
    ).toMatchObject({
      input_tokens: 31,
      output_tokens: 11,
      total_tokens: 42,
      _taskwraith_input_includes_cache: true
    })
  })

  it('keeps Kimi canonical input stable across extract then merge normalization', () => {
    const extracted = extractProviderUsage('kimi', {
      params: {
        token_usage: {
          input_other: 31,
          input_cache_read: 7,
          output_tokens: 11
        }
      }
    })
    const merged = mergeProviderUsage('kimi', undefined, extracted)

    expect(extracted).toMatchObject({
      input_tokens: 38,
      output_tokens: 11,
      total_tokens: 49,
      _taskwraith_input_includes_cache: true
    })
    expect(merged).toMatchObject({
      input_tokens: 38,
      output_tokens: 11,
      total_tokens: 49,
      _taskwraith_input_includes_cache: true
    })
  })

  it('merges cumulative snapshots without double-counting repeated updates', () => {
    const first = mergeProviderUsage('claude', undefined, {
      input_tokens: 10,
      output_tokens: 2
    })
    const second = mergeProviderUsage('claude', first, {
      input_tokens: 12,
      output_tokens: 3
    })
    const repeated = mergeProviderUsage('claude', second, {
      input_tokens: 12,
      output_tokens: 3
    })

    expect(repeated).toMatchObject({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15
    })
  })

  it('keeps Claude aggregate spend and latest atomic context as separate facts', () => {
    const first = extractProviderUsage('claude', {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 80_000,
          cache_creation_input_tokens: 10_000,
          output_tokens: 4_000
        }
      }
    })
    const second = extractProviderUsage('claude', {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 2_000,
          output_tokens: 800
        }
      }
    })
    const merged = mergeProviderUsage('claude', first || undefined, second)

    expect(merged).toMatchObject({
      // Billing maxima remain useful to the run tally.
      input_tokens: 92_002,
      output_tokens: 4_000,
      [TASKWRAITH_CONTEXT_USAGE_KEY]: {
        // Window occupancy is the internally coherent second invocation.
        contextTokens: 92_802,
        outputTokens: 800,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })
  })

  it('does not let a Claude terminal aggregate overwrite the last atomic context', () => {
    const atomic = extractProviderUsage('claude', {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 2_000,
          output_tokens: 800
        }
      }
    })
    const terminal = extractProviderUsage('claude', {
      type: 'result',
      usage: {
        input_tokens: 30,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 9_000
      }
    })
    const merged = mergeProviderUsage('claude', atomic || undefined, terminal)

    expect(merged?.[TASKWRAITH_CONTEXT_USAGE_KEY]).toMatchObject({
      contextTokens: 92_802,
      outputTokens: 800
    })
  })

  it('keeps the peak cache snapshots alongside peak canonical usage', () => {
    const first = mergeProviderUsage('claude', undefined, {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      _taskwraith_input_includes_cache: true
    })
    const merged = mergeProviderUsage('claude', first, {
      input_tokens: 90,
      output_tokens: 25,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      _taskwraith_input_includes_cache: true
    })

    expect(merged).toMatchObject({
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10
    })
  })

  it('maps Gemini API usage metadata and marks already-recorded stats', () => {
    expect(
      geminiUsageMetadataToStats(
        {
          promptTokenCount: 21,
          candidatesTokenCount: 13,
          totalTokenCount: 34
        },
        2200,
        { alreadyRecorded: true }
      )
    ).toMatchObject({
      promptTokenCount: 21,
      candidatesTokenCount: 13,
      totalTokenCount: 34,
      input_tokens: 21,
      output_tokens: 13,
      total_tokens: 34,
      duration_ms: 2200,
      _taskwraith_usage_recorded: true
    })
  })

  it('keeps Gemini last-call thoughts and cache in an exact context snapshot', () => {
    expect(
      geminiUsageMetadataToStats({
        promptTokenCount: 1_000,
        cachedContentTokenCount: 700,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 120,
        totalTokenCount: 1_200,
        toolUsePromptTokenCount: 250
      })
    ).toMatchObject({
      [TASKWRAITH_CONTEXT_USAGE_KEY]: {
        contextTokens: 1_200,
        cacheReadInputTokens: 700,
        visibleOutputTokens: 80,
        reasoningTokens: 120,
        toolUsePromptTokens: 250,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })
  })

  it('marks incomplete Gemini metadata as derived when no provider total proves coverage', () => {
    expect(
      geminiUsageMetadataToStats({
        promptTokenCount: 1_000,
        cachedContentTokenCount: 700
      })
    ).toMatchObject({
      [TASKWRAITH_CONTEXT_USAGE_KEY]: {
        contextTokens: 1_000,
        cacheReadInputTokens: 700,
        source: 'provider-last-invocation',
        precision: 'derived'
      }
    })
  })

  it('maps legacy cached content metadata into cache read stats without double-counting input', () => {
    expect(
      geminiUsageMetadataToStats({
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 10,
        totalTokenCount: 110
      })
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cache_read_input_tokens: 40,
      _taskwraith_input_includes_cache: true
    })
  })

  it('includes Gemini thinking tokens when deriving a missing total', () => {
    expect(
      geminiUsageMetadataToStats({
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 25
      })
    ).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 135
    })
  })
})
