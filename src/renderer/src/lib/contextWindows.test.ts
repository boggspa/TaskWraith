import { describe, expect, it } from 'vitest'
import { contextPercent, formatContextTokens, resolveContextWindow } from './contextWindows'
import type { ProviderId } from '../../../main/store/types'

describe('resolveContextWindow', () => {
  it('prefers a positive finite stats token limit over model and provider defaults', () => {
    expect(resolveContextWindow('codex', 'gpt-5.5', 123_456)).toBe(123_456)
  })

  it('ignores invalid stats token limits and falls back to known model windows', () => {
    expect(resolveContextWindow('codex', 'gpt-5.3-codex-spark', 0)).toBe(200_000)
    expect(resolveContextWindow('grok', 'grok-4.3', Number.NaN)).toBe(1_000_000)
    expect(resolveContextWindow('gemini', 'flash-lite', Number.POSITIVE_INFINITY)).toBe(200_000)
  })

  it('resolves representative model ids across providers', () => {
    expect(resolveContextWindow('gemini', 'pro')).toBe(1_048_576)
    expect(resolveContextWindow('codex', 'gpt-5.5')).toBe(1_050_000)
    expect(resolveContextWindow('codex', 'gpt-5.4')).toBe(1_050_000)
    expect(resolveContextWindow('codex', 'gpt-5.4-mini')).toBe(400_000)
    expect(resolveContextWindow('claude', 'claude-opus-4-8-1m')).toBe(1_000_000)
    expect(resolveContextWindow('claude', 'claude-fable-5')).toBe(200_000)
    expect(resolveContextWindow('claude', 'claude-fable-5-1m')).toBe(1_000_000)
    expect(resolveContextWindow('kimi', 'kimi-k2.7-code')).toBe(256_000)
    expect(resolveContextWindow('kimi', 'kimi-k2.6')).toBe(256_000)
    expect(resolveContextWindow('grok', 'grok-composer-2.5-fast')).toBe(200_000)
    expect(resolveContextWindow('grok', 'grok-build')).toBe(256_000)
    expect(resolveContextWindow('ollama', 'qwen3:4b-instruct')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'qwen3.5:9b')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'qwen3.6:35b')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'qwen3.6:35b-a3b')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'gemma4:12b')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'gemma4:12b-it-q4_K_M')).toBe(262_144)
    expect(resolveContextWindow('ollama', 'gpt-oss')).toBe(131_072)
    expect(resolveContextWindow('ollama', 'gpt-oss:20b')).toBe(131_072)
    expect(resolveContextWindow('ollama', 'minicpm-v4.5:8b')).toBe(40_960)
    expect(resolveContextWindow('ollama', 'granite4.1:3b')).toBe(131_072)
    expect(resolveContextWindow('ollama', 'granite4.1:30b')).toBe(131_072)
    expect(resolveContextWindow('ollama', 'nemotron3:33b')).toBe(131_072)
  })

  it('prefers live Ollama context_length from /api/tags over static table', () => {
    expect(resolveContextWindow('ollama', 'qwen3.5:9b', undefined, 128_000)).toBe(128_000)
    expect(resolveContextWindow('ollama', 'unknown-local', undefined, 65_536)).toBe(65_536)
  })

  it('uses provider fallbacks for all seven providers when the model is unknown', () => {
    const expected: Record<ProviderId, number> = {
      gemini: 1_048_576,
      codex: 1_050_000,
      claude: 200_000,
      kimi: 256_000,
      grok: 256_000,
      cursor: 200_000,
      ollama: 262_144
    }

    for (const [provider, limit] of Object.entries(expected) as Array<[ProviderId, number]>) {
      expect(resolveContextWindow(provider, 'unknown-model')).toBe(limit)
    }
  })

  it('uses the conservative default when provider and model are missing', () => {
    expect(resolveContextWindow(undefined, undefined)).toBe(200_000)
  })
})

describe('formatContextTokens', () => {
  it('formats million-scale windows with one decimal place under 10M', () => {
    expect(formatContextTokens(1_000_000)).toBe('1.0M')
    expect(formatContextTokens(1_048_576)).toBe('1.0M')
  })

  it('rounds thousand-scale windows to compact k labels', () => {
    expect(formatContextTokens(199_500)).toBe('200k')
    expect(formatContextTokens(400_000)).toBe('400k')
  })

  it('leaves sub-thousand values as plain numbers', () => {
    expect(formatContextTokens(999)).toBe('999')
    expect(formatContextTokens(0)).toBe('0')
  })
})

describe('contextPercent', () => {
  it('clamps usage percentages to finite meter bounds', () => {
    expect(contextPercent(50_000, 200_000)).toBe(25)
    expect(contextPercent(500_000, 200_000)).toBe(100)
    expect(contextPercent(-5, 200_000)).toBe(0)
    expect(contextPercent(50_000, 0)).toBe(0)
  })
})
