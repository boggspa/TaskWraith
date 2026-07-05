export const TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION = 1

export type TaskWraithPluginProviderId =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
export type TaskWraithPluginAgenticServiceId =
  | 'shellCommands'
  | 'fileChanges'
  | 'mcpTools'
  | 'subThreadDelegation'
  | 'canvasInteraction'
  | 'canvasEval'
  | 'crossThreadRead'
  | 'mediaEditing'
  | 'mediaRecording'
export type TaskWraithPluginAgenticServicePolicy = 'ask' | 'workspace' | 'allow' | 'deny'
export type TaskWraithPluginUserMcpServerTransport = 'stdio' | 'http' | 'sse'
export type TaskWraithPluginRuntimeWorkspaceMode = 'local' | 'worktree' | 'container'
export type TaskWraithPluginRuntimeNetworkPolicy = 'inherit' | 'allow' | 'deny'
export type TaskWraithPluginRuntimePersistence = 'reusable' | 'ephemeral'
export type TaskWraithPluginToolName = string
export type TaskWraithPluginPlatform =
  | 'android'
  | 'aix'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'haiku'
  | 'netbsd'

export type TaskWraithPluginSource = 'builtin' | 'local' | 'marketplace'
export type TaskWraithPluginInstallSource = TaskWraithPluginSource | 'unknown'
export type TaskWraithPluginPreflightStatus = 'ready' | 'repairable' | 'blocked'

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
  platforms?: Array<TaskWraithPluginPlatform | 'all'>
  providers?: TaskWraithPluginProviderId[]
}

export interface TaskWraithPluginCapability {
  kind: TaskWraithPluginCapabilityKind
  id: string
  label: string
  description?: string
  risk?: TaskWraithPluginPermissionRisk
  agenticServices?: TaskWraithPluginAgenticServiceId[]
  fileScopes?: TaskWraithPluginFileScope[]
  networkScopes?: TaskWraithPluginNetworkScope[]
  remoteCapabilities?: TaskWraithPluginRemoteCapability[]
}

export interface TaskWraithPluginCapabilitySnapshot {
  id: string
  kind: TaskWraithPluginCapabilityKind
  label: string
  risk?: TaskWraithPluginPermissionRisk
  agenticServices?: TaskWraithPluginAgenticServiceId[]
  fileScopes?: TaskWraithPluginFileScope[]
  networkScopes?: TaskWraithPluginNetworkScope[]
  remoteCapabilities?: TaskWraithPluginRemoteCapability[]
}

export interface TaskWraithPluginCapabilityDiff {
  added: TaskWraithPluginCapabilitySnapshot[]
  removed: TaskWraithPluginCapabilitySnapshot[]
  changed: Array<{
    before: TaskWraithPluginCapabilitySnapshot
    after: TaskWraithPluginCapabilitySnapshot
  }>
}

export interface TaskWraithPluginPermissions {
  agenticServices?: Partial<
    Record<TaskWraithPluginAgenticServiceId, TaskWraithPluginAgenticServicePolicy>
  >
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
  transport: TaskWraithPluginUserMcpServerTransport
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
  tools: TaskWraithPluginToolName[]
}

export interface TaskWraithPluginWorkflowTemplate {
  id: string
  name: string
  description?: string
  prompt: string
  provider?: TaskWraithPluginProviderId
  approvalMode?: string
  requiredTools?: TaskWraithPluginToolName[]
}

export interface TaskWraithPluginRuntimeProfile {
  id: string
  name: string
  provider: TaskWraithPluginProviderId
  scope: 'workspace' | 'global'
  workspaceMode: TaskWraithPluginRuntimeWorkspaceMode
  approvalMode?: string
  agenticServices?: TaskWraithPluginPermissions['agenticServices']
  networkPolicy?: TaskWraithPluginRuntimeNetworkPolicy
  persistence?: TaskWraithPluginRuntimePersistence
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
  /**
   * Declarative hints for matching this service to workspace-discovered launch
   * targets. Plugins never provide commands; TaskWraith re-discovers and starts
   * matching launch targets through the existing approval-gated launch flow.
   */
  launchTargetHints?: string[]
  managedByTaskWraith?: boolean
}

