/**
 * Microsoft Graph credential store — safeStorage-encrypted envelope on disk,
 * modelled on AntigravityGeminiApiSecretStore.
 *
 * Main-process only. There is deliberately NO IPC channel that returns a
 * token: the renderer can learn that an account is connected and when, and
 * nothing else. Refusing to store anything when encryption is unavailable is
 * the point — a refresh token is a long-lived key to a mailbox and must
 * never land in plaintext.
 *
 * The client id is NOT a secret (public-client device-code flow has no
 * client secret at all), but it lives in the same envelope so connecting is
 * one atomic act.
 */

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
import { basename, dirname, join } from 'node:path'
import type { GraphScopeMode, GraphTokenSet } from './MicrosoftDeviceCodeAuth'

export const OUTLOOK_CREDENTIAL_FILENAME = 'outlook-graph-credentials.json'

const ENVELOPE_PURPOSE = 'taskwraith:outlook-graph-credentials-envelope:v1'
const SECRET_PURPOSE = 'taskwraith:outlook-graph-credentials:v1'
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024
const ENCRYPTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export interface OutlookSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * The only credential shape suitable for renderer projection. It never
 * contains a token, its ciphertext, or a storage path.
 */
export interface OutlookConnectionStatus {
  connected: boolean
  encryptionAvailable: boolean
  /** Display name / UPN of the signed-in account, when known. */
  account?: string
  /** 'read' until the user explicitly opts into write scopes. */
  scopeMode?: GraphScopeMode
  updatedAt?: string
}

export interface OutlookCredentials {
  clientId: string
  tenant: string
  scopeMode: GraphScopeMode
  tokens: GraphTokenSet
  account: string | null
}

export type OutlookCredentialLoad =
  | { status: 'ok'; credentials: OutlookCredentials }
  | { status: 'missing' | 'encryptionUnavailable' | 'unreadable' | 'corrupt' | 'decryptFailed' }

interface PersistedEnvelope {
  schemaVersion: 1
  purpose: string
  updatedAt: string
  encryptedPayload: string
}

type EnvelopeRead =
  | { status: 'ok'; envelope: PersistedEnvelope }
  | { status: 'missing' | 'unreadable' | 'corrupt' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMissingPathError = (error: unknown): boolean =>
  isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

function parseEnvelope(serialized: string): PersistedEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.schemaVersion !== 1 || parsed.purpose !== ENVELOPE_PURPOSE) return null
  const encryptedPayload = parsed.encryptedPayload
  const updatedAt = parsed.updatedAt
  if (typeof encryptedPayload !== 'string' || typeof updatedAt !== 'string') return null
  return { schemaVersion: 1, purpose: ENVELOPE_PURPOSE, updatedAt, encryptedPayload }
}

function parsePayload(plaintext: string): OutlookCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.purpose !== SECRET_PURPOSE) return null
  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : ''
  const tenant = typeof parsed.tenant === 'string' ? parsed.tenant : 'common'
  const scopeMode = parsed.scopeMode === 'write' ? 'write' : 'read'
  const account = typeof parsed.account === 'string' ? parsed.account : null
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : null
  if (!clientId || !tokens) return null
  const accessToken = typeof tokens.accessToken === 'string' ? tokens.accessToken : ''
  const refreshToken = typeof tokens.refreshToken === 'string' ? tokens.refreshToken : null
  const expiresAtMs = typeof tokens.expiresAtMs === 'number' ? tokens.expiresAtMs : 0
  const scopes = Array.isArray(tokens.scopes)
    ? tokens.scopes.filter((scope): scope is string => typeof scope === 'string')
    : []
  if (!accessToken) return null
  return {
    clientId,
    tenant,
    scopeMode,
    account,
    tokens: { accessToken, refreshToken, expiresAtMs, scopes, account }
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(directory, constants.O_RDONLY)
    fsyncSync(descriptor)
  } catch {
    // Durability of the directory entry is best-effort.
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore.
      }
    }
  }
}

export interface OutlookCredentialStoreOptions {
  readonly userDataPath: string
  readonly safeStorage: OutlookSafeStorage
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
}

