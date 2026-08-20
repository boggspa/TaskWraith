import { describe, expect, it } from 'vitest'
import {
  resolveOllamaContextBudget,
  resolveOllamaMeasuredContextTokens
} from './OllamaContextBudget'

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
    expect(resolveOllamaContextBudget('qwen3.8:27b-mlx').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('qwen3.5:9b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('nemotron3:33b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('gpt-oss:20b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('ornith:35b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('ornith:9b').maxBlockChars
    )
    expect(resolveOllamaContextBudget('ornith:35b').maxBlockChars).toBeGreaterThanOrEqual(30_000)
    expect(resolveOllamaContextBudget('ornith-1.5:35b')).toEqual(
      resolveOllamaContextBudget('ornith:35b')
    )
    expect(resolveOllamaContextBudget('laguna-xs-2.1:q8_0').maxBlockChars).toBeGreaterThanOrEqual(
      30_000
    )
    expect(resolveOllamaContextBudget('lfm2.5:8b').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('unknown-local:latest').maxBlockChars
    )
    expect(resolveOllamaContextBudget('muse-glimmer:30b-mlx').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('qwen3.5:9b').maxBlockChars
    )
    expect(
      resolveOllamaContextBudget('nemotron-3.5-lightning:30b-mlx').maxBlockChars
    ).toBeGreaterThan(resolveOllamaContextBudget('qwen3.5:9b').maxBlockChars)
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

  it('sizes the six verified tags by their tuned families', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    for (const modelId of ['llama3.1:8b', 'deepseek-r1:8b']) {
      expect(resolveOllamaContextBudget(modelId).maxBlockChars).toBeGreaterThan(
        unknown.maxBlockChars
      )
    }
    expect(resolveOllamaContextBudget('rnj-1').maxTurns).toBeGreaterThan(unknown.maxTurns)
    expect(resolveOllamaContextBudget('llama3.2:3b').maxCharsPerTurn).toBeGreaterThan(
      unknown.maxCharsPerTurn
    )
    expect(resolveOllamaContextBudget('glm-4.7-flash:q4_K_M').maxBlockChars).toBeGreaterThan(
      resolveOllamaContextBudget('deepseek-r1:8b').maxBlockChars
    )
    expect(
      resolveOllamaContextBudget('north-mini-code-1.0:q4_K_M').maxBlockChars
    ).toBeGreaterThanOrEqual(30_000)
  })

  it('uses compact known-family budgets for the lightweight catalog', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    for (const modelId of [
      'ministral-3:3b',
      'granite4:3b',
      'qwen3.5:2b',
      'deepseek-r1:1.5b',
      'nemotron-3-nano:4b',
      'lfm2.5-thinking:1.2b',
      'gemma3:4b'
    ]) {
      expect(resolveOllamaContextBudget(modelId).maxBlockChars).toBeGreaterThan(
        unknown.maxBlockChars
      )
    }
  })

  it('keeps unknown local tags conservative until live model metadata is known', () => {
    const unknown = resolveOllamaContextBudget('unknown-local:latest')
    expect(unknown.maxTurns).toBe(8)
    expect(unknown.maxBlockChars).toBe(6000)
  })
})

