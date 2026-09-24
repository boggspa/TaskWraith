import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'fs'
import { basename, dirname, join } from 'path'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'
import { PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION } from './PeopleToChannelMigrationHistory'
import { PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION } from './PeopleToChannelMigrationMaterializer'
import { PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION } from './PeopleToChannelMigrationPlan'
import { peopleToChannelMigrationRecoveryPaths } from './PeopleToChannelMigrationRecoveryStore'
import {
  validatePeopleToChannelMigrationFinalizationScope,
  type PeopleToChannelMigrationFinalizationScope
} from './PeopleToChannelMigrationFinalizationScope'

export const PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION = 1
export const PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_FILENAME = 'finalization-execution.json'
export const MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_PLAINTEXT_BYTES = 128 * 1024 * 1024
export const MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_FILE_BYTES = 192 * 1024 * 1024

/**
 * The encrypted terminal execution prepared while ordinary People writes are
 * quiesced. Its `initial*` fields bind it to the additive-soak authority;
 * `delta` is allowed to have a new plan id because it inventories the final
 * frozen source generation rather than replaying the original one.
 */
export interface PeopleToChannelMigrationFinalizationExecution {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION
  initialPlanId: string
  initialPlanDigest: string
  channelStateDigest: string
  cutoverStateDigest: string
  /** Exact encrypted partition of ordinary retirement and the explicit P5 exception. */
  scope: PeopleToChannelMigrationFinalizationScope
  delta: PeopleToChannelMigrationExecution
  /** Content-free hash committed to the recovery fence before retirement. */
  finalizationDigest: string
}

export interface PeopleToChannelMigrationFinalizationExecutionStoreOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  /** Observability rendezvous after temp-file fsync and before atomic replacement. */
  beforeDurablePublish?: (
    event: PeopleToChannelMigrationFinalizationExecutionDurablePublish
  ) => void
  /** Test/observability seam invoked only after a replacement is durable. */
  afterDurableWrite?: () => void
}

export interface PeopleToChannelMigrationFinalizationExecutionDurablePublish {
  boundary: 'finalization_execution'
  operation: 'rename'
  temporaryPath: string
  destinationPath: string
}

export interface PeopleToChannelMigrationFinalizationExecutionPrepareResult {
  replaced: boolean
  payloadDigest: string
  finalizationDigest: string
}

interface PersistedFinalizationEnvelope {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION
  initialPlanId: string
  initialPlanDigest: string
  finalizationDigest: string
  payloadDigest: string
  encryptedPayload: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const FINALIZATION_KEYS = new Set([
  'schemaVersion',
  'initialPlanId',
  'initialPlanDigest',
  'channelStateDigest',
  'cutoverStateDigest',
  'scope',
  'delta',
  'finalizationDigest'
])
const DELTA_EXECUTION_KEYS = new Set([
  'schemaVersion',
  'planDigest',
  'hostDisplayName',
  'plan',
  'base',
  'history'
])
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'initialPlanId',
  'initialPlanDigest',
  'finalizationDigest',
  'payloadDigest',
  'encryptedPayload'
])

