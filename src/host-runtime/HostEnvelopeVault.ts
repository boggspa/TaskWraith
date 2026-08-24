import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, isAbsolute, join, parse, resolve } from 'node:path'

/** A pure Host envelope-vault core. Platform keychain adapters stay outside this module. */
export const HOST_ENVELOPE_VAULT_DIRECTORY = 'host-envelope-vault'
export const HOST_ENVELOPE_VAULT_SCHEMA_VERSION = 1 as const
export const HOST_ENVELOPE_VAULT_PURPOSE = 'taskwraith:host-envelope-vault:v1'
export const HOST_ENVELOPE_VAULT_MAX_FILE_BYTES = 256 * 1024
/**
 * Small-secret core limit. Leaves room for base64 ciphertext, nonce/tag, and
 * canonical metadata; large migration checkpoints require a chunked format.
 */
export const HOST_ENVELOPE_VAULT_MAX_PLAINTEXT_BYTES = 128 * 1024

const MASTER_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12
const GCM_AUTH_TAG_BYTES = 16
const SHA256_BYTES = 32
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MASTER_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HEX_256_PATTERN = /^[a-f0-9]{64}$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Transfer-only master-key source. The returned key Buffer must contain exactly
 * 32 random bytes. The vault copies it and zeroes the supplied buffer before
 * returning from construction; adapters must not reuse that Buffer. `masterKeyId`
 * is a bounded non-secret key epoch used to distinguish rotation from ordinary
 * AES-GCM authentication failures.
 */
export interface HostEnvelopeVaultMasterKeyPort {
  acquireMasterKey(): HostEnvelopeVaultMasterKeyMaterial
}

export interface HostEnvelopeVaultMasterKeyMaterial {
  readonly key: Buffer
  readonly masterKeyId: string
}

export interface HostEnvelopeVaultRandomPort {
  randomBytes(size: number): Buffer
}

export interface HostEnvelopeVaultClock {
  now(): Date
}

export interface HostEnvelopeVaultCryptoPort {
  sha256(input: Buffer): Buffer
  encrypt(input: { key: Buffer; nonce: Buffer; aad: Buffer; plaintext: Buffer }): {
    ciphertext: Buffer
    authTag: Buffer
  }
  decrypt(input: {
    key: Buffer
    nonce: Buffer
    aad: Buffer
    ciphertext: Buffer
    authTag: Buffer
  }): Buffer
}

export interface HostEnvelopeVaultFileStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number | bigint
  readonly nlink?: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Small synchronous filesystem seam for deterministic durability fault tests. */
export interface HostEnvelopeVaultFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_WRONLY: number
    readonly O_CREAT: number
    readonly O_EXCL: number
    readonly O_NOFOLLOW?: number
    readonly O_NONBLOCK?: number
  }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  realpathSync(path: string): string
  lstatSync(path: string): HostEnvelopeVaultFileStat
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number): HostEnvelopeVaultFileStat
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ): number
  writeSync(fd: number, data: Buffer): number
  fsyncSync(fd: number): void
  fchmodSync(fd: number, mode: number): void
  chmodSync(path: string, mode: number): void
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  readdirSync(path: string): string[]
}

export interface HostEnvelopeVaultOptions {
  /** Owner profile directory, supplied by the Host authority after profile fencing. */
  readonly profilePath: string
  readonly masterKey: HostEnvelopeVaultMasterKeyPort
  readonly fs?: HostEnvelopeVaultFs
  readonly crypto?: HostEnvelopeVaultCryptoPort
  readonly random?: HostEnvelopeVaultRandomPort
  readonly clock?: HostEnvelopeVaultClock
  readonly platform?: NodeJS.Platform
}

export interface HostEnvelopeVaultRecordMetadata {
  readonly recordId: string
  readonly generation: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly plaintextByteLength: number
}

export interface HostEnvelopeVaultReadResult extends HostEnvelopeVaultRecordMetadata {
  /** Caller-owned secret bytes. The caller must zero this Buffer in a finally block. */
  readonly plaintext: Buffer
}

interface PersistedEnvelope extends HostEnvelopeVaultRecordMetadata {
  readonly schemaVersion: 1
  readonly purpose: typeof HOST_ENVELOPE_VAULT_PURPOSE
  readonly profileFingerprint: string
  readonly masterKeyId: string
  readonly state: 'active' | 'deleted'
  readonly nonce: string
  readonly ciphertext: string
  readonly authTag: string
}

interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

interface ReadEnvelope {
  readonly envelope: PersistedEnvelope
  readonly plaintext: Buffer
  readonly identity: FileIdentity
}

