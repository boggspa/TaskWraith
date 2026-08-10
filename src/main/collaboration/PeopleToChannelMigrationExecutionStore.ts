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
  unlinkSync,
  writeSync
} from 'fs'
import { basename, dirname, join } from 'path'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
  type PeopleToChannelMigrationPlan
} from './PeopleToChannelMigrationPlan'
import { peopleToChannelMigrationRecoveryPaths } from './PeopleToChannelMigrationRecoveryStore'

export const PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION = 1
export const PEOPLE_TO_CHANNEL_EXECUTION_FILENAME = 'execution.json'
export const MAX_PEOPLE_TO_CHANNEL_EXECUTION_PLAINTEXT_BYTES = 128 * 1024 * 1024
export const MAX_PEOPLE_TO_CHANNEL_EXECUTION_FILE_BYTES = 192 * 1024 * 1024

export interface PeopleToChannelMigrationExecution {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION
  planDigest: string
  hostDisplayName: string
  plan: PeopleToChannelMigrationPlan
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}

export interface PeopleToChannelMigrationExecutionStoreOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  /** Test/observability seam invoked only after the immutable file is durable. */
  afterDurableWrite?: () => void
}

export interface PeopleToChannelMigrationExecutionPersistResult {
  created: boolean
  payloadDigest: string
}

interface PersistedExecutionEnvelope {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION
  planId: string
  planDigest: string
  sourceDigest: string
  payloadDigest: string
  encryptedPayload: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'planId',
  'planDigest',
  'sourceDigest',
  'payloadDigest',
  'encryptedPayload'
])
const EXECUTION_KEYS = new Set([
  'schemaVersion',
  'planDigest',
  'hostDisplayName',
  'plan',
  'base',
  'history'
])

export class PeopleToChannelMigrationExecutionStoreError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationExecutionStoreError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationExecutionStoreError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function materializationDigest(value: PeopleToChannelMigrationMaterialization): string {
  const { materializationDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(value: PeopleToChannelMigrationHistoryMaterialization): string {
  const { executionDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

function validateExecution(value: unknown): PeopleToChannelMigrationExecution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    blocked('People migration execution payload is invalid')
  }
  const raw = value as Record<string, unknown>
  if (!exactKeys(raw, EXECUTION_KEYS)) {
    blocked('People migration execution payload is invalid')
  }
  const execution = raw as unknown as PeopleToChannelMigrationExecution
  const { plan, base, history } = execution
  if (
    execution.schemaVersion !== PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION ||
    typeof execution.hostDisplayName !== 'string' ||
    !execution.hostDisplayName ||
    execution.hostDisplayName.trim() !== execution.hostDisplayName ||
    execution.hostDisplayName.length > 120 ||
    !SHA256_PATTERN.test(execution.planDigest) ||
    !plan ||
    plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    !SHA256_PATTERN.test(plan.planId) ||
    !SHA256_PATTERN.test(plan.sourceDigest) ||
    sha256(canonicalJson(plan)) !== execution.planDigest ||
    !base ||
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    base.planId !== plan.planId ||
    base.sourceDigest !== plan.sourceDigest ||
    !SHA256_PATTERN.test(base.materializationDigest) ||
    materializationDigest(base) !== base.materializationDigest ||
    !history ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    history.planId !== plan.planId ||
    history.sourceDigest !== plan.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest ||
    history.migrationAt !== base.migrationAt ||
    !SHA256_PATTERN.test(history.executionDigest) ||
    historyExecutionDigest(history) !== history.executionDigest
  ) {
    blocked('People migration execution payload does not match its authority digests')
  }
  return clone(execution)
}

function encryptionAvailable(safeStorage: HumanCollaborationSafeStorage): boolean {
  try {
    return safeStorage?.isEncryptionAvailable() === true
  } catch {
    return false
  }
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      blocked('People migration execution directory is unsafe')
    }
    chmodSync(path, 0o700)
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationExecutionStoreError) throw error
    blocked('People migration execution directory could not be prepared')
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch {
    // Some platforms do not support directory fsync. The file itself is synced.
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function readRegularFile(path: string): Buffer | null {
  if (!existsSync(path)) return null
  try {
    const before = lstatSync(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size > MAX_PEOPLE_TO_CHANNEL_EXECUTION_FILE_BYTES
    ) {
      blocked('People migration execution checkpoint path is unsafe')
    }
    const bytes = readFileSync(path)
    const after = lstatSync(path)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== bytes.length
    ) {
      blocked('People migration execution checkpoint changed while being read')
    }
    return bytes
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationExecutionStoreError) throw error
    blocked('People migration execution checkpoint could not be read')
  }
}

