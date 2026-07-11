import { describe, expect, it } from 'vitest'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from './usageAccounting'

describe('usageAccounting', () => {
  it('recognizes current, legacy, and historical Codex cache-inclusive shapes', () => {
    expect(usageInputIncludesCache({ _taskwraith_input_includes_cache: true })).toBe(true)
    expect(usageInputIncludesCache({ _agentbench_input_includes_cache: true })).toBe(true)
    expect(usageInputIncludesCache({ cachedInputTokens: 12 })).toBe(true)
    expect(usageInputIncludesCache({ cached_input_tokens: 12 })).toBe(true)
    expect(usageInputIncludesCache({ cache_read_input_tokens: 12 })).toBe(false)
  })

  it('takes the maximum across aliases instead of adding duplicate counters', () => {
    const stats = {
      cacheReadInputTokens: 40,
      cache_read_input_tokens: 40,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 7,
      cacheWriteTokens: 7
    }

    expect(usageCacheReadInputTokens(stats)).toBe(40)
    expect(usageCacheCreationInputTokens(stats)).toBe(7)
  })
})
