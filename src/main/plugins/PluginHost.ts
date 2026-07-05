import * as fs from 'fs'
import * as path from 'path'
import { createHash, createPublicKey, verify as verifySignature } from 'crypto'
import { BUILT_IN_TASKWRAITH_PLUGIN_MANIFESTS } from './BuiltInPluginCatalog'
import {
  TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION,
  pluginToolNamespace,
  validateTaskWraithPluginManifest,
  type TaskWraithPluginMcpServerPreset,
  type TaskWraithPluginCapabilityKind,
  type TaskWraithPluginCatalogEntry,
  type TaskWraithPluginCatalogSnapshot,
  type TaskWraithPluginContributionProvenance,
  type TaskWraithPluginContributionSnapshot,
  type TaskWraithPluginInstallState,
  type TaskWraithPluginManifest,
  type TaskWraithPluginMcpServerContribution,
  type TaskWraithPluginMcpPresetMaterializationResult,
  type TaskWraithPluginPreflightIssue,
  type TaskWraithPluginPreflightResult,
  type TaskWraithPluginResourceProvenance,
  type TaskWraithPluginSource,
  type TaskWraithPluginStateFile,
  type TaskWraithPluginCapabilityDiff,
  type TaskWraithPluginCapabilitySnapshot,
  type TaskWraithPluginLifecycleEvent,
  type TaskWraithPluginManifestSignature,
  type TaskWraithPluginTrustResult,
  type TaskWraithPluginUninstallTombstone,
  type TaskWraithPluginUserMcpServerConfig,
  type TaskWraithPluginSecret
} from './PluginManifest'

export interface PluginTrustedPublisherKey {
  keyId: string
  publicKeyPem: string
}

export interface PluginHostOptions {
  userDataPath?: string
  pluginsDir?: string
  statePath?: string
  builtInManifests?: TaskWraithPluginManifest[]
  trustedPublisherKeys?: Record<string, PluginTrustedPublisherKey[]>
  now?: () => Date
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  log?: (line: string) => void
}

const EMPTY_STATE: TaskWraithPluginStateFile = {
  schemaVersion: 1,
  plugins: {},
  tombstones: {},
  lifecycleEvents: []
}
const MAX_PLUGIN_STATE_RECORDS = 512
const MAX_PLUGIN_LIFECYCLE_EVENTS = 1024
const PLUGIN_LIFECYCLE_ACTIONS = new Set([
  'install',
  'enable',
  'disable',
  'update',
  'uninstall',
  'materialize-mcp-preset'
])
const PLUGIN_RESOURCE_KINDS = new Set([
  'mcpServer',
  'workflowTemplate',
  'runtimeProfile',
  'connector',
  'localService',
  'remoteProjection'
])
const PLUGIN_EVENT_RESULTS = new Set(['applied', 'prepared', 'blocked'])

function readJson<T>(filePath: string, defaultData: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch (error) {
    console.error(`Failed to read ${filePath}`, error)
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      }
    } catch (backupError) {
      console.error(`Failed to preserve corrupt ${filePath}`, backupError)
    }
  }
  return defaultData
}

function writeJson<T>(filePath: string, data: T): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w')
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(dirFd)
      fs.closeSync(dirFd)
    } catch {
      // Directory fsync is best effort on some filesystems.
    }
  } catch (error) {
    console.error(`Failed to write ${filePath}`, error)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Stale temp files are safer than masking the original failure.
    }
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (typeof child !== 'undefined') output[key] = stableJsonValue(child)
  }
  return output
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function manifestSigningPayload(manifest: TaskWraithPluginManifest): string {
  const { signatures: _signatures, ...unsignedManifest } = manifest
  return stableStringify(unsignedManifest)
}

function manifestContentHash(manifest: TaskWraithPluginManifest): string {
  return createHash('sha256').update(manifestSigningPayload(manifest)).digest('hex')
}

function capabilitySnapshot(manifest: TaskWraithPluginManifest): TaskWraithPluginCapabilitySnapshot[] {
  return (manifest.capabilities ?? []).map((capability) => ({
    id: capability.id,
    kind: capability.kind,
    label: capability.label,
    ...(capability.risk ? { risk: capability.risk } : {}),
    ...(capability.agenticServices ? { agenticServices: [...capability.agenticServices] } : {}),
    ...(capability.fileScopes ? { fileScopes: [...capability.fileScopes] } : {}),
    ...(capability.networkScopes ? { networkScopes: [...capability.networkScopes] } : {}),
    ...(capability.remoteCapabilities
      ? { remoteCapabilities: [...capability.remoteCapabilities] }
      : {})
  }))
}

function capabilitySnapshotKey(capability: TaskWraithPluginCapabilitySnapshot): string {
  return `${capability.kind}:${capability.id}`
}

