/**
 * Durable Host delta log (Host Arc Wave 2A).
 *
 * Crash-safe bounded journal + checkpoint under an injected data directory.
 * Appends ordered HostDeltaEnvelope records with generation fences, strictly
 * monotonic cursors within a generation, tombstones, and reconnect reads that
 * return full-resnapshot-required on previousCursor mismatch or retention gap.
 *
 * Reopen recovers generation, last cursor, tombstones, and retained deltas.
 * Truncated journal tails are dropped without inventing state; corrupt interior
 * records surface as explicit recovery warnings.
 *
 * Imports landed shared Host protocol types narrowly. Does not wire control,
 * facade, receipts, or composition roots.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostCursor,
  type HostCursorPosition,
  type HostDeltaEnvelope,
  type HostDeltaFamily,
  type HostDeltaKind,
  type HostGeneration
} from '../../shared/hostProtocol'

export const HOST_DELTA_STORE_SCHEMA_VERSION = 1 as const
export const HOST_DELTA_CHECKPOINT_FILENAME = 'host-deltas.checkpoint.json'
export const HOST_DELTA_JOURNAL_FILENAME = 'host-deltas.journal.jsonl'

/** Default bound on retained deltas after compaction. */
export const DEFAULT_HOST_DELTA_MAX_RECORDS = 2000

/** Default approximate payload-bytes budget for retained deltas. */
export const DEFAULT_HOST_DELTA_MAX_BYTES = 4_000_000

/** Default journal record count before compaction is attempted. */
export const DEFAULT_HOST_DELTA_COMPACT_AFTER_RECORDS = 256

const MAX_ENTITY_ID = 512
const MAX_REASON = 500
const MAX_PAYLOAD_JSON = 8_000

export type HostDeltaRecoveryState =
  | 'clean'
  | 'recovered-truncated-tail'
  | 'recovered-corrupt-interior'
  | 'degraded-checkpoint'

export interface HostDeltaStoredRecord {
  schemaVersion: typeof HOST_DELTA_STORE_SCHEMA_VERSION
  envelope: HostDeltaEnvelope
  /** Stable digest of the envelope used for exact-duplicate vs conflict detection. */
  contentFingerprint: string
  retainedBytes: number
}

export interface HostDeltaAppendInput {
  kind: HostDeltaKind
  family: HostDeltaFamily
  entityId?: string
  payload?: unknown
  tombstone?: boolean
  at?: string
  /** Optional explicit generation for generation-reset bookkeeping. */
  generation?: HostGeneration
}

export type HostDeltaAppendResult =
  | { kind: 'appended'; record: HostDeltaStoredRecord; position: HostCursorPosition }
  | { kind: 'duplicate'; record: HostDeltaStoredRecord; position: HostCursorPosition }
  | {
      kind: 'rejected'
      reason: 'conflicting_duplicate' | 'invalid_envelope' | 'generation_discontinuity'
      detail?: string
      position: HostCursorPosition
    }

export type HostDeltaSinceResult =
  | {
      kind: 'deltas'
      generation: HostGeneration
      fromCursor: HostCursor
      toCursor: HostCursor
      deltas: HostDeltaEnvelope[]
    }
  | {
      kind: 'full_resnapshot_required'
      reason:
        | 'generation_mismatch'
        | 'previous_cursor_mismatch'
        | 'retention_gap'
        | 'generation_reset'
      generation: HostGeneration
      cursor: HostCursor
      clientGeneration: HostGeneration
      clientCursor: HostCursor
    }

export interface HostDeltaStoreOptions {
  /** Injected Host data directory. Required — no Electron app path lookup. */
  dataDir: string
  maxRecords?: number
  maxBytes?: number
  compactAfterRecords?: number
  /** Initial generation when no durable state exists. Defaults to 1. */
  initialGeneration?: HostGeneration
  now?: () => string
  log?: (line: string) => void
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_DELTA_STORE_SCHEMA_VERSION
  updatedAt: string
  generation: HostGeneration
  cursor: HostCursor
  lowestRetainedCursor: HostCursor
  records: HostDeltaStoredRecord[]
}

