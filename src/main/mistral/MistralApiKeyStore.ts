import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const MISTRAL_API_KEY_FILENAME = 'mistral-api-key.json'

const SECRET_PURPOSE = 'taskwraith:mistral-api-key:v1'
const ENVELOPE_PURPOSE = 'taskwraith:mistral-api-key-envelope:v1'
const MAX_API_KEY_BYTES = 4_096
const MAX_SECRET_FILE_BYTES = 64 * 1024
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const ENCRYPTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const OUTER_KEYS = ['schemaVersion', 'purpose', 'updatedAt', 'encryptedPayload'] as const
const INNER_KEYS = ['schemaVersion', 'purpose', 'apiKey'] as const

export interface MistralSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface MistralApiKeyStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export type MistralApiKeyLoadResult =
  | { status: 'ok'; value: string }
  | {
      status: 'missing' | 'encryptionUnavailable' | 'unreadable' | 'corrupt' | 'decryptFailed'
    }

export type MistralApiKeyMutationError =
  | 'invalidApiKey'
  | 'encryptionUnavailable'
  | 'encryptFailed'
  | 'existingRecordUnreadable'
  | 'writeFailed'
  | 'clearFailed'

export interface MistralApiKeyMutationResult {
  ok: boolean
  status: MistralApiKeyStatus
  error?: MistralApiKeyMutationError
}

export interface MistralApiKeyStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: MistralSafeStorage
  readonly now?: () => Date
  readonly platform?: NodeJS.Platform
}

interface PersistedSecretEnvelope {
  readonly schemaVersion: 1
  readonly purpose: typeof ENVELOPE_PURPOSE
  readonly updatedAt: string
  readonly encryptedPayload: string
}

interface PersistedSecretPayload {
  readonly schemaVersion: 1
  readonly purpose: typeof SECRET_PURPOSE
  readonly apiKey: string
}

type PersistedEnvelopeRead =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'corrupt' }
  | { status: 'ok'; envelope: PersistedSecretEnvelope }

/**
 * Stores the user-supplied direct Mistral API key (BYOK) for metered PAYG billing
 * and access to the complete Mistral API model family.
 */
export class MistralApiKeyStore {
  private readonly secretPath: string
  private readonly safeStorage: MistralSafeStorage
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform

  constructor(options: MistralApiKeyStoreOptions) {
    if (!options.userDataPath || !isAbsolute(options.userDataPath)) {
      throw new Error(
        `MistralApiKeyStore requires an absolute userDataPath, received: "${String(options.userDataPath)}"`
      )
    }
    this.secretPath = join(options.userDataPath, MISTRAL_API_KEY_FILENAME)
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
  }