function diffCapabilitySnapshots(
  before: readonly TaskWraithPluginCapabilitySnapshot[] | undefined,
  after: readonly TaskWraithPluginCapabilitySnapshot[]
): TaskWraithPluginCapabilityDiff | undefined {
  if (!before) return undefined
  const beforeByKey = new Map(before.map((capability) => [capabilitySnapshotKey(capability), capability]))
  const afterByKey = new Map(after.map((capability) => [capabilitySnapshotKey(capability), capability]))
  const added: TaskWraithPluginCapabilitySnapshot[] = []
  const removed: TaskWraithPluginCapabilitySnapshot[] = []
  const changed: TaskWraithPluginCapabilityDiff['changed'] = []
  for (const [key, capability] of afterByKey) {
    const previous = beforeByKey.get(key)
    if (!previous) {
      added.push(capability)
    } else if (stableHash(previous) !== stableHash(capability)) {
      changed.push({ before: previous, after: capability })
    }
  }
  for (const [key, capability] of beforeByKey) {
    if (!afterByKey.has(key)) removed.push(capability)
  }
  return { added, removed, changed }
}

function pluginObjectId(pluginId: string, kind: string, objectId: string): string {
  return `plugin:${pluginId}:${kind}:${objectId}`
}

function isSecretPlaceholder(value: string, envVar: string): boolean {
  return value.trim() === `$${envVar}` || value.trim() === '${' + envVar + '}'
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function pluginMcpSecretRefs(
  secrets: readonly TaskWraithPluginSecret[] | undefined,
  preset: TaskWraithPluginMcpServerPreset
): TaskWraithPluginUserMcpServerConfig['secretRefs'] | undefined {
  if (!Array.isArray(preset.requiredSecrets) || preset.requiredSecrets.length === 0) {
    return undefined
  }
  const secretsById = new Map((secrets ?? []).map((secret) => [secret.id, secret]))
  const envRefs: string[] = []
  const headerRefs: string[] = []
  for (const secretId of preset.requiredSecrets) {
    const secret = secretsById.get(secretId)
    const envVar = secret?.envVar?.trim()
    if (!envVar) continue
    let mapped = false
    for (const [key, value] of Object.entries(preset.env ?? {})) {
      if (isSecretPlaceholder(value, envVar)) {
        envRefs.push(key)
        mapped = true
      }
    }
    for (const [key, value] of Object.entries(preset.headers ?? {})) {
      if (isSecretPlaceholder(value, envVar)) {
        headerRefs.push(key)
        mapped = true
      }
    }
    if (!mapped) envRefs.push(envVar)
  }
  const refs = {
    ...(envRefs.length > 0 ? { env: uniqueStrings(envRefs) } : {}),
    ...(headerRefs.length > 0 ? { headers: uniqueStrings(headerRefs) } : {})
  }
  return Object.keys(refs).length > 0 ? refs : undefined
}

function literalPresetFieldsWithoutSecretPlaceholders(
  fields: Record<string, string> | undefined,
  secrets: readonly TaskWraithPluginSecret[] | undefined,
  preset: TaskWraithPluginMcpServerPreset
): Record<string, string> | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined
  const requiredEnvVars = new Set(
    (preset.requiredSecrets ?? [])
      .map((secretId) => (secrets ?? []).find((secret) => secret.id === secretId)?.envVar?.trim())
      .filter((value): value is string => Boolean(value))
  )
  const entries = Object.entries(fields).filter(
    ([, value]) => !Array.from(requiredEnvVars).some((envVar) => isSecretPlaceholder(value, envVar))
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function toDisabledUserMcpServerConfig(
  pluginId: string,
  pluginName: string,
  preset: TaskWraithPluginMcpServerPreset,
  secrets?: readonly TaskWraithPluginSecret[],
  provenance?: TaskWraithPluginUserMcpServerConfig['pluginProvenance']
): TaskWraithPluginUserMcpServerConfig {
  const env = literalPresetFieldsWithoutSecretPlaceholders(preset.env, secrets, preset)
  const headers = literalPresetFieldsWithoutSecretPlaceholders(preset.headers, secrets, preset)
  const secretRefs = pluginMcpSecretRefs(secrets, preset)
  return {
    id: pluginObjectId(pluginId, 'mcp', preset.id),
    name: `${pluginName}: ${preset.name}`,
    enabled: false,
    transport: preset.transport,
    ...(preset.command ? { command: preset.command } : {}),
    ...(preset.args ? { args: [...preset.args] } : {}),
    ...(preset.url ? { url: preset.url } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    ...(secretRefs ? { secretRefs } : {}),
    ...(preset.bearerTokenEnvVar ? { bearerTokenEnvVar: preset.bearerTokenEnvVar } : {}),
    ...(preset.description ? { description: preset.description } : {}),
    ...(provenance ? { pluginProvenance: provenance } : {})
  }
}

function normalizeInstallState(value: unknown): TaskWraithPluginInstallState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<TaskWraithPluginInstallState>
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities
        .filter(
          (capability): capability is TaskWraithPluginCapabilitySnapshot =>
            Boolean(
              capability &&
                typeof capability.id === 'string' &&
                typeof capability.kind === 'string' &&
                typeof capability.label === 'string'
            )
        )
        .slice(0, 128)
    : undefined
  return {
    installed: input.installed === true,
    enabled: input.installed === true && input.enabled === true,
    source:
      input.source === 'builtin' || input.source === 'local' || input.source === 'marketplace'
        ? input.source
        : 'unknown',
    ...(typeof input.installedAt === 'string' && input.installedAt.trim()
      ? { installedAt: input.installedAt.trim() }
      : {}),
    ...(typeof input.updatedAt === 'string' && input.updatedAt.trim()
      ? { updatedAt: input.updatedAt.trim() }
      : {}),
    ...(typeof input.version === 'string' && input.version.trim()
      ? { version: input.version.trim() }
      : {}),
    ...(typeof input.manifestHash === 'string' && input.manifestHash.trim()
      ? { manifestHash: input.manifestHash.trim() }
      : {}),
    ...(capabilities ? { capabilities } : {})
  }
}

function normalizeLifecycleEvent(value: unknown): TaskWraithPluginLifecycleEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<TaskWraithPluginLifecycleEvent>
  if (!input.id?.trim() || !input.pluginId?.trim() || !input.timestamp?.trim()) return null
  if (typeof input.action !== 'string' || !PLUGIN_LIFECYCLE_ACTIONS.has(input.action)) return null
  return {
    id: input.id.trim(),
    pluginId: input.pluginId.trim(),
    action: input.action,
    timestamp: input.timestamp.trim(),
    source:
      input.source === 'builtin' || input.source === 'local' || input.source === 'marketplace'
        ? input.source
        : 'unknown',
    ...(typeof input.version === 'string' && input.version.trim()
      ? { version: input.version.trim() }
      : {}),
    ...(typeof input.manifestHash === 'string' && input.manifestHash.trim()
      ? { manifestHash: input.manifestHash.trim() }
      : {}),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(typeof input.objectKind === 'string' && PLUGIN_RESOURCE_KINDS.has(input.objectKind)
      ? { objectKind: input.objectKind }
      : {}),
    ...(typeof input.objectId === 'string' && input.objectId.trim()
      ? { objectId: input.objectId.trim() }
      : {}),
    ...(input.capabilityDiff ? { capabilityDiff: input.capabilityDiff } : {}),
    ...(typeof input.result === 'string' && PLUGIN_EVENT_RESULTS.has(input.result)
      ? { result: input.result }
      : {}),
    ...(typeof input.message === 'string' && input.message.trim()
      ? { message: input.message.trim().slice(0, 4096) }
      : {})
  }
}

function normalizeUninstallTombstone(value: unknown): TaskWraithPluginUninstallTombstone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<TaskWraithPluginUninstallTombstone>
  if (!input.pluginId?.trim() || !input.uninstalledAt?.trim()) return null
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities
        .filter(
          (capability): capability is TaskWraithPluginCapabilitySnapshot =>
            Boolean(
              capability &&
                typeof capability.id === 'string' &&
                typeof capability.kind === 'string' &&
                typeof capability.label === 'string'
            )
        )
        .slice(0, 128)
    : undefined
  return {
    pluginId: input.pluginId.trim(),
    ...(typeof input.publisher === 'string' && input.publisher.trim()
      ? { publisher: input.publisher.trim() }
      : {}),
    ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
    ...(typeof input.version === 'string' && input.version.trim()
      ? { version: input.version.trim() }
      : {}),
    source:
      input.source === 'builtin' || input.source === 'local' || input.source === 'marketplace'
        ? input.source
        : 'unknown',
    ...(typeof input.namespace === 'string' && input.namespace.trim()
      ? { namespace: input.namespace.trim() }
      : {}),
    ...(typeof input.manifestHash === 'string' && input.manifestHash.trim()
      ? { manifestHash: input.manifestHash.trim() }
      : {}),
    ...(typeof input.installedAt === 'string' && input.installedAt.trim()
      ? { installedAt: input.installedAt.trim() }
      : {}),
    ...(typeof input.updatedAt === 'string' && input.updatedAt.trim()
      ? { updatedAt: input.updatedAt.trim() }
      : {}),
    uninstalledAt: input.uninstalledAt.trim(),
    enabledAtUninstall: input.enabledAtUninstall === true,
    ...(capabilities ? { capabilities } : {})
  }
}

