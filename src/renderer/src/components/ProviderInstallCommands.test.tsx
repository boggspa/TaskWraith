import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskWraithPluginActivatedProviderSetup } from '../../../shared/plugins/PluginTypes'
import { ProviderInstallCommands } from './ProviderInstallCommands'

describe('ProviderInstallCommands', () => {
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
