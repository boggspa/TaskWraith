import { describe, expect, it } from 'vitest'
import { resolveOllamaContextBudget } from './OllamaContextBudget'

describe('resolveOllamaContextBudget', () => {
  it('keeps Qwen 4B below GPT-OSS while no longer starving it', () => {
    const qwen = resolveOllamaContextBudget('qwen3:4b-instruct')
    const oss = resolveOllamaContextBudget('gpt-oss:20b')
    expect(qwen.maxBlockChars).toBeGreaterThanOrEqual(10_000)
    expect(qwen.maxBlockChars).toBeLessThan(oss.maxBlockChars)
    expect(qwen.maxTurns).toBeLessThanOrEqual(oss.maxTurns)
  })

  it('uses larger context summaries for stronger local reasoning tags', () => {
    expect(resolveOllamaContextBudget('qwen3.6:35b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('qwen3.5:9b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('nemotron3:33b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('gpt-oss:20b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('ornith:35b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('ornith:9b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('ornith:35b').maxBlockChars).toBeGreaterThanOrEqual(30_000)
    expect(resolveOllamaContextBudget('laguna-xs-2.1:q8_0').maxBlockChars).toBeGreaterThanOrEqual(
      30_000
    )
    expect(resolveOllamaContextBudget('lfm2.5:8b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('unknown-local:latest').maxBlockChars
    )
  })

  it('sizes the three new local tags by their own class, not the unknown floor', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    // Devstral is the coding tag of the three and gets the large-coding budget;
    // Ministral the mid tier; the 4B Qwen the same lightweight budget as
    // qwen3:4b-instruct.
    expect(resolveOllamaContextBudget('devstral-small-2:24b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('ministral-3:14b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('ministral-3:14b').maxBlockChars).toBeGreaterThan(
      unknown.maxBlockChars
    )
    expect(resolveOllamaContextBudget('qwen3.5:4b')).toEqual(
      resolveOllamaContextBudget('qwen3:4b-instruct')
    )
  })

  it('keeps unknown local tags conservative until live model metadata is known', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    expect(unknown.maxTurns).toBe(8)
    expect(unknown.maxBlockChars).toBe(6000)
  })
})
