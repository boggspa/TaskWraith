export type {
  TaskWraithPluginCapabilityKind,
  TaskWraithPluginCompatibility,
  TaskWraithPluginCapability,
  TaskWraithPluginCapabilitySnapshot,
  TaskWraithPluginCapabilityDiff,
  TaskWraithPluginPermissions,
  TaskWraithPluginSecret,
  TaskWraithPluginSecretMutationResult,
  TaskWraithPluginSecretStatus,
  TaskWraithPluginSecretStatusSnapshot,
  TaskWraithPluginMcpServerPreset,
  TaskWraithPluginToolBundle,
  TaskWraithPluginWorkflowTemplate,
  TaskWraithPluginRuntimeProfile,
  TaskWraithPluginConnectorBinding,
  TaskWraithPluginLocalServiceDefinition,
  TaskWraithPluginProviderSetupMetadata,
  TaskWraithPluginMobileProjectionMetadata,
  TaskWraithPluginMarketplaceMetadata,
  TaskWraithPluginManifestSignature,
  TaskWraithPluginManifest,
  TaskWraithPluginInstallState,
  TaskWraithPluginLifecycleAction,
  TaskWraithPluginLifecycleEvent,
  TaskWraithPluginStateFile,
  TaskWraithPluginUninstallTombstone,
  TaskWraithPluginPreflightIssue,
  TaskWraithPluginPreflightResult,
  TaskWraithPluginTrustResult,
  TaskWraithPluginCatalogEntry,
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginContributionProvenance,
  TaskWraithPluginResourceKind,
  TaskWraithPluginResourceProvenance,
  TaskWraithPluginCleanupAction,
  TaskWraithPluginCleanupManualReviewItem,
  TaskWraithPluginCleanupPlan,
  TaskWraithPluginMaterializedResourceRef,
  TaskWraithPluginMcpServerContribution,
  TaskWraithPluginMcpPresetMaterializationResult,
  TaskWraithPluginActivatedToolBundle,
  TaskWraithPluginActivatedWorkflowTemplate,
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginActivatedLocalService,
  TaskWraithPluginActivatedProviderSetup,
  TaskWraithPluginActivatedMobileProjection,
  TaskWraithPluginActivationSnapshot,
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
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'

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

const MAX_PLUGIN_STRING_LENGTH = 4096
const MAX_PLUGIN_ARRAY_LENGTH = 64
const MAX_PLUGIN_OBJECT_KEYS = 64
const PROVIDER_IDS = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi'
])
const AGENTIC_SERVICE_IDS = new Set([
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'canvasEval',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'mediaRecording'
])
const AGENTIC_SERVICE_POLICIES = new Set(['ask', 'workspace', 'allow', 'deny'])
const CAPABILITY_KINDS = new Set([
  'mcpServers',
  'taskwraithToolBundle',
  'workflowTemplates',
  'runtimeProfiles',
  'connectors',
  'localServices',
  'providerSetup',
  'mobileRemoteProjection'
])
const FILE_SCOPES = new Set(['none', 'workspace-read', 'workspace-write', 'external-path'])
const NETWORK_SCOPES = new Set(['none', 'localhost', 'configured-origin', 'public-web'])
const REMOTE_CAPABILITIES = new Set(['startTurn', 'approve', 'cancelRun', 'viewStatus'])
const PERMISSION_RISKS = new Set(['low', 'medium', 'high', 'signed-elevated'])
const MCP_TRANSPORTS = new Set(['stdio', 'http', 'sse'])
const RUNTIME_WORKSPACE_MODES = new Set(['local', 'worktree', 'container'])
const RUNTIME_NETWORK_POLICIES = new Set(['inherit', 'allow', 'deny'])
const RUNTIME_PERSISTENCE = new Set(['reusable', 'ephemeral'])
const CONNECTOR_KINDS = new Set(['mcp', 'oauth', 'api-key', 'remote', 'desktop-app'])
const SIGNATURE_ALGORITHMS = new Set(['ed25519'])
const PLATFORM_IDS = new Set([
  'android',
  'aix',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'haiku',
  'netbsd',
  'all'
])
const TASKWRAITH_TOOL_NAMES = new Set<string>(TASKWRAITH_MCP_TOOLS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateStringLength(errors: string[], label: string, value: unknown): void {
  if (typeof value === 'string' && value.length > MAX_PLUGIN_STRING_LENGTH) {
    errors.push(`${label} exceeds ${MAX_PLUGIN_STRING_LENGTH} characters.`)
  }
}

function validateArrayCap(errors: string[], label: string, value: unknown): void {
  if (Array.isArray(value) && value.length > MAX_PLUGIN_ARRAY_LENGTH) {
    errors.push(`${label} exceeds ${MAX_PLUGIN_ARRAY_LENGTH} entries.`)
  }
}

function validateObjectCap(errors: string[], label: string, value: unknown): void {
  if (isRecord(value) && Object.keys(value).length > MAX_PLUGIN_OBJECT_KEYS) {
    errors.push(`${label} exceeds ${MAX_PLUGIN_OBJECT_KEYS} keys.`)
  }
}

function validateEnumArray(
  errors: string[],
  label: string,
  value: unknown,
  allowed: ReadonlySet<string>
): void {
  validateArrayCap(errors, label, value)
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      errors.push(`${label} contains unsupported value "${String(item)}".`)
    }
  }
}

