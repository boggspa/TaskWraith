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
  })
})
