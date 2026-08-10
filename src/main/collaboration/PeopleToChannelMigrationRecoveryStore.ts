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
  writeFileSync
} from 'fs'
import { basename, dirname, join, resolve } from 'path'

import {
  MAX_PEOPLE_MIGRATION_SOURCE_BYTES,
  type PeopleToChannelMigrationSourceRead
} from './PeopleToChannelMigrationSource'
import {
  PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
  PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
  type PeopleToChannelMigrationPlan
} from './PeopleToChannelMigrationPlan'

export const PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION = 1
export const PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_DIRECTORY = 'people-to-channel-v1'

export const PEOPLE_TO_CHANNEL_GENERAL_CHAT_SCOPES = [
  'all-general-chats',
  'active-people-shares-only',
  'forward-only-solo'
] as const
export const PEOPLE_TO_CHANNEL_LEGACY_HISTORY_MODES = [
  'read-only-legacy-view',
  'channel-reference-events',
  'no-legacy-view',
  'import-then-reset'
] as const
export const PEOPLE_TO_CHANNEL_RETIREMENT_MODES = [
  'staged',
  'immediate',
  'keep-adjacent',
  'after-p4-acceptance'
] as const

export type PeopleToChannelGeneralChatScope = (typeof PEOPLE_TO_CHANNEL_GENERAL_CHAT_SCOPES)[number]
export type PeopleToChannelLegacyHistoryMode =
  (typeof PEOPLE_TO_CHANNEL_LEGACY_HISTORY_MODES)[number]
export type PeopleToChannelRetirementMode = (typeof PEOPLE_TO_CHANNEL_RETIREMENT_MODES)[number]

/**
 * There are deliberately no defaults. Persisted migration work cannot begin
 * until the product-level cutover choices have been supplied explicitly.
 */
export interface PeopleToChannelMigrationCutoverDecisions {
  generalChatScope: PeopleToChannelGeneralChatScope
  legacyProjectionHistory: PeopleToChannelLegacyHistoryMode
  peopleRetirementTiming: PeopleToChannelRetirementMode
}

export type PeopleToChannelMigrationRecoveryPhase =
  | 'prepared'
  | 'channels_applied'
  | 'cutover_applied'
  | 'finalizing'
  | 'committed'

export interface PeopleToChannelMigrationSourceEvidence {
  exists: boolean
  bytes: number
  fileSha256: string | null
  backupFile: string | null
}

export interface PeopleToChannelMigrationRecoveryRecord {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION
  planId: string
  planDigest: string
  sourceDigest: string
  source: PeopleToChannelMigrationSourceEvidence
  decisions: PeopleToChannelMigrationCutoverDecisions
  phase: PeopleToChannelMigrationRecoveryPhase
  preparedAt: number
  updatedAt: number
  channelStateDigest?: string
  cutoverStateDigest?: string
  commitStartedAt?: number
  receiptSha256?: string
}

export interface PeopleToChannelMigrationReceipt {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION
  status: 'committed'
  planId: string
  planDigest: string
  sourceDigest: string
  sourceFileSha256: string | null
  decisions: PeopleToChannelMigrationCutoverDecisions
  channelStateDigest: string
  cutoverStateDigest: string
  committedAt: number
}

export interface PeopleToChannelMigrationRecoveryPaths {
  root: string
  intent: string
  backups: string
  receipts: string
}

export type PeopleToChannelMigrationRecoveryWriteStage =
  | 'backup'
  | 'intent:prepared'
  | 'intent:channels_applied'
  | 'intent:cutover_applied'
  | 'intent:finalizing'
  | 'receipt'
  | 'intent:committed'

export interface PeopleToChannelMigrationRecoveryStoreOptions {
  userDataPath: string
  now?: () => number
  /** Test/observability seam invoked only after the named write is durable. */
  afterDurableWrite?: (stage: PeopleToChannelMigrationRecoveryWriteStage) => void
}

export class PeopleToChannelMigrationRecoveryError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationRecoveryError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RECORD_KEYS = new Set([
  'schemaVersion',
  'planId',
  'planDigest',
  'sourceDigest',
  'source',
  'decisions',
  'phase',
  'preparedAt',
  'updatedAt',
  'channelStateDigest',
  'cutoverStateDigest',
  'commitStartedAt',
  'receiptSha256'
])
const SOURCE_KEYS = new Set(['exists', 'bytes', 'fileSha256', 'backupFile'])
const DECISION_KEYS = new Set([
  'generalChatScope',
  'legacyProjectionHistory',
  'peopleRetirementTiming'
])
const RECEIPT_KEYS = new Set([
  'schemaVersion',
  'status',
  'planId',
  'planDigest',
  'sourceDigest',
  'sourceFileSha256',
  'decisions',
  'channelStateDigest',
  'cutoverStateDigest',
  'committedAt'
])

