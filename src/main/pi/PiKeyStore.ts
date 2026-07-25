import { randomBytes } from 'crypto'
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
} from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import { PI_ALLOWED_UPSTREAMS, isPiUpstreamAllowed, type PiUpstreamId } from './PiModelPolicy'

/**
 * safeStorage envelope for the Pi seat's BYOK upstream keys — the multi-key
 * sibling of AntigravityGeminiApiSecretStore, with the same file hardening
 * (O_NOFOLLOW + nlink/inode pinning, atomic 0600 rename, exact-object schema,
 * canonical base64/ISO checks) and the same recovery boundary: a corrupt or
 * unreadable record blocks further writes until an explicit clearAll, so UI
 * can never be invited to overwrite a record it cannot read.
 *
 * Only allowlisted upstreams (PiModelPolicy) can ever be stored; the store is
 * a second line of the anti-circumvention wall, not just a convenience.
 */

export const PI_PROVIDER_KEYS_FILENAME = 'pi-provider-keys.json'

const SECRET_PURPOSE = 'taskwraith:pi-provider-keys:v1'
const ENVELOPE_PURPOSE = 'taskwraith:pi-provider-keys-envelope:v1'
const MAX_API_KEY_BYTES = 4_096
const MAX_SECRET_FILE_BYTES = 64 * 1024
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const ENCRYPTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const OUTER_KEYS = ['schemaVersion', 'purpose', 'updatedAt', 'encryptedPayload'] as const
const INNER_KEYS = ['schemaVersion', 'purpose', 'keys'] as const

export interface PiSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

/** Renderer/iOS-safe projection: never key material, paths, or ciphertext. */
export interface PiKeyStoreStatus {
  encryptionAvailable: boolean
  /** Upstreams with a stored key (empty when the record is unreadable). */
  configuredUpstreams: PiUpstreamId[]
  /** True when a record exists but cannot be read; clearAll is the recovery. */
  recordUnreadable: boolean
  updatedAt?: string
}

export type PiKeyLoadResult =
  | { status: 'ok'; keys: Partial<Record<PiUpstreamId, string>> }
  | { status: 'missing' | 'encryptionUnavailable' | 'unreadable' | 'corrupt' | 'decryptFailed' }

export type PiKeyMutationError =
  | 'invalidUpstream'
  | 'invalidApiKey'
  | 'encryptionUnavailable'
  | 'encryptFailed'
  | 'existingRecordUnreadable'
  | 'writeFailed'
  | 'clearFailed'

export interface PiKeyMutationResult {
  ok: boolean
  status: PiKeyStoreStatus
  error?: PiKeyMutationError
}

export interface PiKeyStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: PiSafeStorage
  readonly now?: () => Date
}

interface PersistedEnvelope {
  readonly schemaVersion: 1
  readonly purpose: typeof ENVELOPE_PURPOSE
  readonly updatedAt: string
  readonly encryptedPayload: string
}

interface PersistedPayload {
  readonly schemaVersion: 1
  readonly purpose: typeof SECRET_PURPOSE
  readonly keys: Record<string, string>
}

type PersistedEnvelopeRead =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'corrupt' }
  | { status: 'ok'; envelope: PersistedEnvelope }

export class PiKeyStore {
  private readonly secretPath: string
  private readonly safeStorage: PiSafeStorage
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform

  constructor(options: PiKeyStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Pi key-store options are required.')
    }
    if (
      typeof options.userDataPath !== 'string' ||
      !options.userDataPath ||
      !isAbsolute(options.userDataPath)
    ) {
      throw new TypeError('An absolute userData path is required for Pi key storage.')
    }
    if (!options.safeStorage || typeof options.safeStorage !== 'object') {
      throw new TypeError('Electron safeStorage is required for Pi key storage.')
    }
    this.secretPath = join(options.userDataPath, PI_PROVIDER_KEYS_FILENAME)
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.platform = process.platform
  }

  getStatus(): PiKeyStoreStatus {
    return this.statusFrom(this.readEnvelope(), this.encryptionAvailable())
  }

  /** Main-process only; typed outcomes, never secret-bearing exceptions. */
  loadKeys(): PiKeyLoadResult {
    if (!this.encryptionAvailable()) return { status: 'encryptionUnavailable' }
    return this.loadFromEnvelope(this.readEnvelope())
  }

  setKey(upstream: string, input: string): PiKeyMutationResult {
    if (!isPiUpstreamAllowed(upstream)) {
      return { ok: false, error: 'invalidUpstream', status: this.getStatus() }
    }
    const apiKey = normalizeApiKey(input)
    if (!apiKey) {
      return { ok: false, error: 'invalidApiKey', status: this.getStatus() }
    }
    return this.mutateKeys((keys) => {
      keys[upstream] = apiKey
    })
  }

  clearKey(upstream: string): PiKeyMutationResult {
    if (!isPiUpstreamAllowed(upstream)) {
      return { ok: false, error: 'invalidUpstream', status: this.getStatus() }
    }
    return this.mutateKeys((keys) => {
      delete keys[upstream]
    })
  }

  /** The recovery boundary for an unreadable record: remove the whole file. */
  clearAll(): PiKeyMutationResult {
    try {
      unlinkSync(this.secretPath)
    } catch (error) {
      if (!isMissingPathError(error)) {
        return { ok: false, error: 'clearFailed', status: this.getStatus() }
      }
    }
    return {
      ok: true,
      status: {
        encryptionAvailable: this.encryptionAvailable(),
        configuredUpstreams: [],
        recordUnreadable: false
      }
    }
  }

  private mutateKeys(apply: (keys: Partial<Record<PiUpstreamId, string>>) => void): PiKeyMutationResult {
    const encryptionAvailable = this.encryptionAvailable()
    if (!encryptionAvailable) {
      return { ok: false, error: 'encryptionUnavailable', status: this.getStatus() }
    }
    const existing = this.readEnvelope()
    let keys: Partial<Record<PiUpstreamId, string>> = {}
    if (existing.status !== 'missing') {
      const loaded = this.loadFromEnvelope(existing)
      if (loaded.status !== 'ok') {
        return {
          ok: false,
          error: 'existingRecordUnreadable',
          status: this.statusFrom(existing, encryptionAvailable)
        }
      }
      keys = { ...loaded.keys }
    }
    apply(keys)

    if (Object.keys(keys).length === 0) {
      return this.clearAll()
    }

    let encryptedPayload: Buffer
    try {
      const payload: PersistedPayload = {
        schemaVersion: 1,
        purpose: SECRET_PURPOSE,
        keys: keys as Record<string, string>
      }
      encryptedPayload = this.safeStorage.encryptString(JSON.stringify(payload))
      if (!Buffer.isBuffer(encryptedPayload) || encryptedPayload.byteLength === 0) {
        throw new Error('invalid encrypted payload')
      }
    } catch {
      return { ok: false, error: 'encryptFailed', status: this.getStatus() }
    }

    const envelope: PersistedEnvelope = {
      schemaVersion: 1,
      purpose: ENVELOPE_PURPOSE,
      updatedAt: this.now().toISOString(),
      encryptedPayload: encryptedPayload.toString('base64')
    }
    try {
      this.writeEnvelope(envelope)
    } catch {
      return { ok: false, error: 'writeFailed', status: this.getStatus() }
    }
    return {
      ok: true,
      status: {
        encryptionAvailable: true,
        configuredUpstreams: sortedUpstreams(keys),
        recordUnreadable: false,
        updatedAt: envelope.updatedAt
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

  private statusFrom(
    persisted: PersistedEnvelopeRead,
    encryptionAvailable: boolean
  ): PiKeyStoreStatus {
    if (persisted.status === 'missing') {
      return { encryptionAvailable, configuredUpstreams: [], recordUnreadable: false }
    }
    if (persisted.status !== 'ok') {
      return { encryptionAvailable, configuredUpstreams: [], recordUnreadable: true }
    }
    const loaded = this.loadFromEnvelope(persisted)
    if (loaded.status !== 'ok') {
      return {
        encryptionAvailable,
        configuredUpstreams: [],
        recordUnreadable: true,
        updatedAt: persisted.envelope.updatedAt
      }
    }
    return {
      encryptionAvailable,
      configuredUpstreams: sortedUpstreams(loaded.keys),
      recordUnreadable: false,
      updatedAt: persisted.envelope.updatedAt
    }
  }

  private loadFromEnvelope(persisted: PersistedEnvelopeRead): PiKeyLoadResult {
    if (persisted.status !== 'ok') return persisted
    let plaintext: string
    try {
      plaintext = this.safeStorage.decryptString(
        Buffer.from(persisted.envelope.encryptedPayload, 'base64')
      )
    } catch {
      return { status: 'decryptFailed' }
    }
    const payload = parsePayload(plaintext)
    if (!payload) return { status: 'corrupt' }
    const keys: Partial<Record<PiUpstreamId, string>> = {}
    for (const upstream of PI_ALLOWED_UPSTREAMS) {
      const value = payload.keys[upstream]
      if (typeof value === 'string' && normalizeApiKey(value) === value) {
        keys[upstream] = value
      }
    }
    return { status: 'ok', keys }
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

  private writeEnvelope(envelope: PersistedEnvelope): void {
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

function sortedUpstreams(keys: Partial<Record<PiUpstreamId, string>>): PiUpstreamId[] {
  return PI_ALLOWED_UPSTREAMS.filter((upstream) => typeof keys[upstream] === 'string')
}

function normalizeApiKey(input: string): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) return null
  return value
}

function parseEnvelope(serialized: string): PersistedEnvelope | null {
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
    return value as unknown as PersistedEnvelope
  } catch {
    return null
  }
}

function parsePayload(plaintext: string): PersistedPayload | null {
  try {
    const value = JSON.parse(plaintext) as unknown
    if (!isExactObject(value, INNER_KEYS)) return null
    if (value.schemaVersion !== 1 || value.purpose !== SECRET_PURPOSE) return null
    const keys = value.keys
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return null
    for (const [name, key] of Object.entries(keys)) {
      if (typeof key !== 'string' || !isPiUpstreamAllowed(name)) return null
    }
    return value as unknown as PersistedPayload
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