function normalizePluginStateFile(value: unknown): TaskWraithPluginStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_STATE
  const input = value as Partial<TaskWraithPluginStateFile>
  const rawPlugins =
    input.plugins && typeof input.plugins === 'object' && !Array.isArray(input.plugins)
      ? input.plugins
      : {}
  const plugins: Record<string, TaskWraithPluginInstallState> = {}
  for (const [pluginId, rawState] of Object.entries(rawPlugins).slice(0, MAX_PLUGIN_STATE_RECORDS)) {
    if (!pluginId.trim()) continue
    const state = normalizeInstallState(rawState)
    if (state) plugins[pluginId] = state
  }
  const rawTombstones =
    input.tombstones && typeof input.tombstones === 'object' && !Array.isArray(input.tombstones)
      ? input.tombstones
      : {}
  const tombstones: Record<string, TaskWraithPluginUninstallTombstone> = {}
  for (const [pluginId, rawTombstone] of Object.entries(rawTombstones).slice(
    0,
    MAX_PLUGIN_STATE_RECORDS
  )) {
    if (!pluginId.trim()) continue
    const tombstone = normalizeUninstallTombstone(rawTombstone)
    if (tombstone) tombstones[pluginId] = tombstone
  }
  const lifecycleEvents = Array.isArray(input.lifecycleEvents)
    ? input.lifecycleEvents
        .map(normalizeLifecycleEvent)
        .filter((event): event is TaskWraithPluginLifecycleEvent => Boolean(event))
        .slice(-MAX_PLUGIN_LIFECYCLE_EVENTS)
    : []
  return {
    schemaVersion: 1,
    plugins,
    tombstones,
    lifecycleEvents
  }
}