function validateRecordKeys(
  errors: string[],
  label: string,
  value: unknown,
  keyPattern: RegExp
): void {
  validateObjectCap(errors, label, value)
  if (!isRecord(value)) return
  for (const [key, rawValue] of Object.entries(value)) {
    if (!keyPattern.test(key)) errors.push(`${label} contains invalid key "${key}".`)
    if (typeof rawValue !== 'string') errors.push(`${label}.${key} must be a string.`)
    validateStringLength(errors, `${label}.${key}`, rawValue)
  }
}

function validateRequiredSecrets(
  errors: string[],
  label: string,
  value: unknown,
  knownSecretIds: ReadonlySet<string>
): void {
  validateArrayCap(errors, label, value)
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'string' || !TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(item)) {
      errors.push(`${label} contains invalid secret id "${String(item)}".`)
      continue
    }
    if (!knownSecretIds.has(item)) {
      errors.push(`${label} references unknown secret "${item}".`)
    }
  }
}

function validateStringArray(errors: string[], label: string, value: unknown): void {
  validateArrayCap(errors, label, value)
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${label} contains invalid string "${String(item)}".`)
      continue
    }
    validateStringLength(errors, label, item)
  }
}

function validateHttpUrl(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) return
  validateStringLength(errors, label, value)
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`${label} must be an http(s) URL.`)
    }
  } catch {
    errors.push(`${label} must be a valid URL.`)
  }
}

function findForbiddenKeys(value: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 8 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.slice(0, MAX_PLUGIN_ARRAY_LENGTH + 1).forEach((item, index) => {
      findForbiddenKeys(item, `${path}[${index}]`, errors, depth + 1)
    })
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`
    if (TASKWRAITH_PLUGIN_FORBIDDEN_MANIFEST_KEYS.has(key)) {
      errors.push(`Manifest key "${nextPath}" is not allowed in declarative plugins.`)
    }
    validateStringLength(errors, nextPath, child)
    findForbiddenKeys(child, nextPath, errors, depth + 1)
  }
}

function trackDuplicateObjectId(
  errors: string[],
  seen: Set<string>,
  kind: string,
  id: unknown,
  label: string
): void {
  if (typeof id !== 'string' || !TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(id)) {
    errors.push(`${label} "${typeof id === 'string' ? id : '(missing)'}" has an invalid id.`)
    return
  }
  const key = `${kind}:${id}`
  if (seen.has(key)) errors.push(`${label} "${id}" is duplicated.`)
  seen.add(key)
}