function blocked(message: string): never {
  throw new PeopleToChannelMigrationRecoveryError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function parseDecisions(value: unknown): PeopleToChannelMigrationCutoverDecisions | null {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, DECISION_KEYS) || Object.keys(raw).length !== DECISION_KEYS.size) {
    return null
  }
  if (
    !includes(PEOPLE_TO_CHANNEL_GENERAL_CHAT_SCOPES, raw.generalChatScope) ||
    !includes(PEOPLE_TO_CHANNEL_LEGACY_HISTORY_MODES, raw.legacyProjectionHistory) ||
    !includes(PEOPLE_TO_CHANNEL_RETIREMENT_MODES, raw.peopleRetirementTiming)
  ) {
    return null
  }
  return {
    generalChatScope: raw.generalChatScope,
    legacyProjectionHistory: raw.legacyProjectionHistory,
    peopleRetirementTiming: raw.peopleRetirementTiming
  }
}

function backupFilename(fileSha256: string): string {
  return `human-collaboration-${fileSha256}.json`
}

function parseSourceEvidence(value: unknown): PeopleToChannelMigrationSourceEvidence | null {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, SOURCE_KEYS) || Object.keys(raw).length !== SOURCE_KEYS.size) {
    return null
  }
  if (
    typeof raw.exists !== 'boolean' ||
    !Number.isSafeInteger(raw.bytes) ||
    (raw.bytes as number) < 0
  ) {
    return null
  }
  if (raw.exists) {
    if (
      !validDigest(raw.fileSha256) ||
      raw.backupFile !== backupFilename(raw.fileSha256) ||
      (raw.bytes as number) > MAX_PEOPLE_MIGRATION_SOURCE_BYTES
    ) {
      return null
    }
  } else if (raw.bytes !== 0 || raw.fileSha256 !== null || raw.backupFile !== null) {
    return null
  }
  return {
    exists: raw.exists,
    bytes: raw.bytes as number,
    fileSha256: raw.fileSha256 as string | null,
    backupFile: raw.backupFile as string | null
  }
}

function phaseRank(phase: PeopleToChannelMigrationRecoveryPhase): number {
  return ['prepared', 'channels_applied', 'cutover_applied', 'finalizing', 'committed'].indexOf(
    phase
  )
}

function parseRecord(value: unknown): PeopleToChannelMigrationRecoveryRecord | null {
  const raw = objectRecord(value)
  if (!raw || !exactKeys(raw, RECORD_KEYS)) return null
  const source = parseSourceEvidence(raw.source)
  const decisions = parseDecisions(raw.decisions)
  const phase = raw.phase
  if (
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION ||
    !validDigest(raw.planId) ||
    !validDigest(raw.planDigest) ||
    !validDigest(raw.sourceDigest) ||
    !source ||
    !decisions ||
    (phase !== 'prepared' &&
      phase !== 'channels_applied' &&
      phase !== 'cutover_applied' &&
      phase !== 'finalizing' &&
      phase !== 'committed') ||
    !validTimestamp(raw.preparedAt) ||
    !validTimestamp(raw.updatedAt) ||
    raw.updatedAt < raw.preparedAt
  ) {
    return null
  }
  const rank = phaseRank(phase)
  const channelStateDigest = raw.channelStateDigest
  const cutoverStateDigest = raw.cutoverStateDigest
  const commitStartedAt = raw.commitStartedAt
  const receiptSha256 = raw.receiptSha256
  if (rank >= 1 !== validDigest(channelStateDigest)) return null
  if (rank >= 2 !== validDigest(cutoverStateDigest)) return null
  if (rank >= 3 !== validTimestamp(commitStartedAt)) return null
  if (validTimestamp(commitStartedAt) && commitStartedAt < raw.updatedAt && rank === 3) return null
  if (rank >= 4 !== validDigest(receiptSha256)) return null
  return clone(raw) as unknown as PeopleToChannelMigrationRecoveryRecord
}