function jsonFilesInDirectory(directory: string): string[] {
  try {
    if (!fs.existsSync(directory)) return []
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function coerceManifest(value: unknown): TaskWraithPluginManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<TaskWraithPluginManifest>
  if (input.schemaVersion !== TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION) return null
  if (typeof input.id !== 'string' || typeof input.publisher !== 'string') return null
  if (typeof input.name !== 'string' || typeof input.version !== 'string') return null
  if (typeof input.description !== 'string') return null
  return {
    ...input,
    schemaVersion: TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: input.id,
    publisher: input.publisher,
    name: input.name,
    version: input.version,
    description: input.description,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : []
  } as TaskWraithPluginManifest
}

function loadLocalManifests(directory: string, log: (line: string) => void): TaskWraithPluginManifest[] {
  const manifests: TaskWraithPluginManifest[] = []
  for (const filePath of jsonFilesInDirectory(directory)) {
    try {
      const manifest = coerceManifest(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
      if (manifest) manifests.push(manifest)
      else log(`[PluginHost] Ignoring invalid plugin manifest ${filePath}`)
    } catch (error) {
      log(`[PluginHost] Failed to read plugin manifest ${filePath}: ${String(error)}`)
    }
  }
  return manifests
}

export class PluginPreflightService {
  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv
      platform?: NodeJS.Platform
    } = {}
  ) {}

  evaluate(manifest: TaskWraithPluginManifest): TaskWraithPluginPreflightResult {
    const issues: TaskWraithPluginPreflightIssue[] = []
    for (const error of validateTaskWraithPluginManifest(manifest)) {
      issues.push({ severity: 'error', code: 'invalid-manifest', message: error })
    }

    const platform = this.options.platform ?? process.platform
    const platforms = manifest.compatibility?.platforms
    if (
      Array.isArray(platforms) &&
      platforms.length > 0 &&
      !platforms.includes('all') &&
      !platforms.includes(platform)
    ) {
      issues.push({
        severity: 'error',
        code: 'platform-incompatible',
        message: `This plugin does not declare compatibility with ${platform}.`
      })
    }

    const env = this.options.env ?? process.env
    for (const secret of manifest.secrets ?? []) {
      if (secret.required && secret.envVar && !env[secret.envVar]) {
        issues.push({
          severity: 'warning',
          code: 'missing-secret-env',
          message: `${secret.label} requires environment variable ${secret.envVar}.`
        })
      }
    }

    for (const server of manifest.mcpServers ?? []) {
      if (server.transport === 'stdio') {
        issues.push({
          severity: 'info',
          code: 'stdio-requires-explicit-install',
          message: `${server.name} is a stdio MCP preset and will not be auto-enabled.`
        })
      }
      if (server.transport !== 'stdio' && server.enabledByDefault) {
        issues.push({
          severity: 'warning',
          code: 'remote-mcp-requires-review',
          message: `${server.name} requests default enablement and must still be reviewed before activation.`
        })
      }
    }

    const hasErrors = issues.some((issue) => issue.severity === 'error')
    const hasWarnings = issues.some((issue) => issue.severity === 'warning')
    return {
      status: hasErrors ? 'blocked' : hasWarnings ? 'repairable' : 'ready',
      issues
    }
  }
}

export class PluginHost {
  private readonly pluginsDir: string
  private readonly statePath: string
  private readonly builtInManifests: TaskWraithPluginManifest[]
  private readonly trustedPublisherKeys: Record<string, PluginTrustedPublisherKey[]>
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private readonly preflight: PluginPreflightService

