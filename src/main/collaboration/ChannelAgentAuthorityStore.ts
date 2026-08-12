import { createHash, randomUUID } from 'crypto'
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
  unlinkSync,
  writeFileSync
} from 'fs'
import { isAbsolute, join } from 'path'

import {
  channelAgentPublicKeyFingerprint,
  parseSignedChannelAgentDelegation,
  parseSignedChannelAgentDispatchGrant,
  parseSignedChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey } from '../../shared/e2ee/keys'
import {
  ChannelAgentAuthorityState,
  ChannelAgentAuthorityStateError,
  type ChannelAgentAuthoritySnapshot,
  type ChannelAgentDispatchConsumptionResult,
  type ChannelAgentOwnerPublicKeyResolver,
  type ChannelAgentPostAuthorityResult,
  type ConsumeChannelAgentDispatchInput,
  type VerifyChannelAgentPostAuthorityInput
} from './ChannelAgentAuthorityState'

export const CHANNEL_AGENT_AUTHORITY_STORE_VERSION = 1 as const
export const CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX = '.authority.json' as const
export const CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES = 64 * 1024 * 1024

const CHANNEL_FILE_HASH_DOMAIN = 'taskwraith.channel.agent-authority-file.v1\0'
const SNAPSHOT_HASH_DOMAIN = 'taskwraith.channel.agent-authority-snapshot.v1\0'
const MAX_IDENTIFIER_LENGTH = 512
const MAX_MUTATION_ATTEMPTS = 4

export type ChannelAgentAuthorityStoreErrorCode =
  | 'concurrent_update'
  | 'invalid_channel'
  | 'persistence_failed'
  | 'recovery_blocked'

export class ChannelAgentAuthorityStoreError extends Error {
  constructor(
    readonly code: ChannelAgentAuthorityStoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentAuthorityStoreError'
  }
}

export interface ChannelAgentAuthorityStoreOptions {
  readonly storageDirectory: string
  readonly resolveOwnerPublicKey: ChannelAgentOwnerPublicKeyResolver
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly randomId?: () => string
  readonly logger?: (line: string) => void
}

interface StoredChannelAgentAuthorityEnvelope {
  readonly schemaVersion: typeof CHANNEL_AGENT_AUTHORITY_STORE_VERSION
  readonly channelIdHash: string
  readonly ownerPublicKeyFingerprint: string
  readonly snapshotHash: string
  readonly snapshot: ChannelAgentAuthoritySnapshot
}

interface AuthorityRecord {
  readonly state: ChannelAgentAuthorityState
  readonly rawEnvelope: string
}

interface Mutation<T> {
  readonly result: T
  readonly changed: boolean
}

function storeError(
  code: ChannelAgentAuthorityStoreErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentAuthorityStoreError {
  // Filesystem callbacks may put sensitive local data in their error text. Public errors stay
  // bounded to this store's stable code and context; diagnostics get only non-secret hashes.
  return new ChannelAgentAuthorityStoreError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== expected.length) return false
  const keys = new Set(expected)
  return actual.every((key) => keys.has(key))
}

function isIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function invalidSignedInput(message: string): ChannelAgentAuthorityStateError {
  return new ChannelAgentAuthorityStateError('invalid_input', message)
}

export function channelAgentAuthorityFileHash(channelId: string): string {
  if (!isIdentifier(channelId)) {
    throw storeError('invalid_channel', 'Channel id is invalid for agent authority storage')
  }
  return createHash('sha256')
    .update(CHANNEL_FILE_HASH_DOMAIN)
    .update(channelId, 'utf8')
    .digest('hex')
}

export function hashChannelAgentAuthoritySnapshot(snapshot: ChannelAgentAuthoritySnapshot): string {
  return createHash('sha256')
    .update(SNAPSHOT_HASH_DOMAIN)
    .update(JSON.stringify(snapshot), 'utf8')
    .digest('hex')
}

function parseEnvelope(
  value: unknown,
  expectedChannelHash: string
): StoredChannelAgentAuthorityEnvelope | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'channelIdHash',
      'ownerPublicKeyFingerprint',
      'snapshotHash',
      'snapshot'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_AUTHORITY_STORE_VERSION ||
    value.channelIdHash !== expectedChannelHash ||
    !isHash(value.channelIdHash) ||
    !isHash(value.ownerPublicKeyFingerprint) ||
    !isHash(value.snapshotHash) ||
    !isPlainObject(value.snapshot)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STORE_VERSION,
    channelIdHash: value.channelIdHash,
    ownerPublicKeyFingerprint: value.ownerPublicKeyFingerprint,
    snapshotHash: value.snapshotHash,
    snapshot: value.snapshot as unknown as ChannelAgentAuthoritySnapshot
  }
}

