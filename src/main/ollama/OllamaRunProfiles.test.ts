import { describe, expect, it } from 'vitest'
import {
  OLLAMA_RUN_PROFILE_PRESETS,
  resolveOllamaRunProfile,
  resolveOllamaThinkingLevel,
  resolveOllamaTurnNumPredict
} from './OllamaRunProfiles'

describe('OllamaRunProfiles', () => {
  it('defaults Ollama runs to the full-capability provider_parity preset (never local_scout)', () => {
    // The global run-profile settings surface is gone; absent a per-participant
    // selection, a run must NOT be pinned to the restrictive local_scout.
    const profile = resolveOllamaRunProfile('gpt-oss:latest')
    expect(profile.id).toBe('provider_parity')
    expect(profile.protocolMode).toBe('native_first')
    expect(profile.keepAlive).toBe('10m')
    // Full tool schemas + higher output budget than local_scout would allow.
    expect(profile.compactToolSchemas).toBe(false)
    expect(profile.numPredictFinal).toBeGreaterThan(
      OLLAMA_RUN_PROFILE_PRESETS.local_scout.numPredictFinal
    )
  })

  it('honors an explicit per-participant run profile selection', () => {
    const profile = resolveOllamaRunProfile('gpt-oss:latest', 'verify_with_shell')
    expect(profile.id).toBe('verify_with_shell')
    expect(profile.reasoningLevel).toBe('high')
    expect(profile.numPredictFinal).toBeGreaterThan(profile.numPredictTool || 0)
  })

  it('falls back to provider_parity when the selection is absent or invalid', () => {
    expect(resolveOllamaRunProfile('gpt-oss:latest', undefined).id).toBe('provider_parity')
    expect(resolveOllamaRunProfile('gpt-oss:latest', 'bogus').id).toBe('provider_parity')
    // 'custom' no longer carries overrides → treated as the default preset.
    expect(resolveOllamaRunProfile('gpt-oss:latest', 'custom').id).toBe('provider_parity')
  })

  it('uses larger context caps for known high-context local coding models', () => {
    expect(resolveOllamaRunProfile('ornith:35b', 'provider_parity').contextCapTokens).toBe(262_144)
    expect(resolveOllamaRunProfile('qwen3.6:35b', 'provider_parity').contextCapTokens).toBe(262_144)
    // 2026-07-30: the working profiles' ceiling rose 131_072 -> 262_144, so a
    // 262K model is capped by ITS OWN window rather than by the profile.
    expect(resolveOllamaRunProfile('ornith:35b', 'verify_with_shell').contextCapTokens).toBe(262_144)
    // Default (no selection) now scales to the model window instead of the old
    // local_scout 65_536 ceiling — the whole point of dropping the restriction.
    expect(resolveOllamaRunProfile('ornith:35b').contextCapTokens).toBe(262_144)
    expect(resolveOllamaRunProfile('gpt-oss:20b', 'provider_parity').contextCapTokens).toBe(131_072)
    expect(resolveOllamaRunProfile('lfm2.5:8b', 'provider_parity').contextCapTokens).toBe(128_000)
    expect(resolveOllamaRunProfile('laguna-xs-2.1:q8_0', 'provider_parity').contextCapTokens).toBe(
      262_144
    )
  })

  it('lets provider_parity exceed 256K where the model genuinely does', () => {
    // devstral measures 393,216 locally and was being clipped to 262,144 by the
    // old OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX. This is also the one case where the
    // working/parity distinction still bites: the working profiles stop at 262,144,
    // parity follows the model.
    expect(
      resolveOllamaRunProfile('devstral-small-2:24b', 'provider_parity').contextCapTokens
    ).toBe(393_216)
    expect(
      resolveOllamaRunProfile('devstral-small-2:24b', 'verify_with_shell').contextCapTokens
    ).toBe(262_144)
  })

  it('sizes all six new tags from their verified daemon windows', () => {
    expect(resolveOllamaRunProfile('llama3.1:8b', 'provider_parity').contextCapTokens).toBe(131_072)
    expect(resolveOllamaRunProfile('deepseek-r1:8b', 'provider_parity').contextCapTokens).toBe(
      131_072
    )
    expect(resolveOllamaRunProfile('rnj-1', 'provider_parity').contextCapTokens).toBe(32_768)
    expect(
      resolveOllamaRunProfile('glm-4.7-flash:q4_K_M', 'provider_parity').contextCapTokens
    ).toBe(202_752)
    expect(
      resolveOllamaRunProfile('north-mini-code-1.0:q4_K_M', 'provider_parity').contextCapTokens
    ).toBe(500_000)
    expect(
      resolveOllamaRunProfile('muse-glimmer:30b-mlx', 'provider_parity').contextCapTokens
    ).toBe(131_072)
    expect(resolveOllamaRunProfile('llama3.2:3b', 'provider_parity').contextCapTokens).toBe(131_072)
  })

  it('keeps local_scout deliberately small even on a huge-window model', () => {
    // Scout trades context for speed on purpose; raising the other ceilings must
    // not drag it up too.
    expect(resolveOllamaRunProfile('devstral-small-2:24b', 'local_scout').contextCapTokens).toBe(
      65_536
    )
  })

  it('rescues an unknown tag from the fallback cap once its window is MEASURED', () => {
    // The family gate exists because an unrecognised tag has no trustworthy window.
    // A daemon reading removes that doubt, so a freshly pulled 262K model no longer
    // sits on a 65_536 preset just because nobody hand-added a family arm.
    expect(
      resolveOllamaRunProfile('unknown-local:latest', 'provider_parity', 262_144).contextCapTokens
    ).toBe(262_144)
    // A measured SMALL window is still respected — this is a ceiling, not a floor.
    expect(
      resolveOllamaRunProfile('unknown-local:latest', 'provider_parity', 8_192).contextCapTokens
    ).toBe(8_192)
    // Junk measurements fall back to the preset rather than widening anything.
    for (const bad of [0, -1, Number.NaN, null, undefined]) {
      expect(
        resolveOllamaRunProfile('unknown-local:latest', 'provider_parity', bad).contextCapTokens
      ).toBe(65_536)
    }
  })

  it('keeps unknown local tags at the preset fallback cap', () => {
    expect(resolveOllamaRunProfile('unknown-local:latest', 'provider_parity').contextCapTokens).toBe(
      65_536
    )
    expect(resolveOllamaRunProfile('unknown-local:latest').contextCapTokens).toBe(65_536)
  })

  it('returns thinking level for Ollama tags that advertise thinking support', () => {
    expect(
      resolveOllamaThinkingLevel('gpt-oss:latest', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('qwen3.6:35b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('minicpm-v4.5:8b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('lfm2.5:8b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('nemotron3:33b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('laguna-xs-2.1:q8_0', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('qwen3.5:9b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('ornith:9b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('ornith:35b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    // Live daemon capabilities, read 2026-07-30: devstral-small-2:24b and
    // ministral-3:14b advertise ["completion","vision","tools"] with NO
    // thinking, so they MUST stay off — Ollama rejects a `think` request
    // outright on a tag that does not advertise it.
    //
    // The qwen3.5 dense sizes all advertise thinking and move together on
    // purpose: splitting them would be a product difference the capabilities
    // do not justify.
    expect(
      resolveOllamaThinkingLevel('qwen3.5:4b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    for (const modelId of [
      'qwen3.5:2b',
      'deepseek-r1:1.5b',
      'nemotron-3-nano:4b',
      'lfm2.5-thinking:1.2b',
      'lfm2.5-thinking',
      'lfm2.5-thinking:latest',
      'deepseek-r1:8b',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'muse-glimmer:30b-mlx'
    ]) {
      expect(resolveOllamaThinkingLevel(modelId, OLLAMA_RUN_PROFILE_PRESETS.local_scout)).toBe(
        'medium'
      )
    }
    for (const modelId of [
      'ministral-3:3b',
      'granite4:3b',
      'gemma3:4b',
      'llama3.1:8b',
      'rnj-1',
      'llama3.2:3b'
    ]) {
      expect(
        resolveOllamaThinkingLevel(modelId, OLLAMA_RUN_PROFILE_PRESETS.local_scout)
      ).toBeUndefined()
    }
    expect(
      resolveOllamaThinkingLevel('devstral-small-2:24b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
    expect(
      resolveOllamaThinkingLevel('ministral-3:14b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
  })

  it('budgets the first turn for the think stream on thinking models only', () => {
    const profile = OLLAMA_RUN_PROFILE_PRESETS.provider_parity
    expect(
      resolveOllamaTurnNumPredict({ toolCallCount: 0, thinkingLevel: null, profile })
    ).toBe(profile.numPredictTool)
    // A thinking first response must hold the think stream plus the tool call;
    // the small tool budget truncates it mid-thought into the degenerate-turn
    // nudge cycle.
    expect(
      resolveOllamaTurnNumPredict({ toolCallCount: 0, thinkingLevel: 'high', profile })
    ).toBe(profile.numPredictFinal)
    expect(
      resolveOllamaTurnNumPredict({ toolCallCount: 2, thinkingLevel: null, profile })
    ).toBe(profile.numPredictFinal)
  })
})
