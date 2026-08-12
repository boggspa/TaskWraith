import { createHash, createPublicKey, randomUUID, type KeyObject } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

import {
  exportPrivateKeyDer,
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  importEd25519PrivateKeyDer,
  type KeyPair
} from '../../shared/e2ee/keys'
import { channelAgentPublicKeyFingerprint } from '../../shared/collaboration/ChannelAgentProtocol'
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'

export const CHANNEL_AGENT_IDENTITY_STORE_VERSION = 1 as const
export const CHANNEL_AGENT_IDENTITY_FILE_SUFFIX = '.identity.json' as const
export const CHANNEL_AGENT_MAX_RETIRED_KEYS = 64

const SAFE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
const SEAT_HASH_DOMAIN = 'taskwraith.channel.agent-seat-file.v1\0'
const MAX_SEAT_ID_LENGTH = 512
const MAX_IDENTITY_ENVELOPE_BYTES = 256 * 1024
const MAX_IDENTITY_PAYLOAD_BYTES = 128 * 1024

export interface ChannelAgentIdentitySafeStorage extends HumanCollaborationSafeStorage {
  getSelectedStorageBackend?: () => string
}

export type ChannelAgentIdentityStoreErrorCode =
  | 'invalid_seat'
  | 'key_not_found'
  | 'persistence_failed'
  | 'recovery_blocked'
  | 'safe_storage_unavailable'

export class ChannelAgentIdentityStoreError extends Error {
  constructor(
    readonly code: ChannelAgentIdentityStoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentIdentityStoreError'
  }
}

export interface ChannelAgentPublicKeyRecord {
  readonly agentSeatId: string
  readonly keyGeneration: number
  readonly publicKeyB64: string
  readonly fingerprint: string
  readonly createdAt: number
  readonly retiredAt?: number
}

export interface ChannelAgentIdentityMaterial extends ChannelAgentPublicKeyRecord {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

export interface ChannelAgentPublicKeyHistory {
  readonly current: ChannelAgentPublicKeyRecord
  readonly retired: readonly ChannelAgentPublicKeyRecord[]
}

export interface ChannelAgentIdentityRotation {
  readonly identity: ChannelAgentIdentityMaterial
  readonly retired: ChannelAgentPublicKeyRecord
  readonly history: ChannelAgentPublicKeyHistory
}

export interface ChannelAgentIdentityStoreOptions {
  readonly storageDirectory: string
  readonly safeStorage: ChannelAgentIdentitySafeStorage
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly generateKeyPair?: () => KeyPair
  readonly randomId?: () => string
  readonly logger?: (line: string) => void
}

interface StoredCurrentKey {
  readonly keyGeneration: number
  readonly privateKeyDerB64: string
  readonly publicKeyB64: string
  readonly createdAt: number
}

interface StoredRetiredKey {
  readonly keyGeneration: number
  readonly publicKeyB64: string
  readonly createdAt: number
  readonly retiredAt: number
}

interface StoredIdentityPayload {
  readonly schemaVersion: typeof CHANNEL_AGENT_IDENTITY_STORE_VERSION
  readonly agentSeatId: string
  readonly current: StoredCurrentKey
  readonly retired: readonly StoredRetiredKey[]
}

interface StoredIdentityEnvelope {
  readonly schemaVersion: typeof CHANNEL_AGENT_IDENTITY_STORE_VERSION
  readonly seatIdHash: string
  readonly encryptedPayload: string
}

function storeError(
  code: ChannelAgentIdentityStoreErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentIdentityStoreError {
  // safeStorage and filesystem errors are not projected: a hostile callback can put key
  // material in its message, while callers only need the stable code and bounded context.
  return new ChannelAgentIdentityStoreError(code, message)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeSeatId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SEAT_ID_LENGTH) {
    return false
  }
  if (value.trim() !== value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isCanonicalBase64(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const decoded = Buffer.from(value, 'base64')
    return (
      decoded.length > 0 &&
      (expectedBytes === undefined || decoded.length === expectedBytes) &&
      decoded.toString('base64') === value
    )
  } catch {
    return false
  }
}

function parseCurrentKey(value: unknown): StoredCurrentKey | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['keyGeneration', 'privateKeyDerB64', 'publicKeyB64', 'createdAt']) ||
    !isGeneration(value.keyGeneration) ||
    !isCanonicalBase64(value.privateKeyDerB64) ||
    !isCanonicalBase64(value.publicKeyB64, 32) ||
    !isTimestamp(value.createdAt)
  ) {
    return null
  }
  return {
    keyGeneration: value.keyGeneration,
    privateKeyDerB64: value.privateKeyDerB64,
    publicKeyB64: value.publicKeyB64,
    createdAt: value.createdAt
  }
}

