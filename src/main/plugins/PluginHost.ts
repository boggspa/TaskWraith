import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { BUILT_IN_TASKWRAITH_PLUGIN_MANIFESTS } from './BuiltInPluginCatalog'
import {
  TASKWRAITH_PLUGIN_MANIFEST_SCHEMA_VERSION,
  pluginToolNamespace,
  validateTaskWraithPluginManifest,
  type TaskWraithPluginCapabilityKind,
  type TaskWraithPluginManifest
} from './PluginManifest'

export type TaskWraithPluginSource = 'builtin' | 'local' | 'marketplace'
export type TaskWraithPluginInstallSource = TaskWraithPluginSource | 'unknown'
export type TaskWraithPluginPreflightStatus = 'ready' | 'repairable' | 'blocked'

export interface TaskWraithPluginInstallState {
  installed: boolean
  enabled: boolean
  source: TaskWraithPluginInstallSource
  installedAt?: string
  updatedAt?: string
  version?: string
  manifestHash?: string
}

export interface TaskWraithPluginStateFile {
  schemaVersion: 1
  plugins: Record<string, TaskWraithPluginInstallState>
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

export interface TaskWraithPluginCatalogEntry {
  manifest: TaskWraithPluginManifest
  source: TaskWraithPluginSource
  namespace: string
  manifestHash: string
  installed: boolean
  enabled: boolean
  installState?: TaskWraithPluginInstallState
  preflight: TaskWraithPluginPreflightResult
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

export interface PluginHostOptions {
  userDataPath?: string
  pluginsDir?: string
  statePath?: string
  builtInManifests?: TaskWraithPluginManifest[]
  now?: () => Date
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  log?: (line: string) => void
}

const EMPTY_STATE: TaskWraithPluginStateFile = {
  schemaVersion: 1,
  plugins: {}
}

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

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function normalizeInstallState(value: unknown): TaskWraithPluginInstallState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<TaskWraithPluginInstallState>
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
      : {})
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
  for (const [pluginId, rawState] of Object.entries(rawPlugins).slice(0, 512)) {
    if (!pluginId.trim()) continue
    const state = normalizeInstallState(rawState)
    if (state) plugins[pluginId] = state
  }
  return {
    schemaVersion: 1,
    plugins
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
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => {})
    this.preflight = new PluginPreflightService({
      env: options.env,
      platform: options.platform
    })
  }

  getCatalogSnapshot(): TaskWraithPluginCatalogSnapshot {
    const state = this.readState()
    const entries = this.getAvailableManifests().map(({ manifest, source }) => {
      const installState = state.plugins[manifest.id]
      const manifestHash = stableHash(manifest)
      return {
        manifest,
        source,
        namespace: pluginToolNamespace(manifest),
        manifestHash,
        installed: installState?.installed === true,
        enabled: installState?.installed === true && installState.enabled === true,
        ...(installState ? { installState } : {}),
        preflight: this.preflight.evaluate(manifest)
      } satisfies TaskWraithPluginCatalogEntry
    })
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      plugins: entries,
      counts: this.countEntries(entries)
    }
  }

  installPlugin(pluginId: string): TaskWraithPluginCatalogSnapshot {
    const entry = this.requireAvailableEntry(pluginId)
    const state = this.readState()
    const now = this.now().toISOString()
    const current = state.plugins[entry.manifest.id]
    state.plugins[entry.manifest.id] = {
      installed: true,
      enabled: current?.enabled === true,
      source: entry.source,
      installedAt: current?.installedAt || now,
      updatedAt: now,
      version: entry.manifest.version,
      manifestHash: stableHash(entry.manifest)
    }
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
    const preflight = this.preflight.evaluate(entry.manifest)
    state.plugins[entry.manifest.id] = {
      ...current,
      enabled: Boolean(enabled && preflight.status !== 'blocked'),
      updatedAt: this.now().toISOString(),
      version: entry.manifest.version,
      manifestHash: stableHash(entry.manifest),
      source: entry.source
    }
    this.writeState(state)
    return this.getCatalogSnapshot()
  }

  uninstallPlugin(pluginId: string): TaskWraithPluginCatalogSnapshot {
    const state = this.readState()
    if (state.plugins[pluginId]) {
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

