import * as fs from 'fs'
import * as path from 'path'
import type {
  TaskWraithPluginActivationSnapshot,
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginSecretMutationResult,
  TaskWraithPluginSecretStatus,
  TaskWraithPluginSecretStatusSnapshot
} from './PluginManifest'
import {
  buildPluginConnectorClients,
  type PluginConnectorClient
} from './PluginConnectorClients'

export interface PluginSecretSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface PluginSecretStoreOptions {
  userDataPath?: string
  secretsPath?: string
  safeStorage: PluginSecretSafeStorage
  now?: () => Date
  log?: (line: string) => void
}

interface PersistedPluginSecret {
  pluginId: string
  secretId: string
  label: string
  encryptedValue: string
  createdAt: string
  updatedAt: string
}

interface PluginSecretStateFile {
  schemaVersion: 1
  secrets: Record<string, PersistedPluginSecret>
}

const EMPTY_SECRET_STATE: PluginSecretStateFile = {
  schemaVersion: 1,
  secrets: {}
}
const MAX_PLUGIN_SECRET_RECORDS = 512

function secretKey(pluginId: string, secretId: string): string {
  return `${pluginId}:${secretId}`
}

function readJson<T>(filePath: string, defaultData: T, log: (line: string) => void): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch (error) {
    log(`[PluginSecretStore] Failed to read ${filePath}: ${String(error)}`)
  }
  return defaultData
}

