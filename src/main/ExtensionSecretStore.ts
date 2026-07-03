import * as fs from 'fs'
import * as path from 'path'

export interface ExtensionSecretSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type ExtensionSecretOwnerKind = 'userMcpServer' | 'runtimeProfile'
export type ExtensionSecretFieldKind = 'env' | 'header'

export interface UserMcpServerExtensionSecretRef {
  ownerKind: 'userMcpServer'
  ownerId: string
  fieldKind: ExtensionSecretFieldKind
  fieldName: string
}

export interface RuntimeProfileExtensionSecretRef {
  ownerKind: 'runtimeProfile'
  ownerId: string
  fieldKind: 'env'
  fieldName: string
}

export type ExtensionSecretRef = UserMcpServerExtensionSecretRef | RuntimeProfileExtensionSecretRef

export interface InvalidExtensionSecretRef {
  ownerKind: ExtensionSecretOwnerKind
  ownerId: string
  fieldKind: ExtensionSecretFieldKind
  fieldName: string
}

export interface ExtensionSecretStatus extends ExtensionSecretRef {
  configured: boolean
  updatedAt?: string
}

export interface ExtensionSecretStatusSnapshot {
  schemaVersion: 1
  generatedAt: string
  encryptionAvailable: boolean
  secrets: ExtensionSecretStatus[]
}

export interface ExtensionSecretMutationResult {
  ok: boolean
  error?: string
  snapshot: ExtensionSecretStatusSnapshot
}

export type ExtensionSecretResolutionStatus =
  | 'ok'
  | 'invalidRef'
  | 'missing'
  | 'encryptionUnavailable'
  | 'decryptFailed'

export interface ExtensionSecretResolution {
  ref: ExtensionSecretRef | null
  status: ExtensionSecretResolutionStatus
  value?: string
}

export interface ExtensionSecretStoreOptions {
  userDataPath?: string
  secretsPath?: string
  safeStorage: ExtensionSecretSafeStorage
  now?: () => Date
  log?: (line: string) => void
}

interface PersistedExtensionSecret extends ExtensionSecretRef {
  encryptedValue: string
  createdAt: string
  updatedAt: string
}

interface ExtensionSecretStateFile {
  schemaVersion: 1
  secrets: Record<string, PersistedExtensionSecret>
}

interface EncryptedExtensionSecretPayload {
  schemaVersion: 1
  ref: ExtensionSecretRef
  value: string
}

const EMPTY_SECRET_STATE: ExtensionSecretStateFile = {
  schemaVersion: 1,
  secrets: {}
}
const MAX_EXTENSION_SECRET_RECORDS = 1024
const MAX_EXTENSION_SECRET_OWNER_ID = 200
const MAX_EXTENSION_SECRET_FIELD_NAME = 200
const ENV_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_FIELD_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function extensionSecretKey(ref: ExtensionSecretRef): string {
  return [
    ref.ownerKind,
    encodeURIComponent(ref.ownerId.trim()),
    ref.fieldKind,
    encodeURIComponent(ref.fieldName.trim())
  ].join(':')
}

function cleanRef(ref: InvalidExtensionSecretRef | ExtensionSecretRef): ExtensionSecretRef | null {
  const ownerKind = ref.ownerKind
  const fieldKind = ref.fieldKind
  const ownerId = ref.ownerId.trim()
  const fieldName = ref.fieldName.trim()
  if (!ownerId || !fieldName) return null
  if (ownerId.length > MAX_EXTENSION_SECRET_OWNER_ID) return null
  if (fieldName.length > MAX_EXTENSION_SECRET_FIELD_NAME) return null
  if (ownerKind !== 'userMcpServer' && ownerKind !== 'runtimeProfile') return null
  if (fieldKind !== 'env' && fieldKind !== 'header') return null
  if (ownerKind === 'runtimeProfile' && fieldKind !== 'env') return null
  if (fieldKind === 'env' && !ENV_FIELD_NAME_RE.test(fieldName)) return null
  if (fieldKind === 'header' && !HEADER_FIELD_NAME_RE.test(fieldName)) return null
  return {
    ownerKind,
    ownerId,
    fieldKind,
    fieldName
  } as ExtensionSecretRef
}

