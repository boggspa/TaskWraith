import { describe, expect, it } from 'vitest'
import {
  OLLAMA_RUN_PROFILE_PRESETS,
  resolveOllamaRunProfile,
  resolveOllamaThinkingLevel
} from './OllamaRunProfiles'

describe('OllamaRunProfiles', () => {
  it('defaults read-only Ollama runs to Local Scout', () => {
    const profile = resolveOllamaRunProfile({}, 'gpt-oss:latest')
    expect(profile.id).toBe('local_scout')
    expect(profile.reasoningLevel).toBe('medium')
    expect(profile.protocolMode).toBe('native_first')
    expect(profile.keepAlive).toBe('10m')
  })

  it('uses explicit verification run profiles for high-thinking shell verification', () => {
    const profile = resolveOllamaRunProfile(
      { ollamaDefaultRunProfile: 'verify_with_shell' },
      'gpt-oss:latest'
    )
    expect(profile.id).toBe('verify_with_shell')
    expect(profile.reasoningLevel).toBe('high')
    expect(profile.numPredictFinal).toBeGreaterThan(profile.numPredictTool || 0)
  })

  it('a per-chat run profile wins over the global default', () => {
    const profile = resolveOllamaRunProfile(
      { ollamaDefaultRunProfile: 'local_scout' },
      'gpt-oss:latest',
      'verify_with_shell'
    )
    expect(profile.id).toBe('verify_with_shell')
  })

  it('falls back to the global default profile when the chat profile is absent or invalid', () => {
    const settings = { ollamaDefaultRunProfile: 'approved_patcher' as const }
    expect(resolveOllamaRunProfile(settings, 'gpt-oss:latest', undefined).id).toBe(
      'approved_patcher'
    )
    expect(resolveOllamaRunProfile(settings, 'gpt-oss:latest', 'bogus').id).toBe(
      'approved_patcher'
    )
  })

  it('uses larger context caps for known high-context local coding models', () => {
    expect(
      resolveOllamaRunProfile({}, 'ornith:35b', 'provider_parity').contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile({}, 'qwen3.6:35b', 'provider_parity').contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile({}, 'ornith:35b', 'verify_with_shell').contextCapTokens
    ).toBe(131_072)
    expect(
      resolveOllamaRunProfile({}, 'ornith:35b').contextCapTokens
    ).toBe(65_536)
    expect(
      resolveOllamaRunProfile({}, 'gpt-oss:20b', 'provider_parity').contextCapTokens
    ).toBe(131_072)
    expect(
      resolveOllamaRunProfile({}, 'lfm2.5:8b', 'provider_parity').contextCapTokens
    ).toBe(131_072)
  })

  it('keeps unknown local tags conservative unless the user customizes the cap', () => {
    expect(
      resolveOllamaRunProfile({}, 'unknown-local:latest', 'provider_parity').contextCapTokens
    ).toBe(65_536)
    expect(
      resolveOllamaRunProfile(
        { ollamaRunProfiles: { default: { contextCapTokens: 300_000 } } },
        'unknown-local:latest',
        'provider_parity'
      ).contextCapTokens
    ).toBe(262_144)
    expect(
      resolveOllamaRunProfile(
        { ollamaRunProfiles: { default: { contextCapTokens: 24_000 } } },
        'ornith:35b',
        'provider_parity'
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