function parseReceipt(value: unknown): PeopleToChannelMigrationReceipt | null {
  const raw = objectRecord(value)
  const decisions = raw ? parseDecisions(raw.decisions) : null
  if (
    !raw ||
    !exactKeys(raw, RECEIPT_KEYS) ||
    Object.keys(raw).length !== RECEIPT_KEYS.size ||
    raw.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION ||
    raw.status !== 'committed' ||
    !validDigest(raw.planId) ||
    !validDigest(raw.planDigest) ||
    !validDigest(raw.sourceDigest) ||
    (raw.sourceFileSha256 !== null && !validDigest(raw.sourceFileSha256)) ||
    !decisions ||
    !validDigest(raw.channelStateDigest) ||
    !validDigest(raw.cutoverStateDigest) ||
    !validTimestamp(raw.committedAt)
  ) {
    return null
  }
  return clone(raw) as unknown as PeopleToChannelMigrationReceipt
}

function readRegularFile(
  path: string,
  maxBytes = MAX_PEOPLE_MIGRATION_SOURCE_BYTES
): Buffer | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) blocked('A migration recovery path is unsafe')
    if (stat.size > maxBytes) blocked('Migration recovery evidence exceeds its byte bound')
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof PeopleToChannelMigrationRecoveryError) throw error
    blocked('Migration recovery evidence could not be read')
  }
}

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Some supported platforms do not permit directory fsync. File fsync and
    // atomic rename still preserve a complete prior or next record.
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) blocked('Migration recovery root is unsafe')
  chmodSync(path, 0o700)
}

function atomicWrite(path: string, bytes: Buffer): void {
  ensurePrivateDirectory(dirname(path))
  const existing = readRegularFile(path)
  if (existing && existing.equals(bytes)) return
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original write failure.
      }
    }
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary)
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error
  }
}

function immutableWrite(path: string, bytes: Buffer): boolean {
  const existing = readRegularFile(path)
  if (existing) {
    if (!existing.equals(bytes)) blocked('Immutable migration recovery evidence conflicts')
    return false
  }
  atomicWrite(path, bytes)
  return true
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function safeNow(value: number, minimum = 0): number {
  if (!validTimestamp(value) || value < minimum) blocked('Migration recovery time is invalid')
  return value
}

function validatePlan(plan: PeopleToChannelMigrationPlan): string {
  if (
    plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    !validDigest(plan.planId) ||
    !validDigest(plan.sourceDigest) ||
    !Array.isArray(plan.generalChats) ||
    plan.entries.some((entry) => entry.blockers.length > 0 || entry.disposition === 'blocked') ||
    plan.generalChats.some(
      (entry) => entry.blockers.length > 0 || entry.disposition === 'blocked'
    ) ||
    plan.summary.blocked !== 0 ||
    plan.summary.generalBlocked !== 0 ||
    canonicalJson(plan.cutoverDecisions) !== canonicalJson(PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS)
  ) {
    blocked('Migration plan is not executable')
  }
  return sha256(canonicalJson(plan))
}

function sourceEvidence(source: PeopleToChannelMigrationSourceRead): {
  evidence: PeopleToChannelMigrationSourceEvidence
  bytes: Buffer | null
} {
  const bytes = readRegularFile(source.path)
  if (!source.exists) {
    if (bytes !== null || source.bytes !== 0 || source.fileSha256 !== null) {
      blocked('People source changed after inventory')
    }
    return {
      evidence: { exists: false, bytes: 0, fileSha256: null, backupFile: null },
      bytes: null
    }
  }
  if (
    !bytes ||
    bytes.length > MAX_PEOPLE_MIGRATION_SOURCE_BYTES ||
    source.bytes !== bytes.length ||
    !validDigest(source.fileSha256) ||
    sha256(bytes) !== source.fileSha256
  ) {
    blocked('People source changed after inventory')
  }
  return {
    evidence: {
      exists: true,
      bytes: bytes.length,
      fileSha256: source.fileSha256,
      backupFile: backupFilename(source.fileSha256)
    },
    bytes
  }
}

function receiptFor(
  record: PeopleToChannelMigrationRecoveryRecord
): PeopleToChannelMigrationReceipt {
  if (
    !record.channelStateDigest ||
    !record.cutoverStateDigest ||
    record.commitStartedAt === undefined
  ) {
    blocked('Migration recovery state is not ready to commit')
  }
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION,
    status: 'committed',
    planId: record.planId,
    planDigest: record.planDigest,
    sourceDigest: record.sourceDigest,
    sourceFileSha256: record.source.fileSha256,
    decisions: clone(record.decisions),
    channelStateDigest: record.channelStateDigest,
    cutoverStateDigest: record.cutoverStateDigest,
    committedAt: record.commitStartedAt
  }
}