export class HostEnvelopeVaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostEnvelopeVaultError'
  }
}

/** A persisted record is malformed, substituted, tampered with, or rolled back. */
export class HostEnvelopeVaultIntegrityError extends HostEnvelopeVaultError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostEnvelopeVaultIntegrityError'
  }
}

export class HostEnvelopeVaultDisposedError extends HostEnvelopeVaultError {
  constructor() {
    super('Host envelope vault is disposed.')
    this.name = 'HostEnvelopeVaultDisposedError'
  }
}

/** The master-key epoch in a valid envelope does not match this vault's key. */
export class HostEnvelopeVaultKeyMismatchError extends HostEnvelopeVaultIntegrityError {
  constructor() {
    super('Vault envelope was sealed with a different master-key epoch.')
    this.name = 'HostEnvelopeVaultKeyMismatchError'
  }
}

/** Publication may have reached durable storage even though the call failed. */
export class HostEnvelopeVaultIndeterminateError extends HostEnvelopeVaultError {
  readonly operation: 'record' | 'tombstone'

  constructor(operation: 'record' | 'tombstone', options?: ErrorOptions) {
    super(
      `Host envelope vault ${operation} publication is indeterminate; inspect durable state before retrying.`,
      options
    )
    this.name = 'HostEnvelopeVaultIndeterminateError'
    this.operation = operation
  }
}

const productionFs: HostEnvelopeVaultFs = nodeFs as HostEnvelopeVaultFs
const productionRandom: HostEnvelopeVaultRandomPort = { randomBytes }
const productionClock: HostEnvelopeVaultClock = { now: () => new Date() }
const productionCrypto: HostEnvelopeVaultCryptoPort = {
  sha256: (input) => createHash('sha256').update(input).digest(),
  encrypt: ({ key, nonce, aad, plaintext }) => {
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
      authTag: cipher.getAuthTag()
    }
  },
  decrypt: ({ key, nonce, aad, ciphertext, authTag }) => {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  }
}

/**
 * Profile-bound AES-256-GCM vault for small secrets (at most 128 KiB plaintext
 * per record). This core neither creates nor persists a master key: platform
 * adapters must provide the key explicitly. Large migration checkpoints need a
 * separate chunked envelope format rather than raising this small-secret bound.
 *
 * Generation rollback detection is process-local. It catches a previously
 * observed record being replaced by an older envelope during this Host's
 * lifetime. Durable rollback resistance requires an external monotonic
 * authority (future profile lock/audit integration) and is intentionally not
 * claimed by this standalone core.
 */
export class HostEnvelopeVault {
  private readonly fs: HostEnvelopeVaultFs
  private readonly crypto: HostEnvelopeVaultCryptoPort
  private readonly random: HostEnvelopeVaultRandomPort
  private readonly clock: HostEnvelopeVaultClock
  private readonly platform: NodeJS.Platform
  private readonly profilePath: string
  private readonly vaultPath: string
  private readonly profileFingerprint: string
  private readonly masterKeyId: string
  private readonly generationFloor = new Map<string, number>()
  private key: Buffer | null

