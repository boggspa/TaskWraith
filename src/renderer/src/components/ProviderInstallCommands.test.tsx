import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskWraithPluginActivatedProviderSetup } from '../../../shared/plugins/PluginTypes'
import { ProviderInstallCommands } from './ProviderInstallCommands'

describe('ProviderInstallCommands', () => {
  it('renders the verified Ollama model commands with version guidance', () => {
    const html = renderToStaticMarkup(<ProviderInstallCommands providerSetup={[]} />)

    for (const command of [
      'ollama run llama3.1:8b',
      'ollama run deepseek-r1:8b',
      'ollama run rnj-1',
      'ollama run glm-4.7-flash:q4_K_M',
      'ollama run north-mini-code-1.0:q4_K_M',
      'ollama run muse-glimmer:30b-mlx',
      'ollama run llama3.2:3b',
      'ollama run ministral-3:3b',
      'ollama run granite4:3b',
      'ollama run qwen3.5:2b',
      'ollama run deepseek-r1:1.5b',
      'ollama run nemotron-3-nano:4b',
      'ollama run lfm2.5-thinking:1.2b',
      'ollama run gemma3:4b'
    ]) {
      expect(html).toContain(command)
    }
    expect(html).toContain('Ollama 0.15.0+')
    expect(html).toContain('Ollama 0.30.10+')
  })

  it('lists the official Mistral Vibe installer for the first-class Vibe seat', () => {
    const html = renderToStaticMarkup(<ProviderInstallCommands providerSetup={[]} />)

    expect(html).toContain('data-provider="mistral"')
    expect(html).toContain('Mistral Vibe')
    expect(html).toContain('curl -LsSf https://mistral.ai/vibe/install.sh | bash')
  })

  it('renders activated plugin provider setup recipes', () => {
    const providerSetup: TaskWraithPluginActivatedProviderSetup[] = [
      {
        id: 'plugin.taskwraith.provider-setup-bundle:providerSetup:codex',
        plugin: {
          pluginId: 'provider-setup-bundle',
          publisher: 'taskwraith',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.taskwraith.provider-setup-bundle',
          manifestHash: 'sha256:setup'
        },
        setup: {
          provider: 'codex',
          label: 'Codex CLI',
          installHint: 'Install Codex through the plugin setup recipe.',
          authHint: 'Run codex login.',
          preflightChecks: ['binary', 'auth', 'mcp']
        },
        pluginProvenance: {
          pluginId: 'provider-setup-bundle',
          publisher: 'taskwraith',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.taskwraith.provider-setup-bundle',
          manifestHash: 'sha256:setup',
          kind: 'providerSetup',
          objectId: 'codex',
          materializedAt: '2026-06-21T18:02:00.000Z'
        }
      }
    ]

    const html = renderToStaticMarkup(<ProviderInstallCommands providerSetup={providerSetup} />)

    expect(html).toContain('Plugin setup recipes')
    expect(html).toContain('Codex CLI')
    expect(html).toContain('Install Codex through the plugin setup recipe.')
    expect(html).toContain('provider-setup-bundle')
  })
})