export function peopleToChannelMigrationRecoveryPaths(
  userDataPath: string
): PeopleToChannelMigrationRecoveryPaths {
  if (
    typeof userDataPath !== 'string' ||
    !userDataPath.trim() ||
    userDataPath.trim() !== userDataPath
  ) {
    blocked('People migration recovery requires userDataPath')
  }
  const userDataRoot = resolve(userDataPath)
  const root = join(userDataRoot, 'channels', PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_DIRECTORY)
  return {
    root,
    intent: join(root, 'intent.json'),
    backups: join(root, 'backups'),
    receipts: join(root, 'receipts')
  }
}

/**
 * Durable recovery envelope only. It never mutates Channel metadata/logs,
 * People state, chats, runtime sessions, or startup authority.
 */
export class PeopleToChannelMigrationRecoveryStore {
  readonly paths: PeopleToChannelMigrationRecoveryPaths
  private readonly now: () => number
  private readonly afterDurableWrite?: (stage: PeopleToChannelMigrationRecoveryWriteStage) => void

  constructor(options: PeopleToChannelMigrationRecoveryStoreOptions) {
    this.paths = peopleToChannelMigrationRecoveryPaths(options.userDataPath)
    this.now = options.now ?? Date.now
    this.afterDurableWrite = options.afterDurableWrite
  }