  constructor(options: HostEnvelopeVaultOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Host envelope vault options are required.')
    }
    this.fs = options.fs || productionFs
    this.crypto = options.crypto || productionCrypto
    this.random = options.random || productionRandom
    this.clock = options.clock || productionClock
    this.platform = options.platform || process.platform
    this.profilePath = canonicalProfilePath(options.profilePath, this.fs)
    this.vaultPath = initializeVaultDirectory(this.profilePath, this.fs, this.platform)
    this.profileFingerprint = profileFingerprintFor(this.profilePath, this.crypto)
    const material = acquireTransferredMasterKey(options.masterKey)
    this.key = material.key
    this.masterKeyId = material.masterKeyId
  }

  /** Writes or replaces one exact logical record, returning authenticated metadata only. */
  write(recordId: string, plaintext: Buffer): HostEnvelopeVaultRecordMetadata {
    this.assertLive()
    assertRecordId(recordId)
    if (!Buffer.isBuffer(plaintext)) {
      throw new TypeError('Host envelope vault plaintext must be a Buffer.')
    }
    if (plaintext.byteLength > HOST_ENVELOPE_VAULT_MAX_PLAINTEXT_BYTES) {
      throw new HostEnvelopeVaultError('Host envelope vault plaintext exceeds the record limit.')
    }

    const existing = this.readEnvelope(recordId)
    let generationFloor = this.generationFloor.get(recordId) || 0
    let createdAt = canonicalNow(this.clock)
    if (existing) {
      try {
        generationFloor = Math.max(generationFloor, existing.envelope.generation)
        createdAt = existing.envelope.createdAt
      } finally {
        existing.plaintext.fill(0)
      }
    }
    const generation = existing
      ? Math.max(existing.envelope.generation + 1, generationFloor + 1)
      : Math.max(1, generationFloor)
    const updatedAt = canonicalNow(this.clock)
    const nonce = this.randomBytes(GCM_NONCE_BYTES, 'GCM nonce')
    const header = {
      schemaVersion: HOST_ENVELOPE_VAULT_SCHEMA_VERSION,
      purpose: HOST_ENVELOPE_VAULT_PURPOSE,
      profileFingerprint: this.profileFingerprint,
      masterKeyId: this.masterKeyId,
      recordId,
      generation,
      createdAt,
      updatedAt,
      plaintextByteLength: plaintext.byteLength,
      state: 'active' as const
    } as const
    const aad = Buffer.from(JSON.stringify(header), 'utf8')
    let encrypted: { ciphertext: Buffer; authTag: Buffer } | null = null
    try {
      encrypted = this.crypto.encrypt({
        key: this.requireKey(),
        nonce,
        aad,
        plaintext
      })
      assertBufferLength(encrypted.ciphertext, plaintext.byteLength, 'Vault ciphertext')
      assertBufferLength(encrypted.authTag, GCM_AUTH_TAG_BYTES, 'Vault authentication tag')
      const envelope: PersistedEnvelope = Object.freeze({
        ...header,
        nonce: nonce.toString('base64'),
        ciphertext: encrypted.ciphertext.toString('base64'),
        authTag: encrypted.authTag.toString('base64')
      })
      this.atomicWrite(this.recordPath(recordId), serializeEnvelope(envelope), 'record')
      this.generationFloor.set(recordId, generation)
      return metadataFor(envelope)
    } catch (error) {
      if (error instanceof HostEnvelopeVaultIndeterminateError) throw error
      if (error instanceof HostEnvelopeVaultError) throw error
      throw new HostEnvelopeVaultError(
        'Host envelope vault record encryption or publication failed.',
        {
          cause: error
        }
      )
    } finally {
      nonce.fill(0)
      aad.fill(0)
      encrypted?.ciphertext.fill(0)
      encrypted?.authTag.fill(0)
    }
  }

  /**
   * Returns null for a missing or tombstoned record. Integrity failures throw.
   * Ownership of a returned plaintext Buffer transfers to the caller, which
   * must zero it in a finally block as soon as the secret has been consumed.
   */
  read(recordId: string): HostEnvelopeVaultReadResult | null {
    this.assertLive()
    assertRecordId(recordId)
    const entry = this.readEnvelope(recordId)
    if (!entry) return null
    if (entry.envelope.state === 'deleted') {
      entry.plaintext.fill(0)
      return null
    }
    return { ...metadataFor(entry.envelope), plaintext: entry.plaintext }
  }

  /** Lists every exact record in lexical record-id order after authenticated validation. */
  list(): HostEnvelopeVaultRecordMetadata[] {
    this.assertLive()
    let names: string[]
    try {
      names = this.fs.readdirSync(this.vaultPath)
    } catch (error) {
      throw new HostEnvelopeVaultError('Host envelope vault directory could not be listed.', {
        cause: error
      })
    }
    const records: HostEnvelopeVaultRecordMetadata[] = []
    for (const name of names.sort()) {
      if (isVaultTempName(name)) continue
      if (!isVaultRecordName(name)) {
        throw new HostEnvelopeVaultIntegrityError(
          'Host envelope vault contains an unexpected entry.'
        )
      }
      const entry = this.readEnvelopePath(join(this.vaultPath, name))
      if (!entry) {
        throw new HostEnvelopeVaultIntegrityError(
          'Vault record disappeared while the vault was listed.'
        )
      }
      try {
        if (name !== recordFilename(entry.envelope.recordId, this.crypto)) {
          throw new HostEnvelopeVaultIntegrityError(
            'Vault record filename does not match its logical id.'
          )
        }
        if (entry.envelope.state === 'active') records.push(metadataFor(entry.envelope))
      } finally {
        entry.plaintext.fill(0)
      }
    }
    return records.sort((left, right) => left.recordId.localeCompare(right.recordId))
  }

  /**
   * Authenticates and publishes a durable deletion tombstone. Physical unlink
   * is deliberately forbidden: no portable inode-CAS exists, and an old owner
   * must never claim it atomically removed a successor.
   */
  delete(recordId: string): boolean {
    this.assertLive()
    assertRecordId(recordId)
    const entry = this.readEnvelope(recordId)
    if (!entry) return false
    try {
      if (entry.envelope.state === 'deleted') return false
      const generation = entry.envelope.generation + 1
      const updatedAt = canonicalNow(this.clock)
      const nonce = this.randomBytes(GCM_NONCE_BYTES, 'GCM nonce')
      const header = {
        schemaVersion: HOST_ENVELOPE_VAULT_SCHEMA_VERSION,
        purpose: HOST_ENVELOPE_VAULT_PURPOSE,
        profileFingerprint: this.profileFingerprint,
        masterKeyId: this.masterKeyId,
        recordId,
        generation,
        createdAt: entry.envelope.createdAt,
        updatedAt,
        plaintextByteLength: 0,
        state: 'deleted'
      } as const
      const aad = Buffer.from(JSON.stringify(header), 'utf8')
      const empty = Buffer.alloc(0)
      let encrypted: { ciphertext: Buffer; authTag: Buffer } | null = null
      try {
        encrypted = this.crypto.encrypt({
          key: this.requireKey(),
          nonce,
          aad,
          plaintext: empty
        })
        assertBufferLength(encrypted.ciphertext, 0, 'Vault tombstone ciphertext')
        assertBufferLength(encrypted.authTag, GCM_AUTH_TAG_BYTES, 'Vault authentication tag')
        const tombstone: PersistedEnvelope = Object.freeze({
          ...header,
          nonce: nonce.toString('base64'),
          ciphertext: encrypted.ciphertext.toString('base64'),
          authTag: encrypted.authTag.toString('base64')
        })
        this.atomicWrite(this.recordPath(recordId), serializeEnvelope(tombstone), 'tombstone')
        this.generationFloor.set(recordId, generation)
        return true
      } catch (error) {
        if (error instanceof HostEnvelopeVaultIndeterminateError) throw error
        if (error instanceof HostEnvelopeVaultError) throw error
        throw new HostEnvelopeVaultError('Host envelope vault tombstone publication failed.', {
          cause: error
        })
      } finally {
        nonce.fill(0)
        aad.fill(0)
        empty.fill(0)
        encrypted?.ciphertext.fill(0)
        encrypted?.authTag.fill(0)
      }
    } finally {
      entry.plaintext.fill(0)
    }
  }

  /** Zeroes the copied master key and makes all subsequent calls fail closed. */
  dispose(): void {
    if (!this.key) return
    this.key.fill(0)
    this.key = null
    this.generationFloor.clear()
  }

  private readEnvelope(recordId: string): ReadEnvelope | null {
    return this.readEnvelopePath(this.recordPath(recordId), recordId)
  }

  private readEnvelopePath(path: string, expectedRecordId?: string): ReadEnvelope | null {
    const loaded = readOptionalPrivateRegularFile(this.fs, this.platform, path)
    if (!loaded) return null
    let plaintext: Buffer | null = null
    let envelope: PersistedEnvelope
    try {
      envelope = parseEnvelope(loaded.raw)
      if (envelope.profileFingerprint !== this.profileFingerprint) {
        throw new HostEnvelopeVaultIntegrityError('Vault envelope belongs to a different profile.')
      }
      if (envelope.masterKeyId !== this.masterKeyId) {
        throw new HostEnvelopeVaultKeyMismatchError()
      }
      if (expectedRecordId && envelope.recordId !== expectedRecordId) {
        throw new HostEnvelopeVaultIntegrityError(
          'Vault record id does not match its requested record.'
        )
      }
      if (path !== this.recordPath(envelope.recordId)) {
        throw new HostEnvelopeVaultIntegrityError(
          'Vault record path does not match its logical record id.'
        )
      }
      const nonce = decodeCanonicalBase64(envelope.nonce, 'Vault nonce')
      const ciphertext = decodeCanonicalBase64(envelope.ciphertext, 'Vault ciphertext', true)
      const authTag = decodeCanonicalBase64(envelope.authTag, 'Vault authentication tag')
      const aad = aadFor(envelope)
      try {
        assertBufferLength(nonce, GCM_NONCE_BYTES, 'Vault nonce')
        assertBufferLength(authTag, GCM_AUTH_TAG_BYTES, 'Vault authentication tag')
        plaintext = this.crypto.decrypt({
          key: this.requireKey(),
          nonce,
          aad,
          ciphertext,
          authTag
        })
        assertBufferLength(plaintext, envelope.plaintextByteLength, 'Vault plaintext')
        this.observeGeneration(envelope)
        const result = { envelope, plaintext, identity: loaded.identity }
        plaintext = null
        return result
      } finally {
        nonce.fill(0)
        ciphertext.fill(0)
        authTag.fill(0)
        aad.fill(0)
      }
    } catch (error) {
      plaintext?.fill(0)
      if (error instanceof HostEnvelopeVaultIntegrityError) throw error
      if (error instanceof HostEnvelopeVaultDisposedError) throw error
      throw new HostEnvelopeVaultIntegrityError('Vault envelope could not be authenticated.', {
        cause: error
      })
    } finally {
      loaded.raw.fill(0)
    }
  }

  private observeGeneration(envelope: PersistedEnvelope): void {
    const floor = this.generationFloor.get(envelope.recordId)
    if (floor !== undefined && envelope.generation < floor) {
      throw new HostEnvelopeVaultIntegrityError(
        'Vault record generation rolled back during this Host lifetime.'
      )
    }
    this.generationFloor.set(envelope.recordId, envelope.generation)
  }

  private atomicWrite(
    targetPath: string,
    serialized: Buffer,
    operation: 'record' | 'tombstone'
  ): void {
    const filename = basename(targetPath)
    const temporaryToken = this.randomBytes(12, 'temporary filename token')
    const temporaryPath = join(this.vaultPath, `.${filename}.${temporaryToken.toString('hex')}.tmp`)
    temporaryToken.fill(0)
    let descriptor: number | null = null
    let published = false
    let renameAttempted = false
    try {
      descriptor = this.fs.openSync(
        temporaryPath,
        this.fs.constants.O_WRONLY |
          this.fs.constants.O_CREAT |
          this.fs.constants.O_EXCL |
          (this.fs.constants.O_NOFOLLOW || 0),
        PRIVATE_FILE_MODE
      )
      const stat = this.fs.fstatSync(descriptor)
      assertRegularFile(stat, temporaryPath)
      if (this.platform !== 'win32') this.fs.fchmodSync(descriptor, PRIVATE_FILE_MODE)
      writeAll(this.fs, descriptor, serialized)
      this.fs.fsyncSync(descriptor)
      this.fs.closeSync(descriptor)
      descriptor = null
      renameAttempted = true
      this.fs.renameSync(temporaryPath, targetPath)
      published = true
      if (this.platform !== 'win32') this.fs.chmodSync(targetPath, PRIVATE_FILE_MODE)
      fsyncDirectory(this.fs, this.platform, this.vaultPath)
    } catch (error) {
      if (!published) {
        try {
          this.fs.unlinkSync(temporaryPath)
        } catch {
          // An unlinked temp is never authoritative; leave a crash artefact
          // rather than touching an unexpected successor.
        }
      }
      if (published || renameAttempted) {
        throw new HostEnvelopeVaultIndeterminateError(operation, { cause: error })
      }
      throw error
    } finally {
      if (descriptor !== null) this.fs.closeSync(descriptor)
      serialized.fill(0)
    }
  }

  private recordPath(recordId: string): string {
    return join(this.vaultPath, recordFilename(recordId, this.crypto))
  }

  private randomBytes(size: number, label: string): Buffer {
    const value = this.random.randomBytes(size)
    if (!Buffer.isBuffer(value) || value.byteLength !== size) {
      value?.fill?.(0)
      throw new HostEnvelopeVaultError(`${label} source returned an invalid byte length.`)
    }
    return value
  }

  private requireKey(): Buffer {
    if (!this.key) throw new HostEnvelopeVaultDisposedError()
    return this.key
  }

  private assertLive(): void {
    this.requireKey()
  }
}

