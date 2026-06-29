import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskWraithPluginCatalogEntry } from '../../../shared/plugins/PluginTypes'
import {
  SETTINGS_TABS,
  getVisibleSettingsTabs,
  pluginMcpPresetServerId,
  pluginSettingsActionState,
  pluginSettingsEntryMatchesQuery,
  pluginSettingsProvenancePayload,
  settingsTabMatchesQuery
} from './SettingsPanel'
import { SettingsSidebar } from './SettingsSidebar'

function makePluginEntry(
  overrides: Partial<TaskWraithPluginCatalogEntry> = {}
): TaskWraithPluginCatalogEntry {
  const base: TaskWraithPluginCatalogEntry = {
    manifest: {
      schemaVersion: 1,
      id: 'github-dev-bundle',
      publisher: 'taskwraith',
      name: 'GitHub Dev Bundle',
      version: '1.2.3',
      description: 'GitHub MCP presets and review workflow templates.',
      capabilities: [
        {
          kind: 'mcpServers',
          id: 'github-mcp',
          label: 'GitHub MCP',
          description: 'GitHub issue and pull request tools.',
          agenticServices: ['mcpTools'],
          fileScopes: ['workspace-read'],
          networkScopes: ['configured-origin'],
          remoteCapabilities: ['viewStatus']
        }
      ],
      mcpServers: [
        {
          id: 'github',
          name: 'GitHub',
          transport: 'http',
          url: 'https://api.github.example/mcp',
          enabledByDefault: false
        }
      ],
      marketplace: {
        category: 'Developer tools',
        tags: ['github', 'code-review']
      }
    },
    source: 'builtin',
    namespace: 'plugin.taskwraith.github-dev-bundle',
    manifestHash: 'sha256:abc123',
    installed: false,
    enabled: false,
    preflight: {
      status: 'ready',
      issues: []
    }
  }

  return {
    ...base,
    ...overrides,
    manifest: {
      ...base.manifest,
      ...(overrides.manifest || {})
    },
    preflight: {
      ...base.preflight,
      ...(overrides.preflight || {})
    }
  }
}

describe('Settings Plugins UI helpers', () => {
  it('exposes Plugins in settings navigation and search aliases', () => {
    const tabsById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab]))
    const html = renderToStaticMarkup(
      <SettingsSidebar
        activeTab="plugins"
        onTabChange={vi.fn()}
        onBackToApp={vi.fn()}
        appVersion="1.1.0"
      />
    )

    expect(getVisibleSettingsTabs().map((tab) => tab.id)).toContain('plugins')
    expect(tabsById.plugins?.label).toBe('Plugins')
    expect(settingsTabMatchesQuery(tabsById.plugins, 'marketplace')).toBe(true)
    expect(settingsTabMatchesQuery(tabsById.plugins, 'connectors')).toBe(true)
    expect(html).toContain('Plugins')
    expect(html).toContain('aria-selected="true"')
  })

  it('filters plugin rows by publisher, capability, tags, lifecycle, and update state', () => {
    const entry = makePluginEntry({
      installed: true,
      enabled: false,
      update: {
        status: 'available',
        installedVersion: '1.2.2',
        availableVersion: '1.2.3',
        installedManifestHash: 'sha256:old',
        availableManifestHash: 'sha256:abc123'
      }
    })

    expect(pluginSettingsEntryMatchesQuery(entry, 'taskwraith')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'pull request tools')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'code-review')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'installed')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'update available')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'figma')).toBe(false)
  })

  it('keeps blocked plugins from installing, enabling, or adding MCP presets', () => {
    const entry = makePluginEntry({
      installed: true,
      enabled: false,
      preflight: {
        status: 'blocked',
        issues: [{ severity: 'error', code: 'missing-secret', message: 'Missing token' }]
      }
    })

    const state = pluginSettingsActionState(entry, [], null)

    expect(state.installDisabled).toBe(true)
    expect(state.enableDisabled).toBe(true)
    expect(state.updateDisabled).toBe(false)
    expect(state.uninstallDisabled).toBe(false)
    expect(state.mcpPresets.github.disabled).toBe(true)
  })

  it('blocks enablement and preset materialization while an installed plugin has an update diff', () => {
    const entry = makePluginEntry({
      installed: true,
      enabled: false,
      update: {
        status: 'available',
        installedVersion: '1.2.2',
        availableVersion: '1.2.3',
        installedManifestHash: 'sha256:old',
        availableManifestHash: 'sha256:abc123',
        capabilityDiff: {
          added: [],
          removed: [],
          changed: []
        }
      }
    })

    const state = pluginSettingsActionState(entry, [], null)

    expect(state.updateAvailable).toBe(true)
    expect(state.enableDisabled).toBe(true)
    expect(state.updateDisabled).toBe(false)
    expect(state.mcpPresets.github.disabled).toBe(true)
  })

  it('marks MCP presets as materialized by provenance-safe server id', () => {
    const entry = makePluginEntry({ installed: true })
    const serverId = pluginMcpPresetServerId('github-dev-bundle', 'github')
    const state = pluginSettingsActionState(entry, [{ id: serverId }], null)

    expect(state.mcpPresets.github.serverId).toBe(serverId)
    expect(state.mcpPresets.github.materialized).toBe(true)
    expect(state.mcpPresets.github.disabled).toBe(true)
  })

  it('renders a compact provenance payload for the provenance JSON details', () => {
    const entry = makePluginEntry({ installed: true, enabled: true })
    const provenance = pluginSettingsProvenancePayload(entry)

    expect(provenance).toMatchObject({
      pluginId: 'github-dev-bundle',
      publisher: 'taskwraith',
      version: '1.2.3',
      source: 'builtin',
      namespace: 'plugin.taskwraith.github-dev-bundle',
      manifestHash: 'sha256:abc123',
      installed: true,
      enabled: true
    })
    expect(provenance.capabilities).toEqual([
      {
        id: 'github-mcp',
        kind: 'mcpServers',
        agenticServices: ['mcpTools'],
        fileScopes: ['workspace-read'],
        networkScopes: ['configured-origin'],
        remoteCapabilities: ['viewStatus']
      }
    ])
  })
})
