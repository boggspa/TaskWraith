// Pure plugin-catalog helpers extracted from SettingsPanel.tsx.
//
// Every external dependency here is a type-only import (shared plugin types
// plus one main/store type), so this module adds no renderer -> main runtime
// edge: `import type` is erased at emit and invisible to
// scripts/architecture-guard.cjs.
import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginCapabilityDiff,
  TaskWraithPluginCapabilitySnapshot,
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginSecretStatusSnapshot
} from '../../../../shared/plugins/PluginTypes'
import type { UserMcpServerConfig } from '../../../../main/store/types'

interface PluginConnectorSecretSummary {
  key: string
  pluginId: string
  secretId: string
  label: string
  required: boolean
  configured: boolean
  installed: boolean
  enabled: boolean
  envVar?: string
  description?: string
  updatedAt?: string
}

export function pluginConnectorSecretSummaries(
  connector: TaskWraithPluginActivatedConnector,
  secretStatus: TaskWraithPluginSecretStatusSnapshot | null | undefined
): PluginConnectorSecretSummary[] {
  const requiredSecrets = connector.connector.requiredSecrets || []
  if (requiredSecrets.length === 0) return []
  const statuses = new Map(
    (secretStatus?.secrets || [])
      .filter((secret) => secret.pluginId === connector.plugin.pluginId)
      .map((secret) => [secret.secretId, secret])
  )
  return requiredSecrets.map((secretId) => {
    const status = statuses.get(secretId)
    return {
      key: `${connector.plugin.pluginId}:${secretId}`,
      pluginId: connector.plugin.pluginId,
      secretId,
      label: status?.label || secretId,
      required: status?.required ?? true,
      configured: status?.configured ?? false,
      installed: status?.installed ?? false,
      enabled: status?.enabled ?? false,
      ...(status?.envVar ? { envVar: status.envVar } : {}),
      ...(status?.description ? { description: status.description } : {}),
      ...(status?.updatedAt ? { updatedAt: status.updatedAt } : {})
    }
  })
}

export function pluginMcpPresetServerId(pluginId: string, presetId: string): string {
  return `plugin:${pluginId}:mcp:${presetId}`
}

