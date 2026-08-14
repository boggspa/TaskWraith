import { describe, it, expect } from 'vitest'
import {
  codexReasoningDisplayLabel,
  formatComposerModelChip,
  reasoningDisplayLabel,
  shortModelName
} from './composerChipFormat'
import { CURSOR_GROK_46_WIRE_MODEL_IDS } from '../../../shared/grok45Models'
import { PI_MODEL_LABELS } from '../../../shared/piBrandTable'

describe('shortModelName', () => {
  it('extracts Codex version digit + capitalised suffix', () => {
    expect(shortModelName('codex', 'GPT-5.5', 'gpt-5.5')).toBe('5.5')
    expect(shortModelName('codex', 'GPT-5.4-Mini', 'gpt-5.4-mini')).toBe('5.4-Mini')
    expect(shortModelName('codex', 'GPT-5.3-Codex-Spark', 'gpt-5.3-codex-spark')).toBe(
      '5.3-Codex-Spark'
    )
  })

  it('extracts Claude family + version', () => {
    expect(shortModelName('claude', 'Claude Opus 4.7', 'claude-opus-4-7')).toBe('Opus 4.7')
    expect(
      shortModelName('claude', 'Claude Sonnet 4.6 (thinking)', 'claude-sonnet-4-6-thinking')
    ).toBe('Sonnet 4.6')
    expect(shortModelName('claude', 'Claude Haiku 4.0', 'claude-haiku-4-0')).toBe('Haiku 4.0')
  })

  it('extracts single-digit Fable/Mythos versions while preserving the -1m marker', () => {
    expect(shortModelName('claude', 'Claude Fable 5', 'claude-fable-5')).toBe('Fable 5')
    expect(shortModelName('claude', 'Claude Mythos 5', 'claude-mythos-5')).toBe('Mythos 5')
    // -1m is the TaskWraith context-variant marker, NOT a minor version —
    // claude-fable-5-1m must never render as "Fable 5.1".
    expect(shortModelName('claude', 'Claude Fable 5 1M', 'claude-fable-5-1m')).toBe('Fable 5 1M')
    // Two-digit families with the marker keep their existing rendering.
    expect(shortModelName('claude', 'Claude Opus 4.8 1M', 'claude-opus-4-8-1m')).toBe('Opus 4.8 1M')
  })

  it('extracts Kimi version', () => {
    expect(shortModelName('kimi', 'K2.7 Coding', 'kimi-k2.7-code')).toBe('K2.7 Coding')
    expect(shortModelName('kimi', 'K2.7 Coding Thinking', 'kimi-k2.7-code-thinking')).toBe(
      'K2.7 Coding'
    )
    expect(shortModelName('kimi', 'K3', 'kimi-k3')).toBe('K3')
    expect(shortModelName('kimi', 'Kimi K2.6 Thinking', 'kimi-k2.6-thinking')).toBe('K2.6')
  })

  it('extracts Gemini variant', () => {
    expect(shortModelName('gemini', 'Gemini 2.5 Pro', 'gemini-2.5-pro')).toBe('2.5 Pro')
    expect(shortModelName('gemini', 'Gemini Flash Lite', 'gemini-flash-lite')).toBe('Flash Lite')
  })

  it('falls back to the human label when no provider pattern matches', () => {
    expect(shortModelName('codex', 'Custom Model X', 'custom-model-x')).toBe('Custom Model X')
  })

  it('renders Cursor Composer model ids as human labels', () => {
    expect(shortModelName('cursor', '', 'composer-2.5-fast')).toBe('Composer 2.5 Fast')
    expect(shortModelName('cursor', '', 'composer-2.5')).toBe('Composer 2.5')
    expect(shortModelName('cursor', 'Cursor Grok 4.5', 'grok-4.5')).toBe('Grok 4.5')
    expect(shortModelName('cursor', 'Cursor Grok 4.6', 'grok-4.6')).toBe('Grok 4.6')
    for (const modelId of CURSOR_GROK_46_WIRE_MODEL_IDS) {
      expect(shortModelName('cursor', '', modelId)).toBe('Grok 4.6')
    }
  })

  it('renders Grok CLI model ids as Grok model labels', () => {
    expect(shortModelName('grok', '', 'grok-composer-2.5-fast')).toBe('Grok Composer 2.5 Fast')
    expect(shortModelName('grok', '', 'grok-build')).toBe('Grok 4.5 Fast')
    expect(shortModelName('grok', '', 'grok-4.6')).toBe('Grok 4.6 Fast')
    expect(shortModelName('grok', '', 'grok-4.5')).toBe('Grok 4.5 Fast')
  })

  it('renders local Ollama tags as model names', () => {
    expect(shortModelName('ollama', '', 'qwen3:4b-instruct')).toBe('Qwen 3 (4B Param)')
    expect(shortModelName('ollama', '', 'qwen3.5:9b')).toBe('Qwen 3.5 (9B Param)')
    expect(shortModelName('ollama', '', 'qwen3.5:9b-q4_K_M')).toBe('Qwen 3.5 (9B Param)')
    expect(shortModelName('ollama', '', 'qwen3.6:35b')).toBe('Qwen 3.6 (35B-A3B)')
    expect(shortModelName('ollama', '', 'qwen3.8:27b-mlx')).toBe('Qwen 3.8 (27B-MLX)')
    expect(shortModelName('ollama', '', 'gemma4:12b')).toBe('Gemma 4 (12B Param)')
    expect(shortModelName('ollama', '', 'gemma4:12b-it-q4_K_M')).toBe('Gemma 4 (12B Param)')
    expect(shortModelName('ollama', '', 'ornith')).toBe('Ornith 1.0 (9B Param)')
    expect(shortModelName('ollama', '', 'ornith:latest')).toBe('Ornith 1.0 (9B Param)')
    expect(shortModelName('ollama', '', 'ornith:9b')).toBe('Ornith 1.0 (9B Param)')
    expect(shortModelName('ollama', '', 'ornith:35b')).toBe('Ornith 1.0 (35B Param)')
    expect(shortModelName('ollama', '', 'laguna-xs-2.1:q8_0')).toBe(
      'Laguna XS 2.1 (33B-A3B Q8)'
    )
    expect(shortModelName('ollama', '', 'gpt-oss')).toBe('GPT OSS (20B Param)')
    expect(shortModelName('ollama', '', 'gpt-oss:20b')).toBe('GPT OSS (20B Param)')
    expect(shortModelName('ollama', '', 'minicpm-v4.5:8b')).toBe('MiniCPM-V 4.5 (8B Param)')
    expect(shortModelName('ollama', '', 'granite4.1:30b')).toBe('Granite 4.1 (30B Param)')
    expect(shortModelName('ollama', '', 'nemotron3:33b')).toBe('Nemotron 3 Nano Omni (33B Param)')
    expect(shortModelName('ollama', '', 'nemotron-3.5-lightning:30b-mlx')).toBe(
      'Nemotron 3.5 Lightning (30B-MLX)'
    )
    expect(shortModelName('ollama', '', 'qwen3.5:4b')).toBe('Qwen 3.5 (4B Param)')
    expect(shortModelName('ollama', '', 'devstral-small-2:24b')).toBe(
      'Devstral Small 2 (24B Param)'
    )
    expect(shortModelName('ollama', '', 'ministral-3:14b')).toBe('Ministral 3 (14B Param)')
    expect(shortModelName('ollama', '', 'llama3.1:8b')).toBe('Llama 3.1 (8B Param)')
    expect(shortModelName('ollama', '', 'deepseek-r1:8b')).toBe('DeepSeek R1 (8B Param)')
    expect(shortModelName('ollama', '', 'rnj-1:latest')).toBe('Rnj-1 (8B Param)')
    expect(shortModelName('ollama', '', 'glm-4.7-flash:q4_K_M')).toBe(
      'GLM-4.7-Flash (30B-A3B Q4)'
    )
    expect(shortModelName('ollama', '', 'north-mini-code-1.0:q4_K_M')).toBe(
      'North Mini Code 1.0 (30B-A3B Q4)'
    )
    expect(shortModelName('ollama', '', 'muse-glimmer:30b-mlx')).toBe(
      'Muse Glimmer (30B-MLX)'
    )
    expect(shortModelName('ollama', '', 'llama3.2:3b')).toBe('Llama 3.2 (3B Param)')
    for (const [modelId, label] of [
      ['ministral-3:3b', 'Ministral 3 (3B Param)'],
      ['granite4:3b', 'Granite 4.0 (3B Param)'],
      ['qwen3.5:2b', 'Qwen 3.5 (2B Param)'],
      ['deepseek-r1:1.5b', 'DeepSeek R1 (1.5B Param)'],
      ['nemotron-3-nano:4b', 'Nemotron 3 Nano (4B Param)'],
      ['lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking (1.2B Param)'],
      ['gemma3:4b', 'Gemma 3 (4B Param)']
    ]) {
      expect(shortModelName('ollama', '', modelId)).toBe(label)
    }
  })

  it('renders every curated Pi wire id as its human model name', () => {
    for (const [modelId, label] of Object.entries(PI_MODEL_LABELS)) {
      expect(shortModelName('pi', '', modelId)).toBe(label)
    }
  })

  it('derives AntiGravity key-lane ids to their catalog label', () => {
    // The chip must match the picker rows exactly ("2.5 Flash-Lite", not the
    // raw wire id `gemini-api:gemini-2.5-flash-lite`).
    expect(shortModelName('antigravity', '', 'gemini-api:gemini-2.5-flash')).toBe('2.5 Flash')
    expect(shortModelName('antigravity', '', 'gemini-api:gemini-2.5-flash-lite')).toBe(
      '2.5 Flash-Lite'
    )
    expect(shortModelName('antigravity', '', 'gemini-api:gemini-3.1-flash-tts')).toBe(
      '3.1 Flash TTS'
    )
    // agy-lane ids fall back to the provided label like any other provider.
    expect(shortModelName('antigravity', 'AGY Model', 'agy-model')).toBe('AGY Model')
  })

  it("resolves the cli-default sentinel to each provider's real default", () => {
    expect(shortModelName('codex', '', 'cli-default')).toBe('5.5')
    expect(shortModelName('claude', '', 'cli-default')).toBe('Sonnet 4.6')
    expect(shortModelName('kimi', '', 'cli-default')).toBe('K2.7 Coding')
    expect(shortModelName('grok', '', 'cli-default')).toBe('Grok 4.6 Fast')
    expect(shortModelName('gemini', '', 'cli-default')).toBe('Flash Lite')
    expect(shortModelName('cursor', '', 'cli-default')).toBe('Composer 2.5 Fast')
    expect(shortModelName('ollama', '', 'cli-default')).toBe('Qwen 3 (4B Param)')
  })
})

