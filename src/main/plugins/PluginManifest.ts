export type {
  TaskWraithPluginCapabilityKind,
  TaskWraithPluginCompatibility,
  TaskWraithPluginCapability,
  TaskWraithPluginCapabilitySnapshot,
  TaskWraithPluginCapabilityDiff,
  TaskWraithPluginPermissions,
  TaskWraithPluginSecret,
  TaskWraithPluginMcpServerPreset,
  TaskWraithPluginToolBundle,
  TaskWraithPluginWorkflowTemplate,
  TaskWraithPluginRuntimeProfile,
  TaskWraithPluginConnectorBinding,
  TaskWraithPluginLocalServiceDefinition,
  TaskWraithPluginProviderSetupMetadata,
  TaskWraithPluginMobileProjectionMetadata,
  TaskWraithPluginMarketplaceMetadata,
  TaskWraithPluginManifest,
  TaskWraithPluginInstallState,
  TaskWraithPluginStateFile,
  TaskWraithPluginPreflightIssue,
  TaskWraithPluginPreflightResult,
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginContributionProvenance,
  TaskWraithPluginMcpServerContribution,
  TaskWraithPluginMcpPresetMaterializationResult,
  TaskWraithPluginContributionSnapshot,
  TaskWraithPluginSource,
  TaskWraithPluginUserMcpServerConfig
} from '../../shared/plugins/PluginTypes'
export {
  TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION,
  TASKWRAITH_PLUGIN_ID_PATTERN,
  TASKWRAITH_PLUGIN_PUBLISHER_PATTERN,
  TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN,
  pluginToolNamespace
} from '../../shared/plugins/PluginTypes'
import {
  TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN,
  TASKWRAITH_PLUGIN_ID_PATTERN,
  TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION,
  TASKWRAITH_PLUGIN_PUBLISHER_PATTERN,
  type TaskWraithPluginManifest
} from '../../shared/plugins/PluginTypes'

export const TASKWRAITH_PLUGIN_FORBIDDEN_MANIFEST_KEYS = new Set([
  'install',
  'installScript',
  'postinstall',
  'preinstall',
  'scripts',
  'main',
  'renderer',
  'preload',
  'nativeDaemon',
  'nativeHelper',
  'shellCommand',
  'bridgeMethods',
  'keychainAccess',
  'backgroundElevation'
])

export function validateTaskWraithPluginManifest(manifest: TaskWraithPluginManifest): string[] {
  const errors: string[] = []
  if (manifest.schemaVersion !== TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION) {
    errors.push('Unsupported plugin manifest schema version.')
  }
  if (!TASKWRAITH_PLUGIN_ID_PATTERN.test(manifest.id)) {
    errors.push('Plugin id must be lowercase, DNS-like, and 3-128 characters.')
  }
  if (!TASKWRAITH_PLUGIN_PUBLISHER_PATTERN.test(manifest.publisher)) {
    errors.push('Plugin publisher must be lowercase and URL-safe.')
  }
  if (!manifest.name?.trim()) errors.push('Plugin name is required.')
  if (!manifest.version?.trim()) errors.push('Plugin version is required.')
  if (!manifest.description?.trim()) errors.push('Plugin description is required.')
  for (const key of Object.keys(manifest as unknown as Record<string, unknown>)) {
    if (TASKWRAITH_PLUGIN_FORBIDDEN_MANIFEST_KEYS.has(key)) {
      errors.push(`Manifest key "${key}" is not allowed in declarative plugins.`)
    }
  }
  const seenCapabilityIds = new Set<string>()
  for (const capability of manifest.capabilities ?? []) {
    if (!TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(capability.id)) {
      errors.push(`Capability "${capability.id || '(missing)'}" has an invalid id.`)
    }
    if (seenCapabilityIds.has(capability.id)) {
      errors.push(`Capability "${capability.id}" is duplicated.`)
    }
    seenCapabilityIds.add(capability.id)
  }
  for (const server of manifest.mcpServers ?? []) {
    if (!TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(server.id)) {
      errors.push(`MCP server preset "${server.id || '(missing)'}" has an invalid id.`)
    }
    if (server.transport === 'stdio' && server.enabledByDefault) {
      errors.push(`MCP server preset "${server.id}" cannot enable stdio by default.`)
    }
  }
  return errors
}
