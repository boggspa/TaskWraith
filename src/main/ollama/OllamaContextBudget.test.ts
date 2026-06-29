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
  })

  it('keeps unknown local tags conservative until live model metadata is known', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    expect(unknown.maxTurns).toBe(8)
    expect(unknown.maxBlockChars).toBe(6000)
  })
})