  load(): PeopleToChannelMigrationRecoveryRecord | null {
    const bytes = readRegularFile(this.paths.intent)
    if (!bytes) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      blocked('Migration recovery intent is corrupt')
    }
    const record = parseRecord(parsed)
    if (!record) blocked('Migration recovery intent is unsupported or corrupt')
    this.verifyBackup(record)
    if (record.phase === 'committed') this.verifyReceipt(record)
    return clone(record)
  }

  prepare(input: {
    plan: PeopleToChannelMigrationPlan
    source: PeopleToChannelMigrationSourceRead
    decisions: PeopleToChannelMigrationCutoverDecisions
    now?: number
  }): PeopleToChannelMigrationRecoveryRecord {
    const planDigest = validatePlan(input.plan)
    const decisions = parseDecisions(input.decisions)
    if (!decisions) blocked('Migration cutover decisions are incomplete or unsupported')
    const sourceState = sourceEvidence(input.source)
    const expectedIdentity = {
      planId: input.plan.planId,
      planDigest,
      sourceDigest: input.plan.sourceDigest,
      source: sourceState.evidence,
      decisions
    }
    const existing = this.load()
    if (existing) {
      if (
        canonicalJson({
          planId: existing.planId,
          planDigest: existing.planDigest,
          sourceDigest: existing.sourceDigest,
          source: existing.source,
          decisions: existing.decisions
        }) !== canonicalJson(expectedIdentity)
      ) {
        blocked('A different People migration is already in progress')
      }
      return existing
    }

    ensurePrivateDirectory(this.paths.root)
    ensurePrivateDirectory(this.paths.backups)
    ensurePrivateDirectory(this.paths.receipts)
    if (sourceState.bytes && sourceState.evidence.backupFile) {
      const created = immutableWrite(
        join(this.paths.backups, sourceState.evidence.backupFile),
        sourceState.bytes
      )
      if (created) this.afterDurableWrite?.('backup')
    }
    const at = safeNow(input.now ?? this.now())
    const record: PeopleToChannelMigrationRecoveryRecord = {
      schemaVersion: PEOPLE_TO_CHANNEL_MIGRATION_RECOVERY_VERSION,
      ...expectedIdentity,
      phase: 'prepared',
      preparedAt: at,
      updatedAt: at
    }
    this.writeIntent(record, 'intent:prepared')
    return clone(record)
  }

  markChannelsApplied(input: {
    planId: string
    channelStateDigest: string
    now?: number
  }): PeopleToChannelMigrationRecoveryRecord {
    const record = this.requireRecord(input.planId)
    if (!validDigest(input.channelStateDigest)) blocked('Channel migration digest is invalid')
    if (phaseRank(record.phase) >= phaseRank('channels_applied')) {
      if (record.channelStateDigest !== input.channelStateDigest) {
        blocked('Channel migration evidence conflicts with the durable intent')
      }
      return record
    }
    if (record.phase !== 'prepared') blocked('Channel migration phase is out of order')
    const next: PeopleToChannelMigrationRecoveryRecord = {
      ...record,
      phase: 'channels_applied',
      channelStateDigest: input.channelStateDigest,
      updatedAt: safeNow(input.now ?? this.now(), record.updatedAt)
    }
    this.writeIntent(next, 'intent:channels_applied')
    return clone(next)
  }

  markCutoverApplied(input: {
    planId: string
    cutoverStateDigest: string
    now?: number
  }): PeopleToChannelMigrationRecoveryRecord {
    const record = this.requireRecord(input.planId)
    if (!validDigest(input.cutoverStateDigest)) blocked('People cutover digest is invalid')
    if (phaseRank(record.phase) >= phaseRank('cutover_applied')) {
      if (record.cutoverStateDigest !== input.cutoverStateDigest) {
        blocked('People cutover evidence conflicts with the durable intent')
      }
      return record
    }
    if (record.phase !== 'channels_applied') blocked('People cutover phase is out of order')
    const next: PeopleToChannelMigrationRecoveryRecord = {
      ...record,
      phase: 'cutover_applied',
      cutoverStateDigest: input.cutoverStateDigest,
      updatedAt: safeNow(input.now ?? this.now(), record.updatedAt)
    }
    this.writeIntent(next, 'intent:cutover_applied')
    return clone(next)
  }

  finalize(input: { planId: string; now?: number }): PeopleToChannelMigrationRecoveryRecord {
    let record = this.requireRecord(input.planId)
    if (record.phase === 'committed') return record
    if (record.phase === 'cutover_applied') {
      const at = safeNow(input.now ?? this.now(), record.updatedAt)
      record = {
        ...record,
        phase: 'finalizing',
        commitStartedAt: at,
        updatedAt: at
      }
      this.writeIntent(record, 'intent:finalizing')
    } else if (record.phase !== 'finalizing') {
      blocked('Migration finalization phase is out of order')
    }

    const receipt = receiptFor(record)
    const receiptBytes = jsonBytes(receipt)
    const receiptPath = this.receiptPath(record.planId)
    const created = immutableWrite(receiptPath, receiptBytes)
    if (created) this.afterDurableWrite?.('receipt')
    const next: PeopleToChannelMigrationRecoveryRecord = {
      ...record,
      phase: 'committed',
      receiptSha256: sha256(receiptBytes),
      updatedAt: safeNow(input.now ?? this.now(), record.updatedAt)
    }
    this.writeIntent(next, 'intent:committed')
    return clone(next)
  }

  private requireRecord(planId: string): PeopleToChannelMigrationRecoveryRecord {
    if (!validDigest(planId)) blocked('Migration plan id is invalid')
    const record = this.load()
    if (!record) blocked('Migration recovery intent is missing')
    if (record.planId !== planId) blocked('Migration plan does not own this recovery intent')
    return record
  }

  private writeIntent(
    record: PeopleToChannelMigrationRecoveryRecord,
    stage: PeopleToChannelMigrationRecoveryWriteStage
  ): void {
    atomicWrite(this.paths.intent, jsonBytes(record))
    this.afterDurableWrite?.(stage)
  }

  private verifyBackup(record: PeopleToChannelMigrationRecoveryRecord): void {
    if (!record.source.exists) return
    const file = record.source.backupFile
    if (!file || basename(file) !== file || !record.source.fileSha256) {
      blocked('Migration source backup metadata is invalid')
    }
    const bytes = readRegularFile(join(this.paths.backups, file))
    if (
      !bytes ||
      bytes.length !== record.source.bytes ||
      sha256(bytes) !== record.source.fileSha256
    ) {
      blocked('Migration source backup is missing or corrupt')
    }
  }

  private receiptPath(planId: string): string {
    return join(this.paths.receipts, `${planId}.json`)
  }

  private verifyReceipt(record: PeopleToChannelMigrationRecoveryRecord): void {
    const bytes = readRegularFile(this.receiptPath(record.planId))
    if (!bytes || sha256(bytes) !== record.receiptSha256) {
      blocked('Migration receipt is missing or corrupt')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      blocked('Migration receipt is corrupt')
    }
    const receipt = parseReceipt(parsed)
    if (!receipt || canonicalJson(receipt) !== canonicalJson(receiptFor(record))) {
      blocked('Migration receipt conflicts with the durable intent')
    }
  }
}