export class OutlookCredentialStore {
  private readonly credentialPath: string
  private readonly safeStorage: OutlookSafeStorage
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date

  constructor(options: OutlookCredentialStoreOptions) {
    this.credentialPath = join(options.userDataPath, OUTLOOK_CREDENTIAL_FILENAME)
    this.safeStorage = options.safeStorage
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
  }

  status(): OutlookConnectionStatus {
    const encryptionAvailable = this.encryptionAvailable()
    const persisted = this.readEnvelope()
    if (persisted.status === 'missing') return { connected: false, encryptionAvailable }
    if (persisted.status !== 'ok') {
      // Corrupt/unreadable reports as connected so the UI offers disconnect
      // (the recovery boundary) rather than silently inviting an overwrite.
      return { connected: true, encryptionAvailable }
    }
    const loaded = this.loadFromEnvelope(persisted)
    if (loaded.status !== 'ok') {
      return { connected: true, encryptionAvailable, updatedAt: persisted.envelope.updatedAt }
    }
    return {
      connected: true,
      encryptionAvailable,
      account: loaded.credentials.account ?? undefined,
      scopeMode: loaded.credentials.scopeMode,
      updatedAt: persisted.envelope.updatedAt
    }
  }

  /** Main-process only. Never expose the result across an IPC boundary. */
  load(): OutlookCredentialLoad {
    if (!this.encryptionAvailable()) return { status: 'encryptionUnavailable' }
    return this.loadFromEnvelope(this.readEnvelope())
  }

  save(credentials: OutlookCredentials): { ok: boolean; status: OutlookConnectionStatus } {
    if (!this.encryptionAvailable()) {
      return { ok: false, status: { connected: false, encryptionAvailable: false } }
    }
    try {
      const payload = JSON.stringify({
        schemaVersion: 1,
        purpose: SECRET_PURPOSE,
        clientId: credentials.clientId,
        tenant: credentials.tenant,
        scopeMode: credentials.scopeMode,
        account: credentials.account,
        tokens: credentials.tokens
      })
      const encryptedPayload = this.safeStorage.encryptString(payload).toString('base64')
      this.writeEnvelope({
        schemaVersion: 1,
        purpose: ENVELOPE_PURPOSE,
        updatedAt: this.now().toISOString(),
        encryptedPayload
      })
      return { ok: true, status: this.status() }
    } catch {
      return { ok: false, status: this.status() }
    }
  }

  clear(): { ok: boolean; status: OutlookConnectionStatus } {
    try {
      unlinkSync(this.credentialPath)
    } catch (error) {
      if (!isMissingPathError(error)) {
        return { ok: false, status: this.status() }
      }
    }
    return { ok: true, status: this.status() }
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

  private loadFromEnvelope(persisted: EnvelopeRead): OutlookCredentialLoad {
    if (persisted.status !== 'ok') return persisted
    let plaintext: string
    try {
      plaintext = this.safeStorage.decryptString(
        Buffer.from(persisted.envelope.encryptedPayload, 'base64')
      )
    } catch {
      return { status: 'decryptFailed' }
    }
    const credentials = parsePayload(plaintext)
    return credentials ? { status: 'ok', credentials } : { status: 'corrupt' }
  }

  private readEnvelope(): EnvelopeRead {
    let descriptor: number | null = null
    try {
      const before = lstatSync(this.credentialPath, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n) return { status: 'unreadable' }
      if (before.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)) return { status: 'corrupt' }

      const noFollow = this.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
      descriptor = openSync(this.credentialPath, constants.O_RDONLY | noFollow)
      const opened = fstatSync(descriptor, { bigint: true })
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        return { status: 'unreadable' }
      }
      if (opened.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)) return { status: 'corrupt' }
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
    const directory = dirname(this.credentialPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = join(
      directory,
      `.${basename(this.credentialPath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
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
      renameSync(temporaryPath, this.credentialPath)
      temporaryExists = false
      if (this.platform !== 'win32') {
        chmodSync(this.credentialPath, 0o600)
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