function parseEnvelope(bytes: Buffer): PersistedExecutionEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    blocked('People migration execution checkpoint is malformed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    blocked('People migration execution checkpoint is malformed')
  }
  const raw = parsed as Record<string, unknown>
  if (
    !exactKeys(raw, ENVELOPE_KEYS) ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION ||
    typeof raw.planId !== 'string' ||
    !SHA256_PATTERN.test(raw.planId) ||
    typeof raw.planDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.planDigest) ||
    typeof raw.sourceDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.sourceDigest) ||
    typeof raw.payloadDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.payloadDigest) ||
    typeof raw.encryptedPayload !== 'string' ||
    !raw.encryptedPayload
  ) {
    blocked('People migration execution checkpoint is invalid')
  }
  return raw as unknown as PersistedExecutionEnvelope
}

function encodeExecution(args: {
  execution: PeopleToChannelMigrationExecution
  safeStorage: HumanCollaborationSafeStorage
}): { bytes: Buffer; payloadDigest: string } {
  const execution = validateExecution(args.execution)
  // Preserve the canonical Channel message field order produced by the log
  // owner. Its on-disk checksum predates this store and hashes JSON order, so
  // recursively sorting a frozen execution would make a valid message
  // impossible to materialize after restart.
  const plaintext = JSON.stringify(execution)
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PEOPLE_TO_CHANNEL_EXECUTION_PLAINTEXT_BYTES) {
    blocked('People migration execution exceeds its plaintext byte bound')
  }
  let encrypted: Buffer
  try {
    encrypted = args.safeStorage.encryptString(plaintext)
  } catch {
    blocked('People migration execution encryption failed')
  }
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    blocked('People migration execution encryption failed')
  }
  const payloadDigest = sha256(plaintext)
  const envelope: PersistedExecutionEnvelope = {
    schemaVersion: PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
    planId: execution.plan.planId,
    planDigest: execution.planDigest,
    sourceDigest: execution.plan.sourceDigest,
    payloadDigest,
    encryptedPayload: encrypted.toString('base64')
  }
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (bytes.length > MAX_PEOPLE_TO_CHANNEL_EXECUTION_FILE_BYTES) {
    blocked('People migration execution exceeds its storage byte bound')
  }
  return { bytes, payloadDigest }
}

function decodeExecution(args: { bytes: Buffer; safeStorage: HumanCollaborationSafeStorage }): {
  execution: PeopleToChannelMigrationExecution
  payloadDigest: string
} {
  const envelope = parseEnvelope(args.bytes)
  let encrypted: Buffer
  try {
    encrypted = Buffer.from(envelope.encryptedPayload, 'base64')
  } catch {
    blocked('People migration execution ciphertext is malformed')
  }
  if (!encrypted.length || encrypted.toString('base64') !== envelope.encryptedPayload) {
    blocked('People migration execution ciphertext is malformed')
  }
  let plaintext: string
  try {
    plaintext = args.safeStorage.decryptString(encrypted)
  } catch {
    blocked('People migration execution could not be decrypted')
  }
  if (
    typeof plaintext !== 'string' ||
    Buffer.byteLength(plaintext, 'utf8') > MAX_PEOPLE_TO_CHANNEL_EXECUTION_PLAINTEXT_BYTES ||
    sha256(plaintext) !== envelope.payloadDigest
  ) {
    blocked('People migration execution payload digest does not match')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    blocked('People migration execution payload is malformed')
  }
  if (JSON.stringify(parsed) !== plaintext) {
    blocked('People migration execution payload is not canonical')
  }
  const execution = validateExecution(parsed)
  if (
    execution.plan.planId !== envelope.planId ||
    execution.planDigest !== envelope.planDigest ||
    execution.plan.sourceDigest !== envelope.sourceDigest
  ) {
    blocked('People migration execution envelope does not match its payload')
  }
  return { execution, payloadDigest: envelope.payloadDigest }
}