export interface TaskWraithPluginProviderSetupMetadata {
  provider: TaskWraithPluginProviderId
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

export type TaskWraithPluginSignatureAlgorithm = 'ed25519'

export interface TaskWraithPluginManifestSignature {
  algorithm: TaskWraithPluginSignatureAlgorithm
  keyId: string
  signatureBase64: string
  signedAt?: string
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
  signatures?: TaskWraithPluginManifestSignature[]
}

export interface TaskWraithPluginInstallState {
  installed: boolean
  enabled: boolean
  source: TaskWraithPluginInstallSource
  installedAt?: string
  updatedAt?: string
  version?: string
  manifestHash?: string
  capabilities?: TaskWraithPluginCapabilitySnapshot[]
}

export type TaskWraithPluginLifecycleAction =
  | 'install'
  | 'enable'
  | 'disable'
  | 'update'
  | 'uninstall'
  | 'materialize-mcp-preset'

export interface TaskWraithPluginLifecycleEvent {
  id: string
  pluginId: string
  action: TaskWraithPluginLifecycleAction
  timestamp: string
  source: TaskWraithPluginInstallSource
  version?: string
  manifestHash?: string
  enabled?: boolean
  objectKind?: TaskWraithPluginResourceKind
  objectId?: string
  capabilityDiff?: TaskWraithPluginCapabilityDiff
  result?: 'applied' | 'prepared' | 'blocked'
  message?: string
}

export interface TaskWraithPluginUninstallTombstone {
  pluginId: string
  publisher?: string
  name?: string
  version?: string
  source: TaskWraithPluginInstallSource
  namespace?: string
  manifestHash?: string
  installedAt?: string
  updatedAt?: string
  uninstalledAt: string
  enabledAtUninstall: boolean
  capabilities?: TaskWraithPluginCapabilitySnapshot[]
}

export interface TaskWraithPluginStateFile {
  schemaVersion: 1
  plugins: Record<string, TaskWraithPluginInstallState>
  tombstones?: Record<string, TaskWraithPluginUninstallTombstone>
  lifecycleEvents?: TaskWraithPluginLifecycleEvent[]
}

export interface TaskWraithPluginPreflightIssue {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export interface TaskWraithPluginPreflightResult {
  status: TaskWraithPluginPreflightStatus
  issues: TaskWraithPluginPreflightIssue[]
}

export type TaskWraithPluginTrustStatus = 'trusted' | 'unsigned' | 'untrusted' | 'invalid'

export interface TaskWraithPluginTrustResult {
  status: TaskWraithPluginTrustStatus
  source: TaskWraithPluginSource
  reason: string
  keyId?: string
  algorithm?: TaskWraithPluginSignatureAlgorithm
  signedAt?: string
}

export interface TaskWraithPluginSecretStatus {
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

export interface TaskWraithPluginSecretStatusSnapshot {
  schemaVersion: 1
  generatedAt: string
  encryptionAvailable: boolean
  secrets: TaskWraithPluginSecretStatus[]
}

export interface TaskWraithPluginSecretMutationResult {
  ok: boolean
  error?: string
  snapshot?: TaskWraithPluginSecretStatusSnapshot
}

export interface TaskWraithPluginCatalogEntry {
  manifest: TaskWraithPluginManifest
  source: TaskWraithPluginSource
  namespace: string
  manifestHash: string
  trust: TaskWraithPluginTrustResult
  installed: boolean
  enabled: boolean
  installState?: TaskWraithPluginInstallState
  tombstone?: TaskWraithPluginUninstallTombstone
  preflight: TaskWraithPluginPreflightResult
  update?: {
    status: 'current' | 'available'
    installedVersion?: string
    availableVersion: string
    installedManifestHash?: string
    availableManifestHash: string
    capabilityDiff?: TaskWraithPluginCapabilityDiff
  }
}

export interface TaskWraithPluginCatalogSnapshot {
  schemaVersion: 1
  generatedAt: string
  plugins: TaskWraithPluginCatalogEntry[]
  counts: {
    available: number
    installed: number
    enabled: number
    blocked: number
    repairable: number
    byCapability: Partial<Record<TaskWraithPluginCapabilityKind, number>>
  }
}

export interface TaskWraithPluginContributionProvenance {
  pluginId: string
  publisher: string
  version: string
  source: TaskWraithPluginSource
  namespace: string
  manifestHash: string
}

export type TaskWraithPluginResourceKind =
  | 'mcpServer'
  | 'toolBundle'
  | 'workflowTemplate'
  | 'runtimeProfile'
  | 'connector'
  | 'localService'
  | 'providerSetup'
  | 'remoteProjection'

export interface TaskWraithPluginResourceProvenance
  extends TaskWraithPluginContributionProvenance {
  kind: TaskWraithPluginResourceKind
  objectId: string
  materializedAt: string
}

export interface TaskWraithPluginMaterializedResourceRef {
  id: string
  kind: TaskWraithPluginResourceKind
  label?: string
  enabled?: boolean
  running?: boolean
  pluginProvenance?: TaskWraithPluginResourceProvenance
}

export interface TaskWraithPluginCleanupAction {
  action: 'disable' | 'stop' | 'remove'
  resource: TaskWraithPluginMaterializedResourceRef
  reason: string
}

export interface TaskWraithPluginCleanupManualReviewItem {
  resource: TaskWraithPluginMaterializedResourceRef
  reason: string
}

export interface TaskWraithPluginCleanupPlan {
  pluginId: string
  actions: TaskWraithPluginCleanupAction[]
  manualReview: TaskWraithPluginCleanupManualReviewItem[]
}

export interface TaskWraithPluginUserMcpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: TaskWraithPluginUserMcpServerTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  secretRefs?: {
    env?: string[]
    headers?: string[]
  }
  bearerTokenEnvVar?: string
  description?: string
  pluginProvenance?: TaskWraithPluginResourceProvenance
  createdAt?: string
  updatedAt?: string
}

export interface TaskWraithPluginMcpServerContribution {
  plugin: TaskWraithPluginContributionProvenance
  preset: TaskWraithPluginMcpServerPreset
  userMcpServerConfig: TaskWraithPluginUserMcpServerConfig
}

export interface TaskWraithPluginMcpPresetMaterializationResult {
  plugin: TaskWraithPluginContributionProvenance
  preset: TaskWraithPluginMcpServerPreset
  userMcpServerConfig: TaskWraithPluginUserMcpServerConfig
}

export interface TaskWraithPluginContributionSnapshot {
  schemaVersion: 1
  generatedAt: string
  mcpServers: TaskWraithPluginMcpServerContribution[]
  taskwraithToolBundles: Array<{
    plugin: TaskWraithPluginContributionProvenance
    bundle: TaskWraithPluginToolBundle
  }>
  workflowTemplates: Array<{
    plugin: TaskWraithPluginContributionProvenance
    template: TaskWraithPluginWorkflowTemplate
  }>
  runtimeProfiles: Array<{
    plugin: TaskWraithPluginContributionProvenance
    profile: TaskWraithPluginRuntimeProfile
    runtimeProfileId: string
  }>
  connectors: Array<{
    plugin: TaskWraithPluginContributionProvenance
    connector: TaskWraithPluginConnectorBinding
  }>
  localServices: Array<{
    plugin: TaskWraithPluginContributionProvenance
    service: TaskWraithPluginLocalServiceDefinition
    serviceId: string
  }>
  providerSetup: Array<{
    plugin: TaskWraithPluginContributionProvenance
    setup: TaskWraithPluginProviderSetupMetadata
  }>
  mobileRemoteProjection: Array<{
    plugin: TaskWraithPluginContributionProvenance
    projection: TaskWraithPluginMobileProjectionMetadata
    projectionId: string
  }>
  counts: {
    enabledPlugins: number
    mcpServers: number
    taskwraithToolBundles: number
    workflowTemplates: number
    runtimeProfiles: number
    connectors: number
    localServices: number
    providerSetup: number
    mobileRemoteProjection: number
  }
}

export interface TaskWraithPluginActivatedToolBundle {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  bundle: TaskWraithPluginToolBundle
  pluginProvenance: TaskWraithPluginResourceProvenance
}

export interface TaskWraithPluginActivatedWorkflowTemplate {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  template: TaskWraithPluginWorkflowTemplate
  pluginProvenance: TaskWraithPluginResourceProvenance
}

export interface TaskWraithPluginActivatedConnector {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  connector: TaskWraithPluginConnectorBinding
  pluginProvenance: TaskWraithPluginResourceProvenance
}

export interface TaskWraithPluginActivatedLocalService {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  service: TaskWraithPluginLocalServiceDefinition
  pluginProvenance: TaskWraithPluginResourceProvenance
  enabled: boolean
  running: boolean
  managedByTaskWraith: boolean
}

export interface TaskWraithPluginActivatedProviderSetup {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  setup: TaskWraithPluginProviderSetupMetadata
  pluginProvenance: TaskWraithPluginResourceProvenance
}

export interface TaskWraithPluginActivatedMobileProjection {
  id: string
  plugin: TaskWraithPluginContributionProvenance
  projection: TaskWraithPluginMobileProjectionMetadata
  pluginProvenance: TaskWraithPluginResourceProvenance
  enabled: boolean
}

export interface TaskWraithPluginActivationSnapshot {
  schemaVersion: 1
  generatedAt: string
  mcpServers: TaskWraithPluginUserMcpServerConfig[]
  runtimeProfileIds: string[]
  taskwraithToolBundles: TaskWraithPluginActivatedToolBundle[]
  workflowTemplates: TaskWraithPluginActivatedWorkflowTemplate[]
  connectors: TaskWraithPluginActivatedConnector[]
  localServices: TaskWraithPluginActivatedLocalService[]
  providerSetup: TaskWraithPluginActivatedProviderSetup[]
  mobileRemoteProjection: TaskWraithPluginActivatedMobileProjection[]
  materializedResources: TaskWraithPluginMaterializedResourceRef[]
  counts: {
    enabledPlugins: number
    mcpServers: number
    runtimeProfiles: number
    taskwraithToolBundles: number
    workflowTemplates: number
    connectors: number
    localServices: number
    providerSetup: number
    mobileRemoteProjection: number
  }
}

export const TASKWRAITH_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,127}$/
export const TASKWRAITH_PLUGIN_PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,95}$/

export function pluginToolNamespace(
  manifest: Pick<TaskWraithPluginManifest, 'publisher' | 'id'>
): string {
  return `plugin.${manifest.publisher}.${manifest.id}`
}
