import { describe, expect, it } from 'vitest'
import {
  OLLAMA_RUN_PROFILE_PRESETS,
  resolveOllamaRunProfile,
  resolveOllamaThinkingLevel
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
    expect(resolveOllamaRunProfile('ornith:35b', 'verify_with_shell').contextCapTokens).toBe(131_072)
    // Default (no selection) now scales to the model window instead of the old
    // local_scout 65_536 ceiling — the whole point of dropping the restriction.
    expect(resolveOllamaRunProfile('ornith:35b').contextCapTokens).toBe(262_144)
    expect(resolveOllamaRunProfile('gpt-oss:20b', 'provider_parity').contextCapTokens).toBe(131_072)
    expect(resolveOllamaRunProfile('lfm2.5:8b', 'provider_parity').contextCapTokens).toBe(131_072)
    expect(resolveOllamaRunProfile('laguna-xs-2.1:q8_0', 'provider_parity').contextCapTokens).toBe(
      262_144
    )
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
    ).toBeUndefined()
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
    // qwen3.5:4b DOES advertise thinking, and is still excluded deliberately:
    // it tracks its generation-mate qwen3.5:9b, which also advertises thinking
    // and is pinned off just below. Flip the pair together or not at all.
    expect(
      resolveOllamaThinkingLevel('qwen3.5:4b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
    expect(
      resolveOllamaThinkingLevel('devstral-small-2:24b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
    expect(
      resolveOllamaThinkingLevel('ministral-3:14b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
  })
})