function canonicalProfilePath(profilePath: string, fs: HostEnvelopeVaultFs): string {
  if (typeof profilePath !== 'string' || !isAbsolute(profilePath)) {
    throw new TypeError('Host envelope vault requires an absolute profile path.')
  }
  const resolved = resolve(profilePath)
  if (resolved === parse(resolved).root) {
    throw new TypeError('Host envelope vault refuses a filesystem-root profile path.')
  }
  const canonical = fs.realpathSync(resolved)
  const stat = fs.lstatSync(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostEnvelopeVaultIntegrityError(
      'Host envelope vault profile path is not a real directory.'
    )
  }
  return canonical
}

function initializeVaultDirectory(
  profilePath: string,
  fs: HostEnvelopeVaultFs,
  platform: NodeJS.Platform
): string {
  const path = join(profilePath, HOST_ENVELOPE_VAULT_DIRECTORY)
  let direct: HostEnvelopeVaultFileStat | null = null
  try {
    direct = fs.lstatSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new HostEnvelopeVaultIntegrityError(
        'Host envelope vault directory cannot be inspected.',
        {
          cause: error
        }
      )
    }
  }
  if (direct) {
    assertPrivateDirectory(direct, platform, 'Host envelope vault directory')
  } else {
    fs.mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    direct = fs.lstatSync(path)
    assertPrivateDirectory(direct, platform, 'Host envelope vault directory')
  }
  if (platform !== 'win32') {
    fs.chmodSync(path, PRIVATE_DIRECTORY_MODE)
    assertPrivateDirectory(fs.lstatSync(path), platform, 'Host envelope vault directory')
  }
  const canonical = fs.realpathSync(path)
  const stat = fs.lstatSync(canonical)
  assertPrivateDirectory(stat, platform, 'Host envelope vault directory')
  return canonical
}