export class PeopleToChannelMigrationFinalizationExecutionStoreError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationExecutionStoreError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationExecutionStoreError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function materializationDigest(value: PeopleToChannelMigrationExecution['base']): string {
  const { materializationDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(value: PeopleToChannelMigrationExecution['history']): string {
  const { executionDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

/** Mirrors the initial checkpoint's authority checks for the nested delta. */
function validateDeltaExecution(value: unknown): PeopleToChannelMigrationExecution {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, DELTA_EXECUTION_KEYS)) {
    blocked('People migration finalization delta is invalid')
  }
  const delta = raw as unknown as PeopleToChannelMigrationExecution
  const plan = objectRecord(delta.plan)
  const base = objectRecord(delta.base)
  const history = objectRecord(delta.history)
  if (
    delta.schemaVersion !== PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION ||
    typeof delta.hostDisplayName !== 'string' ||
    !delta.hostDisplayName ||
    delta.hostDisplayName.trim() !== delta.hostDisplayName ||
    delta.hostDisplayName.length > 120 ||
    !digest(delta.planDigest) ||
    !plan ||
    plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    !digest(plan.planId) ||
    !digest(plan.sourceDigest) ||
    sha256(canonicalJson(plan)) !== delta.planDigest ||
    !base ||
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    base.planId !== plan.planId ||
    base.sourceDigest !== plan.sourceDigest ||
    !digest(base.materializationDigest) ||
    materializationDigest(delta.base) !== base.materializationDigest ||
    !history ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    history.planId !== plan.planId ||
    history.sourceDigest !== plan.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest ||
    history.migrationAt !== base.migrationAt ||
    !digest(history.executionDigest) ||
    historyExecutionDigest(delta.history) !== history.executionDigest
  ) {
    blocked('People migration finalization delta does not match its authority digests')
  }
  return clone(delta)
}

function withoutFinalizationDigest(
  value: PeopleToChannelMigrationFinalizationExecution
): Omit<PeopleToChannelMigrationFinalizationExecution, 'finalizationDigest'> {
  const { finalizationDigest: _recorded, ...withoutDigest } = value
  return withoutDigest
}

export function peopleToChannelMigrationFinalizationDigest(
  value: Omit<PeopleToChannelMigrationFinalizationExecution, 'finalizationDigest'>
): string {
  return sha256(canonicalJson(value))
}

export function createPeopleToChannelMigrationFinalizationExecution(
  value: Omit<PeopleToChannelMigrationFinalizationExecution, 'finalizationDigest'>
): PeopleToChannelMigrationFinalizationExecution {
  return validateFinalizationExecution({
    ...clone(value),
    finalizationDigest: peopleToChannelMigrationFinalizationDigest(value)
  })
}

function validateFinalizationExecution(
  value: unknown
): PeopleToChannelMigrationFinalizationExecution {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, FINALIZATION_KEYS)) {
    blocked('People migration finalization execution is invalid')
  }
  const execution = raw as unknown as PeopleToChannelMigrationFinalizationExecution
  const delta = validateDeltaExecution(execution.delta)
  const scope = validatePeopleToChannelMigrationFinalizationScope(execution.scope)
  if (
    execution.schemaVersion !== PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION ||
    !digest(execution.initialPlanId) ||
    !digest(execution.initialPlanDigest) ||
    !digest(execution.channelStateDigest) ||
    !digest(execution.cutoverStateDigest) ||
    !digest(execution.finalizationDigest) ||
    peopleToChannelMigrationFinalizationDigest(withoutFinalizationDigest(execution)) !==
      execution.finalizationDigest
  ) {
    blocked('People migration finalization execution does not match its authority digests')
  }
  return {
    schemaVersion: execution.schemaVersion,
    initialPlanId: execution.initialPlanId,
    initialPlanDigest: execution.initialPlanDigest,
    channelStateDigest: execution.channelStateDigest,
    cutoverStateDigest: execution.cutoverStateDigest,
    scope,
    delta,
    finalizationDigest: execution.finalizationDigest
  }
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
      blocked('People migration finalization directory is unsafe')
    }
    chmodSync(path, 0o700)
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationFinalizationExecutionStoreError) throw error
    blocked('People migration finalization directory could not be prepared')
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
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0) ||
      before.size > MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_FILE_BYTES
    ) {
      blocked('People migration finalization execution path is unsafe')
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
      blocked('People migration finalization execution changed while being read')
    }
    return bytes
  } catch (error) {
    if (error instanceof PeopleToChannelMigrationFinalizationExecutionStoreError) throw error
    blocked('People migration finalization execution could not be read')
  }
}

