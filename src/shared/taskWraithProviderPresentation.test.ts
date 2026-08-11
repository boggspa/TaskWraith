import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OLLAMA_DISPLAY_BRANDS } from './ollamaBrandTable'
import { PI_UPSTREAM_BRANDS } from './piBrandTable'
import {
  TASKWRAITH_PROVIDER_ACCENTS,
  TASKWRAITH_PROVIDER_ACCENT_ALIASES,
  resolveTaskWraithProviderPresentation,
  taskWraithModelLabel,
  taskWraithProviderAccent
} from './taskWraithProviderPresentation'

describe('TaskWraith TUI provider presentation', () => {
  it('pins every ANSI provider accent to the desktop theme', () => {
    const theme = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')
    for (const [provider, accent] of Object.entries(TASKWRAITH_PROVIDER_ACCENTS)) {
      expect(theme).toContain(`--provider-${provider}-color: ${accent};`)
    }
    for (const [alias, provider] of Object.entries(TASKWRAITH_PROVIDER_ACCENT_ALIASES)) {
      expect(theme).toContain(`--provider-${alias}-color: var(--provider-${provider}-color);`)
      expect(taskWraithProviderAccent(alias)).toBe(
        TASKWRAITH_PROVIDER_ACCENTS[provider as keyof typeof TASKWRAITH_PROVIDER_ACCENTS]
      )
    }
  })

  it('lets every curated Ollama model wear its upstream brand and hue', () => {
    for (const brand of OLLAMA_DISPLAY_BRANDS) {
      const presentation = resolveTaskWraithProviderPresentation('ollama', brand.needles[0])
      expect(presentation.runtimeProvider).toBe('ollama')
      expect(presentation.displayProvider).toBe(brand.providerLabel)
      expect(presentation.hueKey).toBe(brand.providerClass)
      expect(presentation.accent).toBe(taskWraithProviderAccent(brand.providerClass))
    }
  })

  it('lets every curated Pi upstream wear its brand while retaining Pi runtime identity', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const presentation = resolveTaskWraithProviderPresentation('pi', `${upstream}/new-model`)
      expect(presentation.runtimeProvider).toBe('pi')
      expect(presentation.displayProvider).toBe(brand.label)
      expect(presentation.hueKey).toBe(brand.hueClass)
      expect(presentation.accent).toBe(taskWraithProviderAccent(brand.hueClass))
      expect(presentation.modelLabel).toBe('new-model')
    }
  })

  it('falls back to the runtime seat when no spoof is known', () => {
    const ollama = resolveTaskWraithProviderPresentation('ollama', 'private/model')
    const pi = resolveTaskWraithProviderPresentation('pi', 'private/model')
    expect(ollama.displayProvider).toBe('Ollama')
    expect(ollama.accent).toBe(TASKWRAITH_PROVIDER_ACCENTS.ollama)
    expect(pi.displayProvider).toBe('Pi')
    expect(pi.accent).toBe(TASKWRAITH_PROVIDER_ACCENTS.pi)
  })

  it('uses compact desktop-style labels instead of raw wire ids', () => {
    expect(taskWraithModelLabel('claude', 'claude-opus-4-8-1m')).toBe('Opus 4.8 1M')
    expect(taskWraithModelLabel('codex', 'gpt-5.6-sol')).toBe('GPT-5.6-Sol')
    expect(taskWraithModelLabel('kimi', 'kimi-k3')).toBe('K3')
    expect(taskWraithModelLabel('ollama', 'qwen3.5:9b-q4_K_M')).toBe('Qwen 3.5 (9B Param)')
    expect(taskWraithModelLabel('ollama', 'llama3.1:8b')).toBe('Llama 3.1 (8B Param)')
    expect(taskWraithModelLabel('ollama', 'deepseek-r1:8b')).toBe('DeepSeek R1 (8B Param)')
    expect(taskWraithModelLabel('ollama', 'rnj-1:latest')).toBe('Rnj-1 (8B Param)')
    expect(taskWraithModelLabel('ollama', 'glm-4.7-flash:q4_K_M')).toBe(
      'GLM-4.7-Flash (30B-A3B Q4)'
    )
    expect(taskWraithModelLabel('ollama', 'north-mini-code-1.0:q4_K_M')).toBe(
      'North Mini Code 1.0 (30B-A3B Q4)'
    )
    expect(taskWraithModelLabel('ollama', 'muse-glimmer:30b-mlx')).toBe('Muse Glimmer (30B-MLX)')
    expect(taskWraithModelLabel('ollama', 'llama3.2:3b')).toBe('Llama 3.2 (3B Param)')
    for (const [modelId, label] of [
      ['ministral-3:3b', 'Ministral 3 (3B Param)'],
      ['granite4:3b', 'Granite 4.0 (3B Param)'],
      ['qwen3.5:2b', 'Qwen 3.5 (2B Param)'],
      ['deepseek-r1:1.5b', 'DeepSeek R1 (1.5B Param)'],
      ['nemotron-3-nano:4b', 'Nemotron 3 Nano (4B Param)'],
      ['lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking (1.2B Param)'],
      ['gemma3:4b', 'Gemma 3 (4B Param)']
    ]) {
      expect(taskWraithModelLabel('ollama', modelId)).toBe(label)
    }
  })
})