function acquireTransferredMasterKey(port: HostEnvelopeVaultMasterKeyPort): {
  key: Buffer
  masterKeyId: string
} {
  if (!port || typeof port.acquireMasterKey !== 'function') {
    throw new TypeError('Host envelope vault requires a master-key port.')
  }
  let supplied: HostEnvelopeVaultMasterKeyMaterial | null = null
  try {
    supplied = port.acquireMasterKey()
    if (!supplied || typeof supplied !== 'object' || !Buffer.isBuffer(supplied.key)) {
      throw new HostEnvelopeVaultError('Host envelope vault master-key material is invalid.')
    }
    if (supplied.key.byteLength !== MASTER_KEY_BYTES) {
      throw new HostEnvelopeVaultError('Host envelope vault master key must be exactly 32 bytes.')
    }
    if (
      typeof supplied.masterKeyId !== 'string' ||
      !MASTER_KEY_ID_PATTERN.test(supplied.masterKeyId)
    ) {
      throw new HostEnvelopeVaultError('Host envelope vault master-key epoch is invalid.')
    }
    return { key: Buffer.from(supplied.key), masterKeyId: supplied.masterKeyId }
  } finally {
    supplied?.key.fill(0)
  }
}

function profileFingerprintFor(profilePath: string, crypto: HostEnvelopeVaultCryptoPort): string {
  const input = Buffer.from(`taskwraith:host-envelope-vault:profile:v1\0${profilePath}`, 'utf8')
  try {
    const digest = crypto.sha256(input)
    assertBufferLength(digest, SHA256_BYTES, 'Profile fingerprint')
    return digest.toString('hex')
  } finally {
    input.fill(0)
  }
}

