import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginSecretStatusSnapshot
} from '../../../shared/plugins/PluginTypes'
import {
  SETTINGS_TABS,
  getVisibleSettingsTabs,
  pluginConnectorSecretSummaries,
  pluginSettingsCapabilityDiffLines,
  pluginSettingsCapabilityDiffSummary,
  pluginMcpPresetServerId,
  pluginSettingsActionState,
  pluginSettingsEntryMatchesQuery,
  pluginSettingsProvenancePayload,
  pluginSettingsUpdateReviewMessage,
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
    trust: {
      status: 'trusted',
      source: 'builtin',
      reason: 'Built-in plugin manifests are packaged with TaskWraith.'
    },
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
    expect(pluginSettingsEntryMatchesQuery(entry, 'trusted')).toBe(true)
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

  it('keeps untrusted plugin sources from enabling or adding MCP presets', () => {
    const entry = makePluginEntry({
      installed: true,
      trust: {
        status: 'unsigned',
        source: 'local',
        reason: 'local plugin manifest is unsigned.'
      }
    })

    const state = pluginSettingsActionState(entry, [], null)

    expect(state.installDisabled).toBe(false)
    expect(state.enableDisabled).toBe(true)
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

  it('formats plugin update capability diffs for review before acceptance', () => {
    const entry = makePluginEntry({
      installed: true,
      update: {
        status: 'available',
        installedVersion: '1.2.2',
        availableVersion: '1.2.3',
        installedManifestHash: 'sha256:old',
        availableManifestHash: 'sha256:abc123',
        capabilityDiff: {
          added: [{ id: 'qa', kind: 'workflowTemplates', label: 'QA workflow' }],
          removed: [{ id: 'old', kind: 'connectors', label: 'Old connector' }],
          changed: [
            {
              before: { id: 'github-mcp', kind: 'mcpServers', label: 'GitHub MCP' },
              after: { id: 'github-mcp', kind: 'mcpServers', label: 'GitHub MCP Plus' }
            }
          ]
        }
      }
    })

    const lines = pluginSettingsCapabilityDiffLines(entry.update?.capabilityDiff)

    expect(pluginSettingsCapabilityDiffSummary(entry.update?.capabilityDiff)).toBe(
      '1 added · 1 removed · 1 changed'
    )
    expect(lines).toEqual([
      'Added workflowTemplates: QA workflow',
      'Removed connectors: Old connector',
      'Changed mcpServers: GitHub MCP -> mcpServers: GitHub MCP Plus'
    ])
    expect(pluginSettingsUpdateReviewMessage(entry)).toContain('Review plugin update')
    expect(pluginSettingsUpdateReviewMessage(entry)).toContain('Capability changes:')
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
      trust: {
        status: 'trusted',
        source: 'builtin',
        reason: 'Built-in plugin manifests are packaged with TaskWraith.'
      },
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

  it('maps activated connector secret requirements to configured secret rows', () => {
    const connector: TaskWraithPluginActivatedConnector = {
      id: 'plugin:design-tools-bundle:connector:figma-like-design-api',
      plugin: {
        pluginId: 'design-tools-bundle',
        publisher: 'taskwraith',
        version: '1.0.0',
        source: 'builtin',
        namespace: 'plugin.taskwraith.design-tools-bundle',
        manifestHash: 'sha256:design'
      },
      connector: {
        id: 'figma-like-design-api',
        label: 'Design API connector',
        kind: 'api-key',
        requiredSecrets: ['design-api-token'],
        networkScopes: ['configured-origin']
      },
      pluginProvenance: {
        pluginId: 'design-tools-bundle',
        publisher: 'taskwraith',
        version: '1.0.0',
        source: 'builtin',
        namespace: 'plugin.taskwraith.design-tools-bundle',
        manifestHash: 'sha256:design',
        kind: 'connector',
        objectId: 'figma-like-design-api',
        materializedAt: '2026-06-29T12:00:00.000Z'
      }
    }
    const secretStatus: TaskWraithPluginSecretStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: '2026-06-29T12:00:00.000Z',
      encryptionAvailable: true,
      secrets: [
        {
          pluginId: 'design-tools-bundle',
          secretId: 'design-api-token',
          label: 'Design API token',
          required: false,
          configured: true,
          installed: true,
          enabled: true,
          envVar: 'DESIGN_API_TOKEN',
          updatedAt: '2026-06-29T12:01:00.000Z'
        }
      ]
    }

    expect(pluginConnectorSecretSummaries(connector, secretStatus)).toEqual([
      {
        key: 'design-tools-bundle:design-api-token',
        pluginId: 'design-tools-bundle',
        secretId: 'design-api-token',
        label: 'Design API token',
        required: false,
        configured: true,
        installed: true,
        enabled: true,
        envVar: 'DESIGN_API_TOKEN',
        updatedAt: '2026-06-29T12:01:00.000Z'
      }
    ])
  })
})
