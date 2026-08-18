import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * safeStorage envelope for the Mistral Admin API key.
 *
 * The third sibling of AntigravityGeminiApiSecretStore (single key) and
 * PiKeyStore (multi key), with the same file hardening: O_NOFOLLOW plus
 * nlink/inode pinning on read, atomic 0600 temp-file+rename on write, an
 * exact-object schema on both envelope and payload, and the same recovery
 * boundary — a record that exists but cannot be read reports as CONFIGURED so
 * the UI can never be invited to silently overwrite something it failed to
 * decrypt. Explicit `clear()` is the only way out of that state.
 *
 * WHY A THIRD COPY RATHER THAN A SHARED HELPER. The hardening is ~200 lines and
 * duplicating it is genuinely unattractive, but the alternative is refactoring
 * two already-shipped, already-tested security boundaries to share a base — and
 * the identity-bearing constants (filename, purposes) are baked into the exact-
 * object schema checks that give those files their value. PiKeyStore made the
 * same call for the same reason. If a fourth key store appears, that is the
 * moment to extract a parameterised base and migrate all four together, with the
 * three existing test suites as the safety net.
 *
 * WHAT THIS KEY IS. An Admin API key from backoffice.mistral.ai — NOT a standard
 * Mistral API key, which Mistral's docs state never grants admin access. It is
 * only useful on Enterprise plans (the Admin API is Preview + Enterprise-only),
 * so for most users this store stays empty and the quota meter runs on the
 * console anchor instead. See MistralAdminUsage.ts.
 */

export const MISTRAL_ADMIN_KEY_FILENAME = 'mistral-admin-api-key.json'

const SECRET_PURPOSE = 'taskwraith:mistral-admin-api-key:v1'
const ENVELOPE_PURPOSE = 'taskwraith:mistral-admin-api-key-envelope:v1'
const MAX_COOKIE_BYTES = 4_096
const MAX_SECRET_FILE_BYTES = 64 * 1024
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const ENCRYPTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const OUTER_KEYS = ['schemaVersion', 'purpose', 'updatedAt', 'encryptedPayload'] as const
const INNER_KEYS = ['schemaVersion', 'purpose', 'cookie'] as const

export interface MistralAdminSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

/** The only shape safe to project to the renderer: never the key or its bytes. */
export interface MistralWebSessionStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export type MistralWebSessionLoadResult =
  | { status: 'ok'; value: string }
  | { status: 'missing' | 'encryptionUnavailable' | 'unreadable' | 'corrupt' | 'decryptFailed' }

export type MistralWebSessionMutationError =
  | 'invalidApiKey'
  | 'encryptionUnavailable'
  | 'encryptFailed'
  | 'existingRecordUnreadable'
  | 'writeFailed'
  | 'clearFailed'

export interface MistralWebSessionMutationResult {
  ok: boolean
  status: MistralWebSessionStatus
  error?: MistralWebSessionMutationError
}

export interface MistralWebSessionStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: MistralAdminSafeStorage
  readonly now?: () => Date
  /**
   * Host platform, injectable for tests. Defaults to `process.platform`.
   *
   * A real dependency, not a convenience — the same one `PiKeyStore` learned
   * the hard way. On Linux this store demands an ENCRYPTED safeStorage backend
   * and fails closed otherwise, so a suite that inherits the runner's platform
   * asserts the runner's keyring rather than this class: every classification
   * passes on macOS and returns `encryptionUnavailable` on headless Linux CI.
   */
  readonly platform?: NodeJS.Platform
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
  readonly cookie: string
}

type EnvelopeRead =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'corrupt' }
  | { status: 'ok'; envelope: PersistedEnvelope }

export class MistralWebSessionStore {
  private readonly secretPath: string
  private readonly safeStorage: MistralAdminSafeStorage
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform

