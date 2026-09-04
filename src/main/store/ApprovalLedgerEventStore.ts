import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  capApprovalLedgerRecords,
  createApprovalLedgerRecord,
  expireApprovalLedgerRecord,
  filterApprovalLedgerRecords,
  recoverExpiredApprovalLedgerRecords,
  resolveApprovalLedgerRecord
} from '../ApprovalLedger'
import type {
  AgentApprovalAction,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  ApprovalLedgerRequestInput
} from './types'

export const APPROVAL_LEDGER_EVENT_FORMAT = 'taskwraith-approval-ledger-event' as const
export const APPROVAL_LEDGER_SNAPSHOT_FORMAT = 'taskwraith-approval-ledger-snapshot' as const
export const APPROVAL_LEDGER_EVENT_STORE_VERSION = 2 as const

const EVENT_HASH_DOMAIN = 'TaskWraith:approval-ledger-event:v2\0'
const SNAPSHOT_HASH_DOMAIN = 'TaskWraith:approval-ledger-snapshot:v2\0'
const RECORD_HASH_DOMAIN = 'TaskWraith:approval-ledger-record:v1\0'
const PROJECTION_HASH_DOMAIN = 'TaskWraith:approval-ledger-projection:v1\0'
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_JOURNAL_BYTES = 256 * 1024 * 1024

type ApprovalLedgerEventOperation =
  | {
      kind: 'put'
      approvalId: string
      baseRecordHash: string | null
      record: ApprovalLedgerRecord
    }
  | {
      kind: 'resolve'
      approvalId: string
      baseRecordHash: string
      action: AgentApprovalAction
      decisionSource: 'user' | 'system'
      extraMetadata: Record<string, unknown>
      record: ApprovalLedgerRecord
    }
  | {
      kind: 'replace_projection'
      baseProjectionHash: string
      records: ApprovalLedgerRecord[]
    }

interface ApprovalLedgerEventUnsigned {
  format: typeof APPROVAL_LEDGER_EVENT_FORMAT
  version: typeof APPROVAL_LEDGER_EVENT_STORE_VERSION
  sequence: number
  eventId: string
  recordedAt: string
  prevHash: string | null
  operation: ApprovalLedgerEventOperation
}

interface ApprovalLedgerEvent extends ApprovalLedgerEventUnsigned {
  hash: string
}

interface ApprovalLedgerSnapshotUnsigned {
  format: typeof APPROVAL_LEDGER_SNAPSHOT_FORMAT
  version: typeof APPROVAL_LEDGER_EVENT_STORE_VERSION
  sequence: number
  headHash: string | null
  createdAt: string
  projectionHash: string
  records: ApprovalLedgerRecord[]
}

interface ApprovalLedgerSnapshot extends ApprovalLedgerSnapshotUnsigned {
  checksum: string
}

export interface ApprovalLedgerEventStorePaths {
  legacy: string
  snapshot: string
  events: string
}

export interface ApprovalLedgerEventStoreStats {
  appends: number
  appendedBytes: number
  importedLegacyRecords: number
  replayedEvents: number
  recoveredTornTails: number
  compactions: number
  purges: number
  sequence: number
}

export interface ApprovalLedgerEventStoreOptions {
  userDataPath: string
  legacyPath?: string
  snapshotPath?: string
  eventsPath?: string
  now?: () => Date
  idFactory?: () => string
  maxEventBytes?: number
  maxJournalBytes?: number
  /** Test-only crash-window seam: the snapshot is durable and the old WAL remains. */
  afterSnapshotWrite?: (snapshot: Readonly<ApprovalLedgerSnapshot>) => void
}