describe('reasoningDisplayLabel', () => {
  it('Codex xhigh becomes Extra High', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'codex',
        composerStyle: 'codex',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'xhigh'
      })
    ).toBe('Extra High')
  })

  it('Codex low/light becomes Light', () => {
    expect(codexReasoningDisplayLabel('low')).toBe('Light')
    expect(codexReasoningDisplayLabel('light')).toBe('Light')
    expect(
      reasoningDisplayLabel({
        provider: 'codex',
        composerStyle: 'codex',
        modelId: 'gpt-5.4-mini',
        modelLabel: 'GPT-5.4 Mini',
        codexReasoningEffort: 'low'
      })
    ).toBe('Light')
  })

  it('Codex other levels capitalised', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'codex',
        composerStyle: 'codex',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'medium'
      })
    ).toBe('Medium')
  })

  it('Claude high stays High', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Claude Opus 4.7',
        claudeReasoningEffort: 'high'
      })
    ).toBe('High')
  })

  it('Muse Meta /effort labels match the slider ladder (including xhigh)', () => {
    const base = {
      provider: 'muse' as const,
      composerStyle: 'codex' as const,
      modelId: 'muse-spark-1.2',
      modelLabel: 'Muse Spark 1.2'
    }
    expect(reasoningDisplayLabel({ ...base, museReasoningEffort: 'minimal' })).toBe('Minimal')
    expect(reasoningDisplayLabel({ ...base, museReasoningEffort: 'low' })).toBe('Low')
    expect(reasoningDisplayLabel({ ...base, museReasoningEffort: 'xhigh' })).toBe('Extra High')
    expect(reasoningDisplayLabel({ ...base, museReasoningEffort: 'ultra' })).toBe('Ultra')
    expect(reasoningDisplayLabel({ ...base, museReasoningEffort: 'none' })).toBe('')
  })

  it('Claude xhigh and ultracode use TaskWraith labels', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-8-1m',
        modelLabel: 'Claude Opus 4.8 1M',
        claudeReasoningEffort: 'xhigh'
      })
    ).toBe('Extra')
    expect(
      reasoningDisplayLabel({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-8-1m',
        modelLabel: 'Claude Opus 4.8 1M',
        claudeReasoningEffort: 'ultracode'
      })
    ).toBe('Ultracode')
  })

  it('Claude off returns empty', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Claude Opus 4.7',
        claudeReasoningEffort: 'off'
      })
    ).toBe('')
  })

  it('Kimi maps fixed K2.7 thinking to Thinking and K3 effort to its tier', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'kimi',
        composerStyle: 'kimi',
        modelId: 'kimi-k2.7-code',
        modelLabel: 'K2.7 Coding',
        kimiThinkingEnabled: true
      })
    ).toBe('Thinking')
    expect(
      reasoningDisplayLabel({
        provider: 'kimi',
        composerStyle: 'kimi',
        modelId: 'kimi-k2.7-code',
        modelLabel: 'K2.7 Coding',
        kimiThinkingEnabled: false
      })
    ).toBe('')
    expect(
      reasoningDisplayLabel({
        provider: 'kimi',
        composerStyle: 'kimi',
        modelId: 'kimi-k3',
        modelLabel: 'K3',
        kimiReasoningEffort: 'max',
        kimiThinkingEnabled: true
      })
    ).toBe('Max')
  })

  it('Gemini returns empty (no reasoning concept yet)', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'gemini',
        composerStyle: 'gemini',
        modelId: 'gemini-2.5-pro',
        modelLabel: 'Gemini 2.5 Pro'
      })
    ).toBe('')
  })

  it('Grok and Cursor reasoning display for both Grok reasoning-model families', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'grok',
        composerStyle: 'grok',
        modelId: 'grok-4.5',
        modelLabel: 'Grok 4.5',
        grokReasoningEffort: 'high'
      })
    ).toBe('High')
    expect(
      reasoningDisplayLabel({
        provider: 'grok',
        composerStyle: 'grok',
        modelId: 'grok-4.6',
        modelLabel: 'Grok 4.6 Fast',
        grokReasoningEffort: 'xhigh'
      })
    ).toBe('Extra High')
    expect(
      reasoningDisplayLabel({
        provider: 'grok',
        composerStyle: 'grok',
        modelId: 'grok-composer-2.5-fast',
        modelLabel: 'Grok Composer 2.5 Fast',
        grokReasoningEffort: 'high'
      })
    ).toBe('')
    expect(
      reasoningDisplayLabel({
        provider: 'cursor',
        composerStyle: 'cursor',
        modelId: 'grok-4.5',
        modelLabel: 'Cursor Grok 4.5',
        cursorReasoningEffort: 'medium'
      })
    ).toBe('Medium')
    expect(
      reasoningDisplayLabel({
        provider: 'cursor',
        composerStyle: 'cursor',
        modelId: 'cursor-grok-4.6-xhigh-fast',
        modelLabel: 'Cursor Grok 4.6',
        cursorReasoningEffort: 'xhigh'
      })
    ).toBe('Extra High')
    expect(
      reasoningDisplayLabel({
        provider: 'cursor',
        composerStyle: 'cursor',
        modelId: 'composer-2.5-fast',
        modelLabel: 'Composer 2.5 Fast',
        cursorReasoningEffort: 'medium'
      })
    ).toBe('')
  })

  it('Mistral Medium 3.5 (and Pi BYOK mirror) show locked High; Devstral stays blank', () => {
    expect(
      reasoningDisplayLabel({
        provider: 'mistral',
        composerStyle: 'claude',
        modelId: 'mistral-medium-3.5',
        modelLabel: 'Mistral Medium 3.5'
      })
    ).toBe('High')
    expect(
      reasoningDisplayLabel({
        provider: 'pi',
        composerStyle: 'claude',
        modelId: 'mistral/mistral-medium-3.5',
        modelLabel: 'Mistral Medium 3.5'
      })
    ).toBe('High')
    expect(
      reasoningDisplayLabel({
        provider: 'mistral',
        composerStyle: 'claude',
        modelId: 'devstral-small',
        modelLabel: 'Devstral Small'
      })
    ).toBe('')
  })
})

