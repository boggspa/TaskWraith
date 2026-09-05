import { describe, expect, it } from 'vitest'
import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginCapabilityDiff,
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginSecretStatusSnapshot
} from '../../../../shared/plugins/PluginTypes'
import {
  pluginConnectorSecretSummaries,
  pluginMcpPresetServerId,
  pluginSettingsActionState,
  pluginSettingsCapabilityDiffLines,
  pluginSettingsCapabilityDiffSummary,
  pluginSettingsEntryMatchesQuery,
  pluginSettingsProvenancePayload,
  pluginSettingsUpdateReviewMessage
} from './settingsPluginHelpers'

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

function makeConnector(requiredSecrets: string[]): TaskWraithPluginActivatedConnector {
  return {
    id: 'plugin:design-tools-bundle:connector:design-api',
    plugin: {
      pluginId: 'design-tools-bundle',
      publisher: 'taskwraith',
      version: '1.0.0',
      source: 'builtin',
      namespace: 'plugin.taskwraith.design-tools-bundle',
      manifestHash: 'sha256:design'
    },
    connector: {
      id: 'design-api',
      label: 'Design API connector',
      kind: 'api-key',
      requiredSecrets,
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
      objectId: 'design-api',
      materializedAt: '2026-06-29T12:00:00.000Z'
    }
  }
}

const capabilityDiff: TaskWraithPluginCapabilityDiff = {
  added: [{ kind: 'mcpServers', id: 'added-cap', label: 'Added Cap' }],
  removed: [{ kind: 'mcpServers', id: 'removed-cap', label: '' }],
  changed: [
    {
      before: { kind: 'mcpServers', id: 'cap', label: 'Old Cap' },
      after: { kind: 'mcpServers', id: 'cap', label: 'New Cap' }
    }
  ]
}