function writeJson(filePath: string, data: PluginSecretStateFile): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, JSON.stringify(normalizeSecretState(data), null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  fs.renameSync(tempPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function normalizeSecretState(value: unknown): PluginSecretStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_SECRET_STATE
  const input = value as Partial<PluginSecretStateFile>
  const rawSecrets =
    input.secrets && typeof input.secrets === 'object' && !Array.isArray(input.secrets)
      ? input.secrets
      : {}
  const secrets: Record<string, PersistedPluginSecret> = {}
  for (const [key, rawSecret] of Object.entries(rawSecrets).slice(0, MAX_PLUGIN_SECRET_RECORDS)) {
    if (!rawSecret || typeof rawSecret !== 'object' || Array.isArray(rawSecret)) continue
    const secret = rawSecret as Partial<PersistedPluginSecret>
    if (
      !key.trim() ||
      !secret.pluginId?.trim() ||
      !secret.secretId?.trim() ||
      !secret.encryptedValue?.trim()
    ) {
      continue
    }
    secrets[key] = {
      pluginId: secret.pluginId.trim(),
      secretId: secret.secretId.trim(),
      label: typeof secret.label === 'string' && secret.label.trim() ? secret.label.trim() : secret.secretId.trim(),
      encryptedValue: secret.encryptedValue.trim(),
      createdAt:
        typeof secret.createdAt === 'string' && secret.createdAt.trim()
          ? secret.createdAt.trim()
          : new Date(0).toISOString(),
      updatedAt:
        typeof secret.updatedAt === 'string' && secret.updatedAt.trim()
          ? secret.updatedAt.trim()
          : new Date(0).toISOString()
    }
  }
  return { schemaVersion: 1, secrets }
}

export class PluginSecretStore {
  private readonly secretsPath: string
  private readonly safeStorage: PluginSecretSafeStorage
  private readonly now: () => Date
  private readonly log: (line: string) => void

  constructor(options: PluginSecretStoreOptions) {
    const basePluginsDir = options.userDataPath
      ? path.join(options.userDataPath, 'plugins')
      : path.join(process.cwd(), 'plugins')
    this.secretsPath = options.secretsPath || path.join(basePluginsDir, 'plugin-secrets.json')
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => {})
  }

  getSecretStatusSnapshot(
    catalog: TaskWraithPluginCatalogSnapshot
  ): TaskWraithPluginSecretStatusSnapshot {
    const state = this.readState()
    const secrets: TaskWraithPluginSecretStatus[] = []
    for (const entry of catalog.plugins) {
      for (const secret of entry.manifest.secrets ?? []) {
        const stored = state.secrets[secretKey(entry.manifest.id, secret.id)]
        secrets.push({
          pluginId: entry.manifest.id,
          secretId: secret.id,
          label: secret.label,
          required: secret.required === true,
          configured: Boolean(stored?.encryptedValue),
          installed: entry.installed,
          enabled: entry.enabled,
          ...(secret.envVar ? { envVar: secret.envVar } : {}),
          ...(secret.description ? { description: secret.description } : {}),
          ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {})
        })
      }
    }
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      encryptionAvailable: this.safeStorage.isEncryptionAvailable(),
      secrets
    }
  }

  setSecret(
    catalog: TaskWraithPluginCatalogSnapshot,
    pluginId: string,
    secretId: string,
    value: string
  ): TaskWraithPluginSecretMutationResult {
    const slot = this.requireSecretSlot(catalog, pluginId, secretId)
    if (!slot.entry.installed) {
      return {
        ok: false,
        error: 'Plugin must be installed before a secret can be stored.',
        snapshot: this.getSecretStatusSnapshot(catalog)
      }
    }
    if (!value) {
      return {
        ok: false,
        error: 'Secret value is required.',
        snapshot: this.getSecretStatusSnapshot(catalog)
      }
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        error: 'OS keychain encryption is unavailable; cannot store plugin secrets.',
        snapshot: this.getSecretStatusSnapshot(catalog)
      }
    }
    const state = this.readState()
    const now = this.now().toISOString()
    const key = secretKey(pluginId, secretId)
    const current = state.secrets[key]
    state.secrets[key] = {
      pluginId,
      secretId,
      label: slot.secret.label,
      encryptedValue: this.safeStorage.encryptString(value).toString('base64'),
      createdAt: current?.createdAt || now,
      updatedAt: now
    }
    this.writeState(state)
    return {
      ok: true,
      snapshot: this.getSecretStatusSnapshot(catalog)
    }
  }

  clearSecret(
    catalog: TaskWraithPluginCatalogSnapshot,
    pluginId: string,
    secretId: string
  ): TaskWraithPluginSecretMutationResult {
    this.requireSecretSlot(catalog, pluginId, secretId)
    const state = this.readState()
    delete state.secrets[secretKey(pluginId, secretId)]
    this.writeState(state)
    return {
      ok: true,
      snapshot: this.getSecretStatusSnapshot(catalog)
    }
  }

  clearPluginSecrets(pluginId: string): number {
    const state = this.readState()
    let removed = 0
    for (const key of Object.keys(state.secrets)) {
      if (state.secrets[key]?.pluginId === pluginId) {
        delete state.secrets[key]
        removed += 1
      }
    }
    if (removed > 0) this.writeState(state)
    return removed
  }

  loadSecretValue(pluginId: string, secretId: string): string | null {
    const encryptedValue = this.readState().secrets[secretKey(pluginId, secretId)]?.encryptedValue
    if (!encryptedValue || !this.safeStorage.isEncryptionAvailable()) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(encryptedValue, 'base64'))
    } catch {
      return null
    }
  }

  getConnectorClients(
    catalog: TaskWraithPluginCatalogSnapshot,
    activation: Pick<TaskWraithPluginActivationSnapshot, 'connectors'>
  ): PluginConnectorClient[] {
    return buildPluginConnectorClients({
      activation,
      secretStatus: this.getSecretStatusSnapshot(catalog),
      loadSecretValue: (pluginId, secretId) => this.loadSecretValue(pluginId, secretId)
    })
  }

  private requireSecretSlot(
    catalog: TaskWraithPluginCatalogSnapshot,
    pluginId: string,
    secretId: string
  ): {
    entry: TaskWraithPluginCatalogSnapshot['plugins'][number]
    secret: NonNullable<TaskWraithPluginCatalogSnapshot['plugins'][number]['manifest']['secrets']>[number]
  } {
    const entry = catalog.plugins.find((candidate) => candidate.manifest.id === pluginId)
    if (!entry) throw new Error('Plugin is not available.')
    const secret = entry.manifest.secrets?.find((candidate) => candidate.id === secretId)
    if (!secret) throw new Error('Plugin secret slot is not available.')
    return { entry, secret }
  }

  private readState(): PluginSecretStateFile {
    return normalizeSecretState(readJson<unknown>(this.secretsPath, EMPTY_SECRET_STATE, this.log))
  }

  private writeState(state: PluginSecretStateFile): void {
    writeJson(this.secretsPath, state)
  }
}