describe('formatComposerModelChip', () => {
  it('Codex shell + codex provider → "5.5 Extra High"', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'codex',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'xhigh'
      })
    ).toBe('5.5 Extra High')
  })

  it('Claude shell + claude provider + high → "Opus 4.7 · High"', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Claude Opus 4.7',
        claudeReasoningEffort: 'high'
      })
    ).toBe('Opus 4.7 · High')
  })

  it('Claude shell + fast + extra → "Opus 4.8 1M · Fast Extra"', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-8-1m',
        modelLabel: 'Claude Opus 4.8 1M',
        claudeReasoningEffort: 'xhigh',
        shellFastModeActive: true
      })
    ).toBe('Opus 4.8 1M · Fast Extra')
  })

  it('Claude shell + fast only → "Opus 4.8 · Fast"', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-8',
        modelLabel: 'Claude Opus 4.8',
        claudeReasoningEffort: 'off',
        shellFastModeActive: true
      })
    ).toBe('Opus 4.8 · Fast')
  })

  it('Claude shell + codex provider + fast + xhigh → "GPT 5.5 · Fast Extra High"', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'claude',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'xhigh',
        shellFastModeActive: true
      })
    ).toBe('GPT 5.5 · Fast Extra High')
  })

  it('Claude shell + codex gpt-5.4 + fast → "GPT 5.4 · Fast"', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'claude',
        modelId: 'gpt-5.4',
        modelLabel: 'GPT-5.4',
        codexReasoningEffort: 'off',
        shellFastModeActive: true
      })
    ).toBe('GPT 5.4 · Fast')
  })

  it('Claude shell + cursor fast model → "Composer 2.5 · Fast"', () => {
    expect(
      formatComposerModelChip({
        provider: 'cursor',
        composerStyle: 'claude',
        modelId: 'composer-2.5-fast',
        modelLabel: 'Composer 2.5 Fast',
        shellFastModeActive: true
      })
    ).toBe('Composer 2.5 · Fast')
  })

  it('TaskWraith shell ignores shell fast mode in chip text', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'default',
        modelId: 'claude-opus-4-8-1m',
        modelLabel: 'Claude Opus 4.8 1M',
        claudeReasoningEffort: 'xhigh',
        shellFastModeActive: true
      })
    ).toBe('Claude Opus 4.8 1M · Extra')
  })

  it('Codex shell ignores shell fast label (uses lightning bolt instead)', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'codex',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'xhigh',
        shellFastModeActive: true
      })
    ).toBe('5.5 Extra High')
  })

  it('Claude shell + claude provider + ultracode → "Opus 4.8 1M · Ultracode"', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-8-1m',
        modelLabel: 'Claude Opus 4.8 1M',
        claudeReasoningEffort: 'ultracode'
      })
    ).toBe('Opus 4.8 1M · Ultracode')
  })

  it('Kimi shell + kimi provider + on → "K2.7 Coding Thinking"', () => {
    expect(
      formatComposerModelChip({
        provider: 'kimi',
        composerStyle: 'kimi',
        modelId: 'kimi-k2.7-code',
        modelLabel: 'K2.7 Coding',
        kimiThinkingEnabled: true
      })
    ).toBe('K2.7 Coding Thinking')
  })

  it('Kimi shell + K3 shows its selected always-on effort', () => {
    expect(
      formatComposerModelChip({
        provider: 'kimi',
        composerStyle: 'kimi',
        modelId: 'kimi-k3',
        modelLabel: 'K3',
        kimiReasoningEffort: 'high',
        kimiThinkingEnabled: true
      })
    ).toBe('K3 High')
  })

  it('TaskWraith native shell + codex provider falls back to "GPT-5.5 · High"', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'default',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'high'
      })
    ).toBe('GPT-5.5 · High')
  })

  it('uses an unprefixed Cursor Grok label and separates High from Fast', () => {
    expect(
      formatComposerModelChip({
        provider: 'cursor',
        composerStyle: 'default',
        modelId: 'grok-4.5',
        modelLabel: 'Cursor Grok 4.5',
        cursorReasoningEffort: 'high',
        shellFastModeActive: true
      })
    ).toBe('Grok 4.5 · High Fast')

    expect(
      formatComposerModelChip({
        provider: 'cursor',
        composerStyle: 'default',
        modelId: 'grok-4.6',
        modelLabel: 'Cursor Grok 4.6',
        cursorReasoningEffort: 'xhigh',
        shellFastModeActive: true
      })
    ).toBe('Grok 4.6 · Extra High Fast')
  })

  it('Creative shells use the default format (no shell-specific match)', () => {
    expect(
      formatComposerModelChip({
        provider: 'codex',
        composerStyle: 'terminal',
        modelId: 'gpt-5.5',
        modelLabel: 'GPT-5.5',
        codexReasoningEffort: 'high'
      })
    ).toBe('GPT-5.5 · High')
  })

  it('Omits reasoning suffix when reasoning is off / empty', () => {
    expect(
      formatComposerModelChip({
        provider: 'claude',
        composerStyle: 'claude',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Claude Opus 4.7',
        claudeReasoningEffort: 'off'
      })
    ).toBe('Opus 4.7')
  })

  it('Mismatched shell + provider falls back to default', () => {
    expect(
      formatComposerModelChip({
        provider: 'kimi',
        composerStyle: 'terminal',
        modelId: 'kimi-k2.7-code',
        modelLabel: 'K2.7 Coding',
        kimiThinkingEnabled: true
      })
    ).toBe('K2.7 Coding · Thinking')
  })
})