function recordFilename(recordId: string, crypto: HostEnvelopeVaultCryptoPort): string {
  assertRecordId(recordId)
  const input = Buffer.from(`taskwraith:host-envelope-vault:record:v1\0${recordId}`, 'utf8')
  try {
    const digest = crypto.sha256(input)
    assertBufferLength(digest, SHA256_BYTES, 'Record filename digest')
    return `${digest.toString('hex')}.vault.json`
  } finally {
    input.fill(0)
  }
}

function aadFor(envelope: PersistedEnvelope): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: envelope.schemaVersion,
      purpose: envelope.purpose,
      profileFingerprint: envelope.profileFingerprint,
      masterKeyId: envelope.masterKeyId,
      recordId: envelope.recordId,
      generation: envelope.generation,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      plaintextByteLength: envelope.plaintextByteLength,
      state: envelope.state
    }),
    'utf8'
  )
}

function metadataFor(envelope: PersistedEnvelope): HostEnvelopeVaultRecordMetadata {
  return {
    recordId: envelope.recordId,
    generation: envelope.generation,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    plaintextByteLength: envelope.plaintextByteLength
  }
}

function serializeEnvelope(envelope: PersistedEnvelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
}

function parseEnvelope(raw: Buffer): PersistedEnvelope {
  if (raw.byteLength === 0 || raw.byteLength > HOST_ENVELOPE_VAULT_MAX_FILE_BYTES) {
    throw new HostEnvelopeVaultIntegrityError('Vault envelope exceeds the bounded file size.')
  }
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown
  } catch (error) {
    throw new HostEnvelopeVaultIntegrityError('Vault envelope is not valid JSON.', { cause: error })
  }
  if (!isPlainObject(value))
    throw new HostEnvelopeVaultIntegrityError('Vault envelope is not an object.')
  const keys = [
    'schemaVersion',
    'purpose',
    'profileFingerprint',
    'masterKeyId',
    'recordId',
    'generation',
    'createdAt',
    'updatedAt',
    'plaintextByteLength',
    'state',
    'nonce',
    'ciphertext',
    'authTag'
  ]
  assertExactKeys(value, keys, 'Vault envelope')
  if (
    value.schemaVersion !== HOST_ENVELOPE_VAULT_SCHEMA_VERSION ||
    value.purpose !== HOST_ENVELOPE_VAULT_PURPOSE
  ) {
    throw new HostEnvelopeVaultIntegrityError('Vault envelope schema is unsupported.')
  }
  const envelope: PersistedEnvelope = {
    schemaVersion: HOST_ENVELOPE_VAULT_SCHEMA_VERSION,
    purpose: HOST_ENVELOPE_VAULT_PURPOSE,
    profileFingerprint: requireFingerprint(value.profileFingerprint),
    masterKeyId: requireMasterKeyId(value.masterKeyId),
    recordId: requireRecordId(value.recordId),
    generation: requireGeneration(value.generation),
    createdAt: requireCanonicalIso(value.createdAt, 'Vault createdAt'),
    updatedAt: requireCanonicalIso(value.updatedAt, 'Vault updatedAt'),
    plaintextByteLength: requirePlaintextLength(value.plaintextByteLength),
    state: requireEnvelopeState(value.state),
    nonce: requireCanonicalBase64(value.nonce, 'Vault nonce'),
    ciphertext: requireCanonicalBase64(value.ciphertext, 'Vault ciphertext', true),
    authTag: requireCanonicalBase64(value.authTag, 'Vault authentication tag')
  }
  if (envelope.state === 'deleted' && envelope.plaintextByteLength !== 0) {
    throw new HostEnvelopeVaultIntegrityError('Vault tombstone carries plaintext bytes.')
  }
  const canonical = serializeEnvelope(envelope)
  try {
    if (!raw.equals(canonical)) {
      throw new HostEnvelopeVaultIntegrityError('Vault envelope is not canonical.')
    }
  } finally {
    canonical.fill(0)
  }
  return Object.freeze(envelope)
}