  private encryptionAvailable(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      if (this.platform === 'linux') {
        const backend = this.safeStorage.getSelectedStorageBackend?.()
        if (!backend || !ENCRYPTED_LINUX_BACKENDS.has(backend)) return false
      }
      return true
    } catch {
      return false
    }
  }

  getStatus(): MistralApiKeyStatus {
    const encryptionAvailable = this.encryptionAvailable()
    const read = this.readEnvelope()
    if (read.status === 'ok') {
      return {
        configured: true,
        encryptionAvailable,
        updatedAt: read.envelope.updatedAt
      }
    }
    // Corrupt or unreadable reports as configured so the UI offers an explicit Clear
    // recovery action rather than attempting a silent overwrite that fails closed.
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return {
        configured: true,
        encryptionAvailable
      }
    }
    return {
      configured: false,
      encryptionAvailable
    }
  }

  loadApiKey(): MistralApiKeyLoadResult {
    const read = this.readEnvelope()
    if (read.status === 'missing') return { status: 'missing' }
    if (read.status === 'unreadable') return { status: 'unreadable' }
    if (read.status === 'corrupt') return { status: 'corrupt' }
    if (!this.encryptionAvailable()) return { status: 'encryptionUnavailable' }

    let decryptedText: string
    try {
      const ciphertext = Buffer.from(read.envelope.encryptedPayload, 'base64')
      decryptedText = this.safeStorage.decryptString(ciphertext)
    } catch {
      return { status: 'decryptFailed' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(decryptedText)
    } catch {
      return { status: 'corrupt' }
    }

    if (!isPlainObject(parsed)) return { status: 'corrupt' }
    if (
      !exactKeys(parsed, INNER_KEYS) ||
      parsed.schemaVersion !== 1 ||
      parsed.purpose !== SECRET_PURPOSE ||
      typeof parsed.apiKey !== 'string' ||
      parsed.apiKey.length === 0 ||
      parsed.apiKey.length > MAX_API_KEY_BYTES
    ) {
      return { status: 'corrupt' }
    }

    return { status: 'ok', value: parsed.apiKey }
  }

  setApiKey(key: string): MistralApiKeyMutationResult {
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (!trimmed || trimmed.length > MAX_API_KEY_BYTES) {
      return { ok: false, status: this.getStatus(), error: 'invalidApiKey' }
    }

    if (!this.encryptionAvailable()) {
      return { ok: false, status: this.getStatus(), error: 'encryptionUnavailable' }
    }

    const current = this.readEnvelope()
    if (current.status === 'unreadable' || current.status === 'corrupt') {
      return { ok: false, status: this.getStatus(), error: 'existingRecordUnreadable' }
    }

    const payload: PersistedSecretPayload = {
      schemaVersion: 1,
      purpose: SECRET_PURPOSE,
      apiKey: trimmed
    }

    let ciphertext: Buffer
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(payload))
    } catch {
      return { ok: false, status: this.getStatus(), error: 'encryptFailed' }
    }

    const envelope: PersistedSecretEnvelope = {
      schemaVersion: 1,
      purpose: ENVELOPE_PURPOSE,
      updatedAt: this.now().toISOString(),
      encryptedPayload: ciphertext.toString('base64')
    }

    try {
      this.atomicWriteFile(JSON.stringify(envelope, null, 2) + '\n')
    } catch {
      return { ok: false, status: this.getStatus(), error: 'writeFailed' }
    }

    return { ok: true, status: this.getStatus() }
  }

  clear(): MistralApiKeyMutationResult {
    try {
      if (existsSync(this.secretPath)) {
        unlinkSync(this.secretPath)
      }
      return { ok: true, status: this.getStatus() }
    } catch {
      return { ok: false, status: this.getStatus(), error: 'clearFailed' }
    }
  }

  clearApiKey(): MistralApiKeyMutationResult {
    return this.clear()
  }

  private readEnvelope(): PersistedEnvelopeRead {
    if (!existsSync(this.secretPath)) {
      return { status: 'missing' }
    }

    let fd = -1
    let raw = ''
    try {
      fd = openSync(this.secretPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SECRET_FILE_BYTES) {
        return { status: 'unreadable' }
      }
      raw = readFileSync(fd, 'utf8')
    } catch {
      return { status: 'unreadable' }
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'corrupt' }
    }

    if (!isPlainObject(parsed) || !exactKeys(parsed, OUTER_KEYS)) {
      return { status: 'corrupt' }
    }

    if (
      parsed.purpose !== ENVELOPE_PURPOSE ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.updatedAt !== 'string' ||
      !canonicalIsoTimestamp(parsed.updatedAt) ||
      typeof parsed.encryptedPayload !== 'string' ||
      parsed.encryptedPayload.length === 0 ||
      parsed.encryptedPayload.length > MAX_SECRET_FILE_BYTES ||
      !CANONICAL_BASE64.test(parsed.encryptedPayload)
    ) {
      return { status: 'corrupt' }
    }

    return { status: 'ok', envelope: parsed as unknown as PersistedSecretEnvelope }
  }

  private atomicWriteFile(content: string): void {
    const dir = dirname(this.secretPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `.${basename(this.secretPath)}.tmp.${randomBytes(8).toString('hex')}`)
    let fd = -1
    let temporaryExists = false
    try {
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      temporaryExists = true
      fchmodSync(fd, 0o600)
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = -1
      renameSync(tmp, this.secretPath)
      temporaryExists = false
      try {
        chmodSync(this.secretPath, 0o600)
      } catch {
        // best-effort
      }
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(tmp)
        } catch {
          // best-effort cleanup on failure
        }
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record)
  if (present.length !== keys.length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(record, k))
}

function canonicalIsoTimestamp(value: string): boolean {
  if (value.length > 64) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed)
}

let singleton: MistralApiKeyStore | null = null

export function configureMistralApiKeyStore(
  options: MistralApiKeyStoreOptions
): MistralApiKeyStore {
  singleton = new MistralApiKeyStore(options)
  return singleton
}

export function mistralApiKeyStore(): MistralApiKeyStore | null {
  return singleton
}