type JournalEvent =
  | { op: 'append'; record: HostDeltaStoredRecord }
  | {
      op: 'generation-reset'
      previousGeneration: HostGeneration
      generation: HostGeneration
      at: string
      reason?: string
    }
  | { op: 'compact'; retainedCursors: number[]; generation: HostGeneration; at: string }

export class HostDeltaStore {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly maxRecords: number
  private readonly maxBytes: number
  private readonly compactAfterRecords: number
  private readonly initialGeneration: HostGeneration
  private readonly now: () => string
  private readonly log: (line: string) => void

  private generation: HostGeneration = 1
  private cursor: HostCursor = 0
  private lowestRetainedCursor: HostCursor = 0
  private recordsByCursor = new Map<HostCursor, HostDeltaStoredRecord>()
  private orderedCursors: HostCursor[] = []
  private retainedBytes = 0
  private journalRecordCount = 0
  private recoveryState: HostDeltaRecoveryState = 'clean'
  private recoveryWarnings: string[] = []

  constructor(options: HostDeltaStoreOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostDeltaStore requires an injected dataDir')
    }
    this.dataDir = options.dataDir
    this.checkpointPath = join(this.dataDir, HOST_DELTA_CHECKPOINT_FILENAME)
    this.journalPath = join(this.dataDir, HOST_DELTA_JOURNAL_FILENAME)
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_HOST_DELTA_MAX_RECORDS)
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_HOST_DELTA_MAX_BYTES)
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_HOST_DELTA_COMPACT_AFTER_RECORDS
    )
    this.initialGeneration = Math.max(1, Math.floor(options.initialGeneration ?? 1))
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = options.log ?? (() => {})
    this.reopen()
  }

  /** Re-read checkpoint + journal from disk. */
  reopen(): void {
    this.generation = this.initialGeneration
    this.cursor = 0
    this.lowestRetainedCursor = 0
    this.recordsByCursor = new Map()
    this.orderedCursors = []
    this.retainedBytes = 0
    this.journalRecordCount = 0
    this.recoveryState = 'clean'
    this.recoveryWarnings = []

    const checkpoint = this.readCheckpoint()
    if (checkpoint) {
      this.generation = checkpoint.generation
      this.cursor = checkpoint.cursor
      this.lowestRetainedCursor = checkpoint.lowestRetainedCursor
      for (const record of checkpoint.records) {
        this.indexRecord(record, { recomputeBytes: true })
      }
    }

    const journal = this.readJournal()
    for (const event of journal.events) {
      this.journalRecordCount += 1
      this.applyJournalEvent(event)
    }

    if (journal.truncatedTail) {
      this.noteRecovery('recovered-truncated-tail', 'dropped truncated journal tail')
    }
    if (journal.corruptInterior) {
      this.noteRecovery('recovered-corrupt-interior', 'skipped corrupt interior journal record(s)')
    }
    if (!checkpoint && existsSync(this.checkpointPath)) {
      this.noteRecovery(
        'degraded-checkpoint',
        'checkpoint unreadable; rebuilt from journal when present'
      )
    }
  }

  getPosition(): HostCursorPosition {
    return { generation: this.generation, cursor: this.cursor }
  }

  getRecoveryState(): {
    recoveryState: HostDeltaRecoveryState
    recoveryWarnings: string[]
    lowestRetainedCursor: HostCursor
    size: number
    retainedBytes: number
  } {
    return {
      recoveryState: this.recoveryState,
      recoveryWarnings: [...this.recoveryWarnings],
      lowestRetainedCursor: this.lowestRetainedCursor,
      size: this.recordsByCursor.size,
      retainedBytes: this.retainedBytes
    }
  }

  get size(): number {
    return this.recordsByCursor.size
  }

  getByCursor(cursor: HostCursor): HostDeltaStoredRecord | null {
    const record = this.recordsByCursor.get(cursor)
    return record ? cloneRecord(record) : null
  }

  /**
   * Append the next delta in the current generation chain.
   * Mints cursor = lastCursor + 1 and previousCursor = lastCursor.
   * generation-reset kind bumps generation and starts cursor at 1 for that envelope.
   */
  append(input: HostDeltaAppendInput): HostDeltaAppendResult {
    const kind = input.kind
    if (
      kind !== 'upsert' &&
      kind !== 'remove' &&
      kind !== 'tombstone' &&
      kind !== 'generation-reset'
    ) {
      return {
        kind: 'rejected',
        reason: 'invalid_envelope',
        detail: 'invalid kind',
        position: this.getPosition()
      }
    }

    if (kind === 'generation-reset') {
      return this.appendGenerationReset(input)
    }

    const previousCursor = this.cursor
    const nextCursor = this.cursor + 1
    const envelope = buildEnvelope({
      generation: this.generation,
      cursor: nextCursor,
      previousCursor,
      kind,
      family: input.family,
      entityId: input.entityId,
      payload: input.payload,
      tombstone: input.tombstone ?? kind === 'tombstone',
      at: input.at ?? this.now()
    })

    const validation = validateEnvelope(envelope)
    if (!validation.ok) {
      return {
        kind: 'rejected',
        reason: 'invalid_envelope',
        detail: validation.error,
        position: this.getPosition()
      }
    }

    const contentFingerprint = fingerprintEnvelope(envelope)
    const existing = this.recordsByCursor.get(nextCursor)
    if (existing) {
      if (existing.contentFingerprint === contentFingerprint) {
        return {
          kind: 'duplicate',
          record: cloneRecord(existing),
          position: this.getPosition()
        }
      }
      return {
        kind: 'rejected',
        reason: 'conflicting_duplicate',
        detail: `cursor ${nextCursor} already retained with different content`,
        position: this.getPosition()
      }
    }

    const retainedBytes = estimateBytes(envelope)
    const record: HostDeltaStoredRecord = {
      schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
      envelope,
      contentFingerprint,
      retainedBytes
    }

    this.indexRecord(record, { recomputeBytes: false })
    this.cursor = nextCursor
    if (this.recordsByCursor.size === 1) {
      this.lowestRetainedCursor = nextCursor
    }
    this.appendJournalEvent({ op: 'append', record })
    this.maybeCompact()
    return {
      kind: 'appended',
      record: cloneRecord(record),
      position: this.getPosition()
    }
  }

  /**
   * Durable generation discontinuity recorded as a generation-reset delta.
   * Clears retained deltas for the previous generation (they cannot be applied
   * across the fence) and starts a fresh cursor chain at 1.
   */
  resetGeneration(
    reason?: string,
    family: HostDeltaFamily = 'snapshot-meta'
  ): HostDeltaAppendResult {
    return this.appendGenerationReset({
      kind: 'generation-reset',
      family,
      payload: reason ? { reason: truncateText(reason, MAX_REASON) } : undefined,
      at: this.now()
    })
  }

  /**
   * Return deltas strictly after the client cursor within the same generation.
   * previousCursor / retention gaps require a full resnapshot.
   */
  since(client: HostCursorPosition): HostDeltaSinceResult {
    const clientGeneration = assertNonNegativeInt(client.generation, 'generation')
    const clientCursor = assertNonNegativeInt(client.cursor, 'cursor')

    if (clientGeneration !== this.generation) {
      return {
        kind: 'full_resnapshot_required',
        reason: clientGeneration < this.generation ? 'generation_reset' : 'generation_mismatch',
        generation: this.generation,
        cursor: this.cursor,
        clientGeneration,
        clientCursor
      }
    }

    if (clientCursor > this.cursor) {
      return {
        kind: 'full_resnapshot_required',
        reason: 'previous_cursor_mismatch',
        generation: this.generation,
        cursor: this.cursor,
        clientGeneration,
        clientCursor
      }
    }

    if (clientCursor === this.cursor) {
      return {
        kind: 'deltas',
        generation: this.generation,
        fromCursor: clientCursor,
        toCursor: this.cursor,
        deltas: []
      }
    }

    // Client is behind: every cursor (clientCursor+1 .. this.cursor) must be retained.
    if (clientCursor < this.lowestRetainedCursor) {
      // Even if clientCursor is 0 and lowest is 1 with full chain, that's fine.
      // Gap only when we cannot serve clientCursor+1.
      if (this.recordsByCursor.size === 0 || !this.recordsByCursor.has(clientCursor + 1)) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'retention_gap',
          generation: this.generation,
          cursor: this.cursor,
          clientGeneration,
          clientCursor
        }
      }
    }

    const deltas: HostDeltaEnvelope[] = []
    for (let c = clientCursor + 1; c <= this.cursor; c += 1) {
      const record = this.recordsByCursor.get(c)
      if (!record) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'retention_gap',
          generation: this.generation,
          cursor: this.cursor,
          clientGeneration,
          clientCursor
        }
      }
      // Chain integrity: previousCursor must link.
      if (record.envelope.previousCursor !== c - 1) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'previous_cursor_mismatch',
          generation: this.generation,
          cursor: this.cursor,
          clientGeneration,
          clientCursor
        }
      }
      if (c === clientCursor + 1 && record.envelope.previousCursor !== clientCursor) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'previous_cursor_mismatch',
          generation: this.generation,
          cursor: this.cursor,
          clientGeneration,
          clientCursor
        }
      }
      deltas.push(cloneEnvelope(record.envelope))
    }

    return {
      kind: 'deltas',
      generation: this.generation,
      fromCursor: clientCursor,
      toCursor: this.cursor,
      deltas
    }
  }

  /** Force compaction enforcing maxRecords / maxBytes. */
  compact(): void {
    this.writeCheckpointAndResetJournal()
  }

  private appendGenerationReset(input: HostDeltaAppendInput): HostDeltaAppendResult {
    const previousGeneration = this.generation
    const nextGeneration = this.generation + 1
    const at = input.at ?? this.now()

    // Clear previous generation's retained deltas — they cannot cross the fence.
    this.recordsByCursor = new Map()
    this.orderedCursors = []
    this.retainedBytes = 0
    this.lowestRetainedCursor = 0
    this.generation = nextGeneration
    this.cursor = 0

    this.appendJournalEvent({
      op: 'generation-reset',
      previousGeneration,
      generation: nextGeneration,
      at,
      ...(typeof input.payload === 'object' &&
      input.payload &&
      'reason' in (input.payload as object) &&
      typeof (input.payload as { reason?: unknown }).reason === 'string'
        ? { reason: truncateText((input.payload as { reason: string }).reason, MAX_REASON) }
        : {})
    })

    const previousCursor = 0
    const nextCursor = 1
    const envelope = buildEnvelope({
      generation: nextGeneration,
      cursor: nextCursor,
      previousCursor,
      kind: 'generation-reset',
      family: input.family,
      entityId: input.entityId,
      payload: input.payload,
      tombstone: false,
      at
    })

    const validation = validateEnvelope(envelope)
    if (!validation.ok) {
      return {
        kind: 'rejected',
        reason: 'invalid_envelope',
        detail: validation.error,
        position: this.getPosition()
      }
    }

    const contentFingerprint = fingerprintEnvelope(envelope)
    const retainedBytes = estimateBytes(envelope)
    const record: HostDeltaStoredRecord = {
      schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
      envelope,
      contentFingerprint,
      retainedBytes
    }

    this.indexRecord(record, { recomputeBytes: false })
    this.cursor = nextCursor
    this.lowestRetainedCursor = nextCursor
    this.appendJournalEvent({ op: 'append', record })
    this.maybeCompact()
    return {
      kind: 'appended',
      record: cloneRecord(record),
      position: this.getPosition()
    }
  }

  private applyJournalEvent(event: JournalEvent): void {
    if (event.op === 'append') {
      const record = normalizeStoredRecord(event.record)
      if (!record) {
        this.noteRecovery('recovered-corrupt-interior', 'skipped invalid append record')
        return
      }
      const existing = this.recordsByCursor.get(record.envelope.cursor)
      if (existing) {
        if (existing.contentFingerprint === record.contentFingerprint) {
          return // exact duplicate — idempotent
        }
        this.noteRecovery(
          'recovered-corrupt-interior',
          `conflicting duplicate at cursor ${record.envelope.cursor} ignored on reopen`
        )
        return
      }
      // Only index if it continues the chain or is the first record after empty state.
      if (
        record.envelope.generation === this.generation &&
        record.envelope.previousCursor === this.cursor &&
        record.envelope.cursor === this.cursor + 1
      ) {
        this.indexRecord(record, { recomputeBytes: false })
        this.cursor = record.envelope.cursor
        if (this.lowestRetainedCursor === 0 || record.envelope.cursor < this.lowestRetainedCursor) {
          this.lowestRetainedCursor = record.envelope.cursor
        }
        return
      }
      // After generation-reset journal event, cursor is 0 and generation already updated.
      if (
        record.envelope.generation === this.generation &&
        this.cursor === 0 &&
        record.envelope.cursor === 1 &&
        record.envelope.previousCursor === 0
      ) {
        this.indexRecord(record, { recomputeBytes: false })
        this.cursor = 1
        this.lowestRetainedCursor = 1
        return
      }
      // Allow replaying retained mid-chain records after checkpoint load when cursor already ahead.
      if (
        record.envelope.generation === this.generation &&
        record.envelope.cursor <= this.cursor &&
        !this.recordsByCursor.has(record.envelope.cursor)
      ) {
        this.indexRecord(record, { recomputeBytes: false })
        if (this.lowestRetainedCursor === 0 || record.envelope.cursor < this.lowestRetainedCursor) {
          this.lowestRetainedCursor = record.envelope.cursor
        }
        return
      }
      this.log(
        `[HostDeltaStore] skipped discontinuous append gen=${record.envelope.generation} cursor=${record.envelope.cursor}`
      )
      this.noteRecovery(
        'recovered-corrupt-interior',
        `skipped discontinuous append at cursor ${record.envelope.cursor}`
      )
      return
    }

    if (event.op === 'generation-reset') {
      this.generation = event.generation
      this.cursor = 0
      this.lowestRetainedCursor = 0
      this.recordsByCursor = new Map()
      this.orderedCursors = []
      this.retainedBytes = 0
      return
    }

    if (event.op === 'compact') {
      if (event.generation !== this.generation) return
      const retain = new Set(event.retainedCursors)
      for (const cursor of [...this.recordsByCursor.keys()]) {
        if (!retain.has(cursor)) {
          this.dropRecord(cursor)
        }
      }
      this.recomputeLowest()
    }
  }

  private indexRecord(record: HostDeltaStoredRecord, opts: { recomputeBytes: boolean }): void {
    const existing = this.recordsByCursor.get(record.envelope.cursor)
    if (existing) {
      this.retainedBytes -= existing.retainedBytes
    } else {
      this.orderedCursors.push(record.envelope.cursor)
      this.orderedCursors.sort((a, b) => a - b)
    }
    this.recordsByCursor.set(record.envelope.cursor, record)
    this.retainedBytes += record.retainedBytes
    if (opts.recomputeBytes) {
      // no-op beyond add; caller may recompute later
    }
  }

  private dropRecord(cursor: HostCursor): void {
    const existing = this.recordsByCursor.get(cursor)
    if (!existing) return
    this.retainedBytes -= existing.retainedBytes
    this.recordsByCursor.delete(cursor)
    this.orderedCursors = this.orderedCursors.filter((c) => c !== cursor)
  }

  private recomputeLowest(): void {
    if (this.orderedCursors.length === 0) {
      this.lowestRetainedCursor = 0
      return
    }
    this.lowestRetainedCursor = this.orderedCursors[0] ?? 0
  }

  private maybeCompact(): void {
    if (
      this.journalRecordCount >= this.compactAfterRecords ||
      this.recordsByCursor.size > this.maxRecords ||
      this.retainedBytes > this.maxBytes
    ) {
      this.writeCheckpointAndResetJournal()
    }
  }

  private writeCheckpointAndResetJournal(): void {
    // Retain newest records within bounds (by cursor descending).
    let cursors = [...this.orderedCursors].sort((a, b) => b - a)
    let bytes = 0
    const retained: HostCursor[] = []
    for (const cursor of cursors) {
      const record = this.recordsByCursor.get(cursor)
      if (!record) continue
      if (retained.length >= this.maxRecords) break
      if (bytes + record.retainedBytes > this.maxBytes && retained.length > 0) break
      retained.push(cursor)
      bytes += record.retainedBytes
    }
    retained.sort((a, b) => a - b)

    const nextMap = new Map<HostCursor, HostDeltaStoredRecord>()
    let nextBytes = 0
    for (const cursor of retained) {
      const record = this.recordsByCursor.get(cursor)
      if (!record) continue
      nextMap.set(cursor, record)
      nextBytes += record.retainedBytes
    }
    this.recordsByCursor = nextMap
    this.orderedCursors = retained
    this.retainedBytes = nextBytes
    this.recomputeLowest()

    // After compaction, if lowest retained is above 1 and clients may be behind,
    // since() will correctly return retention_gap.

    const doc: CheckpointDocument = {
      schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
      updatedAt: this.now(),
      generation: this.generation,
      cursor: this.cursor,
      lowestRetainedCursor: this.lowestRetainedCursor,
      records: retained
        .map((c) => this.recordsByCursor.get(c))
        .filter((r): r is HostDeltaStoredRecord => Boolean(r))
        .map(cloneRecord)
    }

    mkdirSync(this.dataDir, { recursive: true })
    const tmpPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 })
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, this.checkpointPath)

    try {
      if (existsSync(this.journalPath)) {
        unlinkSync(this.journalPath)
      }
    } catch (err) {
      this.log(
        `[HostDeltaStore] journal reset failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    this.journalRecordCount = 0
  }

  private appendJournalEvent(event: JournalEvent): void {
    mkdirSync(this.dataDir, { recursive: true })
    const line = `${JSON.stringify(event)}\n`
    const descriptor = openSync(this.journalPath, 'a', 0o600)
    try {
      appendFileSync(descriptor, line, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    this.journalRecordCount += 1
  }

  private noteRecovery(state: HostDeltaRecoveryState, warning: string): void {
    if (this.recoveryState === 'clean' || severity(state) >= severity(this.recoveryState)) {
      this.recoveryState = state
    }
    if (!this.recoveryWarnings.includes(warning)) {
      this.recoveryWarnings.push(warning)
    }
    this.log(`[HostDeltaStore] ${warning}`)
  }

  private readCheckpoint(): CheckpointDocument | null {
    if (!existsSync(this.checkpointPath)) return null
    try {
      const raw = readFileSync(this.checkpointPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log('[HostDeltaStore] checkpoint malformed (not an object)')
        return null
      }
      const doc = parsed as Partial<CheckpointDocument>
      if (doc.schemaVersion !== HOST_DELTA_STORE_SCHEMA_VERSION) {
        this.log('[HostDeltaStore] checkpoint schema mismatch')
        return null
      }
      if (
        !isNonNegativeInt(doc.generation) ||
        !isNonNegativeInt(doc.cursor) ||
        !isNonNegativeInt(doc.lowestRetainedCursor) ||
        !Array.isArray(doc.records)
      ) {
        this.log('[HostDeltaStore] checkpoint fields invalid')
        return null
      }
      const records = doc.records
        .map(normalizeStoredRecord)
        .filter((r): r is HostDeltaStoredRecord => r !== null)
      return {
        schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : this.now(),
        generation: doc.generation,
        cursor: doc.cursor,
        lowestRetainedCursor: doc.lowestRetainedCursor,
        records
      }
    } catch (err) {
      this.log(
        `[HostDeltaStore] checkpoint load failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  private readJournal(): {
    events: JournalEvent[]
    truncatedTail: boolean
    corruptInterior: boolean
  } {
    if (!existsSync(this.journalPath)) {
      return { events: [], truncatedTail: false, corruptInterior: false }
    }
    let source: string
    try {
      source = readFileSync(this.journalPath, 'utf8')
    } catch (err) {
      this.log(
        `[HostDeltaStore] journal read failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return { events: [], truncatedTail: false, corruptInterior: true }
    }

    const events: JournalEvent[] = []
    let truncatedTail = false
    let corruptInterior = false
    const lines = source.split('\n')
    const endsWithNewline = source.endsWith('\n')
    const lastContentIndex = endsWithNewline ? lines.length - 2 : lines.length - 1

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        const event = parseJournalEvent(line)
        if (event) events.push(event)
        else corruptInterior = true
      } catch {
        if (index === lastContentIndex && !endsWithNewline) {
          truncatedTail = true
          break
        }
        corruptInterior = true
        this.log(`[HostDeltaStore] skipped corrupt journal line at index ${index}`)
      }
    }
    return { events, truncatedTail, corruptInterior }
  }
}

function buildEnvelope(parts: {
  generation: HostGeneration
  cursor: HostCursor
  previousCursor: HostCursor
  kind: HostDeltaKind
  family: HostDeltaFamily
  entityId?: string
  payload?: unknown
  tombstone?: boolean
  at: string
}): HostDeltaEnvelope {
  const envelope: HostDeltaEnvelope = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generation: parts.generation,
    cursor: parts.cursor,
    previousCursor: parts.previousCursor,
    kind: parts.kind,
    family: parts.family,
    at: parts.at
  }
  if (parts.entityId !== undefined) {
    envelope.entityId = truncateText(parts.entityId, MAX_ENTITY_ID)
  }
  if (parts.payload !== undefined) {
    envelope.payload = boundPayload(parts.payload)
  }
  if (parts.tombstone) {
    envelope.tombstone = true
  }
  return envelope
}

function validateEnvelope(
  envelope: HostDeltaEnvelope
): { ok: true } | { ok: false; error: string } {
  if (envelope.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return { ok: false, error: 'protocolVersion mismatch' }
  }
  if (envelope.projectionVersion !== HOST_PROJECTION_VERSION) {
    return { ok: false, error: 'projectionVersion mismatch' }
  }
  if (!isNonNegativeInt(envelope.generation) || envelope.generation < 1) {
    return { ok: false, error: 'generation invalid' }
  }
  if (!isNonNegativeInt(envelope.cursor) || envelope.cursor < 1) {
    return { ok: false, error: 'cursor invalid' }
  }
  if (!isNonNegativeInt(envelope.previousCursor)) {
    return { ok: false, error: 'previousCursor invalid' }
  }
  if (envelope.previousCursor !== envelope.cursor - 1) {
    return { ok: false, error: 'previousCursor must be cursor-1 for stored chain' }
  }
  return { ok: true }
}

function fingerprintEnvelope(envelope: HostDeltaEnvelope): string {
  const canonical = JSON.stringify({
    protocolVersion: envelope.protocolVersion,
    projectionVersion: envelope.projectionVersion,
    generation: envelope.generation,
    cursor: envelope.cursor,
    previousCursor: envelope.previousCursor,
    kind: envelope.kind,
    family: envelope.family,
    entityId: envelope.entityId ?? null,
    payload: envelope.payload ?? null,
    tombstone: envelope.tombstone === true,
    at: envelope.at
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function estimateBytes(envelope: HostDeltaEnvelope): number {
  try {
    return Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  } catch {
    return MAX_PAYLOAD_JSON
  }
}

function boundPayload(payload: unknown): unknown {
  try {
    const json = JSON.stringify(payload)
    if (json === undefined) return null
    if (json.length <= MAX_PAYLOAD_JSON) return payload
    return { _truncated: true, preview: json.slice(0, MAX_PAYLOAD_JSON) }
  } catch {
    return { _unserializable: true }
  }
}

function normalizeStoredRecord(value: unknown): HostDeltaStoredRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<HostDeltaStoredRecord>
  if (raw.schemaVersion !== HOST_DELTA_STORE_SCHEMA_VERSION) return null
  if (!raw.envelope || typeof raw.envelope !== 'object') return null
  const envelope = raw.envelope as HostDeltaEnvelope
  const validation = validateEnvelope(envelope)
  if (!validation.ok) return null
  const contentFingerprint =
    typeof raw.contentFingerprint === 'string' && /^[a-f0-9]+$/i.test(raw.contentFingerprint)
      ? raw.contentFingerprint.toLowerCase()
      : fingerprintEnvelope(envelope)
  const retainedBytes =
    typeof raw.retainedBytes === 'number' && raw.retainedBytes > 0
      ? raw.retainedBytes
      : estimateBytes(envelope)
  return {
    schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
    envelope: cloneEnvelope(envelope),
    contentFingerprint,
    retainedBytes
  }
}

function parseJournalEvent(line: string): JournalEvent | null {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as Record<string, unknown>
  if (value.op === 'append') {
    const record = normalizeStoredRecord(value.record)
    if (!record) return null
    return { op: 'append', record }
  }
  if (value.op === 'generation-reset') {
    if (!isNonNegativeInt(value.previousGeneration) || !isNonNegativeInt(value.generation)) {
      return null
    }
    return {
      op: 'generation-reset',
      previousGeneration: value.previousGeneration,
      generation: value.generation,
      at: typeof value.at === 'string' ? value.at : '',
      ...(typeof value.reason === 'string'
        ? { reason: truncateText(value.reason, MAX_REASON) }
        : {})
    }
  }
  if (value.op === 'compact') {
    if (!isNonNegativeInt(value.generation) || !Array.isArray(value.retainedCursors)) return null
    const retainedCursors = value.retainedCursors.filter(isNonNegativeInt)
    return {
      op: 'compact',
      retainedCursors,
      generation: value.generation,
      at: typeof value.at === 'string' ? value.at : ''
    }
  }
  return null
}

function cloneRecord(record: HostDeltaStoredRecord): HostDeltaStoredRecord {
  return {
    schemaVersion: record.schemaVersion,
    envelope: cloneEnvelope(record.envelope),
    contentFingerprint: record.contentFingerprint,
    retainedBytes: record.retainedBytes
  }
}

function cloneEnvelope(envelope: HostDeltaEnvelope): HostDeltaEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as HostDeltaEnvelope
}

function severity(state: HostDeltaRecoveryState): number {
  switch (state) {
    case 'clean':
      return 0
    case 'recovered-truncated-tail':
      return 1
    case 'recovered-corrupt-interior':
      return 2
    case 'degraded-checkpoint':
      return 3
    default:
      return 0
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function assertNonNegativeInt(value: number, field: string): number {
  if (!isNonNegativeInt(value)) {
    throw new Error(`HostDeltaStore: ${field} must be a non-negative integer`)
  }
  return value
}

function truncateText(value: string, max: number): string {
  const trimmed = String(value).trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}