  constructor(options: MistralWebSessionStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Mistral admin key-store options are required.')
    }
    if (
      typeof options.userDataPath !== 'string' ||
      !options.userDataPath ||
      !isAbsolute(options.userDataPath)
    ) {
      throw new TypeError('An absolute userData path is required for Mistral admin key storage.')
    }
    if (!options.safeStorage || typeof options.safeStorage !== 'object') {
      throw new TypeError('Electron safeStorage is required for Mistral admin key storage.')
    }
    this.secretPath = join(options.userDataPath, MISTRAL_ADMIN_KEY_FILENAME)
    this.safeStorage = options.safeStorage
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
  }

  getStatus(): MistralWebSessionStatus {
    return this.statusFromEnvelope(this.readEnvelope(), this.encryptionAvailable())
  }

  setApiKey(input: string): MistralWebSessionMutationResult {
    const cookie = normalizeApiKey(input)
    if (!cookie) {
      return {
        ok: false,
        error: 'invalidApiKey',
        status: this.statusFromEnvelope(this.readEnvelope(), this.encryptionAvailable())
      }
    }
    const encryptionAvailable = this.encryptionAvailable()
    if (!encryptionAvailable) {
      return {
        ok: false,
        error: 'encryptionUnavailable',
        status: this.statusFromEnvelope(this.readEnvelope(), false)
      }
    }

    // Refuse to clobber a record we cannot read — the recovery boundary.
    const existing = this.readEnvelope()
    if (existing.status !== 'missing' && this.loadFromEnvelope(existing).status !== 'ok') {
      return {
        ok: false,
        error: 'existingRecordUnreadable',
        status: this.statusFromEnvelope(existing, true)
      }
    }

    const updatedAt = this.now().toISOString()
    let encryptedPayload: Buffer
    try {
      const payload: PersistedPayload = { schemaVersion: 1, purpose: SECRET_PURPOSE, cookie }
      encryptedPayload = this.safeStorage.encryptString(JSON.stringify(payload))
      if (!Buffer.isBuffer(encryptedPayload) || encryptedPayload.byteLength === 0) {
        throw new Error('invalid encrypted payload')
      }
    } catch {
      return {
        ok: false,
        error: 'encryptFailed',
        status: this.statusFromEnvelope(this.readEnvelope(), true)
      }
    }

    try {
      this.writeEnvelope({
        schemaVersion: 1,
        purpose: ENVELOPE_PURPOSE,
        updatedAt,
        encryptedPayload: encryptedPayload.toString('base64')
      })
    } catch {
      return {
        ok: false,
        error: 'writeFailed',
        status: this.statusFromEnvelope(this.readEnvelope(), true)
      }
    }
    return { ok: true, status: { configured: true, encryptionAvailable: true, updatedAt } }
  }

  /** Main-process only. Returns a typed outcome, never an exception carrying
   *  secret material or a raw safeStorage error. */
  loadApiKey(): MistralWebSessionLoadResult {
    if (!this.encryptionAvailable()) return { status: 'encryptionUnavailable' }
    return this.loadFromEnvelope(this.readEnvelope())
  }

  clear(): MistralWebSessionMutationResult {
    try {
      unlinkSync(this.secretPath)
    } catch (error) {
      if (!isMissingPathError(error)) {
        return {
          ok: false,
          error: 'clearFailed',
          status: this.statusFromEnvelope(this.readEnvelope(), this.encryptionAvailable())
        }
      }
    }
    return {
      ok: true,
      status: { configured: false, encryptionAvailable: this.encryptionAvailable() }
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

  private statusFromEnvelope(
    persisted: EnvelopeRead,
    encryptionAvailable: boolean
  ): MistralWebSessionStatus {
    if (persisted.status === 'missing') return { configured: false, encryptionAvailable }
    if (persisted.status === 'ok') {
      return { configured: true, encryptionAvailable, updatedAt: persisted.envelope.updatedAt }
    }
    // Corrupt/unreadable reports as configured so no UI offers a silent
    // overwrite. Explicit clear is the recovery.
    return { configured: true, encryptionAvailable }
  }

  private loadFromEnvelope(persisted: EnvelopeRead): MistralWebSessionLoadResult {
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
    return payload ? { status: 'ok', value: payload.cookie } : { status: 'corrupt' }
  }

  private readEnvelope(): EnvelopeRead {
    let descriptor: number | null = null
    try {
      const before = lstatSync(this.secretPath, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n) return { status: 'unreadable' }
      if (before.size > BigInt(MAX_SECRET_FILE_BYTES)) return { status: 'corrupt' }

      const noFollow = this.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
      descriptor = openSync(this.secretPath, constants.O_RDONLY | noFollow)
      const opened = fstatSync(descriptor, { bigint: true })
      // Pin dev+ino across the lstat→open window so the path cannot be swapped
      // for another file between the two calls.
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        return { status: 'unreadable' }
      }
      if (opened.size > BigInt(MAX_SECRET_FILE_BYTES)) return { status: 'corrupt' }
      const envelope = parseEnvelope(readFileSync(descriptor, { encoding: 'utf8' }))
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
      closeSync(descriptor)
      descriptor = null
      renameSync(temporaryPath, this.secretPath)
      temporaryExists = false
      if (this.platform !== 'win32') chmodSync(this.secretPath, 0o600)
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
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) return null
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
      Number.isNaN(new Date(value.updatedAt).getTime()) ||
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
    if (
      value.schemaVersion !== 1 ||
      value.purpose !== SECRET_PURPOSE ||
      typeof value.cookie !== 'string' ||
      normalizeApiKey(value.cookie) !== value.cookie
    ) {
      return null
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
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error) && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

// ── process-wide singleton ───────────────────────────────────────────────────
// Constructed once after app-ready, when safeStorage has selected its final
// platform backend. Every accessor tolerates being called before that — the
// Admin lane is optional, so "not configured yet" must never throw.

let singleton: MistralWebSessionStore | null = null

export function configureMistralWebSessionStore(
  options: MistralWebSessionStoreOptions
): MistralWebSessionStore {
  singleton = new MistralWebSessionStore(options)
  return singleton
}

export function mistralWebSessionStore(): MistralWebSessionStore | null {
  return singleton
}
