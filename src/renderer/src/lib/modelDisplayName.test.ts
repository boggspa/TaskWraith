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
      expect(humaniseModelId('kimi', 'kimi-k3')).toBe('K3')
      expect(humaniseModelId('kimi', 'kimi-k2.7-code')).toBe('K2.7 Coding')
      expect(humaniseModelId('kimi', 'kimi-k2.7-code-thinking')).toBe('K2.7 Coding Thinking')
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

  describe('AntiGravity', () => {
    it('keeps key-lane and official agy ids on their own readable model families', () => {
      expect(humaniseModelId('antigravity', 'gemini-api:gemini-2.5-flash')).toBe('2.5 Flash')
      expect(humaniseModelId('antigravity', 'gemini-api:gemini-2.5-flash-lite')).toBe(
        '2.5 Flash-Lite'
      )
      expect(humaniseModelId('antigravity', 'gemini-api:gemini-3.1-pro-preview')).toBe(
        '3.1 Pro Preview'
      )
      expect(canonicalModelIdForProvider('antigravity', 'gemini-3.6-flash-high')).toBe(
        'gemini-3.6-flash'
      )
      expect(canonicalModelIdForProvider('antigravity', 'gemini-3.6-flash-low')).toBe(
        'gemini-3.6-flash'
      )
      expect(canonicalModelIdForProvider('antigravity', 'GEMINI-3.6-FLASH-HIGH')).toBe(
        'gemini-3.6-flash'
      )
      expect(humaniseModelId('antigravity', 'gemini-3.6-flash-high')).toBe('Gemini 3.6 Flash')
      expect(humaniseModelIdCompact('antigravity', 'gemini-3.6-flash-low')).toBe('3.6 Flash')
      expect(humaniseModelId('antigravity', 'gemini-3.5-flash-medium')).toBe('Gemini 3.5 Flash')
      expect(humaniseModelId('antigravity', 'gemini-3.1-pro-high')).toBe('Gemini 3.1 Pro')
      // Unrecognised ids remain lossless rather than becoming a guessed model.
      expect(humaniseModelId('antigravity', 'agy-model')).toBe('agy-model')
    })
  })

  describe('Mistral', () => {
    it('maps Vibe seat ids to human-readable names instead of surfacing raw ids', () => {
      expect(humaniseModelId('mistral', 'mistral-medium-3.5')).toBe('Mistral Medium 3.5')
      expect(humaniseModelId('mistral', 'devstral-small')).toBe('Devstral Small')
    })

    it('collapses the Vibe wire aliases onto the seat ids so one model is one row', () => {
      expect(canonicalModelIdForProvider('mistral', 'mistral-vibe-cli-latest')).toBe(
        'mistral-medium-3.5'
      )
      expect(canonicalModelIdForProvider('mistral', 'devstral-small-latest')).toBe('devstral-small')
      expect(humaniseModelId('mistral', 'mistral-vibe-cli-latest')).toBe('Mistral Medium 3.5')
    })

    it('resolves the default sentinel to the seat default (devstral-small, not the flagship)', () => {
      expect(canonicalModelIdForProvider('mistral', 'default')).toBe('devstral-small')
      expect(canonicalModelIdForProvider('mistral', 'cli-default')).toBe('devstral-small')
    })

    it('drops the redundant brand prefix under the provider header', () => {
      expect(humaniseModelIdCompact('mistral', 'mistral-medium-3.5')).toBe('Medium 3.5')
      // Devstral does not repeat the provider, so the strip is a no-op.
      expect(humaniseModelIdCompact('mistral', 'devstral-small')).toBe('Devstral Small')
    })

    it('leaves the Pi BYOK mistral/* upstream ids to the Pi resolver', () => {
      // Same brand string, DIFFERENT provider identity — must not be rewritten
      // by the Mistral seat's table.
      expect(canonicalModelIdForProvider('pi', 'mistral/devstral-2512')).toBe(
        'mistral/devstral-2512'
      )
    })
  })

  describe('Muse', () => {
    it('maps Spark wire ids to a human-readable name', () => {
      expect(humaniseModelId('muse', 'muse-spark-1.2')).toBe('Muse Spark 1.2')
      expect(canonicalModelIdForProvider('muse', 'cli-default')).toBe('muse-spark-1.2')
    })
  })

  describe('Newest seats — default sentinel', () => {
    it('resolves the default sentinel per seat rather than showing a "default" row', () => {
      expect(canonicalModelIdForProvider('antigravity', 'default')).toBe(
        'gemini-api:gemini-2.5-flash'
      )
      expect(canonicalModelIdForProvider('pi', 'default')).toBe('deepseek/deepseek-v4-flash')
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
      expect(humaniseModelId('ollama', 'qwen3.5:4b')).toBe('Qwen 3.5 (4B Param)')
      expect(humaniseModelId('ollama', 'qwen3.5:4b-instruct-q4_K_M')).toBe('Qwen 3.5 (4B Param)')
      expect(humaniseModelId('ollama', 'devstral-small-2:24b')).toBe('Devstral Small 2 (24B Param)')
      expect(humaniseModelId('ollama', 'ministral-3:14b')).toBe('Ministral 3 (14B Param)')
      expect(humaniseModelId('ollama', 'muse-glimmer:30b-mlx')).toBe('Muse Glimmer (30B-MLX)')
      expect(humaniseModelId('ollama', 'llama3.1:8b')).toBe('Llama 3.1 (8B Param)')
      expect(humaniseModelId('ollama', 'deepseek-r1:8b')).toBe('DeepSeek R1 (8B Param)')
      expect(humaniseModelId('ollama', 'rnj-1:latest')).toBe('Rnj-1 (8B Param)')
      expect(humaniseModelId('ollama', 'glm-4.7-flash:q4_K_M')).toBe('GLM-4.7-Flash (30B-A3B Q4)')
      expect(humaniseModelId('ollama', 'north-mini-code-1.0:q4_K_M')).toBe(
        'North Mini Code 1.0 (30B-A3B Q4)'
      )
      expect(humaniseModelId('ollama', 'llama3.2:3b')).toBe('Llama 3.2 (3B Param)')
      for (const [modelId, label] of [
        ['ministral-3:3b', 'Ministral 3 (3B Param)'],
        ['granite4:3b', 'Granite 4.0 (3B Param)'],
        ['qwen3.5:2b', 'Qwen 3.5 (2B Param)'],
        ['deepseek-r1:1.5b', 'DeepSeek R1 (1.5B Param)'],
        ['nemotron-3-nano:4b', 'Nemotron 3 Nano (4B Param)'],
        ['lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking (1.2B Param)'],
        ['gemma3:4b', 'Gemma 3 (4B Param)']
      ]) {
        expect(humaniseModelId('ollama', modelId)).toBe(label)
      }
      // The Mistral Vibe seat's own bare `devstral-small` row is a DIFFERENT
      // identity and must not be pulled onto the local tag's label.
      expect(humaniseModelId('mistral', 'devstral-small')).toBe('Devstral Small')
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
      expect(canonicalModelIdForProvider('ollama', 'rnj-1:latest')).toBe('rnj-1')
      expect(canonicalModelIdForProvider('ollama', 'rnj-1:8b')).toBe('rnj-1')
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
      expect(labels['kimi-k3']).toBeDefined()
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
      expect(labels['qwen3.5:4b']).toBeDefined()
      expect(labels['devstral-small-2:24b']).toBeDefined()
      expect(labels['ministral-3:14b']).toBeDefined()
      expect(labels['llama3.1:8b']).toBeDefined()
      expect(labels['deepseek-r1:8b']).toBeDefined()
      expect(labels['rnj-1']).toBeDefined()
      expect(labels['glm-4.7-flash:q4_k_m']).toBeDefined()
      expect(labels['north-mini-code-1.0:q4_k_m']).toBeDefined()
      expect(labels['llama3.2:3b']).toBeDefined()
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
