import { describe, expect, it } from 'vitest'
import {
  codexUsageToStats,
  extractProviderUsage,
  geminiUsageMetadataToStats,
  mergeProviderUsage
} from './ProviderRunStats'

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
})