function parseEnvelope(bytes: Buffer): PersistedFinalizationEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    blocked('People migration finalization execution is malformed')
  }
  const raw = objectRecord(parsed)
  if (
    !raw ||
    !exactKeys(raw, ENVELOPE_KEYS) ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION ||
    !digest(raw.initialPlanId) ||
    !digest(raw.initialPlanDigest) ||
    !digest(raw.finalizationDigest) ||
    !digest(raw.payloadDigest) ||
    typeof raw.encryptedPayload !== 'string' ||
    !raw.encryptedPayload
  ) {
    blocked('People migration finalization execution is invalid')
  }
  return raw as unknown as PersistedFinalizationEnvelope
}

function encodeExecution(args: {
  execution: PeopleToChannelMigrationFinalizationExecution
  safeStorage: HumanCollaborationSafeStorage
}): { bytes: Buffer; payloadDigest: string } {
  const execution = validateFinalizationExecution(args.execution)
  // Preserve the exact order produced by the Channel log owner; its checksums
  // hash JSON order and a recursive sort would make a valid delta unrecoverable.
  const plaintext = JSON.stringify(execution)
  if (
    Buffer.byteLength(plaintext, 'utf8') >
    MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_PLAINTEXT_BYTES
  ) {
    blocked('People migration finalization execution exceeds its plaintext byte bound')
  }
  let encrypted: Buffer
  try {
    encrypted = args.safeStorage.encryptString(plaintext)
  } catch {
    blocked('People migration finalization execution encryption failed')
  }
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    blocked('People migration finalization execution encryption failed')
  }
  const payloadDigest = sha256(plaintext)
  const envelope: PersistedFinalizationEnvelope = {
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION,
    initialPlanId: execution.initialPlanId,
    initialPlanDigest: execution.initialPlanDigest,
    finalizationDigest: execution.finalizationDigest,
    payloadDigest,
    encryptedPayload: encrypted.toString('base64')
  }
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (bytes.length > MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_FILE_BYTES) {
    blocked('People migration finalization execution exceeds its storage byte bound')
  }
  return { bytes, payloadDigest }
}

function decodeExecution(args: { bytes: Buffer; safeStorage: HumanCollaborationSafeStorage }): {
  execution: PeopleToChannelMigrationFinalizationExecution
  payloadDigest: string
} {
  const envelope = parseEnvelope(args.bytes)
  let encrypted: Buffer
  try {
    encrypted = Buffer.from(envelope.encryptedPayload, 'base64')
  } catch {
    blocked('People migration finalization ciphertext is malformed')
  }
  if (!encrypted.length || encrypted.toString('base64') !== envelope.encryptedPayload) {
    blocked('People migration finalization ciphertext is malformed')
  }
  let plaintext: string
  try {
    plaintext = args.safeStorage.decryptString(encrypted)
  } catch {
    blocked('People migration finalization execution could not be decrypted')
  }
  if (
    typeof plaintext !== 'string' ||
    Buffer.byteLength(plaintext, 'utf8') >
      MAX_PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_PLAINTEXT_BYTES ||
    sha256(plaintext) !== envelope.payloadDigest
  ) {
    blocked('People migration finalization execution payload digest does not match')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    blocked('People migration finalization execution payload is malformed')
  }
  if (JSON.stringify(parsed) !== plaintext) {
    blocked('People migration finalization execution payload is not canonical')
  }
  const execution = validateFinalizationExecution(parsed)
  if (
    execution.initialPlanId !== envelope.initialPlanId ||
    execution.initialPlanDigest !== envelope.initialPlanDigest ||
    execution.finalizationDigest !== envelope.finalizationDigest
  ) {
    blocked('People migration finalization envelope does not match its payload')
  }
  return { execution, payloadDigest: envelope.payloadDigest }
}