function readOptionalPrivateRegularFile(
  fs: HostEnvelopeVaultFs,
  platform: NodeJS.Platform,
  path: string
): { raw: Buffer; identity: FileIdentity } | null {
  let descriptor: number | null = null
  try {
    try {
      descriptor = fs.openSync(
        path,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
      )
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
    const initial = fs.fstatSync(descriptor)
    assertRegularFile(initial, path)
    assertOwnerOnlyMode(initial, platform, path)
    const identity = fileIdentity(initial, path)
    assertSameFile(fs.lstatSync(path), identity, path)
    const size = boundedSize(initial.size, path)
    const raw = readBoundedExactly(fs, descriptor, size, path)
    const final = fs.fstatSync(descriptor)
    assertRegularFile(final, path)
    assertOwnerOnlyMode(final, platform, path)
    if (
      !sameFileIdentity(fileIdentity(final, path), identity) ||
      boundedSize(final.size, path) !== size
    ) {
      raw.fill(0)
      throw new HostEnvelopeVaultIntegrityError('Vault envelope changed during validation.')
    }
    assertSameFile(fs.lstatSync(path), identity, path)
    return { raw, identity }
  } catch (error) {
    if (error instanceof HostEnvelopeVaultError) throw error
    throw new HostEnvelopeVaultIntegrityError('Vault envelope could not be read safely.', {
      cause: error
    })
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function fsyncDirectory(fs: HostEnvelopeVaultFs, platform: NodeJS.Platform, path: string): void {
  if (platform === 'win32') return
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeAll(fs: HostEnvelopeVaultFs, descriptor: number, data: Buffer): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = fs.writeSync(descriptor, data.subarray(offset))
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new HostEnvelopeVaultError('Vault envelope could not be written completely.')
    }
    offset += written
  }
}

/** Reads at most the initial validated size; a growing fd can never allocate unbounded memory. */
function readBoundedExactly(
  fs: HostEnvelopeVaultFs,
  descriptor: number,
  size: number,
  label: string
): Buffer {
  const output = Buffer.allocUnsafe(size)
  let offset = 0
  try {
    while (offset < output.byteLength) {
      const read = fs.readSync(descriptor, output, offset, output.byteLength - offset, offset)
      if (!Number.isSafeInteger(read) || read <= 0) break
      offset += read
    }
    if (offset !== output.byteLength) {
      throw new HostEnvelopeVaultIntegrityError(`${label} ended before its validated size.`)
    }
    return output
  } catch (error) {
    output.fill(0)
    throw error
  }
}

function assertRecordId(value: unknown): asserts value is string {
  requireRecordId(value)
}

function requireRecordId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    throw new HostEnvelopeVaultError('Vault record id is invalid.')
  }
  return value
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !HEX_256_PATTERN.test(value)) {
    throw new HostEnvelopeVaultIntegrityError('Vault profile fingerprint is invalid.')
  }
  return value
}

