import { describe, expect, it } from 'vitest'
import {
  OLLAMA_RUN_PROFILE_PRESETS,
  resolveOllamaRunProfile,
  resolveOllamaThinkingLevel
} from './OllamaRunProfiles'

describe('OllamaRunProfiles', () => {
  it('defaults read-only Ollama runs to Local Scout', () => {
    const profile = resolveOllamaRunProfile({}, 'read_only', 'gpt-oss:latest')
    expect(profile.id).toBe('local_scout')
    expect(profile.reasoningLevel).toBe('medium')
    expect(profile.protocolMode).toBe('native_first')
    expect(profile.keepAlive).toBe('10m')
  })

  it('maps approved shell runs to high-thinking verification profile', () => {
    const profile = resolveOllamaRunProfile({}, 'approved_shell', 'gpt-oss:latest')
    expect(profile.id).toBe('verify_with_shell')
    expect(profile.reasoningLevel).toBe('high')
    expect(profile.numPredictFinal).toBeGreaterThan(profile.numPredictTool || 0)
  })

  it('a per-chat run profile wins over the global default', () => {
    const profile = resolveOllamaRunProfile(
      { ollamaDefaultRunProfile: 'local_scout' },
      'read_only',
      'gpt-oss:latest',
      'verify_with_shell'
    )
    expect(profile.id).toBe('verify_with_shell')
  })

  it('falls back to the global default profile when the chat profile is absent or invalid', () => {
    const settings = { ollamaDefaultRunProfile: 'approved_patcher' as const }
    expect(resolveOllamaRunProfile(settings, 'read_only', 'gpt-oss:latest', undefined).id).toBe(
      'approved_patcher'
    )
    expect(resolveOllamaRunProfile(settings, 'read_only', 'gpt-oss:latest', 'bogus').id).toBe(
      'approved_patcher'
    )
  })

  it('uses larger context caps for known high-context local coding models', () => {
    expect(
      resolveOllamaRunProfile({}, 'provider_parity', 'ornith:35b').contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile({}, 'provider_parity', 'qwen3.6:35b').contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile({}, 'approved_shell', 'ornith:35b').contextCapTokens
    ).toBe(131_072)
    expect(
      resolveOllamaRunProfile({}, 'read_only', 'ornith:35b').contextCapTokens
    ).toBe(65_536)
    expect(
      resolveOllamaRunProfile({}, 'provider_parity', 'gpt-oss:20b').contextCapTokens
    ).toBe(131_072)
    expect(
      resolveOllamaRunProfile({}, 'provider_parity', 'lfm2.5:8b').contextCapTokens
    ).toBe(131_072)
  })

  it('keeps unknown local tags conservative unless the user customizes the cap', () => {
    expect(
      resolveOllamaRunProfile({}, 'provider_parity', 'unknown-local:latest').contextCapTokens
    ).toBe(65_536)
    expect(
      resolveOllamaRunProfile(
        { ollamaRunProfiles: { default: { contextCapTokens: 300_000 } } },
        'provider_parity',
        'unknown-local:latest'
      ).contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile(
        { ollamaRunProfiles: { default: { contextCapTokens: 24_000 } } },
        'provider_parity',
        'ornith:35b'
      ).contextCapTokens
    ).toBe(24_000)
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
      resolveOllamaThinkingLevel('qwen3.5:9b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBeUndefined()
    expect(
      resolveOllamaThinkingLevel('ornith:9b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
    expect(
      resolveOllamaThinkingLevel('ornith:35b', OLLAMA_RUN_PROFILE_PRESETS.local_scout)
    ).toBe('medium')
  })
})