export function pluginSettingsEntryMatchesQuery(
  entry: TaskWraithPluginCatalogEntry,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    entry.manifest.id,
    entry.manifest.publisher,
    entry.manifest.name,
    entry.manifest.description,
    entry.manifest.marketplace?.category || '',
    ...(entry.manifest.marketplace?.tags || []),
    entry.source,
    entry.namespace,
    entry.trust.status,
    entry.trust.reason,
    entry.preflight.status,
    entry.installed ? 'installed' : 'available',
    entry.enabled ? 'enabled' : 'disabled',
    ...(entry.update?.status === 'available' ? ['update available'] : []),
    ...entry.manifest.capabilities.flatMap((capability) => [
      capability.kind,
      capability.id,
      capability.label,
      capability.description || ''
    ])
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

function pluginSettingsCapabilityName(capability: TaskWraithPluginCapabilitySnapshot): string {
  return `${capability.kind}: ${capability.label || capability.id}`
}

export function pluginSettingsCapabilityDiffLines(
  diff: TaskWraithPluginCapabilityDiff | undefined
): string[] {
  if (!diff) return []
  return [
    ...diff.added.map((capability) => `Added ${pluginSettingsCapabilityName(capability)}`),
    ...diff.removed.map((capability) => `Removed ${pluginSettingsCapabilityName(capability)}`),
    ...diff.changed.map(
      ({ before, after }) =>
        `Changed ${pluginSettingsCapabilityName(before)} -> ${pluginSettingsCapabilityName(after)}`
    )
  ]
}

export function pluginSettingsCapabilityDiffSummary(
  diff: TaskWraithPluginCapabilityDiff | undefined
): string {
  if (!diff) return 'No capability-surface changes.'
  const parts = [
    diff.added.length ? `${diff.added.length} added` : '',
    diff.removed.length ? `${diff.removed.length} removed` : '',
    diff.changed.length ? `${diff.changed.length} changed` : ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'No capability-surface changes.'
}

export function pluginSettingsUpdateReviewMessage(entry: TaskWraithPluginCatalogEntry): string {
  const update = entry.update
  const header = `Review plugin update: ${entry.manifest.name}\n${update?.installedVersion || 'installed'} -> ${update?.availableVersion || entry.manifest.version}`
  const lines = pluginSettingsCapabilityDiffLines(update?.capabilityDiff)
  if (lines.length === 0) return `${header}\n\nNo capability-surface changes were detected.`
  return `${header}\n\nCapability changes:\n${lines.map((line) => `- ${line}`).join('\n')}`
}

export function pluginSettingsProvenancePayload(entry: TaskWraithPluginCatalogEntry): {
  pluginId: string
  publisher: string
  version: string
  source: string
  namespace: string
  manifestHash: string
  trust: TaskWraithPluginCatalogEntry['trust']
  installed: boolean
  enabled: boolean
  preflight: TaskWraithPluginCatalogEntry['preflight']
  capabilities: Array<{
    id: string
    kind: string
    agenticServices: string[]
    fileScopes: string[]
    networkScopes: string[]
    remoteCapabilities: string[]
  }>
} {
  return {
    pluginId: entry.manifest.id,
    publisher: entry.manifest.publisher,
    version: entry.manifest.version,
    source: entry.source,
    namespace: entry.namespace,
    manifestHash: entry.manifestHash,
    trust: entry.trust,
    installed: entry.installed,
    enabled: entry.enabled,
    preflight: entry.preflight,
    capabilities: entry.manifest.capabilities.map((capability) => ({
      id: capability.id,
      kind: capability.kind,
      agenticServices: capability.agenticServices || [],
      fileScopes: capability.fileScopes || [],
      networkScopes: capability.networkScopes || [],
      remoteCapabilities: capability.remoteCapabilities || []
    }))
  }
}

export interface PluginSettingsMcpPresetActionState {
  serverId: string
  busy: boolean
  materialized: boolean
  disabled: boolean
}

export interface PluginSettingsActionState {
  busy: boolean
  updateAvailable: boolean
  installDisabled: boolean
  enableDisabled: boolean
  updateDisabled: boolean
  uninstallDisabled: boolean
  mcpPresets: Record<string, PluginSettingsMcpPresetActionState>
}

export function pluginSettingsActionState(
  entry: TaskWraithPluginCatalogEntry,
  userMcpServers: Pick<UserMcpServerConfig, 'id'>[],
  pluginBusyId: string | null
): PluginSettingsActionState {
  const pluginId = entry.manifest.id
  const busy = pluginBusyId === pluginId
  const updateAvailable = entry.update?.status === 'available'
  const blocked = entry.preflight.status === 'blocked'
  const trusted = entry.trust.status === 'trusted'
  const userMcpServerIds = new Set(userMcpServers.map((server) => server.id))
  const mcpPresets = Object.fromEntries(
    (entry.manifest.mcpServers || []).map((preset) => {
      const serverId = pluginMcpPresetServerId(pluginId, preset.id)
      const presetBusy = pluginBusyId === `mcp:${pluginId}:${preset.id}`
      const materialized = userMcpServerIds.has(serverId)
      return [
        preset.id,
        {
          serverId,
          busy: presetBusy,
          materialized,
          disabled:
            presetBusy || materialized || !entry.installed || updateAvailable || blocked || !trusted
        }
      ]
    })
  )

  return {
    busy,
    updateAvailable,
    installDisabled: busy || blocked,
    enableDisabled: busy || blocked || updateAvailable || !trusted,
    updateDisabled: busy,
    uninstallDisabled: busy,
    mcpPresets
  }
}