describe('resolveOllamaContextBudget — measured daemon window', () => {
  it('widens an unknown tag once its window is MEASURED, not merely assumed', () => {
    // The condition the floor was always waiting on. Absent a measurement the
    // resolver sees the fabricated 262,144 provider default, so it must not scale;
    // a real daemon reading is a fact and may.
    const assumed = resolveOllamaContextBudget('unknown-local:latest')
    const measured = resolveOllamaContextBudget('unknown-local:latest', 262_144)
    expect(assumed.maxBlockChars).toBe(6000)
    expect(measured.maxBlockChars).toBeGreaterThan(assumed.maxBlockChars)
  })

  it('keeps an unknown tag on the floor when the MEASURED window is genuinely small', () => {
    // The case that made scaling-off-a-guess wrong: a real 8K model must not be
    // handed a block sized for 262K.
    expect(resolveOllamaContextBudget('unknown-local:latest', 8_192).maxBlockChars).toBe(6000)
    expect(resolveOllamaContextBudget('unknown-local:latest', 40_960).maxBlockChars).toBe(6000)
  })

  it('never widens an unknown tag beyond the modest measured ceiling', () => {
    // Even a 1M-token measurement stays capped — this arm is for un-tuned models.
    expect(resolveOllamaContextBudget('unknown-local:latest', 1_000_000).maxBlockChars).toBe(12_000)
  })

  it('prefers the measured window over the hand-maintained table for KNOWN families', () => {
    // Deliberately NOT asserted via a model whose table entry is currently wrong —
    // that made the test vacuous the moment the entry was corrected. Instead drive
    // the SAME known tag with measurements above and below its table value and
    // require the block to follow the measurement in both directions, which holds
    // however accurate the table happens to be.
    const fromTable = resolveOllamaContextBudget('qwen3.5:4b')
    expect(resolveOllamaContextBudget('qwen3.5:4b', 400_000).maxBlockChars).toBeGreaterThan(
      fromTable.maxBlockChars
    )
    expect(resolveOllamaContextBudget('qwen3.5:4b', 16_384).maxBlockChars).toBeLessThan(
      fromTable.maxBlockChars
    )
  })

  it('treats non-positive or non-finite measurements as absent', () => {
    const floor = resolveOllamaContextBudget('unknown-local:latest').maxBlockChars
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(resolveOllamaContextBudget('unknown-local:latest', bad).maxBlockChars).toBe(floor)
    }
  })

  it('leaves maxTurns and maxCharsPerTurn at the conservative default for unknown tags', () => {
    // Only the context BLOCK scales; turn counts stay cautious for an un-tuned model.
    const measured = resolveOllamaContextBudget('unknown-local:latest', 262_144)
    expect(measured.maxTurns).toBe(8)
    expect(measured.maxCharsPerTurn).toBe(420)
  })
})

describe('resolveOllamaMeasuredContextTokens', () => {
  const cache = { 'devstral-small-2:24b': 393_216, 'lfm2.5:8b': 128_000 }

  it('reads an exact model id', () => {
    expect(resolveOllamaMeasuredContextTokens(cache, 'devstral-small-2:24b')).toBe(393_216)
  })

  it('matches across the :latest alias, since write and read keys differ', () => {
    // The cache is written under the RESOLVED id and read under the REQUESTED one.
    expect(resolveOllamaMeasuredContextTokens({ 'ornith:latest': 262_144 }, 'ornith')).toBe(262_144)
    expect(resolveOllamaMeasuredContextTokens({ ornith: 262_144 }, 'ornith:latest')).toBe(262_144)
  })

  it('returns undefined rather than zero when nothing is cached', () => {
    // Consumers branch on "measured or not"; a 0 would read as a real window.
    expect(resolveOllamaMeasuredContextTokens(cache, 'never-seen:8b')).toBeUndefined()
    expect(resolveOllamaMeasuredContextTokens(undefined, 'devstral-small-2:24b')).toBeUndefined()
    expect(resolveOllamaMeasuredContextTokens(cache, '')).toBeUndefined()
    expect(resolveOllamaMeasuredContextTokens(cache, null)).toBeUndefined()
  })

  it('ignores corrupt cache entries instead of trusting them', () => {
    const corrupt = { 'a:1b': 0, 'b:2b': -5, 'c:3b': Number.NaN } as Record<string, number>
    expect(resolveOllamaMeasuredContextTokens(corrupt, 'a:1b')).toBeUndefined()
    expect(resolveOllamaMeasuredContextTokens(corrupt, 'b:2b')).toBeUndefined()
    expect(resolveOllamaMeasuredContextTokens(corrupt, 'c:3b')).toBeUndefined()
  })

  it('feeds the budget end to end, so a cached window actually widens an unknown tag', () => {
    const withoutCache = resolveOllamaContextBudget('brand-new:70b')
    const withCache = resolveOllamaContextBudget(
      'brand-new:70b',
      resolveOllamaMeasuredContextTokens({ 'brand-new:70b': 262_144 }, 'brand-new:70b')
    )
    expect(withoutCache.maxBlockChars).toBe(6000)
    expect(withCache.maxBlockChars).toBeGreaterThan(6000)
  })
})
