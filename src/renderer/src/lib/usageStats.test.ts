import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from './GeminiAdapter'
import {
  extractModelUsageEntriesFromStats,
  extractUsageCountsFromCandidate,
  isProviderExecutionToolEvent
} from './usageStats'

describe('usageStats', () => {
  it('does not count provider thinking traces as execution tool events', () => {
    const event: NormalizedEvent = {
      type: 'tool_event',
      name: 'cursor_thinking',
      data: {
        type: 'tool_result',
        tool_name: 'cursor_thinking',
        output: 'Thinking through the task.'
      },
      timestamp: '2026-07-05T19:00:00.000Z',
      isUse: false,
      isResult: true
    }

    expect(isProviderExecutionToolEvent(event)).toBe(false)
  })

  it('still counts normal tool events as execution tool events', () => {
    const event: NormalizedEvent = {
      type: 'tool_event',
      name: 'read_file',
      data: {
        type: 'tool_use',
        tool_name: 'read_file',
        parameters: { path: 'README.md' }
      },
      timestamp: '2026-07-05T19:00:00.000Z',
      isUse: true,
      isResult: false
    }

    expect(isProviderExecutionToolEvent(event)).toBe(true)
  })

  it('splits normalized cache-inclusive input for persisted usage', () => {
    expect(
      extractModelUsageEntriesFromStats(
        {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 10,
          _taskwraith_input_includes_cache: true
        },
        'claude-sonnet'
      )
    ).toEqual([
      expect.objectContaining({
        inputTokens: 20,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 10,
        outputTokens: 40,
        totalTokens: 140
      })
    ])
  })

  it('keeps Cursor-style fresh input separate from cache read/write aliases', () => {
    expect(
      extractModelUsageEntriesFromStats(
        {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 50,
          cacheReadTokens: 30,
          cacheWriteTokens: 3
        },
        'cursor-composer'
      )
    ).toEqual([
      expect.objectContaining({
        inputTokens: 12,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 3,
        outputTokens: 5,
        totalTokens: 50
      })
    ])
  })

  it('preserves the projected cost-rate model on a Cursor usage entry', () => {
    expect(
      extractModelUsageEntriesFromStats(
        {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 25,
          _taskwraith_cost_rate_model: ' grok-4.6-fast '
        },
        'grok-4.6'
      )
    ).toEqual([
      expect.objectContaining({
        model: 'grok-4.6',
        costRateModel: 'grok-4.6-fast',
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25
      })
    ])
  })

  it('treats Codex cachedInputTokens as part of reported input', () => {
    expect(
      extractModelUsageEntriesFromStats(
        { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 80 },
        'gpt-codex'
      )
    ).toEqual([
      expect.objectContaining({
        inputTokens: 20,
        cacheReadInputTokens: 80,
        outputTokens: 5,
        totalTokens: 105
      })
    ])
  })

  it('derives model totals from camelCase cache-inclusive input without adding cache again', () => {
    expect(
      extractModelUsageEntriesFromStats(
        { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
        'gpt-codex'
      )
    ).toEqual([
      expect.objectContaining({
        inputTokens: 20,
        cacheReadInputTokens: 80,
        outputTokens: 5,
        totalTokens: 105
      })
    ])
  })

  it('honors the legacy cache-inclusive marker in renderer token extraction', () => {
    expect(
      extractUsageCountsFromCandidate({
        input_tokens: 100,
        cache_read_input_tokens: 80,
        output_tokens: 5,
        _agentbench_input_includes_cache: true
      })
    ).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 })
  })
})