function persistImmutable(path: string, bytes: Buffer): boolean {
  ensurePrivateDirectory(dirname(path))
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    chmodSync(temporaryPath, 0o600)
    linkSync(temporaryPath, path)
    unlinkSync(temporaryPath)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
    return true
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    } catch {
      // Preserve the original failure.
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') return false
    blocked('People migration execution checkpoint could not be persisted')
  }
}

export function peopleToChannelMigrationExecutionPath(userDataPath: string): string {
  return join(
    peopleToChannelMigrationRecoveryPaths(userDataPath).root,
    PEOPLE_TO_CHANNEL_EXECUTION_FILENAME
  )
}

/**
 * Immutable, safeStorage-encrypted execution authority. It is written before
 * the recovery intent or either mutable store, so a crash can never strand a
 * partially applied migration whose exact desired history has been forgotten.
 */
export class PeopleToChannelMigrationExecutionStore {
  readonly path: string

  constructor(private readonly options: PeopleToChannelMigrationExecutionStoreOptions) {
    this.path = peopleToChannelMigrationExecutionPath(options.userDataPath)
  }

  load(): PeopleToChannelMigrationExecution | null {
    const bytes = readRegularFile(this.path)
    if (!bytes) return null
    if (!encryptionAvailable(this.options.safeStorage)) {
      blocked('People migration execution encryption is unavailable')
    }
    return decodeExecution({ bytes, safeStorage: this.options.safeStorage }).execution
  }

  persist(
    execution: PeopleToChannelMigrationExecution
  ): PeopleToChannelMigrationExecutionPersistResult {
    if (!encryptionAvailable(this.options.safeStorage)) {
      blocked('People migration execution encryption is unavailable')
    }
    const encoded = encodeExecution({ execution, safeStorage: this.options.safeStorage })
    const existing = readRegularFile(this.path)
    if (existing) {
      const loaded = decodeExecution({ bytes: existing, safeStorage: this.options.safeStorage })
      if (canonicalJson(loaded.execution) !== canonicalJson(validateExecution(execution))) {
        blocked('A different People migration execution is already durable')
      }
      return { created: false, payloadDigest: loaded.payloadDigest }
    }
    const created = persistImmutable(this.path, encoded.bytes)
    if (!created) {
      const raced = readRegularFile(this.path)
      if (!raced) blocked('People migration execution checkpoint publish was lost')
      const loaded = decodeExecution({ bytes: raced, safeStorage: this.options.safeStorage })
      if (canonicalJson(loaded.execution) !== canonicalJson(validateExecution(execution))) {
        blocked('A different People migration execution won the durable checkpoint')
      }
      return { created: false, payloadDigest: loaded.payloadDigest }
    }
    this.options.afterDurableWrite?.()
    return { created: true, payloadDigest: encoded.payloadDigest }
  }
}

export function isPeopleToChannelMigrationExecutionStoreError(
  error: unknown
): error is PeopleToChannelMigrationExecutionStoreError {
  return (
    error instanceof PeopleToChannelMigrationExecutionStoreError &&
    error.code === 'recovery_blocked'
  )
}