export class ChannelAgentAuthorityStore {
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly logger: (line: string) => void
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: ChannelAgentAuthorityStoreOptions) {
    if (!options || typeof options !== 'object') {
      throw storeError('persistence_failed', 'Channel agent authority store options are required')
    }
    if (typeof options.storageDirectory !== 'string' || !isAbsolute(options.storageDirectory)) {
      throw storeError(
        'persistence_failed',
        'Channel agent authority storage requires an absolute directory'
      )
    }
    if (typeof options.resolveOwnerPublicKey !== 'function') {
      throw storeError('persistence_failed', 'Channel agent owner-key resolver is required')
    }
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.logger = options.logger ?? (() => {})
    this.platform = options.platform ?? process.platform
  }

  registerDelegation(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentDelegation(value)
    if (!signed) throw invalidSignedInput('Signed Channel agent delegation is invalid')
    return this.mutate(signed.delegation.channelId, signed.delegation.ownerMemberId, (state) => {
      const result = state.registerDelegation(signed)
      return { result, changed: result === 'stored' }
    })
  }

  registerDispatchGrant(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentDispatchGrant(value)
    if (!signed) throw invalidSignedInput('Signed Channel agent dispatch grant is invalid')
    return this.mutate(signed.grant.channelId, null, (state) => {
      const result = state.registerDispatchGrant(signed)
      return { result, changed: result === 'stored' }
    })
  }

  registerRevocation(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentRevocation(value)
    if (!signed) throw invalidSignedInput('Signed Channel agent revocation is invalid')
    return this.mutate(signed.revocation.channelId, null, (state) => {
      const result = state.registerRevocation(signed)
      return { result, changed: result === 'stored' }
    })
  }

  consumeDispatch(
    channelId: string,
    input: ConsumeChannelAgentDispatchInput
  ): ChannelAgentDispatchConsumptionResult {
    channelAgentAuthorityFileHash(channelId)
    const missing: ChannelAgentDispatchConsumptionResult = {
      kind: 'denied',
      reason: 'dispatch_grant_missing'
    }
    return this.mutate(
      channelId,
      null,
      (state) => {
        const result = state.consumeDispatch(input)
        return { result, changed: result.kind === 'authorized' }
      },
      missing
    )
  }

  verifyPostAuthority(
    channelId: string,
    input: VerifyChannelAgentPostAuthorityInput
  ): ChannelAgentPostAuthorityResult {
    channelAgentAuthorityFileHash(channelId)
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      try {
        const record = this.readRecord(channelId)
        return (
          record?.state.verifyPostAuthority(input) ?? {
            kind: 'denied',
            reason: 'delegation_missing'
          }
        )
      } catch (error) {
        if (
          error instanceof ChannelAgentAuthorityStoreError &&
          error.code === 'concurrent_update'
        ) {
          continue
        }
        throw error
      }
    }
    throw storeError('concurrent_update', 'Channel agent authority changed during every read')
  }

  snapshot(channelId: string): ChannelAgentAuthoritySnapshot | null {
    channelAgentAuthorityFileHash(channelId)
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      try {
        return this.readRecord(channelId)?.state.snapshot() ?? null
      } catch (error) {
        if (
          error instanceof ChannelAgentAuthorityStoreError &&
          error.code === 'concurrent_update'
        ) {
          continue
        }
        throw error
      }
    }
    throw storeError('concurrent_update', 'Channel agent authority changed during every read')
  }

  /** Explicit recovery/privacy erasure for one Channel, including quarantines and temp files. */
  eraseChannel(channelId: string): number {
    const channelHash = channelAgentAuthorityFileHash(channelId)
    if (!existsSync(this.options.storageDirectory)) return 0
    this.assertExistingDirectory()
    let removed = 0
    for (const entry of readdirSync(this.options.storageDirectory, { withFileTypes: true })) {
      if (
        (!entry.isFile() && !entry.isSymbolicLink()) ||
        !this.isOwnedChannelFile(entry.name, channelHash)
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
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !this.isOwnedAuthorityFile(entry.name)) {
        continue
      }
      unlinkSync(join(this.options.storageDirectory, entry.name))
      removed += 1
    }
    if (removed > 0) this.syncDirectory()
    return removed
  }

  private mutate<T>(
    channelId: string,
    ownerMemberIdForCreate: string | null,
    apply: (state: ChannelAgentAuthorityState) => Mutation<T>,
    missingResult?: T
  ): T {
    channelAgentAuthorityFileHash(channelId)
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      let record: AuthorityRecord | null
      try {
        record = this.readRecord(channelId)
      } catch (error) {
        if (
          error instanceof ChannelAgentAuthorityStoreError &&
          error.code === 'concurrent_update'
        ) {
          continue
        }
        throw error
      }
      if (!record && ownerMemberIdForCreate === null) {
        if (missingResult !== undefined) return missingResult
        throw new ChannelAgentAuthorityStateError(
          'target_not_found',
          'Channel agent authority state does not exist'
        )
      }
      const state =
        record?.state ??
        ChannelAgentAuthorityState.create({
          channelId,
          ownerMemberId: ownerMemberIdForCreate!,
          resolveOwnerPublicKey: this.options.resolveOwnerPublicKey
        })
      const mutation = apply(state)
      if (!mutation.changed) return mutation.result
      const committed = this.persist(state, record?.rawEnvelope ?? null)
      if (committed) return mutation.result
    }
    throw storeError(
      'concurrent_update',
      'Channel agent authority changed during every mutation attempt'
    )
  }

  private readRecord(channelId: string): AuthorityRecord | null {
    const channelHash = channelAgentAuthorityFileHash(channelId)
    this.assertExistingDirectory()
    this.assertNoQuarantine(channelHash)
    const path = this.authorityPath(channelHash)
    let before: ReturnType<typeof lstatSync>
    try {
      before = lstatSync(path)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw storeError('recovery_blocked', 'Channel agent authority cannot be inspected', error)
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return this.quarantine(path, channelHash, 'authority path is not a private regular file')
    }
    if (before.size > CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES) {
      return this.quarantine(path, channelHash, 'authority file exceeds its size limit')
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent authority cannot be read', error)
    }
    if (Buffer.byteLength(raw, 'utf8') > CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES) {
      return this.quarantine(path, channelHash, 'authority file exceeds its size limit')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch (error) {
      return this.quarantine(path, channelHash, 'authority envelope is not valid JSON', error)
    }
    const envelope = parseEnvelope(decoded, channelHash)
    if (!envelope) return this.quarantine(path, channelHash, 'authority envelope is malformed')
    if (hashChannelAgentAuthoritySnapshot(envelope.snapshot) !== envelope.snapshotHash) {
      return this.quarantine(path, channelHash, 'authority snapshot hash is invalid')
    }
    if (
      !isIdentifier(envelope.snapshot.channelId) ||
      !isIdentifier(envelope.snapshot.ownerMemberId) ||
      channelAgentAuthorityFileHash(envelope.snapshot.channelId) !== channelHash
    ) {
      return this.quarantine(path, channelHash, 'authority snapshot root is invalid')
    }
    const ownerFingerprint = this.ownerFingerprint(envelope.snapshot)
    if (ownerFingerprint !== envelope.ownerPublicKeyFingerprint) {
      throw storeError(
        'recovery_blocked',
        'Pinned Channel owner identity changed; authority was preserved'
      )
    }

    let state: ChannelAgentAuthorityState
    try {
      state = ChannelAgentAuthorityState.fromSnapshot(
        envelope.snapshot,
        this.options.resolveOwnerPublicKey
      )
    } catch (error) {
      if (error instanceof ChannelAgentAuthorityStateError && error.code === 'owner_unavailable') {
        throw storeError(
          'recovery_blocked',
          'Pinned Channel owner identity is unavailable; authority was preserved',
          error
        )
      }
      return this.quarantine(path, channelHash, 'authority snapshot validation failed', error)
    }
    if (state.channelId !== channelId) {
      return this.quarantine(path, channelHash, 'authority snapshot belongs to another Channel')
    }
    try {
      const after = lstatSync(path)
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        readFileSync(path, 'utf8') !== raw
      ) {
        throw storeError('concurrent_update', 'Channel agent authority changed during validation')
      }
    } catch (error) {
      if (error instanceof ChannelAgentAuthorityStoreError) throw error
      throw storeError(
        'concurrent_update',
        'Channel agent authority could not be revalidated',
        error
      )
    }
    this.repairPermissions(path)
    return { state, rawEnvelope: raw }
  }

  private persist(state: ChannelAgentAuthorityState, expectedRaw: string | null): boolean {
    const snapshot = state.snapshot()
    const channelHash = channelAgentAuthorityFileHash(snapshot.channelId)
    const envelope: StoredChannelAgentAuthorityEnvelope = {
      schemaVersion: CHANNEL_AGENT_AUTHORITY_STORE_VERSION,
      channelIdHash: channelHash,
      ownerPublicKeyFingerprint: this.ownerFingerprint(snapshot),
      snapshotHash: hashChannelAgentAuthoritySnapshot(snapshot),
      snapshot
    }
    const serialized = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES) {
      throw storeError('persistence_failed', 'Channel agent authority exceeds its size limit')
    }
    this.prepareDirectory()
    const path = this.authorityPath(channelHash)
    const temporaryPath = `${path}.tmp-${process.pid}-${this.randomId()}`
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      this.syncFile(temporaryPath)
      if (expectedRaw === null) {
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
      } else {
        let currentRaw: string
        try {
          currentRaw = readFileSync(path, 'utf8')
        } catch (error) {
          if (isMissingPathError(error)) {
            unlinkSync(temporaryPath)
            return false
          }
          throw error
        }
        if (currentRaw !== expectedRaw) {
          unlinkSync(temporaryPath)
          return false
        }
        renameSync(temporaryPath, path)
      }
      chmodSync(path, 0o600)
      this.syncDirectory()
      return true
    } catch (error) {
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      } catch {
        // The original error remains authoritative; explicit erasure also removes stale temps.
      }
      throw storeError('persistence_failed', 'Channel agent authority persistence failed', error)
    }
  }

  private assertNoQuarantine(channelHash: string): void {
    if (!existsSync(this.options.storageDirectory)) return
    const prefix = `${channelHash}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}.corrupt-`
    const blocked = readdirSync(this.options.storageDirectory, { withFileTypes: true }).some(
      (entry) => entry.name.startsWith(prefix)
    )
    if (blocked) {
      throw storeError(
        'recovery_blocked',
        'Channel agent authority is quarantined; explicit erasure is required'
      )
    }
  }

  private quarantine(path: string, channelHash: string, reason: string, _cause?: unknown): never {
    const quarantinePath = `${path}.corrupt-${this.requireNow()}-${this.randomId()}`
    try {
      renameSync(path, quarantinePath)
      this.syncDirectory()
    } catch (error) {
      this.logger(`[channel-agent-authority] quarantine failed: ${reason}`)
      throw storeError('recovery_blocked', `${reason}; quarantine failed`, error)
    }
    this.logger(`[channel-agent-authority] ${channelHash.slice(0, 12)} quarantined: ${reason}`)
    throw storeError('recovery_blocked', reason)
  }

  private prepareDirectory(): void {
    try {
      mkdirSync(this.options.storageDirectory, { recursive: true, mode: 0o700 })
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('authority storage path is not a private directory')
      }
      chmodSync(this.options.storageDirectory, 0o700)
    } catch (error) {
      throw storeError('persistence_failed', 'Channel agent authority directory is unsafe', error)
    }
  }

  private assertExistingDirectory(): void {
    if (!existsSync(this.options.storageDirectory)) return
    try {
      const directory = lstatSync(this.options.storageDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error('authority storage path is not a private directory')
      }
      if ((directory.mode & 0o077) !== 0) chmodSync(this.options.storageDirectory, 0o700)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent authority directory is unsafe', error)
    }
  }

  private repairPermissions(path: string): void {
    try {
      if ((lstatSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
    } catch (error) {
      throw storeError('recovery_blocked', 'Channel agent authority permissions are unsafe', error)
    }
  }

  private isOwnedChannelFile(name: string, channelHash: string): boolean {
    const base = `${channelHash}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
    return name === base || name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.corrupt-`)
  }

  private isOwnedAuthorityFile(name: string): boolean {
    return /^[a-f0-9]{64}\.authority\.json(?:\.(?:tmp|corrupt)-.+)?$/.test(name)
  }

  private authorityPath(channelHash: string): string {
    return join(
      this.options.storageDirectory,
      `${channelHash}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
    )
  }

  private requireNow(): number {
    const value = this.now()
    if (!isTimestamp(value)) {
      throw storeError('persistence_failed', 'Channel agent authority clock is invalid')
    }
    return value
  }

  private ownerFingerprint(snapshot: ChannelAgentAuthoritySnapshot): string {
    let key: ReturnType<ChannelAgentOwnerPublicKeyResolver>
    try {
      key = this.options.resolveOwnerPublicKey(snapshot.channelId, snapshot.ownerMemberId)
    } catch {
      key = null
    }
    if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw storeError(
        'recovery_blocked',
        'Pinned Channel owner identity is unavailable; authority was preserved'
      )
    }
    try {
      return channelAgentPublicKeyFingerprint(exportRawEd25519PublicKey(key).toString('base64'))
    } catch (error) {
      throw storeError(
        'recovery_blocked',
        'Pinned Channel owner identity cannot be fingerprinted; authority was preserved',
        error
      )
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        this.platform === 'win32' &&
        (code === 'EACCES' || code === 'EBADF' || code === 'EINVAL' || code === 'EPERM')
      ) {
        return
      }
      throw storeError(
        'persistence_failed',
        'Channel agent authority directory could not be synchronized',
        error
      )
    }
  }
}