describe('settingsPluginHelpers', () => {
  it('composes namespaced plugin MCP preset server ids', () => {
    expect(pluginMcpPresetServerId('design-tools-bundle', 'figma')).toBe(
      'plugin:design-tools-bundle:mcp:figma'
    )
  })

  it('returns no secret rows when the connector requires no secrets', () => {
    expect(pluginConnectorSecretSummaries(makeConnector([]), null)).toEqual([])
  })

  it('falls back to secret-id defaults and ignores other plugins statuses', () => {
    const status: TaskWraithPluginSecretStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: '2026-06-29T12:00:00.000Z',
      encryptionAvailable: true,
      secrets: [
        {
          pluginId: 'some-other-plugin',
          secretId: 'design-api-token',
          label: 'Foreign token',
          required: false,
          configured: true,
          installed: true,
          enabled: true
        }
      ]
    }

    expect(pluginConnectorSecretSummaries(makeConnector(['design-api-token']), status)).toEqual([
      {
        key: 'design-tools-bundle:design-api-token',
        pluginId: 'design-tools-bundle',
        secretId: 'design-api-token',
        label: 'design-api-token',
        required: true,
        configured: false,
        installed: false,
        enabled: false
      }
    ])
  })

  it('spreads optional secret metadata only when the status carries it', () => {
    const status: TaskWraithPluginSecretStatusSnapshot = {
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
          description: 'Token for the design API.'
        }
      ]
    }

    const [row] = pluginConnectorSecretSummaries(makeConnector(['design-api-token']), status)
    expect(row).toEqual({
      key: 'design-tools-bundle:design-api-token',
      pluginId: 'design-tools-bundle',
      secretId: 'design-api-token',
      label: 'Design API token',
      required: false,
      configured: true,
      installed: true,
      enabled: true,
      envVar: 'DESIGN_API_TOKEN',
      description: 'Token for the design API.'
    })
    expect(row).not.toHaveProperty('updatedAt')
  })

  it('matches catalog entries by capability label and update state, case-insensitively', () => {
    const entry = makePluginEntry()
    expect(pluginSettingsEntryMatchesQuery(entry, '')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'github mcp')).toBe(true)
    expect(pluginSettingsEntryMatchesQuery(entry, 'update available')).toBe(false)
    expect(pluginSettingsEntryMatchesQuery(entry, 'figma')).toBe(false)

    const withUpdate = makePluginEntry({
      update: {
        status: 'available',
        installedVersion: '1.2.2',
        availableVersion: '1.2.3',
        installedManifestHash: 'sha256:old',
        availableManifestHash: 'sha256:abc123'
      }
    })
    expect(pluginSettingsEntryMatchesQuery(withUpdate, 'UPDATE AVAILABLE')).toBe(true)
  })

  it('renders capability diff lines with kind labels and id fallback', () => {
    expect(pluginSettingsCapabilityDiffLines(undefined)).toEqual([])
    expect(pluginSettingsCapabilityDiffLines(capabilityDiff)).toEqual([
      'Added mcpServers: Added Cap',
      'Removed mcpServers: removed-cap',
      'Changed mcpServers: Old Cap -> mcpServers: New Cap'
    ])
  })

  it('summarizes capability diffs and falls back when nothing changed', () => {
    expect(pluginSettingsCapabilityDiffSummary(undefined)).toBe('No capability-surface changes.')
    expect(pluginSettingsCapabilityDiffSummary({ added: [], removed: [], changed: [] })).toBe(
      'No capability-surface changes.'
    )
    expect(pluginSettingsCapabilityDiffSummary(capabilityDiff)).toBe(
      '1 added · 1 removed · 1 changed'
    )
  })

  it('builds the update review message with and without capability changes', () => {
    expect(pluginSettingsUpdateReviewMessage(makePluginEntry())).toBe(
      'Review plugin update: GitHub Dev Bundle\ninstalled -> 1.2.3\n\nNo capability-surface changes were detected.'
    )

    const withDiff = makePluginEntry({
      update: {
        status: 'available',
        installedVersion: '1.2.2',
        availableVersion: '1.2.3',
        installedManifestHash: 'sha256:old',
        availableManifestHash: 'sha256:abc123',
        capabilityDiff
      }
    })
    const message = pluginSettingsUpdateReviewMessage(withDiff)
    expect(message).toContain('Review plugin update: GitHub Dev Bundle\n1.2.2 -> 1.2.3')
    expect(message).toContain('Capability changes:\n- Added mcpServers: Added Cap')
  })

  it('captures provenance payload fields and defaults absent capability arrays', () => {
    const entry = makePluginEntry({
      manifest: {
        ...makePluginEntry().manifest,
        capabilities: [{ kind: 'mcpServers', id: 'bare', label: 'Bare' }]
      }
    })
    expect(pluginSettingsProvenancePayload(entry)).toEqual({
      pluginId: 'github-dev-bundle',
      publisher: 'taskwraith',
      version: '1.2.3',
      source: 'builtin',
      namespace: 'plugin.taskwraith.github-dev-bundle',
      manifestHash: 'sha256:abc123',
      trust: entry.trust,
      installed: false,
      enabled: false,
      preflight: entry.preflight,
      capabilities: [
        {
          id: 'bare',
          kind: 'mcpServers',
          agenticServices: [],
          fileScopes: [],
          networkScopes: [],
          remoteCapabilities: []
        }
      ]
    })
  })

  it('derives per-preset MCP action state including materialized server ids', () => {
    const entry = makePluginEntry({ installed: true })
    const state = pluginSettingsActionState(entry, [], null)
    expect(state.busy).toBe(false)
    expect(state.installDisabled).toBe(false)
    expect(state.enableDisabled).toBe(false)
    expect(state.mcpPresets.github).toEqual({
      serverId: 'plugin:github-dev-bundle:mcp:github',
      busy: false,
      materialized: false,
      disabled: false
    })

    const materialized = pluginSettingsActionState(
      entry,
      [{ id: 'plugin:github-dev-bundle:mcp:github' }],
      null
    )
    expect(materialized.mcpPresets.github.materialized).toBe(true)
    expect(materialized.mcpPresets.github.disabled).toBe(true)
  })

  it('propagates plugin and preset busy ids into disabled action state', () => {
    const entry = makePluginEntry({ installed: true })
    const pluginBusy = pluginSettingsActionState(entry, [], 'github-dev-bundle')
    expect(pluginBusy.busy).toBe(true)
    expect(pluginBusy.installDisabled).toBe(true)
    expect(pluginBusy.updateDisabled).toBe(true)
    expect(pluginBusy.uninstallDisabled).toBe(true)

    const presetBusy = pluginSettingsActionState(entry, [], 'mcp:github-dev-bundle:github')
    expect(presetBusy.busy).toBe(false)
    expect(presetBusy.mcpPresets.github.busy).toBe(true)
    expect(presetBusy.mcpPresets.github.disabled).toBe(true)
  })

  it('keeps blocked or untrusted entries from installing or enabling', () => {
    const blocked = pluginSettingsActionState(
      makePluginEntry({
        installed: true,
        preflight: {
          status: 'blocked',
          issues: [{ severity: 'error', code: 'missing-secret', message: 'Missing token' }]
        }
      }),
      [],
      null
    )
    expect(blocked.installDisabled).toBe(true)
    expect(blocked.enableDisabled).toBe(true)
    expect(blocked.mcpPresets.github.disabled).toBe(true)

    const untrusted = pluginSettingsActionState(
      makePluginEntry({
        installed: true,
        trust: { status: 'untrusted', source: 'local', reason: 'Unsigned manifest.' }
      }),
      [],
      null
    )
    expect(untrusted.installDisabled).toBe(false)
    expect(untrusted.enableDisabled).toBe(true)
    expect(untrusted.mcpPresets.github.disabled).toBe(true)
  })
})