export function approvalLedgerEventStorePaths(userDataPath: string): ApprovalLedgerEventStorePaths {
  return {
    legacy: path.join(userDataPath, 'approval-ledger.json'),
    snapshot: path.join(userDataPath, 'approval-ledger-v2.snapshot.json'),
    events: path.join(userDataPath, 'approval-ledger-v2.events.jsonl')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256').update(domain).update(stableJson(value)).digest('hex')
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function recordHash(record: ApprovalLedgerRecord): string {
  return sha256(RECORD_HASH_DOMAIN, record)
}

function projectionHash(records: readonly ApprovalLedgerRecord[]): string {
  return sha256(PROJECTION_HASH_DOMAIN, records)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function normalizeRecord(value: unknown): ApprovalLedgerRecord {
  if (!isObject(value)) throw new Error('Approval ledger record is not an object.')
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.approvalId !== 'string' ||
    !value.approvalId ||
    typeof value.provider !== 'string' ||
    !value.provider ||
    typeof value.method !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.actions) ||
    typeof value.status !== 'string' ||
    typeof value.requestedAt !== 'string' ||
    !isObject(value.expiration)
  ) {
    throw new Error('Approval ledger record has an invalid shape.')
  }
  return cloneJson(value) as unknown as ApprovalLedgerRecord
}

function normalizeRecords(value: unknown): ApprovalLedgerRecord[] {
  if (!Array.isArray(value)) throw new Error('Approval ledger projection is not an array.')
  return value.map(normalizeRecord)
}

function eventHash(event: ApprovalLedgerEventUnsigned): string {
  return sha256(EVENT_HASH_DOMAIN, event)
}

function snapshotChecksum(snapshot: ApprovalLedgerSnapshotUnsigned): string {
  return sha256(SNAPSHOT_HASH_DOMAIN, snapshot)
}

function assertRegularFileOrMissing(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile())
      throw new Error(`Approval ledger artifact is not a regular file: ${filePath}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function openRegularFile(filePath: string, flags: number, mode?: number): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const descriptor = fs.openSync(filePath, flags | noFollow, mode)
  const stat = fs.fstatSync(descriptor)
  if (!stat.isFile()) {
    fs.closeSync(descriptor)
    throw new Error(`Approval ledger descriptor is not a regular file: ${filePath}`)
  }
  return descriptor
}

function fsyncDirectoryBestEffort(directory: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some supported filesystems reject directory fsync. File bytes remain fsynced.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original operation result.
      }
    }
  }
}

function atomicWrite(filePath: string, content: string): void {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertRegularFileOrMissing(filePath)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openRegularFile(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    )
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    assertRegularFileOrMissing(filePath)
    fs.renameSync(tempPath, filePath)
    fsyncDirectoryBestEffort(directory)
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // A stale temp is safer than hiding the original failure.
    }
    throw error
  }
}

function appendDurably(filePath: string, content: string): void {
  if (!assertRegularFileOrMissing(filePath)) {
    throw new Error(`Approval ledger event journal is missing: ${filePath}`)
  }
  const descriptor = openRegularFile(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND)
  let failure: unknown
  try {
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    failure = error
  }
  try {
    fs.closeSync(descriptor)
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
}

function parseSnapshot(value: unknown): ApprovalLedgerSnapshot {
  if (!isObject(value)) throw new Error('Approval ledger snapshot is not an object.')
  if (
    value.format !== APPROVAL_LEDGER_SNAPSHOT_FORMAT ||
    value.version !== APPROVAL_LEDGER_EVENT_STORE_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.headHash !== null && !isSha256(value.headHash)) ||
    typeof value.createdAt !== 'string' ||
    !isSha256(value.projectionHash) ||
    !isSha256(value.checksum)
  ) {
    throw new Error('Approval ledger snapshot has an invalid shape or version.')
  }
  const records = normalizeRecords(value.records)
  const unsigned: ApprovalLedgerSnapshotUnsigned = {
    format: APPROVAL_LEDGER_SNAPSHOT_FORMAT,
    version: APPROVAL_LEDGER_EVENT_STORE_VERSION,
    sequence: value.sequence as number,
    headHash: value.headHash as string | null,
    createdAt: value.createdAt,
    projectionHash: value.projectionHash,
    records
  }
  if (projectionHash(records) !== unsigned.projectionHash) {
    throw new Error('Approval ledger snapshot projection hash is invalid.')
  }
  if (snapshotChecksum(unsigned) !== value.checksum) {
    throw new Error('Approval ledger snapshot checksum is invalid.')
  }
  return { ...unsigned, checksum: value.checksum }
}

function normalizeOperation(value: unknown): ApprovalLedgerEventOperation {
  if (!isObject(value) || typeof value.kind !== 'string') {
    throw new Error('Approval ledger event operation is invalid.')
  }
  if (value.kind === 'put') {
    if (
      typeof value.approvalId !== 'string' ||
      (value.baseRecordHash !== null && !isSha256(value.baseRecordHash))
    ) {
      throw new Error('Approval ledger put event is invalid.')
    }
    return {
      kind: 'put',
      approvalId: value.approvalId,
      baseRecordHash: value.baseRecordHash as string | null,
      record: normalizeRecord(value.record)
    }
  }
  if (value.kind === 'resolve') {
    if (
      typeof value.approvalId !== 'string' ||
      !isSha256(value.baseRecordHash) ||
      typeof value.action !== 'string' ||
      (value.decisionSource !== 'user' && value.decisionSource !== 'system') ||
      !isObject(value.extraMetadata)
    ) {
      throw new Error('Approval ledger resolve event is invalid.')
    }
    return {
      kind: 'resolve',
      approvalId: value.approvalId,
      baseRecordHash: value.baseRecordHash,
      action: value.action as AgentApprovalAction,
      decisionSource: value.decisionSource,
      extraMetadata: cloneJson(value.extraMetadata),
      record: normalizeRecord(value.record)
    }
  }
  if (value.kind === 'replace_projection') {
    if (!isSha256(value.baseProjectionHash)) {
      throw new Error('Approval ledger projection replacement event is invalid.')
    }
    return {
      kind: 'replace_projection',
      baseProjectionHash: value.baseProjectionHash,
      records: normalizeRecords(value.records)
    }
  }
  throw new Error(`Unknown approval ledger event operation: ${value.kind}`)
}

function parseEvent(line: string): ApprovalLedgerEvent {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    throw new SyntaxError('Approval ledger event contains invalid JSON.')
  }
  if (!isObject(value)) throw new Error('Approval ledger event is not an object.')
  if (
    value.format !== APPROVAL_LEDGER_EVENT_FORMAT ||
    value.version !== APPROVAL_LEDGER_EVENT_STORE_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.eventId !== 'string' ||
    !value.eventId ||
    typeof value.recordedAt !== 'string' ||
    (value.prevHash !== null && !isSha256(value.prevHash)) ||
    !isSha256(value.hash)
  ) {
    throw new Error('Approval ledger event has an invalid shape or version.')
  }
  const unsigned: ApprovalLedgerEventUnsigned = {
    format: APPROVAL_LEDGER_EVENT_FORMAT,
    version: APPROVAL_LEDGER_EVENT_STORE_VERSION,
    sequence: value.sequence as number,
    eventId: value.eventId,
    recordedAt: value.recordedAt,
    prevHash: value.prevHash as string | null,
    operation: normalizeOperation(value.operation)
  }
  if (eventHash(unsigned) !== value.hash) {
    throw new Error('Approval ledger event hash is invalid.')
  }
  return { ...unsigned, hash: value.hash }
}

function safePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Synchronous Phase-A approval persistence: one bounded event append + fsync on
 * hot writes, with full-history work deferred to explicit compaction.
 */
export class ApprovalLedgerEventStore {
  readonly paths: ApprovalLedgerEventStorePaths
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly maxEventBytes: number
  private readonly maxJournalBytes: number
  private readonly afterSnapshotWrite?: ApprovalLedgerEventStoreOptions['afterSnapshotWrite']
  private records = new Map<string, ApprovalLedgerRecord>()
  private sequence = 0
  private headHash: string | null = null
  private initialized = false
  private appendCount = 0
  private appendedBytes = 0
  private importedLegacyRecords = 0
  private replayedEvents = 0
  private recoveredTornTails = 0
  private compactionCount = 0
  private purgeCount = 0

  constructor(options: ApprovalLedgerEventStoreOptions) {
    const defaults = approvalLedgerEventStorePaths(options.userDataPath)
    this.paths = {
      legacy: options.legacyPath ?? defaults.legacy,
      snapshot: options.snapshotPath ?? defaults.snapshot,
      events: options.eventsPath ?? defaults.events
    }
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
    this.maxEventBytes = safePositiveInteger(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES)
    this.maxJournalBytes = safePositiveInteger(options.maxJournalBytes, DEFAULT_MAX_JOURNAL_BYTES)
    this.afterSnapshotWrite = options.afterSnapshotWrite
    this.initialize()
  }

  getRecords(): ApprovalLedgerRecord[] {
    return cloneJson(this.projection())
  }

  getFilteredRecords(filter: ApprovalLedgerFilter = {}): ApprovalLedgerRecord[] {
    return cloneJson(filterApprovalLedgerRecords(this.projection(), filter))
  }

  recoverExpired(): boolean {
    this.ensureInitialized()
    const records = this.projection()
    const recovered = recoverExpiredApprovalLedgerRecords(records, this.now().toISOString())
    const capped = capApprovalLedgerRecords(recovered)
    const changed =
      capped.length !== records.length || capped.some((record, index) => record !== records[index])
    if (!changed) return false
    this.appendOperation({
      kind: 'replace_projection',
      baseProjectionHash: projectionHash(records),
      records: capped
    })
    return true
  }

  put(input: ApprovalLedgerRequestInput): ApprovalLedgerRecord {
    this.ensureInitialized()
    const created = createApprovalLedgerRecord(input, this.now().toISOString())
    const existing = this.records.get(created.approvalId)
    const record = existing
      ? {
          ...existing,
          ...created,
          id: existing.id,
          requestedAt: existing.requestedAt
        }
      : created
    this.appendOperation({
      kind: 'put',
      approvalId: record.approvalId,
      baseRecordHash: existing ? recordHash(existing) : null,
      record
    })
    return cloneJson(record)
  }

  resolve(
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system' = 'user',
    extraMetadata: Record<string, unknown> = {}
  ): ApprovalLedgerRecord | null {
    this.ensureInitialized()
    const existing = this.records.get(approvalId)
    if (!existing || existing.status !== 'pending') return null
    const decidedAt = this.now().toISOString()
    const expiresAt = existing.expiration?.expiresAt
    if (expiresAt && !(Date.parse(expiresAt) > Date.parse(decidedAt))) {
      const expired = expireApprovalLedgerRecord(existing, decidedAt, 'pending_timeout')
      this.appendOperation({
        kind: 'put',
        approvalId,
        baseRecordHash: recordHash(existing),
        record: expired
      })
      return null
    }
    const record = resolveApprovalLedgerRecord(
      existing,
      action,
      decidedAt,
      decisionSource,
      extraMetadata
    )
    this.appendOperation({
      kind: 'resolve',
      approvalId,
      baseRecordHash: recordHash(existing),
      action,
      decisionSource,
      extraMetadata: cloneJson(extraMetadata),
      record
    })
    return cloneJson(record)
  }

  replaceProjection(records: readonly ApprovalLedgerRecord[]): ApprovalLedgerRecord[] {
    this.ensureInitialized()
    const normalized = normalizeRecords(records)
    this.appendOperation({
      kind: 'replace_projection',
      baseProjectionHash: projectionHash(this.projection()),
      records: normalized
    })
    return cloneJson(normalized)
  }

  /**
   * Materialize the capped projection, publish a v2 snapshot and legacy rollback
   * mirror, then reset the WAL. Snapshot publication precedes WAL retirement, so
   * a crash can only leave replayable overlap.
   */
  compact(): ApprovalLedgerRecord[] {
    this.ensureInitialized()
    const records = capApprovalLedgerRecords(this.projection())
    const snapshot = this.makeSnapshot(records)
    atomicWrite(this.paths.snapshot, JSON.stringify(snapshot))
    this.setProjection(records)
    this.afterSnapshotWrite?.(snapshot)
    atomicWrite(this.paths.legacy, JSON.stringify(records, null, 2))
    atomicWrite(this.paths.events, '')
    this.compactionCount += 1
    return cloneJson(records)
  }

  /** Remove canonical, compatibility, temporary and recovery artifacts. */
  purge(): void {
    const pathEntries = Object.values(this.paths)
    const directories = new Set(pathEntries.map((filePath) => path.dirname(filePath)))
    const managedByDirectory = new Map<string, Set<string>>()
    for (const filePath of pathEntries) {
      const directory = path.dirname(filePath)
      const names = managedByDirectory.get(directory) ?? new Set<string>()
      names.add(path.basename(filePath))
      managedByDirectory.set(directory, names)
    }
    for (const directory of directories) {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const bases = managedByDirectory.get(directory) ?? new Set<string>()
      for (const entry of entries) {
        if (!this.isManagedArtifactName(entry.name, bases)) continue
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          throw new Error(`Approval ledger managed artifact is not a file: ${entry.name}`)
        }
        fs.unlinkSync(path.join(directory, entry.name))
      }
      fsyncDirectoryBestEffort(directory)
    }
    this.records.clear()
    this.sequence = 0
    this.headHash = null
    this.initialized = false
    this.purgeCount += 1
  }

  stats(): ApprovalLedgerEventStoreStats {
    return {
      appends: this.appendCount,
      appendedBytes: this.appendedBytes,
      importedLegacyRecords: this.importedLegacyRecords,
      replayedEvents: this.replayedEvents,
      recoveredTornTails: this.recoveredTornTails,
      compactions: this.compactionCount,
      purges: this.purgeCount,
      sequence: this.sequence
    }
  }

  private initialize(): void {
    const hasSnapshot = assertRegularFileOrMissing(this.paths.snapshot)
    const hasEvents = assertRegularFileOrMissing(this.paths.events)
    if (hasSnapshot) {
      const snapshot = parseSnapshot(
        JSON.parse(fs.readFileSync(this.paths.snapshot, 'utf8')) as unknown
      )
      this.setProjection(snapshot.records)
      this.sequence = snapshot.sequence
      this.headHash = snapshot.headHash
      this.replayJournal(snapshot.sequence, snapshot.headHash)
      if (!hasEvents) atomicWrite(this.paths.events, '')
      this.initialized = true
      return
    }
    if (hasEvents && fs.statSync(this.paths.events).size > 0) {
      throw new Error('Approval ledger event journal exists without its snapshot baseline.')
    }
    const legacyRecords = this.readLegacyProjection()
    const imported = capApprovalLedgerRecords(
      recoverExpiredApprovalLedgerRecords(legacyRecords, this.now().toISOString())
    )
    this.setProjection(imported)
    this.importedLegacyRecords = imported.length
    this.sequence = 0
    this.headHash = null
    atomicWrite(this.paths.snapshot, JSON.stringify(this.makeSnapshot(imported)))
    atomicWrite(this.paths.events, '')
    this.initialized = true
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize()
  }

  private readLegacyProjection(): ApprovalLedgerRecord[] {
    if (!assertRegularFileOrMissing(this.paths.legacy)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.paths.legacy, 'utf8')) as unknown
    } catch (error) {
      throw new Error(
        `Legacy approval ledger could not be imported: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return normalizeRecords(parsed)
  }

  private makeSnapshot(records: ApprovalLedgerRecord[]): ApprovalLedgerSnapshot {
    const unsigned: ApprovalLedgerSnapshotUnsigned = {
      format: APPROVAL_LEDGER_SNAPSHOT_FORMAT,
      version: APPROVAL_LEDGER_EVENT_STORE_VERSION,
      sequence: this.sequence,
      headHash: this.headHash,
      createdAt: this.now().toISOString(),
      projectionHash: projectionHash(records),
      records: cloneJson(records)
    }
    return { ...unsigned, checksum: snapshotChecksum(unsigned) }
  }

  private projection(): ApprovalLedgerRecord[] {
    return [...this.records.values()]
  }

  private setProjection(records: readonly ApprovalLedgerRecord[]): void {
    const next = new Map<string, ApprovalLedgerRecord>()
    for (const record of records) next.set(record.approvalId, cloneJson(record))
    this.records = next
  }

  private appendOperation(operation: ApprovalLedgerEventOperation): void {
    this.assertOperationApplicable(operation)
    const unsigned: ApprovalLedgerEventUnsigned = {
      format: APPROVAL_LEDGER_EVENT_FORMAT,
      version: APPROVAL_LEDGER_EVENT_STORE_VERSION,
      sequence: this.sequence + 1,
      eventId: this.idFactory(),
      recordedAt: this.now().toISOString(),
      prevHash: this.headHash,
      operation: cloneJson(operation)
    }
    const event: ApprovalLedgerEvent = { ...unsigned, hash: eventHash(unsigned) }
    const serialized = `\n${JSON.stringify(event)}`
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > this.maxEventBytes) {
      throw new Error(`Approval ledger event exceeds ${this.maxEventBytes} bytes.`)
    }
    const currentBytes = fs.statSync(this.paths.events).size
    if (currentBytes + bytes > this.maxJournalBytes) {
      throw new Error(`Approval ledger event journal exceeds ${this.maxJournalBytes} bytes.`)
    }
    appendDurably(this.paths.events, serialized)
    this.applyOperation(operation)
    this.sequence = event.sequence
    this.headHash = event.hash
    this.appendCount += 1
    this.appendedBytes += bytes
  }

  private replayJournal(snapshotSequence: number, snapshotHash: string | null): void {
    if (!assertRegularFileOrMissing(this.paths.events)) return
    const stat = fs.statSync(this.paths.events)
    if (stat.size > this.maxJournalBytes) {
      throw new Error(`Approval ledger event journal exceeds ${this.maxJournalBytes} bytes.`)
    }
    const bytes = fs.readFileSync(this.paths.events)
    const segments: Array<{ start: number; end: number }> = []
    let start = 0
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue
      segments.push({ start, end: index })
      start = index + 1
    }
    segments.push({ start, end: bytes.length })
    const lastNonEmpty = segments.findLastIndex(({ start: from, end }) => end > from)
    const seenEventIds = new Set<string>()
    let expectedSequence = snapshotSequence
    let expectedHash = snapshotHash
    let truncateAt: number | null = null

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      if (segment.end <= segment.start) continue
      const lineBytes = bytes.subarray(segment.start, segment.end)
      if (lineBytes.length > this.maxEventBytes) {
        throw new Error(`Approval ledger event exceeds ${this.maxEventBytes} bytes.`)
      }
      let event: ApprovalLedgerEvent
      try {
        event = parseEvent(lineBytes.toString('utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) {
          this.recoveredTornTails += 1
          if (index === lastNonEmpty) {
            truncateAt = segment.start
            break
          }
          // Every append starts with a newline. A failed append can therefore
          // leave one malformed fragment between two valid frames without
          // consuming the retry that follows it. Sequence/hash checks below
          // still reject a missing or reordered durable frame.
          continue
        }
        throw error
      }
      if (event.sequence <= snapshotSequence) {
        if (event.sequence === snapshotSequence && event.hash !== snapshotHash) {
          throw new Error('Approval ledger snapshot does not match its overlapping event chain.')
        }
        continue
      }
      if (
        event.sequence === expectedSequence &&
        event.hash === expectedHash &&
        seenEventIds.has(event.eventId)
      ) {
        continue
      }
      if (event.sequence !== expectedSequence + 1 || event.prevHash !== expectedHash) {
        throw new Error('Approval ledger event sequence or hash chain is invalid.')
      }
      if (seenEventIds.has(event.eventId)) {
        throw new Error('Approval ledger event id is duplicated.')
      }
      this.assertOperationApplicable(event.operation)
      this.applyOperation(event.operation)
      expectedSequence = event.sequence
      expectedHash = event.hash
      seenEventIds.add(event.eventId)
      this.replayedEvents += 1
    }
    this.sequence = expectedSequence
    this.headHash = expectedHash
    if (truncateAt !== null) this.truncateJournal(truncateAt)
  }

  private truncateJournal(length: number): void {
    const descriptor = openRegularFile(this.paths.events, fs.constants.O_RDWR)
    try {
      fs.ftruncateSync(descriptor, length)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }

  private assertOperationApplicable(operation: ApprovalLedgerEventOperation): void {
    if (operation.kind === 'replace_projection') {
      if (projectionHash(this.projection()) !== operation.baseProjectionHash) {
        throw new Error('Approval ledger projection replacement base does not match.')
      }
      return
    }
    const existing = this.records.get(operation.approvalId)
    const actualBase = existing ? recordHash(existing) : null
    if (actualBase !== operation.baseRecordHash) {
      throw new Error(`Approval ledger ${operation.kind} base does not match.`)
    }
    if (operation.kind === 'resolve' && existing?.status !== 'pending') {
      throw new Error('Approval ledger resolve event does not target a pending record.')
    }
    if (operation.record.approvalId !== operation.approvalId) {
      throw new Error(`Approval ledger ${operation.kind} event changed approval identity.`)
    }
  }

  private applyOperation(operation: ApprovalLedgerEventOperation): void {
    if (operation.kind === 'replace_projection') {
      this.setProjection(operation.records)
      return
    }
    this.records.set(operation.approvalId, cloneJson(operation.record))
  }

  private isManagedArtifactName(name: string, bases: ReadonlySet<string>): boolean {
    if (bases.has(name)) return true
    for (const base of bases) {
      if (!name.startsWith(`${base}.`)) continue
      const suffix = name.slice(base.length + 1)
      if (
        suffix.startsWith('corrupt-') ||
        suffix.startsWith('claimed-') ||
        suffix.startsWith('spill-') ||
        suffix.startsWith('quarantine-') ||
        suffix.startsWith('retired-') ||
        suffix.endsWith('.tmp')
      ) {
        return true
      }
    }
    return false
  }
}
