import type {
  AgenticServiceId,
  AgenticServicePolicy,
  ProviderId,
  RuntimeNetworkPolicy,
  RuntimePersistence,
  RuntimeWorkspaceMode,
  UserMcpServerTransport
} from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'

export const TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION = 1

export type TaskWraithPluginCapabilityKind =
  | 'mcpServers'
  | 'taskwraithToolBundle'
  | 'workflowTemplates'
  | 'runtimeProfiles'
  | 'connectors'
  | 'localServices'
  | 'providerSetup'
  | 'mobileRemoteProjection'

export type TaskWraithPluginPermissionRisk = 'low' | 'medium' | 'high' | 'signed-elevated'
export type TaskWraithPluginFileScope = 'none' | 'workspace-read' | 'workspace-write' | 'external-path'
export type TaskWraithPluginNetworkScope = 'none' | 'localhost' | 'configured-origin' | 'public-web'
export type TaskWraithPluginRemoteCapability = 'startTurn' | 'approve' | 'cancelRun' | 'viewStatus'

export interface TaskWraithPluginCompatibility {
  minTaskWraithVersion?: string
  maxTaskWraithVersion?: string
  platforms?: Array<NodeJS.Platform | 'all'>
  providers?: ProviderId[]
}

export interface TaskWraithPluginCapability {
  kind: TaskWraithPluginCapabilityKind
  id: string
  label: string
  description?: string
  risk?: TaskWraithPluginPermissionRisk
  agenticServices?: AgenticServiceId[]
  fileScopes?: TaskWraithPluginFileScope[]
  networkScopes?: TaskWraithPluginNetworkScope[]
  remoteCapabilities?: TaskWraithPluginRemoteCapability[]
}

export interface TaskWraithPluginPermissions {
  agenticServices?: Partial<Record<AgenticServiceId, AgenticServicePolicy>>
  networkAccess?: 'allow' | 'deny'
  fileScopes?: TaskWraithPluginFileScope[]
  networkScopes?: TaskWraithPluginNetworkScope[]
  remoteCapabilities?: TaskWraithPluginRemoteCapability[]
}

export interface TaskWraithPluginSecret {
  id: string
  label: string
  envVar?: string
  required?: boolean
  description?: string
}

export interface TaskWraithPluginMcpServerPreset {
  id: string
  name: string
  transport: UserMcpServerTransport
  description?: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  enabledByDefault?: boolean
  requiredSecrets?: string[]
}

export interface TaskWraithPluginToolBundle {
  id: string
  label: string
  description?: string
  tools: TaskWraithMcpToolName[]
}

export interface TaskWraithPluginWorkflowTemplate {
  id: string
  name: string
  description?: string
  prompt: string
  provider?: ProviderId
  approvalMode?: string
  requiredTools?: TaskWraithMcpToolName[]
}

export interface TaskWraithPluginRuntimeProfile {
  id: string
  name: string
  provider: ProviderId
  scope: 'workspace' | 'global'
  workspaceMode: RuntimeWorkspaceMode
  approvalMode?: string
  agenticServices?: TaskWraithPluginPermissions['agenticServices']
  networkPolicy?: RuntimeNetworkPolicy
  persistence?: RuntimePersistence
  mcpProfileId?: string
  env?: Record<string, string>
  description?: string
}

export interface TaskWraithPluginConnectorBinding {
  id: string
  label: string
  kind: 'mcp' | 'oauth' | 'api-key' | 'remote' | 'desktop-app'
  description?: string
  requiredSecrets?: string[]
  networkScopes?: TaskWraithPluginNetworkScope[]
}

export interface TaskWraithPluginLocalServiceDefinition {
  id: string
  label: string
  description?: string
  ports?: number[]
  healthCheck?: {
    url?: string
    commandHint?: string
  }
  managedByTaskWraith?: boolean
}

export interface TaskWraithPluginProviderSetupMetadata {
  provider: ProviderId
  label?: string
  installHint?: string
  authHint?: string
  preflightChecks?: string[]
}

export interface TaskWraithPluginMobileProjectionMetadata {
  id: string
  label: string
  description?: string
  remoteCapabilities: TaskWraithPluginRemoteCapability[]
}

export interface TaskWraithPluginMarketplaceMetadata {
  category: string
  tags: string[]
  displayName?: string
  homepageUrl?: string
  supportUrl?: string
  icon?: string
}

export interface TaskWraithPluginManifest {
  schemaVersion: typeof TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION
  id: string
  publisher: string
  name: string
  version: string
  description: string
  compatibility?: TaskWraithPluginCompatibility
  capabilities: TaskWraithPluginCapability[]
  permissions?: TaskWraithPluginPermissions
  secrets?: TaskWraithPluginSecret[]
  mcpServers?: TaskWraithPluginMcpServerPreset[]
  taskwraithToolBundles?: TaskWraithPluginToolBundle[]
  workflowTemplates?: TaskWraithPluginWorkflowTemplate[]
  runtimeProfiles?: TaskWraithPluginRuntimeProfile[]
  connectors?: TaskWraithPluginConnectorBinding[]
  localServices?: TaskWraithPluginLocalServiceDefinition[]
  providerSetup?: TaskWraithPluginProviderSetupMetadata[]
  mobileRemoteProjection?: TaskWraithPluginMobileProjectionMetadata[]
  marketplace?: TaskWraithPluginMarketplaceMetadata
}

export const TASKWRAITH_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,127}$/
export const TASKWRAITH_PLUGIN_PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,95}$/

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

export function pluginToolNamespace(manifest: Pick<TaskWraithPluginManifest, 'publisher' | 'id'>): string {
  return `plugin.${manifest.publisher}.${manifest.id}`
}

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