function readJson<T>(filePath: string, defaultData: T, log: (line: string) => void): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch (error) {
    log(`[ExtensionSecretStore] Failed to read ${filePath}: ${String(error)}`)
  }
  return defaultData
}

function writeJson(filePath: string, data: ExtensionSecretStateFile): void {
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

function normalizeSecretState(value: unknown): ExtensionSecretStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_SECRET_STATE
  const input = value as Partial<ExtensionSecretStateFile>
  const rawSecrets =
    input.secrets && typeof input.secrets === 'object' && !Array.isArray(input.secrets)
      ? input.secrets
      : {}
  const secrets: Record<string, PersistedExtensionSecret> = {}
  for (const [key, rawSecret] of Object.entries(rawSecrets).slice(0, MAX_EXTENSION_SECRET_RECORDS)) {
    if (!rawSecret || typeof rawSecret !== 'object' || Array.isArray(rawSecret)) continue
    const secret = rawSecret as Partial<PersistedExtensionSecret>
    const ref = cleanRef({
      ownerKind: secret.ownerKind as ExtensionSecretOwnerKind,
      ownerId: typeof secret.ownerId === 'string' ? secret.ownerId : '',
      fieldKind: secret.fieldKind as ExtensionSecretFieldKind,
      fieldName: typeof secret.fieldName === 'string' ? secret.fieldName : ''
    })
    if (!key.trim() || !ref || !secret.encryptedValue?.trim()) continue
    const canonicalKey = extensionSecretKey(ref)
    if (key !== canonicalKey) continue
    secrets[canonicalKey] = {
      ...ref,
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

function encodeSecretPayload(ref: ExtensionSecretRef, value: string): string {
  const payload: EncryptedExtensionSecretPayload = {
    schemaVersion: 1,
    ref,
    value
  }
  return JSON.stringify(payload)
}

function decodeSecretPayload(decrypted: string, expectedRef: ExtensionSecretRef): string | null {
  try {
    const parsed = JSON.parse(decrypted) as Partial<EncryptedExtensionSecretPayload>
    const ref = parsed.ref
      ? cleanRef({
          ownerKind: parsed.ref.ownerKind,
          ownerId: parsed.ref.ownerId,
          fieldKind: parsed.ref.fieldKind,
          fieldName: parsed.ref.fieldName
        } as InvalidExtensionSecretRef)
      : null
    if (
      parsed.schemaVersion !== 1 ||
      !ref ||
      extensionSecretKey(ref) !== extensionSecretKey(expectedRef) ||
      typeof parsed.value !== 'string'
    ) {
      return null
    }
    return parsed.value
  } catch {
    return null
  }
}

export class ExtensionSecretStore {
  private readonly secretsPath: string
  private readonly safeStorage: ExtensionSecretSafeStorage
  private readonly now: () => Date
  private readonly log: (line: string) => void

  constructor(options: ExtensionSecretStoreOptions) {
    this.secretsPath =
      options.secretsPath ||
      path.join(options.userDataPath || process.cwd(), 'extension-secrets.json')
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => {})
  }

  getSecretStatusSnapshot(): ExtensionSecretStatusSnapshot {
    const state = this.readState()
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      encryptionAvailable: this.safeStorage.isEncryptionAvailable(),
      secrets: Object.entries(state.secrets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, secret]) => ({
          ownerKind: secret.ownerKind,
          ownerId: secret.ownerId,
          fieldKind: secret.fieldKind,
          fieldName: secret.fieldName,
          configured: Boolean(secret.encryptedValue),
          updatedAt: secret.updatedAt
        }))
    }
  }

  setSecret(ref: ExtensionSecretRef, value: string): ExtensionSecretMutationResult {
    const clean = cleanRef(ref)
    if (!clean) {
      return { ok: false, error: 'Secret reference is invalid.', snapshot: this.getSecretStatusSnapshot() }
    }
    if (!value) {
      return { ok: false, error: 'Secret value is required.', snapshot: this.getSecretStatusSnapshot() }
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        error: 'OS keychain encryption is unavailable; cannot store extension secrets.',
        snapshot: this.getSecretStatusSnapshot()
      }
    }
    const state = this.readState()
    const now = this.now().toISOString()
    const key = extensionSecretKey(clean)
    const current = state.secrets[key]
    state.secrets[key] = {
      ...clean,
      encryptedValue: this.safeStorage.encryptString(encodeSecretPayload(clean, value)).toString('base64'),
      createdAt: current?.createdAt || now,
      updatedAt: now
    }
    this.writeState(state)
    return { ok: true, snapshot: this.getSecretStatusSnapshot() }
  }

  clearSecret(ref: ExtensionSecretRef): ExtensionSecretMutationResult {
    const clean = cleanRef(ref)
    if (!clean) {
      return { ok: false, error: 'Secret reference is invalid.', snapshot: this.getSecretStatusSnapshot() }
    }
    const state = this.readState()
    delete state.secrets[extensionSecretKey(clean)]
    this.writeState(state)
    return { ok: true, snapshot: this.getSecretStatusSnapshot() }
  }

  clearOwnerSecrets(ownerKind: ExtensionSecretOwnerKind, ownerId: string): number {
    if (ownerKind !== 'userMcpServer' && ownerKind !== 'runtimeProfile') return 0
    const cleanOwnerId = ownerId.trim()
    if (!cleanOwnerId) return 0
    const state = this.readState()
    let removed = 0
    for (const [key, secret] of Object.entries(state.secrets)) {
      if (secret.ownerKind === ownerKind && secret.ownerId === cleanOwnerId) {
        delete state.secrets[key]
        removed += 1
      }
    }
    if (removed > 0) this.writeState(state)
    return removed
  }

  loadSecretValue(ref: ExtensionSecretRef): string | null {
    const resolution = this.resolveSecretValues([ref])[0]
    return resolution?.status === 'ok' ? resolution.value ?? null : null
  }

  resolveSecretValues(refs: Array<ExtensionSecretRef | InvalidExtensionSecretRef>): ExtensionSecretResolution[] {
    const state = this.readState()
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable()
    return refs.map((ref): ExtensionSecretResolution => {
      const clean = cleanRef(ref)
      if (!clean) return { ref: null, status: 'invalidRef' }
      if (!encryptionAvailable) return { ref: clean, status: 'encryptionUnavailable' }
      const key = extensionSecretKey(clean)
      const secret = state.secrets[key]
      if (!secret?.encryptedValue) return { ref: clean, status: 'missing' }
      const storedRef = cleanRef({
        ownerKind: secret.ownerKind,
        ownerId: secret.ownerId,
        fieldKind: secret.fieldKind,
        fieldName: secret.fieldName
      })
      if (!storedRef || extensionSecretKey(storedRef) !== key) {
        return { ref: clean, status: 'decryptFailed' }
      }
      try {
        const decrypted = this.safeStorage.decryptString(Buffer.from(secret.encryptedValue, 'base64'))
        const value = decodeSecretPayload(decrypted, clean)
        return value === null
          ? { ref: clean, status: 'decryptFailed' }
          : { ref: clean, status: 'ok', value }
      } catch {
        return { ref: clean, status: 'decryptFailed' }
      }
    })
  }

  private readState(): ExtensionSecretStateFile {
    return normalizeSecretState(readJson<unknown>(this.secretsPath, EMPTY_SECRET_STATE, this.log))
  }

  private writeState(state: ExtensionSecretStateFile): void {
    writeJson(this.secretsPath, state)
  }
}
