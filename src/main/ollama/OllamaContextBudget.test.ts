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
    // `lfm2.5:8b` sits in CONTEXT_WINDOWS_BY_MODEL as 131_072 while the daemon
    // reports 128_000. The measured value must win, so the table can drift without
    // silently mis-sizing the block.
    const fromTable = resolveOllamaContextBudget('lfm2.5:8b')
    const fromDaemon = resolveOllamaContextBudget('lfm2.5:8b', 128_000)
    expect(fromDaemon.maxBlockChars).toBeLessThanOrEqual(fromTable.maxBlockChars)
    // A drastically smaller measurement must actually shrink the block.
    expect(
      resolveOllamaContextBudget('lfm2.5:8b', 16_384).maxBlockChars
    ).toBeLessThan(fromTable.maxBlockChars)
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