function requireMasterKeyId(value: unknown): string {
  if (typeof value !== 'string' || !MASTER_KEY_ID_PATTERN.test(value)) {
    throw new HostEnvelopeVaultIntegrityError('Vault master-key epoch is invalid.')
  }
  return value
}

function requireEnvelopeState(value: unknown): 'active' | 'deleted' {
  if (value !== 'active' && value !== 'deleted') {
    throw new HostEnvelopeVaultIntegrityError('Vault envelope state is invalid.')
  }
  return value
}

function requireGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new HostEnvelopeVaultIntegrityError('Vault generation is invalid.')
  }
  return value
}

function requirePlaintextLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > HOST_ENVELOPE_VAULT_MAX_PLAINTEXT_BYTES
  ) {
    throw new HostEnvelopeVaultIntegrityError('Vault plaintext length is invalid.')
  }
  return value
}

function requireCanonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new HostEnvelopeVaultIntegrityError(`${label} is invalid.`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new HostEnvelopeVaultIntegrityError(`${label} is invalid.`)
  }
  return value
}

function requireCanonicalBase64(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value) ||
    Buffer.from(value, 'base64').toString('base64') !== value
  ) {
    throw new HostEnvelopeVaultIntegrityError(`${label} is not canonical base64.`)
  }
  return value
}

function decodeCanonicalBase64(value: string, label: string, allowEmpty = false): Buffer {
  const canonical = requireCanonicalBase64(value, label, allowEmpty)
  return Buffer.from(canonical, 'base64')
}

function canonicalNow(clock: HostEnvelopeVaultClock): string {
  const value = clock.now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new HostEnvelopeVaultError('Vault clock returned an invalid timestamp.')
  }
  return value.toISOString()
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new HostEnvelopeVaultIntegrityError(`${label} has unexpected or missing fields.`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRegularFile(stat: HostEnvelopeVaultFileStat, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== undefined && stat.nlink !== 1)) {
    throw new HostEnvelopeVaultIntegrityError(`${label} is not a private regular file.`)
  }
}

function assertPrivateDirectory(
  stat: HostEnvelopeVaultFileStat,
  platform: NodeJS.Platform,
  label: string
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostEnvelopeVaultIntegrityError(`${label} is not a real directory.`)
  }
  if (platform === 'win32') return
  const mode = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  if (!Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new HostEnvelopeVaultIntegrityError(`${label} lacks owner-only permissions.`)
  }
}

function assertOwnerOnlyMode(
  stat: HostEnvelopeVaultFileStat,
  platform: NodeJS.Platform,
  label: string
): void {
  if (platform === 'win32') return
  const mode = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  if (!Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new HostEnvelopeVaultIntegrityError(`${label} lacks owner-only permissions.`)
  }
}

function boundedSize(value: number | bigint, label: string): number {
  const size = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(size) || size < 0 || size > HOST_ENVELOPE_VAULT_MAX_FILE_BYTES) {
    throw new HostEnvelopeVaultIntegrityError(`${label} exceeds the vault file limit.`)
  }
  return size
}

function fileIdentity(stat: HostEnvelopeVaultFileStat, label: string): FileIdentity {
  const dev = normalizeIdentity(stat.dev)
  const ino = normalizeIdentity(stat.ino)
  if (dev === null || ino === null || ino === '0') {
    throw new HostEnvelopeVaultIntegrityError(`${label} has no stable file identity.`)
  }
  return { dev, ino }
}

function normalizeIdentity(value: number | bigint): string | null {
  if (typeof value === 'bigint') return value >= 0n ? value.toString(10) : null
  if (!Number.isSafeInteger(value) || value < 0) return null
  return String(value)
}

function assertSameFile(
  stat: HostEnvelopeVaultFileStat,
  expected: FileIdentity,
  label: string
): void {
  assertRegularFile(stat, label)
  if (!sameFileIdentity(fileIdentity(stat, label), expected)) {
    throw new HostEnvelopeVaultIntegrityError(`${label} changed identity during validation.`)
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertBufferLength(value: Buffer, expected: number, label: string): void {
  if (!Buffer.isBuffer(value) || value.byteLength !== expected) {
    value?.fill?.(0)
    throw new HostEnvelopeVaultIntegrityError(`${label} has an invalid length.`)
  }
}

function isVaultRecordName(name: string): boolean {
  return /^[a-f0-9]{64}\.vault\.json$/.test(name)
}

function isVaultTempName(name: string): boolean {
  return /^\.[a-f0-9]{64}\.vault\.json\.[a-f0-9]{24}\.tmp$/.test(name)
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}