function parseRetiredKey(value: unknown): StoredRetiredKey | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['keyGeneration', 'publicKeyB64', 'createdAt', 'retiredAt']) ||
    !isGeneration(value.keyGeneration) ||
    !isCanonicalBase64(value.publicKeyB64, 32) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.retiredAt) ||
    value.retiredAt < value.createdAt
  ) {
    return null
  }
  return {
    keyGeneration: value.keyGeneration,
    publicKeyB64: value.publicKeyB64,
    createdAt: value.createdAt,
    retiredAt: value.retiredAt
  }
}

function parsePayload(value: unknown, expectedSeatId: string): StoredIdentityPayload | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['schemaVersion', 'agentSeatId', 'current', 'retired']) ||
    value.schemaVersion !== CHANNEL_AGENT_IDENTITY_STORE_VERSION ||
    value.agentSeatId !== expectedSeatId ||
    !Array.isArray(value.retired) ||
    value.retired.length > CHANNEL_AGENT_MAX_RETIRED_KEYS
  ) {
    return null
  }
  const current = parseCurrentKey(value.current)
  const retired = value.retired.map(parseRetiredKey)
  if (!current || retired.some((entry) => entry === null)) return null
  const completeRetired = retired as StoredRetiredKey[]
  if (current.keyGeneration !== completeRetired.length + 1) return null
  const publicKeys = new Set<string>()
  for (let index = 0; index < completeRetired.length; index += 1) {
    const entry = completeRetired[index]
    if (entry.keyGeneration !== index + 1 || publicKeys.has(entry.publicKeyB64)) return null
    publicKeys.add(entry.publicKeyB64)
    const nextCreatedAt = completeRetired[index + 1]?.createdAt ?? current.createdAt
    if (entry.retiredAt !== nextCreatedAt) return null
  }
  if (publicKeys.has(current.publicKeyB64)) return null
  return {
    schemaVersion: CHANNEL_AGENT_IDENTITY_STORE_VERSION,
    agentSeatId: expectedSeatId,
    current,
    retired: completeRetired
  }
}

function parseEnvelope(value: unknown, expectedSeatHash: string): StoredIdentityEnvelope | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['schemaVersion', 'seatIdHash', 'encryptedPayload']) ||
    value.schemaVersion !== CHANNEL_AGENT_IDENTITY_STORE_VERSION ||
    value.seatIdHash !== expectedSeatHash ||
    !/^[a-f0-9]{64}$/.test(value.seatIdHash) ||
    !isCanonicalBase64(value.encryptedPayload)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_IDENTITY_STORE_VERSION,
    seatIdHash: value.seatIdHash,
    encryptedPayload: value.encryptedPayload
  }
}

export function channelAgentSeatFileHash(agentSeatId: string): string {
  if (!isSafeSeatId(agentSeatId)) throw storeError('invalid_seat', 'Agent seat id is invalid')
  return createHash('sha256').update(SEAT_HASH_DOMAIN).update(agentSeatId, 'utf8').digest('hex')
}

function publicRecord(
  agentSeatId: string,
  value: StoredCurrentKey | StoredRetiredKey
): ChannelAgentPublicKeyRecord {
  return {
    agentSeatId,
    keyGeneration: value.keyGeneration,
    publicKeyB64: value.publicKeyB64,
    fingerprint: channelAgentPublicKeyFingerprint(value.publicKeyB64),
    createdAt: value.createdAt,
    ...('retiredAt' in value ? { retiredAt: value.retiredAt } : {})
  }
}

export class ChannelAgentIdentityStore {
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly generateKeyPair: () => KeyPair
  private readonly randomId: () => string
  private readonly logger: (line: string) => void

