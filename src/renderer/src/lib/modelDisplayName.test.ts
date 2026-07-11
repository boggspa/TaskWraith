import { describe, expect, it } from 'vitest'
import {
  canonicalModelIdForProvider,
  getKnownModelLabels,
  humaniseModelId,
  humaniseModelIdCompact,
  humaniseModelIdTableCell
} from './modelDisplayName'

// 1.0.5-EW50 — Shared model-id humaniser. Covers the four
// provider families + the fallback contract. Verifies that:
//   - known ids return their canonical display name
//   - unknown ids fall back to the raw id (not a placeholder)
//   - lookup is case-insensitive on the key side
//   - empty / null inputs return empty string
describe('humaniseModelId', () => {
  describe('Gemini', () => {
    it('maps known full ids to "Gemini X Variant" form', () => {
      expect(humaniseModelId('gemini', 'gemini-3-flash-preview')).toBe('Gemini 3 Flash Preview')
      expect(humaniseModelId('gemini', 'gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro Preview')
      expect(humaniseModelId('gemini', 'gemini-3.1-flash-lite-preview')).toBe(
        'Gemini 3.1 Flash Lite Preview'
      )
      expect(humaniseModelId('gemini', 'gemini-3.1-flash-lite')).toBe('Gemini 3.1 Flash Lite')
    })

    it('maps composer-side short ids to "Gemini X" form', () => {
      expect(humaniseModelId('gemini', 'pro')).toBe('Gemini Pro')
      expect(humaniseModelId('gemini', 'flash')).toBe('Gemini Flash')
      expect(humaniseModelId('gemini', 'flash-lite')).toBe('Gemini Flash Lite')
      expect(humaniseModelId('gemini', 'cli-default')).toBe('Gemini Flash Lite')
    })
  })

  describe('Claude', () => {
    it('maps full claude ids to "Claude Opus/Sonnet/Haiku N.N" form', () => {
      expect(humaniseModelId('claude', 'claude-fable-5')).toBe('Claude Fable 5')
      expect(humaniseModelId('claude', 'claude-fable-5-1m')).toBe('Claude Fable 5 (1M)')
      expect(humaniseModelId('claude', 'claude-mythos-5')).toBe('Claude Mythos 5')
      expect(humaniseModelId('claude', 'claude-sonnet-5')).toBe('Claude Sonnet 5')
      expect(humaniseModelId('claude', 'preview:anthropic:claude-sonnet-5')).toBe('Claude Sonnet 5')
      expect(humaniseModelId('claude', 'claude-opus-4-8')).toBe('Claude Opus 4.8')
      expect(humaniseModelId('claude', 'claude-opus-4-8-1m')).toBe('Claude Opus 4.8 (1M)')
      expect(humaniseModelId('claude', 'claude-opus-4-7')).toBe('Claude Opus 4.7')
      expect(humaniseModelId('claude', 'claude-opus-4-7-1m')).toBe('Claude Opus 4.7 (1M)')
      expect(humaniseModelId('claude', 'claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
      expect(humaniseModelId('claude', 'claude-haiku-4-5')).toBe('Claude Haiku 4.5')
      expect(humaniseModelId('claude', 'claude-opus-4-6')).toBe('Claude Opus 4.6')
    })

    it('maps composer-side short ids to "Claude X" form', () => {
      expect(humaniseModelId('claude', 'sonnet')).toBe('Claude Sonnet')
      expect(humaniseModelId('claude', 'opus')).toBe('Claude Opus')
      expect(humaniseModelId('claude', 'haiku')).toBe('Claude Haiku')
      expect(humaniseModelId('claude', 'fable')).toBe('Claude Fable')
      expect(humaniseModelId('claude', 'mythos')).toBe('Claude Mythos')
    })
  })

  describe('Codex (GPT)', () => {
    it('maps gpt ids preserving the "GPT-X.Y" capitalisation', () => {
      expect(humaniseModelId('codex', 'gpt-5.5')).toBe('GPT-5.5')
      expect(humaniseModelId('codex', 'gpt-5.4')).toBe('GPT-5.4')
      expect(humaniseModelId('codex', 'gpt-5.4-mini')).toBe('GPT-5.4 Mini')
      expect(humaniseModelId('codex', 'gpt-5.3-codex')).toBe('GPT-5.3 Codex')
      expect(humaniseModelId('codex', 'gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
      expect(humaniseModelId('codex', 'gpt-5.2')).toBe('GPT-5.2')
      // GPT-5.6 uses the OFFICIAL hyphenated display names (GA 2026-07-09);
      // stale placeholder ids resolve to the same official name.
      expect(humaniseModelId('codex', 'gpt-5.6-sol')).toBe('GPT-5.6-Sol')
      expect(humaniseModelId('codex', 'gpt-5.6-terra')).toBe('GPT-5.6-Terra')
      expect(humaniseModelId('codex', 'gpt-5.6-luna')).toBe('GPT-5.6-Luna')
      expect(humaniseModelId('codex', 'preview:openai:gpt-5.6:sol')).toBe('GPT-5.6-Sol')
    })
  })

  describe('Kimi', () => {
    it('maps Kimi ids including the old/new thinking aliases', () => {
      expect(humaniseModelId('kimi', 'kimi-k2.7-code')).toBe('Kimi K2.7 Code')
      expect(humaniseModelId('kimi', 'kimi-k2.7-code-thinking')).toBe('Kimi K2.7 Code Thinking')
      expect(humaniseModelId('kimi', 'kimi-k2.6')).toBe('Kimi K2.6')
      expect(humaniseModelId('kimi', 'kimi-k2.6-thinking')).toBe('Kimi K2.6 Thinking')
      // Pre-renamed alias still maps to the same display
      expect(humaniseModelId('kimi', 'kimi-k2-thinking')).toBe('Kimi K2.6 Thinking')
      expect(humaniseModelId('kimi', 'kimi-k2.5')).toBe('Kimi K2.5')
      expect(humaniseModelId('kimi', 'kimi-k2')).toBe('Kimi K2')
      expect(humaniseModelId('kimi', 'kimi-latest')).toBe('Kimi (Latest)')
    })

    it('maps preview / dated Kimi variants', () => {
      expect(humaniseModelId('kimi', 'kimi-k2-turbo-preview')).toBe('Kimi K2 Turbo Preview')
      expect(humaniseModelId('kimi', 'kimi-k2-0711-preview')).toBe('Kimi K2 (0711 Preview)')
      expect(humaniseModelId('kimi', 'kimi-k2-0905-preview')).toBe('Kimi K2 (0905 Preview)')
    })
  })

  describe('Grok', () => {
    it('maps Grok CLI ids to the product model name', () => {
      expect(humaniseModelId('grok', 'grok-composer-2.5-fast')).toBe('Grok Composer 2.5 Fast')
      // Grok's CLI models are permanently Fast-mode, so the Grok seat reads
      // "Grok 4.5 Fast".
      expect(humaniseModelId('grok', 'grok-4.5')).toBe('Grok 4.5 Fast')
      expect(humaniseModelId('grok', 'grok-build')).toBe('Grok 4.5 Fast')
      expect(humaniseModelId('grok', 'grok-build-0.1')).toBe('Grok 4.5 Fast')
    })
  })

  describe('Cursor', () => {
    it('maps Composer CLI ids to human-readable names', () => {
      expect(humaniseModelId('cursor', 'composer-2.5')).toBe('Composer 2.5')
      expect(humaniseModelId('cursor', 'composer-2.5-fast')).toBe('Composer 2.5 Fast')
      // Cursor's grok-4.5 keeps a separate Fast toggle — its base row stays "Grok 4.5".
      expect(humaniseModelId('cursor', 'grok-4.5-fast-xhigh')).toBe('Grok 4.5')
    })
  })

  describe('Ollama', () => {
    it('maps local Ollama tags to readable model names', () => {
      expect(humaniseModelId('ollama', 'qwen3:4b-instruct')).toBe('Qwen 3 (4B Param)')
      expect(humaniseModelId('ollama', 'qwen3.5:9b')).toBe('Qwen 3.5 (9B Param)')
      expect(humaniseModelId('ollama', 'qwen3.5:9b-q4_K_M')).toBe('Qwen 3.5 (9B Param)')
      expect(humaniseModelId('ollama', 'qwen3.6:35b')).toBe('Qwen 3.6 (35B-A3B)')
      expect(humaniseModelId('ollama', 'qwen3.6:35b-a3b')).toBe('Qwen 3.6 (35B-A3B)')
      expect(humaniseModelId('ollama', 'gemma4:12b')).toBe('Gemma 4 (12B Param)')
      expect(humaniseModelId('ollama', 'gemma4:12b-it-q4_K_M')).toBe('Gemma 4 (12B Param)')
      expect(humaniseModelId('ollama', 'ornith')).toBe('Ornith 1.0 (9B Param)')
      expect(humaniseModelId('ollama', 'ornith:latest')).toBe('Ornith 1.0 (9B Param)')
      expect(humaniseModelId('ollama', 'ornith:9b')).toBe('Ornith 1.0 (9B Param)')
      expect(humaniseModelId('ollama', 'ornith:35b')).toBe('Ornith 1.0 (35B Param)')
      expect(humaniseModelId('ollama', 'ornith:35b-q4_K_M')).toBe('Ornith 1.0 (35B Param)')
      expect(humaniseModelId('ollama', 'laguna-xs-2.1:q8_0')).toBe('Laguna XS 2.1 (33B-A3B Q8)')
      expect(humaniseModelId('ollama', 'gpt-oss')).toBe('GPT OSS (20B Param)')
      expect(humaniseModelId('ollama', 'gpt-oss:20b')).toBe('GPT OSS (20B Param)')
      expect(humaniseModelId('ollama', 'gpt-oss:latest')).toBe('GPT OSS (20B Param)')
      expect(humaniseModelId('ollama', 'lfm2.5')).toBe('LFM 2.5 (8B-A1B)')
      expect(humaniseModelId('ollama', 'lfm2.5:8b')).toBe('LFM 2.5 (8B-A1B)')
      expect(humaniseModelId('ollama', 'lfm2.5:8b-q4_K_M')).toBe('LFM 2.5 (8B-A1B)')
      expect(humaniseModelId('ollama', 'minicpm-v4.5:8b')).toBe('MiniCPM-V 4.5 (8B Param)')
      expect(humaniseModelId('ollama', 'granite4.1:3b')).toBe('Granite 4.1 (3B Param)')
      expect(humaniseModelId('ollama', 'granite4.1:30b')).toBe('Granite 4.1 (30B Param)')
      expect(humaniseModelId('ollama', 'nemotron3:33b')).toBe('Nemotron 3 Nano Omni (33B Param)')
    })
  })

  describe('Lookup behaviour', () => {
    it('is case-insensitive on the input id', () => {
      expect(humaniseModelId('gemini', 'GEMINI-3-FLASH-PREVIEW')).toBe('Gemini 3 Flash Preview')
      expect(humaniseModelId('claude', 'Claude-Opus-4-7')).toBe('Claude Opus 4.7')
      expect(humaniseModelId('codex', 'GPT-5.5')).toBe('GPT-5.5')
    })

    it('falls back to the raw id for unknown models (preserves info over placeholder)', () => {
      // Brand-new model the table hasn't been extended for yet —
      // should NOT become "Unknown model" or empty; the raw id
      // stays so power users still see what's there.
      expect(humaniseModelId('gemini', 'gemini-99-experimental-x')).toBe('gemini-99-experimental-x')
      expect(humaniseModelId('codex', 'gpt-x-future')).toBe('gpt-x-future')
    })

    it('returns empty string for empty / null / undefined input', () => {
      expect(humaniseModelId('gemini', '')).toBe('')
      expect(humaniseModelId('gemini', null)).toBe('')
      expect(humaniseModelId('gemini', undefined)).toBe('')
    })

    it('does not require a known provider for unambiguous ids', () => {
      expect(humaniseModelId(undefined, 'gemini-3-flash-preview')).toBe('Gemini 3 Flash Preview')
      // @ts-expect-error — intentional bad provider for runtime guard
      expect(humaniseModelId('not-a-provider', 'gpt-5.5')).toBe('GPT-5.5')
    })

    it('uses provider context to repair stale Gemini placeholder ids for Grok and Cursor', () => {
      expect(canonicalModelIdForProvider('grok', 'flash-lite')).toBe('grok-4.5')
      expect(canonicalModelIdForProvider('grok', 'composer-2.5-fast')).toBe(
        'grok-composer-2.5-fast'
      )
      expect(canonicalModelIdForProvider('cursor', 'flash-lite')).toBe('composer-2.5-fast')
      expect(canonicalModelIdForProvider('cursor', 'Composer 2.5 Fast')).toBe('composer-2.5-fast')
      expect(canonicalModelIdForProvider('cursor', 'Composer 2.5')).toBe('composer-2.5')
      expect(humaniseModelId('grok', 'flash-lite')).toBe('Grok 4.5 Fast')
      expect(humaniseModelId('grok', 'composer-2.5-fast')).toBe('Grok Composer 2.5 Fast')
      expect(humaniseModelId('cursor', 'gemini-3.1-flash-lite')).toBe('Composer 2.5 Fast')
      expect(humaniseModelId('gemini', 'flash-lite')).toBe('Gemini Flash Lite')
    })

    it('maps legacy default sentinels to provider-specific concrete defaults', () => {
      expect(canonicalModelIdForProvider('codex', 'cli-default')).toBe('gpt-5.5')
      expect(canonicalModelIdForProvider('claude', 'default')).toBe('claude-sonnet-5')
      expect(canonicalModelIdForProvider('gemini', 'cli-default')).toBe('flash-lite')
      expect(canonicalModelIdForProvider('kimi', 'cli-default')).toBe('kimi-k2.7-code')
      expect(canonicalModelIdForProvider('grok', 'cli-default')).toBe('grok-4.5')
      expect(canonicalModelIdForProvider('cursor', 'cli-default')).toBe('composer-2.5-fast')
      expect(canonicalModelIdForProvider('ollama', 'cli-default')).toBe('qwen3:4b-instruct')
    })

    it('canonicalizes Ollama aliases that render as the same model', () => {
      expect(canonicalModelIdForProvider('ollama', 'gpt-oss')).toBe('gpt-oss:20b')
      expect(canonicalModelIdForProvider('ollama', 'gpt-oss:latest')).toBe('gpt-oss:20b')
      expect(canonicalModelIdForProvider('ollama', 'openai/gpt-oss-20b')).toBe('gpt-oss:20b')
      expect(canonicalModelIdForProvider('ollama', 'qwen3.6:35b-a3b')).toBe('qwen3.6:35b')
      expect(canonicalModelIdForProvider('ollama', 'lfm2.5')).toBe('lfm2.5:8b')
      expect(canonicalModelIdForProvider('ollama', 'lfm2.5:latest')).toBe('lfm2.5:8b')
    })
  })

  describe('getKnownModelLabels', () => {
    it('returns a shallow clone so callers cannot mutate the source-of-truth', () => {
      const first = getKnownModelLabels()
      const second = getKnownModelLabels()
      expect(first).not.toBe(second)
      // Mutating the returned clone should not affect a fresh call.
      first['injected-key'] = 'pwned'
      expect(getKnownModelLabels()['injected-key']).toBeUndefined()
    })

    it('contains at least the six pillars we surface across the dashboard + Settings', () => {
      const labels = getKnownModelLabels()
      expect(labels['gemini-3-flash-preview']).toBeDefined()
      expect(labels['claude-opus-4-7']).toBeDefined()
      expect(labels['gpt-5.5']).toBeDefined()
      expect(labels['kimi-k2.7-code']).toBeDefined()
      expect(labels['kimi-k2.6']).toBeDefined()
      expect(labels['kimi-k2.6-thinking']).toBeDefined()
      expect(labels['grok-composer-2.5-fast']).toBeDefined()
      expect(labels['grok-4.5']).toBeDefined()
      expect(labels['grok-build']).toBeDefined()
      expect(labels['composer-2.5-fast']).toBeDefined()
      expect(labels['qwen3:4b-instruct']).toBeDefined()
      expect(labels['qwen3.5:9b']).toBeDefined()
      expect(labels['qwen3.6:35b']).toBeDefined()
      expect(labels['gemma4:12b']).toBeDefined()
      expect(labels['ornith']).toBeDefined()
      expect(labels['ornith:latest']).toBeDefined()
      expect(labels['ornith:9b']).toBeDefined()
      expect(labels['ornith:35b']).toBeDefined()
      expect(labels['laguna-xs-2.1:q8_0']).toBeDefined()
      expect(labels['gpt-oss:20b']).toBeDefined()
      expect(labels['lfm2.5:8b']).toBeDefined()
      expect(labels['minicpm-v4.5:8b']).toBeDefined()
      expect(labels['granite4.1:30b']).toBeDefined()
      expect(labels['nemotron3:33b']).toBeDefined()
    })
  })
})

describe('humaniseModelIdCompact', () => {
  it('drops the provider brand when the parent row already names it', () => {
    expect(humaniseModelIdCompact('claude', 'claude-opus-4-8')).toBe('Opus 4.8')
    expect(humaniseModelIdCompact('gemini', 'gemini-3-flash-preview')).toBe('3 Flash Preview')
    expect(humaniseModelIdCompact('kimi', 'kimi-k2.6')).toBe('K2.6')
    expect(humaniseModelIdCompact('grok', 'grok-composer-2.5-fast')).toBe('Composer 2.5 Fast')
    expect(humaniseModelIdCompact('grok', 'grok-build')).toBe('4.5 Fast')
  })

  it('leaves labels that do not repeat the provider unchanged', () => {
    expect(humaniseModelIdCompact('codex', 'gpt-5.5')).toBe('GPT-5.5')
    expect(humaniseModelIdCompact('gemini', 'cli-default')).toBe('Flash Lite')
    expect(humaniseModelIdCompact('cursor', 'composer-2.5-fast')).toBe('Composer 2.5 Fast')
    expect(humaniseModelIdCompact('ollama', 'qwen3:4b-instruct')).toBe('Qwen 3 (4B Param)')
    expect(humaniseModelIdCompact('ollama', 'qwen3.6:35b-a3b')).toBe('Qwen 3.6 (35B-A3B)')
    expect(humaniseModelIdCompact('ollama', 'ornith:9b')).toBe('Ornith 1.0 (9B Param)')
    expect(humaniseModelIdCompact('ollama', 'laguna-xs-2.1:q8_0')).toBe(
      'Laguna XS 2.1 (33B-A3B Q8)'
    )
  })
})

describe('humaniseModelIdTableCell', () => {
  it('hard-truncates long compact labels for narrow table cells', () => {
    expect(humaniseModelIdTableCell('gemini', 'gemini-3.1-flash-lite-preview')).toBe(
      '3.1 Flash Lite Preview'
    )
  })

  it('simplifies dated Claude API ids before truncating', () => {
    expect(humaniseModelIdTableCell('claude', 'claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  })
})