export function validateTaskWraithPluginManifest(manifest: TaskWraithPluginManifest): string[] {
  const errors: string[] = []
  const objectIds = new Set<string>()
  findForbiddenKeys(manifest, 'manifest', errors)
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
  validateStringLength(errors, 'Plugin id', manifest.id)
  validateStringLength(errors, 'Plugin publisher', manifest.publisher)
  validateStringLength(errors, 'Plugin name', manifest.name)
  validateStringLength(errors, 'Plugin version', manifest.version)
  validateStringLength(errors, 'Plugin description', manifest.description)
  validateEnumArray(errors, 'Compatibility platforms', manifest.compatibility?.platforms, PLATFORM_IDS)
  validateEnumArray(errors, 'Compatibility providers', manifest.compatibility?.providers, PROVIDER_IDS)
  const seenCapabilityIds = new Set<string>()
  validateArrayCap(errors, 'Capabilities', manifest.capabilities)
  for (const capability of manifest.capabilities ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'capability', capability.id, 'Capability')
    if (!TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(capability.id)) {
      errors.push(`Capability "${capability.id || '(missing)'}" has an invalid id.`)
    }
    if (seenCapabilityIds.has(capability.id)) {
      errors.push(`Capability "${capability.id}" is duplicated.`)
    }
    if (!CAPABILITY_KINDS.has(capability.kind)) {
      errors.push(`Capability "${capability.id}" has unsupported kind "${String(capability.kind)}".`)
    }
    if (capability.risk && !PERMISSION_RISKS.has(capability.risk)) {
      errors.push(`Capability "${capability.id}" has unsupported risk "${String(capability.risk)}".`)
    }
    validateEnumArray(errors, `Capability "${capability.id}" agentic services`, capability.agenticServices, AGENTIC_SERVICE_IDS)
    validateEnumArray(errors, `Capability "${capability.id}" file scopes`, capability.fileScopes, FILE_SCOPES)
    validateEnumArray(errors, `Capability "${capability.id}" network scopes`, capability.networkScopes, NETWORK_SCOPES)
    validateEnumArray(errors, `Capability "${capability.id}" remote capabilities`, capability.remoteCapabilities, REMOTE_CAPABILITIES)
    seenCapabilityIds.add(capability.id)
  }
  validateObjectCap(errors, 'Plugin permissions agentic services', manifest.permissions?.agenticServices)
  if (manifest.permissions?.agenticServices) {
    for (const [service, policy] of Object.entries(manifest.permissions.agenticServices)) {
      if (!AGENTIC_SERVICE_IDS.has(service)) errors.push(`Permission service "${service}" is unsupported.`)
      if (!AGENTIC_SERVICE_POLICIES.has(String(policy))) {
        errors.push(`Permission service "${service}" has unsupported policy "${String(policy)}".`)
      }
    }
  }
  validateEnumArray(errors, 'Plugin permission file scopes', manifest.permissions?.fileScopes, FILE_SCOPES)
  validateEnumArray(errors, 'Plugin permission network scopes', manifest.permissions?.networkScopes, NETWORK_SCOPES)
  validateEnumArray(errors, 'Plugin permission remote capabilities', manifest.permissions?.remoteCapabilities, REMOTE_CAPABILITIES)
  validateArrayCap(errors, 'Secrets', manifest.secrets)
  const knownSecretIds = new Set<string>()
  for (const secret of manifest.secrets ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'secret', secret.id, 'Secret')
    if (typeof secret.id === 'string' && TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(secret.id)) {
      knownSecretIds.add(secret.id)
    }
    if (secret.envVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.envVar)) {
      errors.push(`Secret "${secret.id}" has invalid env var "${secret.envVar}".`)
    }
  }
  validateArrayCap(errors, 'MCP server presets', manifest.mcpServers)
  for (const server of manifest.mcpServers ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'mcpServer', server.id, 'MCP server preset')
    if (!MCP_TRANSPORTS.has(server.transport)) {
      errors.push(`MCP server preset "${server.id}" has unsupported transport "${String(server.transport)}".`)
    }
    if (server.transport === 'stdio' && server.enabledByDefault) {
      errors.push(`MCP server preset "${server.id}" cannot enable stdio by default.`)
    }
    if (server.transport !== 'stdio') validateHttpUrl(errors, `MCP server preset "${server.id}" URL`, server.url)
    validateRecordKeys(errors, `MCP server preset "${server.id}" env`, server.env, /^[A-Za-z_][A-Za-z0-9_]*$/)
    validateRecordKeys(errors, `MCP server preset "${server.id}" headers`, server.headers, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
    if (server.bearerTokenEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnvVar)) {
      errors.push(`MCP server preset "${server.id}" bearer token env var is invalid.`)
    }
    validateRequiredSecrets(
      errors,
      `MCP server preset "${server.id}" required secrets`,
      server.requiredSecrets,
      knownSecretIds
    )
  }
  validateArrayCap(errors, 'TaskWraith tool bundles', manifest.taskwraithToolBundles)
  for (const bundle of manifest.taskwraithToolBundles ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'toolBundle', bundle.id, 'TaskWraith tool bundle')
    validateEnumArray(errors, `TaskWraith tool bundle "${bundle.id}" tools`, bundle.tools, TASKWRAITH_TOOL_NAMES)
  }
  validateArrayCap(errors, 'Workflow templates', manifest.workflowTemplates)
  for (const template of manifest.workflowTemplates ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'workflowTemplate', template.id, 'Workflow template')
    if (template.provider && !PROVIDER_IDS.has(template.provider)) {
      errors.push(`Workflow template "${template.id}" has unsupported provider "${String(template.provider)}".`)
    }
    validateEnumArray(errors, `Workflow template "${template.id}" required tools`, template.requiredTools, TASKWRAITH_TOOL_NAMES)
  }
  validateArrayCap(errors, 'Runtime profiles', manifest.runtimeProfiles)
  for (const profile of manifest.runtimeProfiles ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'runtimeProfile', profile.id, 'Runtime profile')
    if (!PROVIDER_IDS.has(profile.provider)) {
      errors.push(`Runtime profile "${profile.id}" has unsupported provider "${String(profile.provider)}".`)
    }
    if (!RUNTIME_WORKSPACE_MODES.has(profile.workspaceMode)) {
      errors.push(`Runtime profile "${profile.id}" has unsupported workspace mode "${String(profile.workspaceMode)}".`)
    }
    if (profile.networkPolicy && !RUNTIME_NETWORK_POLICIES.has(profile.networkPolicy)) {
      errors.push(`Runtime profile "${profile.id}" has unsupported network policy "${String(profile.networkPolicy)}".`)
    }
    if (profile.persistence && !RUNTIME_PERSISTENCE.has(profile.persistence)) {
      errors.push(`Runtime profile "${profile.id}" has unsupported persistence "${String(profile.persistence)}".`)
    }
    validateObjectCap(errors, `Runtime profile "${profile.id}" env`, profile.env)
  }
  validateArrayCap(errors, 'Connectors', manifest.connectors)
  for (const connector of manifest.connectors ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'connector', connector.id, 'Connector')
    if (!CONNECTOR_KINDS.has(connector.kind)) {
      errors.push(`Connector "${connector.id}" has unsupported kind "${String(connector.kind)}".`)
    }
    validateEnumArray(errors, `Connector "${connector.id}" network scopes`, connector.networkScopes, NETWORK_SCOPES)
    validateRequiredSecrets(
      errors,
      `Connector "${connector.id}" required secrets`,
      connector.requiredSecrets,
      knownSecretIds
    )
  }
  validateArrayCap(errors, 'Local services', manifest.localServices)
  for (const service of manifest.localServices ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'localService', service.id, 'Local service')
    if (Array.isArray(service.ports)) {
      validateArrayCap(errors, `Local service "${service.id}" ports`, service.ports)
      for (const port of service.ports) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`Local service "${service.id}" has invalid port "${String(port)}".`)
        }
      }
    }
    validateHttpUrl(errors, `Local service "${service.id}" health check URL`, service.healthCheck?.url)
    validateStringArray(
      errors,
      `Local service "${service.id}" launch target hints`,
      service.launchTargetHints
    )
  }
  validateArrayCap(errors, 'Provider setup metadata', manifest.providerSetup)
  for (const setup of manifest.providerSetup ?? []) {
    if (!PROVIDER_IDS.has(setup.provider)) {
      errors.push(`Provider setup has unsupported provider "${String(setup.provider)}".`)
    }
  }
  validateArrayCap(errors, 'Mobile remote projection metadata', manifest.mobileRemoteProjection)
  for (const projection of manifest.mobileRemoteProjection ?? []) {
    trackDuplicateObjectId(errors, objectIds, 'remoteProjection', projection.id, 'Remote projection')
    validateEnumArray(errors, `Remote projection "${projection.id}" capabilities`, projection.remoteCapabilities, REMOTE_CAPABILITIES)
  }
  if (manifest.marketplace) {
    validateHttpUrl(errors, 'Marketplace homepage URL', manifest.marketplace.homepageUrl)
    validateHttpUrl(errors, 'Marketplace support URL', manifest.marketplace.supportUrl)
  }
  validateArrayCap(errors, 'Manifest signatures', manifest.signatures)
  const signatureKeys = new Set<string>()
  for (const signature of manifest.signatures ?? []) {
    if (!SIGNATURE_ALGORITHMS.has(String(signature.algorithm))) {
      errors.push(`Manifest signature has unsupported algorithm "${String(signature.algorithm)}".`)
    }
    if (!TASKWRAITH_PLUGIN_COMPONENT_ID_PATTERN.test(signature.keyId)) {
      errors.push(`Manifest signature key id "${signature.keyId || '(missing)'}" is invalid.`)
    }
    if (signatureKeys.has(signature.keyId)) {
      errors.push(`Manifest signature key id "${signature.keyId}" is duplicated.`)
    }
    signatureKeys.add(signature.keyId)
    if (
      typeof signature.signatureBase64 !== 'string' ||
      !signature.signatureBase64.trim() ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signatureBase64.trim())
    ) {
      errors.push(`Manifest signature "${signature.keyId}" must include base64 signature material.`)
    }
    validateStringLength(errors, `Manifest signature "${signature.keyId}"`, signature.signatureBase64)
    validateStringLength(errors, `Manifest signature "${signature.keyId}" signedAt`, signature.signedAt)
  }
  return errors
}