  constructor(private readonly options: ChannelAgentIdentityStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw storeError('persistence_failed', 'ChannelAgentIdentityStore requires options')
    }
    if (typeof options.storageDirectory !== 'string' || !options.storageDirectory.trim()) {
      throw storeError('persistence_failed', 'Channel agent identity directory is required')
    }
    if (!options.safeStorage || typeof options.safeStorage !== 'object') {
      throw storeError('safe_storage_unavailable', 'Channel agent safeStorage is required')
    }
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
    this.generateKeyPair = options.generateKeyPair ?? generateIdentityKeyPair
    this.randomId = options.randomId ?? randomUUID
    this.logger = options.logger ?? (() => {})
  }

  loadOrCreate(agentSeatId: string): ChannelAgentIdentityMaterial {
    const existing = this.readRecord(agentSeatId)
    if (existing) return this.material(existing)
    this.assertSafeStorage()
    this.prepareDirectory()
    this.removeStaleTemporaryFiles(channelAgentSeatFileHash(agentSeatId))

    const keyPair = this.generateKeyPair()
    const createdAt = this.requireNow()
    const payload = this.payloadForKeyPair(agentSeatId, 1, keyPair, createdAt, [])
    if (!this.persist(payload, false)) {
      const winner = this.readRecord(agentSeatId)
      if (!winner) {
        throw storeError('persistence_failed', 'Concurrent agent identity creation did not persist')
      }
      return this.material(winner)
    }
    return this.material({ payload, keyPair })
  }

  load(agentSeatId: string): ChannelAgentIdentityMaterial | null {
    const record = this.readRecord(agentSeatId)
    return record ? this.material(record) : null
  }

  publicHistory(agentSeatId: string): ChannelAgentPublicKeyHistory | null {
    const record = this.readRecord(agentSeatId)
    if (!record) return null
    return this.history(record.payload)
  }

  rotate(agentSeatId: string): ChannelAgentIdentityRotation {
    const existing = this.readRecord(agentSeatId)
    if (!existing) throw storeError('key_not_found', 'Channel agent identity does not exist')
    this.assertSafeStorage()
    const retiredAt = this.requireNow()
    if (retiredAt < existing.payload.current.createdAt) {
      throw storeError(
        'recovery_blocked',
        'Channel agent identity clock moved behind the current key generation'
      )
    }
    const previous = publicRecord(agentSeatId, { ...existing.payload.current, retiredAt })
    const retired: StoredRetiredKey[] = [
      ...existing.payload.retired,
      {
        keyGeneration: existing.payload.current.keyGeneration,
        publicKeyB64: existing.payload.current.publicKeyB64,
        createdAt: existing.payload.current.createdAt,
        retiredAt
      }
    ]
    if (retired.length > CHANNEL_AGENT_MAX_RETIRED_KEYS) {
      throw storeError(
        'recovery_blocked',
        'Channel agent key-history limit reached; explicit archival is required'
      )
    }
    const nextPair = this.generateKeyPair()
    const payload = this.payloadForKeyPair(
      agentSeatId,
      existing.payload.current.keyGeneration + 1,
      nextPair,
      retiredAt,
      retired
    )
    this.persist(payload, true, existing.rawEnvelope)
    return {
      identity: this.material({ payload, keyPair: nextPair }),
      retired: previous,
      history: this.history(payload)
    }
  }

  /** Explicit recovery/erasure. Removes current, corrupt, and temporary files for one seat. */
  erase(agentSeatId: string): number {
    const seatHash = channelAgentSeatFileHash(agentSeatId)
    if (!existsSync(this.options.storageDirectory)) return 0
    this.assertExistingDirectory()
    let removed = 0
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      if (
        (!entry.isFile() && !entry.isSymbolicLink()) ||
        !this.isOwnedSeatFile(entry.name, seatHash)
      ) {
        continue
      }
      unlinkSync(join(this.options.storageDirectory, entry.name))
      removed += 1
    }
    if (removed > 0) this.syncDirectory()
    return removed
  }

  /** Global collaboration erasure removes only files owned by this dedicated store. */
  purgeAll(): number {
    if (!existsSync(this.options.storageDirectory)) return 0
    this.assertExistingDirectory()
    let removed = 0
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !this.isOwnedIdentityFile(entry.name)) {
        continue
      }
      unlinkSync(join(this.options.storageDirectory, entry.name))
      removed += 1
    }
    if (removed > 0) this.syncDirectory()
    return removed
  }

  private readRecord(agentSeatId: string): {
    payload: StoredIdentityPayload
    keyPair: KeyPair
    rawEnvelope: string
  } | null {
    const seatHash = channelAgentSeatFileHash(agentSeatId)
    this.assertExistingDirectory()
    this.assertNoQuarantine(seatHash)
    const path = this.identityPath(seatHash)

    let pathStat: ReturnType<typeof lstatSync>
    try {
      pathStat = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw storeError('recovery_blocked', 'Channel agent identity cannot be inspected', error)
    }
    this.assertSafeStorage()
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) {
      return this.quarantine(path, seatHash, 'identity path is not a private regular file')
    }
    if (pathStat.size > MAX_IDENTITY_ENVELOPE_BYTES) {
      return this.quarantine(path, seatHash, 'identity envelope exceeds its size limit')
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent identity cannot be read', error)
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES) {
      return this.quarantine(path, seatHash, 'identity envelope exceeds its size limit')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch (error) {
      return this.quarantine(path, seatHash, 'identity envelope is not valid JSON', error)
    }
    const envelope = parseEnvelope(decoded, seatHash)
    if (!envelope) return this.quarantine(path, seatHash, 'identity envelope is malformed')

    let plaintext: string
    try {
      plaintext = this.options.safeStorage.decryptString(
        Buffer.from(envelope.encryptedPayload, 'base64')
      )
    } catch (error) {
      throw storeError(
        'recovery_blocked',
        'Channel agent identity cannot be decrypted; refusing replacement',
        error
      )
    }
    if (
      typeof plaintext !== 'string' ||
      Buffer.byteLength(plaintext, 'utf8') > MAX_IDENTITY_PAYLOAD_BYTES
    ) {
      return this.quarantine(path, seatHash, 'decrypted identity payload exceeds its limits')
    }
    try {
      const currentStat = lstatSync(path)
      if (
        !currentStat.isFile() ||
        currentStat.isSymbolicLink() ||
        currentStat.nlink !== 1 ||
        currentStat.dev !== pathStat.dev ||
        currentStat.ino !== pathStat.ino ||
        readFileSync(path, 'utf8') !== raw
      ) {
        throw storeError(
          'recovery_blocked',
          'Channel agent identity changed during safeStorage decryption'
        )
      }
    } catch (error) {
      if (error instanceof ChannelAgentIdentityStoreError) throw error
      throw storeError('recovery_blocked', 'Channel agent identity could not be revalidated', error)
    }

    let payloadValue: unknown
    try {
      payloadValue = JSON.parse(plaintext)
    } catch (error) {
      return this.quarantine(path, seatHash, 'decrypted identity payload is not JSON', error)
    }
    const payload = parsePayload(payloadValue, agentSeatId)
    if (!payload) return this.quarantine(path, seatHash, 'decrypted identity payload is malformed')

    let privateKey: KeyObject
    let publicKey: KeyObject
    try {
      privateKey = importEd25519PrivateKeyDer(
        Buffer.from(payload.current.privateKeyDerB64, 'base64')
      )
      publicKey = createPublicKey(privateKey)
      const derived = exportRawEd25519PublicKey(publicKey).toString('base64')
      if (derived !== payload.current.publicKeyB64) {
        return this.quarantine(path, seatHash, 'private and public identity keys do not match')
      }
    } catch (error) {
      if (error instanceof ChannelAgentIdentityStoreError) throw error
      return this.quarantine(path, seatHash, 'decrypted private identity key is invalid', error)
    }
    this.repairPermissions(path)
    return { payload, keyPair: { privateKey, publicKey }, rawEnvelope: raw }
  }

  private payloadForKeyPair(
    agentSeatId: string,
    keyGeneration: number,
    keyPair: KeyPair,
    createdAt: number,
    retired: readonly StoredRetiredKey[]
  ): StoredIdentityPayload {
    let privateKeyDerB64: string
    let publicKeyB64: string
    try {
      privateKeyDerB64 = exportPrivateKeyDer(keyPair.privateKey).toString('base64')
      publicKeyB64 = exportRawEd25519PublicKey(keyPair.publicKey).toString('base64')
      const derived = exportRawEd25519PublicKey(createPublicKey(keyPair.privateKey)).toString(
        'base64'
      )
      if (derived !== publicKeyB64) {
        throw new Error('generated private and public keys do not match')
      }
      if (retired.some((entry) => entry.publicKeyB64 === publicKeyB64)) {
        throw new Error('generated key repeats a retired generation')
      }
    } catch (error) {
      throw storeError('persistence_failed', 'Generated Channel agent identity is invalid', error)
    }
    return {
      schemaVersion: CHANNEL_AGENT_IDENTITY_STORE_VERSION,
      agentSeatId,
      current: {
        keyGeneration,
        privateKeyDerB64,
        publicKeyB64,
        createdAt
      },
      retired: [...retired]
    }
  }

  private persist(
    payload: StoredIdentityPayload,
    replace: boolean,
    expectedRawEnvelope?: string
  ): boolean {
    this.assertSafeStorage()
    const seatHash = channelAgentSeatFileHash(payload.agentSeatId)
    const path = this.identityPath(seatHash)
    this.prepareDirectory()
    let encryptedPayload: string
    try {
      const plaintext = JSON.stringify(payload)
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_IDENTITY_PAYLOAD_BYTES) {
        throw new Error('identity payload is too large')
      }
      const encrypted = this.options.safeStorage.encryptString(plaintext)
      if (
        !Buffer.isBuffer(encrypted) ||
        encrypted.length === 0 ||
        encrypted.length > MAX_IDENTITY_ENVELOPE_BYTES
      ) {
        throw new Error('safeStorage returned invalid ciphertext')
      }
      encryptedPayload = encrypted.toString('base64')
    } catch (error) {
      throw storeError('persistence_failed', 'Channel agent identity encryption failed', error)
    }
    const envelope: StoredIdentityEnvelope = {
      schemaVersion: CHANNEL_AGENT_IDENTITY_STORE_VERSION,
      seatIdHash: seatHash,
      encryptedPayload
    }
    const serializedEnvelope = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serializedEnvelope, 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES) {
      throw storeError('persistence_failed', 'Channel agent identity envelope exceeds its limits')
    }
    const temporaryPath = `${path}.tmp-${process.pid}-${this.randomId()}`
    try {
      writeFileSync(temporaryPath, serializedEnvelope, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      this.syncFile(temporaryPath)
      if (replace) {
        if (expectedRawEnvelope === undefined) {
          throw storeError('persistence_failed', 'Identity replacement requires a prior snapshot')
        }
        let currentRaw: string
        try {
          currentRaw = readFileSync(path, 'utf8')
        } catch (error) {
          throw storeError(
            'recovery_blocked',
            'Channel agent identity changed before rotation committed',
            error
          )
        }
        if (currentRaw !== expectedRawEnvelope) {
          throw storeError(
            'recovery_blocked',
            'Channel agent identity changed before rotation committed'
          )
        }
        renameSync(temporaryPath, path)
      } else {
        try {
          linkSync(temporaryPath, path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            unlinkSync(temporaryPath)
            return false
          }
          throw error
        }
        unlinkSync(temporaryPath)
      }
      chmodSync(path, 0o600)
      this.syncDirectory()
      return true
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      } catch {
        // The original error is authoritative; stale temp cleanup is retried on load.
      }
      if (error instanceof ChannelAgentIdentityStoreError) throw error
      throw storeError('persistence_failed', 'Channel agent identity persistence failed', error)
    }
  }

  private material(record: {
    payload: StoredIdentityPayload
    keyPair: KeyPair
    rawEnvelope?: string
  }): ChannelAgentIdentityMaterial {
    const current = publicRecord(record.payload.agentSeatId, record.payload.current)
    return {
      ...current,
      privateKey: record.keyPair.privateKey,
      publicKey: record.keyPair.publicKey
    }
  }

  private history(payload: StoredIdentityPayload): ChannelAgentPublicKeyHistory {
    return {
      current: publicRecord(payload.agentSeatId, payload.current),
      retired: payload.retired.map((entry) => publicRecord(payload.agentSeatId, entry))
    }
  }

  private assertSafeStorage(): void {
    let available: boolean
    try {
      available = this.options.safeStorage.isEncryptionAvailable() === true
    } catch (error) {
      throw storeError(
        'safe_storage_unavailable',
        'Channel agent safeStorage availability failed',
        error
      )
    }
    if (!available) {
      throw storeError(
        'safe_storage_unavailable',
        'Channel agent safeStorage encryption is unavailable'
      )
    }
    if (this.platform !== 'linux') return
    let backend: string
    try {
      backend = this.options.safeStorage.getSelectedStorageBackend?.() ?? ''
    } catch (error) {
      throw storeError(
        'safe_storage_unavailable',
        'Channel agent Linux safeStorage backend cannot be determined',
        error
      )
    }
    if (!SAFE_LINUX_BACKENDS.has(backend)) {
      throw storeError(
        'safe_storage_unavailable',
        `Channel agent Linux safeStorage backend ${backend || 'unknown'} is not encrypted`
      )
    }
  }

  private assertNoQuarantine(seatHash: string): void {
    if (!existsSync(this.options.storageDirectory)) return
    const prefix = `${seatHash}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}.corrupt-`
    const blocked = readdirSync(this.options.storageDirectory, { withFileTypes: true }).some(
      (entry) => entry.name.startsWith(prefix)
    )
    if (blocked) {
      throw storeError(
        'recovery_blocked',
        'Channel agent identity is quarantined; explicit erase/re-enrolment is required'
      )
    }
  }

  private quarantine(path: string, seatHash: string, reason: string, cause?: unknown): never {
    const quarantinePath = `${path}.corrupt-${this.requireNow()}-${this.randomId()}`
    try {
      renameSync(path, quarantinePath)
      this.syncDirectory()
    } catch (error) {
      this.logger(`[channel-agent-identity] quarantine failed: ${reason}`)
      throw storeError('recovery_blocked', `${reason}; quarantine failed`, error)
    }
    this.logger(`[channel-agent-identity] ${seatHash.slice(0, 12)} quarantined: ${reason}`)
    throw storeError('recovery_blocked', reason, cause)
  }

  private prepareDirectory(): void {
    try {
      mkdirSync(this.options.storageDirectory, { recursive: true, mode: 0o700 })
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('identity storage path is not a private directory')
      }
    } catch (error) {
      throw storeError('persistence_failed', 'Channel agent identity directory is unsafe', error)
    }
    try {
      chmodSync(this.options.storageDirectory, 0o700)
    } catch {
      // File-level mode is still enforced; unsupported directory chmod is non-fatal.
    }
  }

  private repairPermissions(path: string): void {
    try {
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent identity permissions are unsafe', error)
    }
  }

  private removeStaleTemporaryFiles(seatHash: string): void {
    if (!existsSync(this.options.storageDirectory)) return
    const prefix = `${seatHash}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}.tmp-`
    let removed = false
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix)) continue
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw storeError(
          'recovery_blocked',
          'Channel agent identity has an unsafe temporary recovery path'
        )
      }
      unlinkSync(join(this.options.storageDirectory, entry.name))
      removed = true
    }
    if (removed) this.syncDirectory()
  }

  private isOwnedSeatFile(name: string, seatHash: string): boolean {
    const base = `${seatHash}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`
    return name === base || name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.corrupt-`)
  }

  private isOwnedIdentityFile(name: string): boolean {
    return /^[a-f0-9]{64}\.identity\.json(?:\.(?:tmp|corrupt)-.+)?$/.test(name)
  }

  private identityPath(seatHash: string): string {
    return join(this.options.storageDirectory, `${seatHash}${CHANNEL_AGENT_IDENTITY_FILE_SUFFIX}`)
  }

  private requireNow(): number {
    const value = this.now()
    if (!isTimestamp(value)) throw storeError('persistence_failed', 'Identity clock is invalid')
    return value
  }

  private assertExistingDirectory(): void {
    if (!existsSync(this.options.storageDirectory)) return
    try {
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('identity storage path is not a private directory')
      }
      if ((directory.mode & 0o077) !== 0) chmodSync(this.options.storageDirectory, 0o700)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent identity directory is unsafe', error)
    }
  }

  private syncFile(path: string): void {
    const descriptor = openSync(path, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  private syncDirectory(): void {
    try {
      const descriptor = openSync(this.options.storageDirectory, 'r')
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      // Some platforms reject directory fsync; file contents are already synced.
    }
  }
}