  constructor(options: PluginHostOptions = {}) {
    const basePluginsDir =
      options.pluginsDir ||
      (options.userDataPath ? path.join(options.userDataPath, 'plugins') : path.join(process.cwd(), 'plugins'))
    this.pluginsDir = basePluginsDir
    this.statePath = options.statePath || path.join(basePluginsDir, 'plugins.json')
    this.builtInManifests = options.builtInManifests ?? BUILT_IN_TASKWRAITH_PLUGIN_MANIFESTS
    this.trustedPublisherKeys = options.trustedPublisherKeys ?? {}
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => {})
    this.preflight = new PluginPreflightService({
      env: options.env,
      platform: options.platform
    })
  }

  private evaluateManifestTrust(
    manifest: TaskWraithPluginManifest,
    source: TaskWraithPluginSource
  ): TaskWraithPluginTrustResult {
    if (source === 'builtin') {
      return {
        status: 'trusted',
        source,
        reason: 'Built-in plugin manifests are packaged with TaskWraith.'
      }
    }

    const signatures = manifest.signatures ?? []
    if (signatures.length === 0) {
      return {
        status: 'unsigned',
        source,
        reason: `${source} plugin manifest is unsigned.`
      }
    }

    const trustedKeys = this.trustedPublisherKeys[manifest.publisher] ?? []
    let sawTrustedKey = false
    let firstSignature: TaskWraithPluginManifestSignature | undefined
    for (const signature of signatures) {
      firstSignature = firstSignature ?? signature
      const trustedKey = trustedKeys.find((key) => key.keyId === signature.keyId)
      if (!trustedKey) continue
      sawTrustedKey = true
      if (this.verifyManifestSignature(manifest, signature, trustedKey.publicKeyPem)) {
        return {
          status: 'trusted',
          source,
          reason: `Manifest signature verified for publisher ${manifest.publisher}.`,
          keyId: signature.keyId,
          algorithm: signature.algorithm,
          ...(signature.signedAt ? { signedAt: signature.signedAt } : {})
        }
      }
    }

    if (sawTrustedKey) {
      return {
        status: 'invalid',
        source,
        reason: 'Manifest signature did not verify with the trusted publisher key.',
        ...(firstSignature
          ? {
              keyId: firstSignature.keyId,
              algorithm: firstSignature.algorithm,
              ...(firstSignature.signedAt ? { signedAt: firstSignature.signedAt } : {})
            }
          : {})
      }
    }

    return {
      status: 'untrusted',
      source,
      reason: `No trusted publisher key is registered for ${manifest.publisher}.`,
      ...(firstSignature
        ? {
            keyId: firstSignature.keyId,
            algorithm: firstSignature.algorithm,
            ...(firstSignature.signedAt ? { signedAt: firstSignature.signedAt } : {})
          }
        : {})
    }
  }

  private verifyManifestSignature(
    manifest: TaskWraithPluginManifest,
    signature: TaskWraithPluginManifestSignature,
    publicKeyPem: string
  ): boolean {
    if (signature.algorithm !== 'ed25519') return false
    try {
      return verifySignature(
        null,
        Buffer.from(manifestSigningPayload(manifest), 'utf-8'),
        createPublicKey(publicKeyPem),
        Buffer.from(signature.signatureBase64, 'base64')
      )
    } catch {
      return false
    }
  }

  private withTrustPreflightIssues(
    preflight: TaskWraithPluginPreflightResult,
    trust: TaskWraithPluginTrustResult
  ): TaskWraithPluginPreflightResult {
    if (trust.status === 'trusted') return preflight
    const severity = trust.status === 'invalid' ? 'error' : 'warning'
    const issues: TaskWraithPluginPreflightIssue[] = [
      ...preflight.issues,
      {
        severity,
        code: `source-trust-${trust.status}`,
        message: trust.reason
      }
    ]
    const hasErrors = issues.some((issue) => issue.severity === 'error')
    const hasWarnings = issues.some((issue) => issue.severity === 'warning')
    return {
      status: hasErrors ? 'blocked' : hasWarnings ? 'repairable' : 'ready',
      issues
    }
  }

  getCatalogSnapshot(): TaskWraithPluginCatalogSnapshot {
    const state = this.readState()
    const entries = this.getAvailableManifests().map(({ manifest, source }) => {
      const installState = state.plugins[manifest.id]
      const manifestHash = manifestContentHash(manifest)
      const trust = this.evaluateManifestTrust(manifest, source)
      const preflight = this.withTrustPreflightIssues(this.preflight.evaluate(manifest), trust)
      const currentCapabilities = capabilitySnapshot(manifest)
      const update =
        installState?.installed === true
          ? {
              status:
                installState.version !== manifest.version || installState.manifestHash !== manifestHash
                  ? ('available' as const)
                  : ('current' as const),
              ...(installState.version ? { installedVersion: installState.version } : {}),
              availableVersion: manifest.version,
              ...(installState.manifestHash
                ? { installedManifestHash: installState.manifestHash }
                : {}),
              availableManifestHash: manifestHash,
              ...(installState.version !== manifest.version || installState.manifestHash !== manifestHash
                ? {
                    capabilityDiff: diffCapabilitySnapshots(
                      installState.capabilities,
                      currentCapabilities
                    )
                  }
                : {})
            }
          : undefined
      return {
        manifest,
        source,
        namespace: pluginToolNamespace(manifest),
        manifestHash,
        trust,
        installed: installState?.installed === true,
        enabled: installState?.installed === true && installState.enabled === true,
        ...(installState ? { installState } : {}),
        ...(state.tombstones?.[manifest.id] ? { tombstone: state.tombstones[manifest.id] } : {}),
        preflight,
        ...(update ? { update } : {})
      } satisfies TaskWraithPluginCatalogEntry
    })
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      plugins: entries,
      counts: this.countEntries(entries)
    }
  }

  getContributionSnapshot(): TaskWraithPluginContributionSnapshot {
    const catalog = this.getCatalogSnapshot()
    const activeEntries = catalog.plugins.filter(
      (entry) =>
        entry.enabled &&
        entry.trust.status === 'trusted' &&
        entry.preflight.status !== 'blocked' &&
        entry.update?.status !== 'available'
    )
    const provenanceFor = (
      entry: TaskWraithPluginCatalogEntry
    ): TaskWraithPluginContributionProvenance => ({
      pluginId: entry.manifest.id,
      publisher: entry.manifest.publisher,
      version: entry.manifest.version,
      source: entry.source,
      namespace: entry.namespace,
      manifestHash: entry.manifestHash
    })
    const mcpServers: TaskWraithPluginMcpServerContribution[] = []
    const taskwraithToolBundles: TaskWraithPluginContributionSnapshot['taskwraithToolBundles'] = []
    const workflowTemplates: TaskWraithPluginContributionSnapshot['workflowTemplates'] = []
    const runtimeProfiles: TaskWraithPluginContributionSnapshot['runtimeProfiles'] = []
    const connectors: TaskWraithPluginContributionSnapshot['connectors'] = []
    const localServices: TaskWraithPluginContributionSnapshot['localServices'] = []
    const providerSetup: TaskWraithPluginContributionSnapshot['providerSetup'] = []
    const mobileRemoteProjection: TaskWraithPluginContributionSnapshot['mobileRemoteProjection'] = []

    for (const entry of activeEntries) {
      const plugin = provenanceFor(entry)
      for (const preset of entry.manifest.mcpServers ?? []) {
        mcpServers.push({
          plugin,
          preset,
          userMcpServerConfig: toDisabledUserMcpServerConfig(
            entry.manifest.id,
            entry.manifest.name,
            preset,
            entry.manifest.secrets
          )
        })
      }
      for (const bundle of entry.manifest.taskwraithToolBundles ?? []) {
        taskwraithToolBundles.push({ plugin, bundle })
      }
      for (const template of entry.manifest.workflowTemplates ?? []) {
        workflowTemplates.push({ plugin, template })
      }
      for (const profile of entry.manifest.runtimeProfiles ?? []) {
        runtimeProfiles.push({
          plugin,
          profile,
          runtimeProfileId: pluginObjectId(entry.manifest.id, 'runtime', profile.id)
        })
      }
      for (const connector of entry.manifest.connectors ?? []) {
        connectors.push({ plugin, connector })
      }
      for (const service of entry.manifest.localServices ?? []) {
        localServices.push({
          plugin,
          service,
          serviceId: pluginObjectId(entry.manifest.id, 'service', service.id)
        })
      }
      for (const setup of entry.manifest.providerSetup ?? []) {
        providerSetup.push({ plugin, setup })
      }
      for (const projection of entry.manifest.mobileRemoteProjection ?? []) {
        mobileRemoteProjection.push({
          plugin,
          projection,
          projectionId: pluginObjectId(entry.manifest.id, 'remote', projection.id)
        })
      }
    }

    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      mcpServers,
      taskwraithToolBundles,
      workflowTemplates,
      runtimeProfiles,
      connectors,
      localServices,
      providerSetup,
      mobileRemoteProjection,
      counts: {
        enabledPlugins: activeEntries.length,
        mcpServers: mcpServers.length,
        taskwraithToolBundles: taskwraithToolBundles.length,
        workflowTemplates: workflowTemplates.length,
        runtimeProfiles: runtimeProfiles.length,
        connectors: connectors.length,
        localServices: localServices.length,
        providerSetup: providerSetup.length,
        mobileRemoteProjection: mobileRemoteProjection.length
      }
    }
  }

  validateMcpServerProvenance(provenance: TaskWraithPluginResourceProvenance | undefined): {
    ok: boolean
    reason?: string
  } {
    if (!provenance || provenance.kind !== 'mcpServer') {
      return { ok: false, reason: 'mcpServer plugin provenance is required' }
    }
    const entry = this.getCatalogSnapshot().plugins.find(
      (candidate) => candidate.manifest.id === provenance.pluginId
    )
    if (!entry) return { ok: false, reason: 'plugin provenance is not available' }
    if (!entry.installed) return { ok: false, reason: 'plugin is not installed' }
    if (!entry.enabled) return { ok: false, reason: 'plugin is not enabled' }
    if (entry.preflight.status === 'blocked') {
      return { ok: false, reason: 'plugin preflight is blocked' }
    }
    if (entry.trust.status !== 'trusted') {
      return { ok: false, reason: 'plugin source trust is not verified' }
    }
    if (entry.update?.status === 'available') {
      return { ok: false, reason: 'plugin update must be reviewed' }
    }
    if (
      provenance.publisher !== entry.manifest.publisher ||
      provenance.version !== entry.manifest.version ||
      provenance.source !== entry.source ||
      provenance.namespace !== entry.namespace ||
      provenance.manifestHash !== entry.manifestHash
    ) {
      return { ok: false, reason: 'plugin provenance does not match the installed manifest' }
    }
    if (!entry.manifest.mcpServers?.some((preset) => preset.id === provenance.objectId)) {
      return { ok: false, reason: 'mcpServer preset is not available for this plugin' }
    }
    return { ok: true }
  }

  materializeMcpServerPreset(
    pluginId: string,
    presetId: string
  ): TaskWraithPluginMcpPresetMaterializationResult {
    const entry = this.getCatalogSnapshot().plugins.find(
      (candidate) => candidate.manifest.id === pluginId
    )
    if (!entry) throw new Error('Plugin is not available.')
    if (!entry.installed) throw new Error('Plugin must be installed before MCP presets can be added.')
    if (entry.update?.status === 'available') {
      throw new Error('Plugin update must be reviewed before MCP presets can be added.')
    }
    if (entry.preflight.status === 'blocked') {
      throw new Error('Blocked plugins cannot materialize MCP presets.')
    }
    if (entry.trust.status !== 'trusted') {
      throw new Error('Plugin source trust must be verified before MCP presets can be added.')
    }
    const preset = entry.manifest.mcpServers?.find((candidate) => candidate.id === presetId)
    if (!preset) throw new Error('MCP preset is not available for this plugin.')
    const materializedAt = this.now().toISOString()
    const plugin: TaskWraithPluginContributionProvenance = {
      pluginId: entry.manifest.id,
      publisher: entry.manifest.publisher,
      version: entry.manifest.version,
      source: entry.source,
      namespace: entry.namespace,
      manifestHash: entry.manifestHash
    }
    const userMcpServerConfig = toDisabledUserMcpServerConfig(
      entry.manifest.id,
      entry.manifest.name,
      preset,
      entry.manifest.secrets,
      {
        ...plugin,
        kind: 'mcpServer',
        objectId: preset.id,
        materializedAt
      }
    )
    userMcpServerConfig.pluginReview = {
      status: 'pending',
      reason: 'new-plugin-resource',
      manifestHash: entry.manifestHash
    }
    userMcpServerConfig.createdAt = materializedAt
    userMcpServerConfig.updatedAt = materializedAt
    const state = this.readState()
    this.appendLifecycleEvent(state, {
      pluginId: entry.manifest.id,
      action: 'materialize-mcp-preset',
      timestamp: materializedAt,
      source: entry.source,
      version: entry.manifest.version,
      manifestHash: entry.manifestHash,
      objectKind: 'mcpServer',
      objectId: preset.id,
      result: 'prepared'
    })
    this.writeState(state)
    return {
      plugin,
      preset,
      userMcpServerConfig
    }
  }

  installPlugin(pluginId: string): TaskWraithPluginCatalogSnapshot {
    const entry = this.requireAvailableEntry(pluginId)
    const state = this.readState()
    const now = this.now().toISOString()
    const current = state.plugins[entry.manifest.id]
    const manifestHash = manifestContentHash(entry.manifest)
    state.plugins[entry.manifest.id] = {
      installed: true,
      enabled: current?.enabled === true,
      source: entry.source,
      installedAt: current?.installedAt || now,
      updatedAt: now,
      version: entry.manifest.version,
      manifestHash,
      capabilities: capabilitySnapshot(entry.manifest)
    }
    if (state.tombstones?.[entry.manifest.id]) delete state.tombstones[entry.manifest.id]
    this.appendLifecycleEvent(state, {
      pluginId: entry.manifest.id,
      action: 'install',
      timestamp: now,
      source: entry.source,
      version: entry.manifest.version,
      manifestHash,
      enabled: current?.enabled === true,
      result: 'applied'
    })
    this.writeState(state)
    return this.getCatalogSnapshot()
  }

  setPluginEnabled(pluginId: string, enabled: boolean): TaskWraithPluginCatalogSnapshot {
    const entry = this.requireAvailableEntry(pluginId)
    const state = this.readState()
    const current = state.plugins[entry.manifest.id]
    if (!current?.installed) {
      throw new Error('Plugin must be installed before it can be enabled.')
    }
    const manifestHash = manifestContentHash(entry.manifest)
    if (enabled && (current.version !== entry.manifest.version || current.manifestHash !== manifestHash)) {
      throw new Error('Plugin update must be reviewed before enabling this plugin.')
    }
    const preflight = this.preflight.evaluate(entry.manifest)
    const trust = this.evaluateManifestTrust(entry.manifest, entry.source)
    const now = this.now().toISOString()
    const nextEnabled = Boolean(
      enabled && preflight.status !== 'blocked' && trust.status === 'trusted'
    )
    state.plugins[entry.manifest.id] = {
      ...current,
      enabled: nextEnabled,
      updatedAt: now,
      source: entry.source
    }
    this.appendLifecycleEvent(state, {
      pluginId: entry.manifest.id,
      action: enabled ? 'enable' : 'disable',
      timestamp: now,
      source: entry.source,
      version: current.version,
      manifestHash: current.manifestHash,
      enabled: nextEnabled,
      result: enabled && !nextEnabled ? 'blocked' : 'applied',
      ...(enabled && !nextEnabled
        ? {
            message:
              trust.status !== 'trusted'
                ? trust.reason
                : 'Plugin preflight blocked enablement.'
          }
        : {})
    })
    this.writeState(state)
    return this.getCatalogSnapshot()
  }

  updatePlugin(pluginId: string): TaskWraithPluginCatalogSnapshot {
    const entry = this.requireAvailableEntry(pluginId)
    const state = this.readState()
    const current = state.plugins[entry.manifest.id]
    if (!current?.installed) throw new Error('Plugin must be installed before it can be updated.')
    const preflight = this.preflight.evaluate(entry.manifest)
    const now = this.now().toISOString()
    const capabilities = capabilitySnapshot(entry.manifest)
    const manifestHash = manifestContentHash(entry.manifest)
    const capabilityDiff = diffCapabilitySnapshots(current.capabilities, capabilities)
    state.plugins[entry.manifest.id] = {
      ...current,
      enabled: Boolean(current.enabled && preflight.status !== 'blocked'),
      source: entry.source,
      updatedAt: now,
      version: entry.manifest.version,
      manifestHash,
      capabilities
    }
    this.appendLifecycleEvent(state, {
      pluginId: entry.manifest.id,
      action: 'update',
      timestamp: now,
      source: entry.source,
      version: entry.manifest.version,
      manifestHash,
      enabled: Boolean(current.enabled && preflight.status !== 'blocked'),
      ...(capabilityDiff ? { capabilityDiff } : {}),
      result: 'applied'
    })
    this.writeState(state)
    return this.getCatalogSnapshot()
  }

  uninstallPlugin(pluginId: string): TaskWraithPluginCatalogSnapshot {
    const state = this.readState()
    const current = state.plugins[pluginId]
    if (current) {
      const now = this.now().toISOString()
      const availableEntry = this.getAvailableManifests().find(
        (candidate) => candidate.manifest.id === pluginId
      )
      const manifest = availableEntry?.manifest
      const source = availableEntry?.source ?? current.source
      state.tombstones = state.tombstones ?? {}
      state.tombstones[pluginId] = {
        pluginId,
        ...(manifest?.publisher ? { publisher: manifest.publisher } : {}),
        ...(manifest?.name ? { name: manifest.name } : {}),
        ...(manifest?.version || current.version ? { version: manifest?.version || current.version } : {}),
        source,
        ...(manifest ? { namespace: pluginToolNamespace(manifest) } : {}),
        ...(manifest ? { manifestHash: manifestContentHash(manifest) } : current.manifestHash ? { manifestHash: current.manifestHash } : {}),
        ...(current.installedAt ? { installedAt: current.installedAt } : {}),
        ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
        uninstalledAt: now,
        enabledAtUninstall: current.enabled === true,
        ...(current.capabilities
          ? { capabilities: current.capabilities }
          : manifest
            ? { capabilities: capabilitySnapshot(manifest) }
            : {})
      }
      this.appendLifecycleEvent(state, {
        pluginId,
        action: 'uninstall',
        timestamp: now,
        source,
        ...(manifest?.version || current.version ? { version: manifest?.version || current.version } : {}),
        ...(manifest ? { manifestHash: manifestContentHash(manifest) } : current.manifestHash ? { manifestHash: current.manifestHash } : {}),
        enabled: current.enabled === true,
        result: 'applied'
      })
      delete state.plugins[pluginId]
      this.writeState(state)
    }
    return this.getCatalogSnapshot()
  }

  readState(): TaskWraithPluginStateFile {
    return normalizePluginStateFile(readJson<unknown>(this.statePath, EMPTY_STATE))
  }

  private writeState(state: TaskWraithPluginStateFile): void {
    writeJson(this.statePath, normalizePluginStateFile(state))
  }

  private appendLifecycleEvent(
    state: TaskWraithPluginStateFile,
    event: Omit<TaskWraithPluginLifecycleEvent, 'id'>
  ): void {
    const lifecycleEvents = state.lifecycleEvents ?? []
    const id = `${event.timestamp}:${lifecycleEvents.length}:${event.action}:${event.pluginId}`
    state.lifecycleEvents = [...lifecycleEvents, { id, ...event }].slice(-MAX_PLUGIN_LIFECYCLE_EVENTS)
  }

  private getAvailableManifests(): Array<{
    manifest: TaskWraithPluginManifest
    source: TaskWraithPluginSource
  }> {
    const byId = new Map<
      string,
      {
        manifest: TaskWraithPluginManifest
        source: TaskWraithPluginSource
      }
    >()

    for (const manifest of this.builtInManifests) {
      if (!byId.has(manifest.id)) byId.set(manifest.id, { manifest, source: 'builtin' })
    }

    for (const manifest of loadLocalManifests(this.pluginsDir, this.log)) {
      if (!byId.has(manifest.id)) byId.set(manifest.id, { manifest, source: 'local' })
    }

    return Array.from(byId.values()).sort((a, b) => {
      const categoryA = a.manifest.marketplace?.category || ''
      const categoryB = b.manifest.marketplace?.category || ''
      return (
        categoryA.localeCompare(categoryB) ||
        a.manifest.name.localeCompare(b.manifest.name) ||
        a.manifest.id.localeCompare(b.manifest.id)
      )
    })
  }

  private requireAvailableEntry(pluginId: string): {
    manifest: TaskWraithPluginManifest
    source: TaskWraithPluginSource
  } {
    const entry = this.getAvailableManifests().find((candidate) => candidate.manifest.id === pluginId)
    if (!entry) throw new Error('Plugin is not available.')
    return entry
  }

  private countEntries(
    entries: readonly TaskWraithPluginCatalogEntry[]
  ): TaskWraithPluginCatalogSnapshot['counts'] {
    const byCapability: Partial<Record<TaskWraithPluginCapabilityKind, number>> = {}
    for (const entry of entries) {
      for (const capability of entry.manifest.capabilities) {
        byCapability[capability.kind] = (byCapability[capability.kind] || 0) + 1
      }
    }
    return {
      available: entries.length,
      installed: entries.filter((entry) => entry.installed).length,
      enabled: entries.filter((entry) => entry.enabled).length,
      blocked: entries.filter((entry) => entry.preflight.status === 'blocked').length,
      repairable: entries.filter((entry) => entry.preflight.status === 'repairable').length,
      byCapability
    }
  }
}