function persistReplacement(
  path: string,
  bytes: Buffer,
  beforeDurablePublish?: (
    event: PeopleToChannelMigrationFinalizationExecutionDurablePublish
  ) => void
): void {
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
    beforeDurablePublish?.({
      boundary: 'finalization_execution',
      operation: 'rename',
      temporaryPath,
      destinationPath: path
    })
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
  } catch (_error) {
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
    blocked('People migration finalization execution could not be persisted')
  }
}

export function peopleToChannelMigrationFinalizationExecutionPath(userDataPath: string): string {
  return join(
    peopleToChannelMigrationRecoveryPaths(userDataPath).root,
    PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_FILENAME
  )
}

/**
 * SafeStorage-encrypted terminal authority. `prepareBeforeRecoveryFence` may
 * replace a stale, unfenced capture after a crash; once recovery records its
 * digest, callers must use `loadForRecoveryFence`, which never writes.
 */
export class PeopleToChannelMigrationFinalizationExecutionStore {
  readonly path: string

  constructor(private readonly options: PeopleToChannelMigrationFinalizationExecutionStoreOptions) {
    this.path = peopleToChannelMigrationFinalizationExecutionPath(options.userDataPath)
  }

  load(): PeopleToChannelMigrationFinalizationExecution | null {
    const bytes = readRegularFile(this.path)
    if (!bytes) return null
    if (!encryptionAvailable(this.options.safeStorage)) {
      blocked('People migration finalization encryption is unavailable')
    }
    return decodeExecution({ bytes, safeStorage: this.options.safeStorage }).execution
  }

  /**
   * Call only while recovery is still at `cutover_applied`. It intentionally
   * replaces a pre-fence capture so a restart cannot retire from an older,
   * writable People generation.
   */
  prepareBeforeRecoveryFence(
    execution: PeopleToChannelMigrationFinalizationExecution
  ): PeopleToChannelMigrationFinalizationExecutionPrepareResult {
    if (!encryptionAvailable(this.options.safeStorage)) {
      blocked('People migration finalization encryption is unavailable')
    }
    const expected = validateFinalizationExecution(execution)
    const existing = readRegularFile(this.path)
    if (existing) {
      const loaded = decodeExecution({ bytes: existing, safeStorage: this.options.safeStorage })
      if (canonicalJson(loaded.execution) === canonicalJson(expected)) {
        return {
          replaced: false,
          payloadDigest: loaded.payloadDigest,
          finalizationDigest: loaded.execution.finalizationDigest
        }
      }
    }
    const encoded = encodeExecution({ execution: expected, safeStorage: this.options.safeStorage })
    persistReplacement(this.path, encoded.bytes, this.options.beforeDurablePublish)
    const persisted = this.load()
    if (!persisted || canonicalJson(persisted) !== canonicalJson(expected)) {
      blocked('People migration finalization execution publish was lost')
    }
    this.options.afterDurableWrite?.()
    return {
      replaced: true,
      payloadDigest: encoded.payloadDigest,
      finalizationDigest: expected.finalizationDigest
    }
  }

  /** Loads the exact execution sealed by `recovery.beginFinalization`; never writes. */
  loadForRecoveryFence(input: {
    initialPlanId: string
    initialPlanDigest: string
    finalizationDigest: string
  }): PeopleToChannelMigrationFinalizationExecution {
    if (
      !digest(input.initialPlanId) ||
      !digest(input.initialPlanDigest) ||
      !digest(input.finalizationDigest)
    ) {
      blocked('People migration finalization recovery fence is invalid')
    }
    const execution = this.load()
    if (
      !execution ||
      execution.initialPlanId !== input.initialPlanId ||
      execution.initialPlanDigest !== input.initialPlanDigest ||
      execution.finalizationDigest !== input.finalizationDigest
    ) {
      blocked('People migration finalization execution does not match the recovery fence')
    }
    return execution
  }
}

export function isPeopleToChannelMigrationFinalizationExecutionStoreError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationExecutionStoreError {
  return (
    error instanceof PeopleToChannelMigrationFinalizationExecutionStoreError &&
    error.code === 'recovery_blocked'
  )
}
