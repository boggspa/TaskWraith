import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const ANTIGRAVITY_GEMINI_API_SECRET_FILENAME = 'antigravity-gemini-api-key.json'

const SECRET_PURPOSE = 'taskwraith:antigravity-gemini-api-key:v1'
const ENVELOPE_PURPOSE = 'taskwraith:antigravity-gemini-api-key-envelope:v1'
const MAX_API_KEY_BYTES = 4_096
const MAX_SECRET_FILE_BYTES = 64 * 1024
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const ENCRYPTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const OUTER_KEYS = ['schemaVersion', 'purpose', 'updatedAt', 'encryptedPayload'] as const
const INNER_KEYS = ['schemaVersion', 'purpose', 'apiKey'] as const

export interface AntigravityGeminiApiSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * The only secret-store shape suitable for renderer/iOS projection. It never
 * contains the API key, its ciphertext, a storage path, or decryption details.
 */
export interface AntigravityGeminiApiSecretStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export type AntigravityGeminiApiSecretLoadResult =
  | { status: 'ok'; value: string }
  | {
      status: 'missing' | 'encryptionUnavailable' | 'unreadable' | 'corrupt' | 'decryptFailed'
    }

export type AntigravityGeminiApiSecretMutationError =
  | 'invalidApiKey'
  | 'encryptionUnavailable'
  | 'encryptFailed'
  | 'existingRecordUnreadable'
  | 'writeFailed'
  | 'clearFailed'

export interface AntigravityGeminiApiSecretMutationResult {
  ok: boolean
  status: AntigravityGeminiApiSecretStatus
  error?: AntigravityGeminiApiSecretMutationError
}

export interface AntigravityGeminiApiSecretStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: AntigravityGeminiApiSafeStorage
  readonly now?: () => Date
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
 * Owns the one explicitly supplied Gemini API key for the combined
 * AGY/AntiGravity provider. Construct it only in Electron main after app-ready,
 * when safeStorage has selected its final platform backend.
 */
export class AntigravityGeminiApiSecretStore {
  private readonly secretPath: string
  private readonly safeStorage: AntigravityGeminiApiSafeStorage
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform

  constructor(options: AntigravityGeminiApiSecretStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Antigravity Gemini API secret-store options are required.')
    }
    if (
      typeof options.userDataPath !== 'string' ||
      !options.userDataPath ||
      !isAbsolute(options.userDataPath)
    ) {
      throw new TypeError('An absolute userData path is required for Gemini API key storage.')
    }
    if (!options.safeStorage || typeof options.safeStorage !== 'object') {
      throw new TypeError('Electron safeStorage is required for Gemini API key storage.')
    }
    this.secretPath = join(options.userDataPath, ANTIGRAVITY_GEMINI_API_SECRET_FILENAME)
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.platform = process.platform
  }

  getStatus(): AntigravityGeminiApiSecretStatus {
    return this.statusWithAvailability(this.encryptionAvailable())
  }

  setApiKey(input: string): AntigravityGeminiApiSecretMutationResult {
    const apiKey = normalizeApiKey(input)
    if (!apiKey) {
      return {
        ok: false,
        error: 'invalidApiKey',
        status: this.statusWithAvailability(this.encryptionAvailable())
      }
    }

    const encryptionAvailable = this.encryptionAvailable()
    if (!encryptionAvailable) {
      return {
        ok: false,
        error: 'encryptionUnavailable',
        status: this.statusWithAvailability(false)
      }
    }

    const existing = this.readEnvelope()
    if (existing.status !== 'missing') {
      const resolution = this.loadFromEnvelope(existing)
      if (resolution.status !== 'ok') {
        return {
          ok: false,
          error: 'existingRecordUnreadable',
          status: this.statusFromEnvelope(existing, true)
        }
      }
    }

    const updatedAt = this.now().toISOString()
    let encryptedPayload: Buffer
    try {
      const payload: PersistedSecretPayload = {
        schemaVersion: 1,
        purpose: SECRET_PURPOSE,
        apiKey
      }
      encryptedPayload = this.safeStorage.encryptString(JSON.stringify(payload))
      if (!Buffer.isBuffer(encryptedPayload) || encryptedPayload.byteLength === 0) {
        throw new Error('invalid encrypted payload')
      }
    } catch {
      return {
        ok: false,
        error: 'encryptFailed',
        status: this.statusWithAvailability(true)
      }
    }

    const envelope: PersistedSecretEnvelope = {
      schemaVersion: 1,
      purpose: ENVELOPE_PURPOSE,
      updatedAt,
      encryptedPayload: encryptedPayload.toString('base64')
    }
    try {
      this.writeEnvelope(envelope)
    } catch {
      return {
        ok: false,
        error: 'writeFailed',
        status: this.statusWithAvailability(true)
      }
    }
    return {
      ok: true,
      status: {
        configured: true,
        encryptionAvailable: true,
        updatedAt
      }
    }
  }

  /**
   * Main-process only. Callers receive a typed outcome and never an exception
   * containing secret material or a raw safeStorage error.
   */
  loadApiKey(): AntigravityGeminiApiSecretLoadResult {
    if (!this.encryptionAvailable()) return { status: 'encryptionUnavailable' }
    return this.loadFromEnvelope(this.readEnvelope())
  }

  clear(): AntigravityGeminiApiSecretMutationResult {
    try {
      unlinkSync(this.secretPath)
    } catch (error) {
      if (!isMissingPathError(error)) {
        return {
          ok: false,
          error: 'clearFailed',
          status: this.statusWithAvailability(this.encryptionAvailable())
        }
      }
    }
    return {
      ok: true,
      status: {
        configured: false,
        encryptionAvailable: this.encryptionAvailable()
      }
    }
  }

  private encryptionAvailable(): boolean {
    try {
      if (this.safeStorage.isEncryptionAvailable() !== true) return false
      if (this.platform !== 'linux') return true
      const backend = this.safeStorage.getSelectedStorageBackend?.()
      return typeof backend === 'string' && ENCRYPTED_LINUX_BACKENDS.has(backend)
    } catch {
      return false
    }
  }

  private statusWithAvailability(encryptionAvailable: boolean): AntigravityGeminiApiSecretStatus {
    return this.statusFromEnvelope(this.readEnvelope(), encryptionAvailable)
  }

  private statusFromEnvelope(
    persisted: PersistedEnvelopeRead,
    encryptionAvailable: boolean
  ): AntigravityGeminiApiSecretStatus {
    if (persisted.status === 'missing') {
      return { configured: false, encryptionAvailable }
    }
    if (persisted.status === 'ok') {
      return {
        configured: true,
        encryptionAvailable,
        updatedAt: persisted.envelope.updatedAt
      }
    }
    // A corrupt or unreadable path is deliberately reported as configured so
    // UI cannot invite an overwrite. Explicit clear is the recovery boundary.
    return { configured: true, encryptionAvailable }
  }

  private loadFromEnvelope(persisted: PersistedEnvelopeRead): AntigravityGeminiApiSecretLoadResult {
    if (persisted.status !== 'ok') return persisted
    let plaintext: string
    try {
      plaintext = this.safeStorage.decryptString(
        Buffer.from(persisted.envelope.encryptedPayload, 'base64')
      )
    } catch {
      return { status: 'decryptFailed' }
    }
    const payload = parseSecretPayload(plaintext)
    return payload ? { status: 'ok', value: payload.apiKey } : { status: 'corrupt' }
  }

  private readEnvelope(): PersistedEnvelopeRead {
    let descriptor: number | null = null
    try {
      const before = lstatSync(this.secretPath, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n) return { status: 'unreadable' }
      if (before.size > BigInt(MAX_SECRET_FILE_BYTES)) return { status: 'corrupt' }

      const noFollow = this.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
      descriptor = openSync(this.secretPath, constants.O_RDONLY | noFollow)
      const opened = fstatSync(descriptor, { bigint: true })
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        return { status: 'unreadable' }
      }
      if (opened.size > BigInt(MAX_SECRET_FILE_BYTES)) return { status: 'corrupt' }
      const serialized = readFileSync(descriptor, { encoding: 'utf8' })
      const envelope = parseEnvelope(serialized)
      return envelope ? { status: 'ok', envelope } : { status: 'corrupt' }
    } catch (error) {
      return isMissingPathError(error) ? { status: 'missing' } : { status: 'unreadable' }
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // A close failure does not make it safe to replace the existing path.
        }
      }
    }
  }

  private writeEnvelope(envelope: PersistedSecretEnvelope): void {
    const directory = dirname(this.secretPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = join(
      directory,
      `.${basename(this.secretPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    )
    let descriptor: number | null = null
    let temporaryExists = false
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      )
      temporaryExists = true
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, JSON.stringify(envelope) + '\n', 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporaryPath, this.secretPath)
      temporaryExists = false
      if (this.platform !== 'win32') {
        chmodSync(this.secretPath, 0o600)
        fsyncDirectory(directory)
      }
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the original storage failure.
        }
      }
      if (temporaryExists) {
        try {
          unlinkSync(temporaryPath)
        } catch {
          // Preserve the original storage failure.
        }
      }
    }
  }
}

function normalizeApiKey(input: string): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) return null
  return value
}

function parseEnvelope(serialized: string): PersistedSecretEnvelope | null {
  try {
    const value = JSON.parse(serialized) as unknown
    if (!isExactObject(value, OUTER_KEYS)) return null
    if (
      value.schemaVersion !== 1 ||
      value.purpose !== ENVELOPE_PURPOSE ||
      typeof value.updatedAt !== 'string' ||
      !isCanonicalIsoTimestamp(value.updatedAt) ||
      typeof value.encryptedPayload !== 'string' ||
      !value.encryptedPayload ||
      !CANONICAL_BASE64.test(value.encryptedPayload)
    ) {
      return null
    }
    return value as unknown as PersistedSecretEnvelope
  } catch {
    return null
  }
}

function parseSecretPayload(plaintext: string): PersistedSecretPayload | null {
  try {
    const value = JSON.parse(plaintext) as unknown
    if (!isExactObject(value, INNER_KEYS)) return null
    if (
      value.schemaVersion !== 1 ||
      value.purpose !== SECRET_PURPOSE ||
      typeof value.apiKey !== 'string' ||
      normalizeApiKey(value.apiKey) !== value.apiKey
    ) {
      return null
    }
    return value as unknown as PersistedSecretPayload
  } catch {
    return null
  }
}

function isExactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys
): value is Record<Keys[number], unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value).sort()
  const expectedKeys = [...keys].sort()
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  )
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(directory, constants.O_RDONLY)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
