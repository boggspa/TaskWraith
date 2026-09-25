/**
 * Durable Host delta log (Host Arc Wave 2A).
 *
 * Crash-safe bounded journal + checkpoint under an injected data directory.
 * Appends ordered HostDeltaEnvelope records with generation fences, strictly
 * monotonic cursors within a generation, tombstones, and reconnect reads that
 * return full-resnapshot-required on previousCursor mismatch or retention gap.
 *
 * This store is the sole durable Host generation/cursor authority. Generation
 * reset is a durable envelope at cursor 1 of the new generation.
 *
 * Payload privacy is fail-closed: structured credential/secret/auth/token,
 * hidden reasoning, unrestricted tool args/results, diff/patch bodies, and
 * full transcript/message/file content keys are rejected before any journal or
 * checkpoint persistence. Oversized safe payloads retain only
 * {_truncated, byteLength, sha256} — never a raw prefix.
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
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync
} from 'node:fs'
import {
  open as openAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync
} from 'node:fs/promises'
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
} from '../shared/hostProtocol'

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
/**
 * A delta row's payload JSON may be up to this many UTF-8 bytes. It sits above
 * the protocol's largest row (a round's run ids: 2,000 list items of about 40
 * bytes, plus fixed fields, about 80 KB), so real rows are carried whole: every
 * client rejects the stub (M4 R2-S5). Anything larger keeps the privacy stub.
 */
export const HOST_DELTA_MAX_PAYLOAD_BYTES = 128_000
/**
 * `since()` answers a resnapshot rather than a reply whose envelopes exceed
 * this many bytes, leaving the frame's own fields room under the transport's
 * 256,000-byte line budget, past which the reply becomes an error frame and
 * the client's socket is destroyed.
 */
export const HOST_DELTA_SINCE_MAX_BYTES = 192_000

/** Stable typed error code when a delta payload is rejected for privacy. */
export const HOST_DELTA_FORBIDDEN_PAYLOAD_CODE = 'host_delta_forbidden_payload' as const
export type HostDeltaPayloadPrivacyCode = typeof HOST_DELTA_FORBIDDEN_PAYLOAD_CODE

/**
 * Exact structured key denylist after lowercasing and stripping `_`/`-`.
 * Matches keys only — never innocent prose substrings in string values.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'privatekey',
  'clientsecret',
  'sessiontoken',
  'idtoken',
  'thinking',
  'reasoning',
  'hiddenreasoning',
  'rawthinking',
  'chainofthought',
  'toolinput',
  'tooloutput',
  'toolargs',
  'toolarguments',
  'toolresult',
  'toolresults',
  'rawarguments',
  'rawoutput',
  'rawinput',
  'diff',
  'patch',
  'hunks',
  'unifieddiff',
  'patchbody',
  'diffbody',
  'rawdiff',
  'rawpatch',
  'transcript',
  'messages',
  'messagebody',
  'messagecontent',
  'filecontent',
  'filecontents',
  'rawcontent',
  'filebody',
  'rawfile'
])

const HOST_USAGE_PAYLOAD_KEYS = new Set([
  'availability',
  'tokens',
  'costText',
  'confidence',
  'band'
])
const HOST_USAGE_AVAILABILITY = new Set(['available', 'estimated', 'unavailable'])
const HOST_USAGE_CONFIDENCE = new Set(['exact', 'derived', 'estimated', 'unknown'])
const HOST_USAGE_BAND = new Set(['low', 'medium', 'high', 'critical', 'unknown'])

export type HostDeltaPayloadPrepareResult =
  | { ok: true; payload: unknown }
  | { ok: false; code: HostDeltaPayloadPrivacyCode; detail: string }

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
      reason:
        | 'conflicting_duplicate'
        | 'invalid_envelope'
        | 'generation_discontinuity'
        | 'forbidden_payload'
      code?: HostDeltaPayloadPrivacyCode
      detail?: string
      position: HostCursorPosition
    }

export type HostDeltaAppendBatchResult =
  | {
      kind: 'appended'
      results: Array<Extract<HostDeltaAppendResult, { kind: 'appended' }>>
      position: HostCursorPosition
    }
  | {
      kind: 'rejected'
      failedAtIndex: number
      result: Extract<HostDeltaAppendResult, { kind: 'rejected' }>
      position: HostCursorPosition
    }
  | {
      kind: 'write-failed'
      detail: string
      position: HostCursorPosition
      rollback: 'proven' | 'uncertain'
    }

/** One command's effects, appended as one journal line (M4 slice 7a). */
export interface HostDeltaGroupInput {
  commandId: string
  effects: readonly HostDeltaAppendInput[]
}

/**
 * A command's group as the store holds it. `start` and `end` are the first
 * and last cursors it occupies (both the head it was appended at when it is
 * empty); `end` is where the command's receipt completes. `durable` turns
 * true once an fsync covered it.
 */
export interface HostDeltaGroupDescriptor {
  commandId: string
  count: number
  setDigest: string
  start: HostCursorPosition
  end: HostCursorPosition
  durable: boolean
}

export type HostDeltaGroupAppendResult =
  | { kind: 'appended'; group: HostDeltaGroupDescriptor }
  | { kind: 'exists'; group: HostDeltaGroupDescriptor }
  | {
      kind: 'rejected'
      failedAtIndex: number
      result: Extract<HostDeltaAppendResult, { kind: 'rejected' }>
      position: HostCursorPosition
    }
  | {
      kind: 'write-failed'
      detail: string
      position: HostCursorPosition
      rollback: 'proven' | 'uncertain'
      recovery: HostDeltaGroupFailureRecovery
    }

/** What the store did after a group write or fsync failed (M4 slice 7b). */
export type HostDeltaGroupFailureRecovery =
  | { kind: 'reset'; position: HostCursorPosition }
  | { kind: 'fail-stopped' }

export type HostDeltaDurabilityResult =
  | { kind: 'durable'; position: HostCursorPosition }
  /** The group was not made durable; it completes at this reset (as D1). */
  | { kind: 'reset'; position: HostCursorPosition; detail: string }
  | { kind: 'fail-stopped'; detail: string }

export const HOST_DELTA_GROUP_FAILURE_RESET_REASON = 'group durability failed'

/** A journal segment sealed by rotation; group 1 is its 20-digit sequence. */
export const HOST_DELTA_SEALED_SEGMENT_PATTERN = /^host-deltas\.journal\.(\d{20})\.sealed\.jsonl$/

export type HostDeltaCompactionStage = 'rotated' | 'checkpoint-written' | 'checkpoint-renamed'

export type HostDeltaCompactionResult =
  | { kind: 'compacted'; checkpointCursor: HostCursor; sealedRemoved: number }
  | { kind: 'skipped'; reason: 'in-flight' | 'not-durable' | 'fail-stopped' }
  | { kind: 'failed'; detail: string }

/**
 * Post-commit notification emitted only after an append is durable in the
 * journal. Consumers receive clones and cannot mutate the store's retained
 * record. Listener failures are diagnostic-only: a slow/broken projection
 * client must never turn a committed Host mutation into a failed mutation.
 */
export interface HostDeltaAppendEvent {
  readonly record: HostDeltaStoredRecord
  readonly position: HostCursorPosition
}

export type HostDeltaAppendListener = (event: HostDeltaAppendEvent) => void

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
  /** Fault seams shared by ordinary, reset, and batch journal writes. */
  batchWrite?: (descriptor: number, bytes: Uint8Array, offset: number, length: number) => number
  batchFsync?: (descriptor: number) => void
  batchTruncate?: (descriptor: number, length: number) => void
  /**
   * Async fsync of a path, used by group durability for the journal and, when
   * a group created the journal, the data directory. Defaults to open, sync
   * and close.
   */
  groupFsync?: (path: string) => Promise<void>
  /**
   * Called once when the store fail-stops: a group failed and the generation
   * reset that should have followed failed too. The Host exits here.
   */
  onFailStop?: (detail: string) => void
  /** Test seam: awaited at each background compaction stage (K11). */
  onCompactionStage?: (stage: HostDeltaCompactionStage) => void | Promise<void>
  /** Writes and fsyncs a background checkpoint's temp file. */
  checkpointWrite?: (tmpPath: string, data: string) => Promise<void>
  /** Byte bound on one `since()` reply; defaults to HOST_DELTA_SINCE_MAX_BYTES. */
  sinceMaxBytes?: number
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_DELTA_STORE_SCHEMA_VERSION
  updatedAt: string
  generation: HostGeneration
  cursor: HostCursor
  lowestRetainedCursor: HostCursor
  records: HostDeltaStoredRecord[]
  /** Unreleased groups of this generation (M4 slice 7c `openGroups`). */
  groups?: HostDeltaGroupEntry[]
  /** Every sealed segment at or below this sequence is covered whole. */
  sealedThrough?: string
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
  | {
      op: 'group'
      generation: HostGeneration
      /** The appended head the group chained after. */
      head: HostCursor
      commandId: string
      count: number
      setDigest: string
      /** In memory without `txn`; the journal line stamps it per record. */
      records: HostDeltaStoredRecord[]
    }

interface HostDeltaGroupEntry {
  commandId: string
  count: number
  setDigest: string
  start: HostCursor
  end: HostCursor
}

interface HostDeltaDurabilityWaiter {
  target: HostCursor
  writeSeq: number
  generation: HostGeneration
  resolve: (result: HostDeltaDurabilityResult) => void
}

type PreparedAppend = {
  record: HostDeltaStoredRecord
  result: Extract<HostDeltaAppendResult, { kind: 'appended' }>
}

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
  private readonly batchWrite: NonNullable<HostDeltaStoreOptions['batchWrite']>
  private readonly batchFsync: NonNullable<HostDeltaStoreOptions['batchFsync']>
  private readonly batchTruncate: NonNullable<HostDeltaStoreOptions['batchTruncate']>
  private readonly groupFsync: NonNullable<HostDeltaStoreOptions['groupFsync']>
  private readonly onFailStop: HostDeltaStoreOptions['onFailStop']
  private readonly onCompactionStage: HostDeltaStoreOptions['onCompactionStage']
  private readonly checkpointWrite: NonNullable<HostDeltaStoreOptions['checkpointWrite']>
  private readonly sinceMaxBytes: number
  private compactionInFlight = false
  /**
   * The highest sealed sequence ever used or covered. It never goes back, so
   * a new segment is never mistaken for one a checkpoint's `sealedThrough`
   * already covers.
   */
  private sealedSequenceFloor = 0n
  /** Sticky for this instance: only a new store (boot recovery) moves on. */
  private failStop: { detail: string } | null = null

  private generation: HostGeneration = 1
  /** The appended head: the next append chains after it. */
  private cursor: HostCursor = 0
  /** The durable head: everything readers and listeners see stops here. */
  private durableCursor: HostCursor = 0
  private lowestRetainedCursor: HostCursor = 0
  private groupsByCommand = new Map<string, HostDeltaGroupEntry>()
  private durabilityWaiters: HostDeltaDurabilityWaiter[] = []
  private flushInFlight = false
  private flushRequested = false
  /**
   * Group writes are numbered. A write is durable once a flush, or a legacy
   * synchronous fsync, covers its number: the cursor alone cannot say so,
   * because an empty group writes a line without moving it.
   */
  private writeSeq = 0
  private durableWriteSeq = 0
  /** The latest group write that created the journal (0: none). */
  private journalCreatedAtSeq = 0
  /** Every journal create at or below this write has a durable directory entry. */
  private dirSyncedSeq = 0
  private groupWriteSeq = new Map<string, number>()
  private recordsByCursor = new Map<HostCursor, HostDeltaStoredRecord>()
  private orderedCursors: HostCursor[] = []
  private retainedBytes = 0
  private journalRecordCount = 0
  private recoveryState: HostDeltaRecoveryState = 'clean'
  private recoveryWarnings: string[] = []
  private readonly appendListeners = new Set<HostDeltaAppendListener>()
  private readonly appendNotificationQueue: Array<
    Extract<HostDeltaAppendResult, { kind: 'appended' }>
  > = []
  private notifyingAppends = false
  private appendAuthorityBlocked = false

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
    this.batchWrite =
      options.batchWrite ??
      ((descriptor, bytes, offset, length) => writeSync(descriptor, bytes, offset, length, null))
    this.batchFsync = options.batchFsync ?? fsyncSync
    this.batchTruncate = options.batchTruncate ?? ftruncateSync
    this.groupFsync = options.groupFsync ?? fsyncPath
    this.onFailStop = options.onFailStop
    this.onCompactionStage = options.onCompactionStage
    this.checkpointWrite = options.checkpointWrite ?? writeAndFsyncFile
    this.sinceMaxBytes = Math.max(1, options.sinceMaxBytes ?? HOST_DELTA_SINCE_MAX_BYTES)
    this.reopen()
  }

  /** Re-read checkpoint + journal from disk. */
  reopen(): void {
    const preserveBlockedAuthority = this.appendAuthorityBlocked
    this.appendAuthorityBlocked = true
    this.appendNotificationQueue.length = 0
    this.notifyingAppends = false
    this.generation = this.initialGeneration
    this.cursor = 0
    this.durableCursor = 0
    this.lowestRetainedCursor = 0
    this.groupsByCommand = new Map()
    this.groupWriteSeq = new Map()
    this.writeSeq = 0
    this.durableWriteSeq = 0
    this.journalCreatedAtSeq = 0
    this.dirSyncedSeq = 0
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
      for (const group of checkpoint.groups ?? []) {
        this.groupsByCommand.set(group.commandId, { ...group })
      }
    }

    // Sealed segments (oldest first) precede the active journal.
    const journal = { events: [] as JournalEvent[], truncatedTail: false, corruptInterior: false }
    const sealedThrough = checkpoint?.sealedThrough
    this.sealedSequenceFloor = sealedThrough !== undefined ? BigInt(sealedThrough) : 0n
    for (const path of [
      ...this.listSealedSegments()
        .filter((segment) => sealedThrough === undefined || segment.sequence > sealedThrough)
        .map((segment) => segment.path),
      this.journalPath
    ]) {
      const read = this.readJournal(path)
      journal.events.push(...read.events)
      journal.truncatedTail ||= read.truncatedTail
      journal.corruptInterior ||= read.corruptInterior
    }
    for (const event of journal.events) {
      this.journalRecordCount += 1
      if (checkpoint) {
        // A checkpoint may be durable while removal of the old journal failed.
        // Covered entries cannot resurrect trimmed records or replay old fences.
        const generation =
          event.op === 'append' ? event.record.envelope.generation : event.generation
        if (generation < checkpoint.generation) continue
        if (
          generation === checkpoint.generation &&
          (event.op === 'generation-reset' ||
            (event.op === 'append' && event.record.envelope.cursor <= checkpoint.cursor) ||
            (event.op === 'group' && event.head < checkpoint.cursor))
        ) {
          continue
        }
      }
      this.applyJournalEvent(event)
    }

    // Everything found on disk is durable.
    this.durableCursor = this.cursor
    if (journal.truncatedTail) {
      this.noteRecovery('recovered-truncated-tail', 'dropped truncated journal tail')
    }
    if (journal.corruptInterior) {
      this.noteRecovery('recovered-corrupt-interior', 'skipped corrupt interior journal record(s)')
    }
    this.appendAuthorityBlocked = preserveBlockedAuthority
  }

  /** The durable head. Appended but not yet durable groups are invisible. */
  getPosition(): HostCursorPosition {
    return { generation: this.generation, cursor: this.durableCursor }
  }

  /** The appended head, including groups not yet durable (snapshot stamping). */
  getAppendedPosition(): HostCursorPosition {
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
    if (cursor > this.durableCursor) return null
    const record = this.recordsByCursor.get(cursor)
    return record ? cloneRecord(record) : null
  }

  /**
   * Observe newly committed deltas. Reopening/replaying durable state does not
   * emit historical notifications; reconnecting clients use since() for that.
   */
  subscribe(listener: HostDeltaAppendListener): () => void {
    if (typeof listener !== 'function') {
      throw new Error('HostDeltaStore.subscribe requires a listener')
    }
    this.appendListeners.add(listener)
    return () => {
      this.appendListeners.delete(listener)
    }
  }

  /**
   * Append the next delta in the current generation chain.
   * Mints cursor = lastCursor + 1 and previousCursor = lastCursor.
   * generation-reset kind bumps generation and starts cursor at 1 for that envelope.
   */
  append(input: HostDeltaAppendInput): HostDeltaAppendResult {
    if (this.appendAuthorityBlocked) throw new Error('Host delta append authority is blocked')
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

    let preparedPayload = input.payload
    if (input.payload !== undefined) {
      const prepared = prepareHostDeltaPayload(input.payload)
      if (!prepared.ok) {
        return {
          kind: 'rejected',
          reason: 'forbidden_payload',
          code: prepared.code,
          detail: prepared.detail,
          position: this.getPosition()
        }
      }
      preparedPayload = prepared.payload
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
      payload: preparedPayload,
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

    this.appendJournalEvents([{ op: 'append', record }])
    // That fsync also made every pending group durable.
    this.settleDurableThrough(previousCursor)
    this.indexRecord(record, { recomputeBytes: false })
    this.cursor = nextCursor
    this.durableCursor = nextCursor
    if (this.recordsByCursor.size === 1) {
      this.lowestRetainedCursor = nextCursor
    }
    this.compactAfterAppend()
    const result: Extract<HostDeltaAppendResult, { kind: 'appended' }> = {
      kind: 'appended',
      record: cloneRecord(record),
      position: this.getPosition()
    }
    this.notifyAppend(result)
    return result
  }

  /**
   * Domain-effect batch for reconciliation and command completion. Every
   * envelope is validated before the first byte is written; the complete JSONL
   * batch is fsynced once before any memory state or listener can observe it.
   */
  appendBatch(inputs: readonly HostDeltaAppendInput[]): HostDeltaAppendBatchResult {
    if (this.appendAuthorityBlocked) throw new Error('Host delta append authority is blocked')
    const initial = this.getPosition()
    const preparation = this.prepareAppends(inputs, initial)
    if (!preparation.ok) return preparation.rejection
    const prepared = preparation.prepared
    if (prepared.length === 0) return { kind: 'appended', results: [], position: initial }

    const write = this.appendJournalBatch(prepared.map(({ record }) => ({ op: 'append', record })))
    if (!write.ok) {
      if (!write.rolledBack) this.appendAuthorityBlocked = true
      return {
        kind: 'write-failed',
        detail: write.detail,
        position: initial,
        rollback: write.rolledBack ? 'proven' : 'uncertain'
      }
    }
    // That fsync also made every pending group durable.
    this.settleDurableThrough(this.cursor)
    for (const { record } of prepared) {
      this.indexRecord(record, { recomputeBytes: false })
      this.cursor = record.envelope.cursor
      if (this.recordsByCursor.size === 1) this.lowestRetainedCursor = record.envelope.cursor
    }
    this.durableCursor = this.cursor
    this.compactAfterAppend()
    const position = this.getPosition()
    this.notifyAppends(prepared.map(({ result }) => result))
    return {
      kind: 'appended',
      results: prepared.map(({ result }) => result),
      position
    }
  }

  /**
   * One command's effects as one journal line, written but NOT fsynced (M4
   * RR-7: the write happens under the publication lock, the fsync after it).
   * Nothing is visible until `awaitDurable` covers it. A command never gets a
   * second group: an existing one is returned and nothing is written.
   */
  appendGroup(input: HostDeltaGroupInput): HostDeltaGroupAppendResult {
    if (this.appendAuthorityBlocked) throw new Error('Host delta append authority is blocked')
    const initial = this.getAppendedPosition()
    const reject = (detail: string): HostDeltaGroupAppendResult => ({
      kind: 'rejected',
      failedAtIndex: 0,
      result: { kind: 'rejected', reason: 'invalid_envelope', detail, position: initial },
      position: initial
    })
    const commandId = input?.commandId
    if (typeof commandId !== 'string' || commandId.length === 0) {
      return reject('group commandId must be a non-empty string')
    }
    if (commandId.length > MAX_ENTITY_ID) return reject('group commandId is too long')
    const existing = this.groupsByCommand.get(commandId)
    if (existing) return { kind: 'exists', group: this.describeGroup(existing) }

    const preparation = this.prepareAppends(input.effects, initial)
    if (!preparation.ok) return preparation.rejection
    const records = preparation.prepared.map(({ record }) => record)
    const setDigest = hostDeltaGroupSetDigest(records.map((record) => record.contentFingerprint))
    const head = this.cursor
    const write = this.appendJournalBatch(
      [
        {
          op: 'group',
          generation: this.generation,
          head,
          commandId,
          count: records.length,
          setDigest,
          records
        }
      ],
      { fsync: false }
    )
    if (!write.ok) {
      // A reset written after bytes that may be torn could itself be
      // concatenated into a corrupt line, so an unproven rollback stops.
      const recovery: HostDeltaGroupFailureRecovery = write.rolledBack
        ? this.recoverFromGroupFailure(`group write failed: ${write.detail}`)
        : this.failStopWith(`group write failed and its rollback is uncertain: ${write.detail}`)
      return {
        kind: 'write-failed',
        detail: write.detail,
        position: initial,
        rollback: write.rolledBack ? 'proven' : 'uncertain',
        recovery
      }
    }
    this.writeSeq += 1
    if (write.created) this.journalCreatedAtSeq = this.writeSeq
    for (const record of records) {
      this.indexRecord(record, { recomputeBytes: false })
      this.cursor = record.envelope.cursor
      if (this.recordsByCursor.size === 1) this.lowestRetainedCursor = record.envelope.cursor
    }
    this.groupWriteSeq.set(commandId, this.writeSeq)
    const entry: HostDeltaGroupEntry = {
      commandId,
      count: records.length,
      setDigest,
      start: records[0]?.envelope.cursor ?? head,
      end: this.cursor
    }
    this.groupsByCommand.set(commandId, entry)
    return { kind: 'appended', group: this.describeGroup(entry) }
  }

  /**
   * Resolves once everything appended before the call is durable. Calls
   * coalesce: one async fsync covers every group appended before it started.
   */
  awaitDurable(): Promise<HostDeltaDurabilityResult> {
    if (this.failStop)
      return Promise.resolve({ kind: 'fail-stopped', detail: this.failStop.detail })
    if (this.everythingDurable()) {
      return Promise.resolve({ kind: 'durable', position: this.getPosition() })
    }
    return new Promise((resolve) => {
      this.durabilityWaiters.push({
        target: this.cursor,
        writeSeq: this.writeSeq,
        generation: this.generation,
        resolve
      })
      this.requestFlush()
    })
  }

  /** Why the store fail-stopped, or null while it is running. */
  getFailStop(): { detail: string } | null {
    return this.failStop ? { ...this.failStop } : null
  }

  /** The command's group in the current generation, or null. */
  findGroup(commandId: string): HostDeltaGroupDescriptor | null {
    const entry = this.groupsByCommand.get(commandId)
    return entry ? this.describeGroup(entry) : null
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
    if (this.appendAuthorityBlocked) throw new Error('Host delta append authority is blocked')
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
    // Readers stop at the durable head; a group appended but not yet
    // durable is invisible.
    const head = this.durableCursor

    if (clientGeneration !== this.generation) {
      return {
        kind: 'full_resnapshot_required',
        reason: clientGeneration < this.generation ? 'generation_reset' : 'generation_mismatch',
        generation: this.generation,
        cursor: head,
        clientGeneration,
        clientCursor
      }
    }

    if (clientCursor > head) {
      return {
        kind: 'full_resnapshot_required',
        reason: 'previous_cursor_mismatch',
        generation: this.generation,
        cursor: head,
        clientGeneration,
        clientCursor
      }
    }

    if (clientCursor === head) {
      return {
        kind: 'deltas',
        generation: this.generation,
        fromCursor: clientCursor,
        toCursor: head,
        deltas: []
      }
    }

    // Client is behind: every cursor (clientCursor+1 .. head) must be retained.
    if (clientCursor < this.lowestRetainedCursor) {
      // Even if clientCursor is 0 and lowest is 1 with full chain, that's fine.
      // Gap only when we cannot serve clientCursor+1.
      if (this.recordsByCursor.size === 0 || !this.recordsByCursor.has(clientCursor + 1)) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'retention_gap',
          generation: this.generation,
          cursor: head,
          clientGeneration,
          clientCursor
        }
      }
    }

    const deltas: HostDeltaEnvelope[] = []
    let replyBytes = 0
    for (let c = clientCursor + 1; c <= head; c += 1) {
      const record = this.recordsByCursor.get(c)
      if (!record) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'retention_gap',
          generation: this.generation,
          cursor: head,
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
          cursor: head,
          clientGeneration,
          clientCursor
        }
      }
      if (c === clientCursor + 1 && record.envelope.previousCursor !== clientCursor) {
        return {
          kind: 'full_resnapshot_required',
          reason: 'previous_cursor_mismatch',
          generation: this.generation,
          cursor: head,
          clientGeneration,
          clientCursor
        }
      }
      replyBytes += record.retainedBytes
      if (replyBytes > this.sinceMaxBytes) {
        // Too large for one reply: the client resnapshots instead of losing
        // its socket to an oversized frame.
        return {
          kind: 'full_resnapshot_required',
          reason: 'retention_gap',
          generation: this.generation,
          cursor: head,
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
      toCursor: head,
      deltas
    }
  }

  /** Force compaction enforcing maxRecords / maxBytes. */
  compact(): void {
    if (this.appendAuthorityBlocked) throw new Error('Host delta append authority is blocked')
    // Retention may cut records not yet notified; they are durable in the
    // checkpoint, so notify them from the map as it was before the cut.
    const before = new Map(this.recordsByCursor)
    const cursor = this.cursor
    // The checkpoint holds every appended record and was fsynced.
    if (this.writeCheckpointAndResetJournal()) {
      this.settleDurableThrough(cursor, this.writeSeq, before)
    }
  }

  /**
   * The command's receipt is terminal: drop its group's anchor, so it leaves
   * `findGroup` and the next checkpoint.
   */
  releaseGroup(commandId: string): boolean {
    this.groupWriteSeq.delete(commandId)
    return this.groupsByCommand.delete(commandId)
  }

  private appendGenerationReset(input: HostDeltaAppendInput): HostDeltaAppendResult {
    let preparedPayload = input.payload
    if (input.payload !== undefined) {
      const prepared = prepareHostDeltaPayload(input.payload)
      if (!prepared.ok) {
        return {
          kind: 'rejected',
          reason: 'forbidden_payload',
          code: prepared.code,
          detail: prepared.detail,
          position: this.getPosition()
        }
      }
      preparedPayload = prepared.payload
    }

    const previousGeneration = this.generation
    const nextGeneration = this.generation + 1
    const at = input.at ?? this.now()

    const previousCursor = 0
    const nextCursor = 1
    const envelope = buildEnvelope({
      generation: nextGeneration,
      cursor: nextCursor,
      previousCursor,
      kind: 'generation-reset',
      family: input.family,
      entityId: input.entityId,
      payload: preparedPayload,
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

    // Persist both existing journal events at one boundary before exposing the
    // new generation or clearing any of the previous generation's records.
    this.appendJournalEvents([
      {
        op: 'generation-reset',
        previousGeneration,
        generation: nextGeneration,
        at,
        ...(typeof preparedPayload === 'object' &&
        preparedPayload &&
        'reason' in (preparedPayload as object) &&
        typeof (preparedPayload as { reason?: unknown }).reason === 'string'
          ? { reason: truncateText((preparedPayload as { reason: string }).reason, MAX_REASON) }
          : {})
      },
      { op: 'append', record }
    ])
    // That fsync made every pending group durable; the reset then clears
    // the old generation's groups with its records.
    this.settleDurableThrough(this.cursor)
    this.recordsByCursor = new Map()
    this.orderedCursors = []
    this.retainedBytes = 0
    this.groupsByCommand = new Map()
    this.groupWriteSeq = new Map()
    this.generation = nextGeneration
    this.indexRecord(record, { recomputeBytes: false })
    this.cursor = nextCursor
    this.durableCursor = nextCursor
    this.lowestRetainedCursor = nextCursor
    this.compactAfterAppend()
    const result: Extract<HostDeltaAppendResult, { kind: 'appended' }> = {
      kind: 'appended',
      record: cloneRecord(record),
      position: this.getPosition()
    }
    this.notifyAppend(result)
    return result
  }

  /**
   * Validate and envelope a batch against the appended head, before any byte
   * is written. Shared by `appendBatch` and `appendGroup`.
   */
  private prepareAppends(
    inputs: readonly HostDeltaAppendInput[],
    initial: HostCursorPosition
  ):
    | { ok: true; prepared: PreparedAppend[] }
    | { ok: false; rejection: Extract<HostDeltaAppendBatchResult, { kind: 'rejected' }> } {
    const rejected = (
      failedAtIndex: number,
      result: Extract<HostDeltaAppendResult, { kind: 'rejected' }>
    ) => ({
      ok: false as const,
      rejection: { kind: 'rejected' as const, failedAtIndex, result, position: initial }
    })
    if (!Array.isArray(inputs)) {
      return rejected(0, {
        kind: 'rejected',
        reason: 'invalid_envelope',
        detail: 'batch must be an array',
        position: initial
      })
    }
    const prepared: PreparedAppend[] = []
    let cursor = this.cursor
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]!
      const kind = input.kind
      if (kind !== 'upsert' && kind !== 'remove' && kind !== 'tombstone') {
        return rejected(index, {
          kind: 'rejected',
          reason: 'invalid_envelope',
          detail: 'batch kind must be upsert, remove, or tombstone',
          position: initial
        })
      }
      let payload = input.payload
      if (input.payload !== undefined) {
        const checked = prepareHostDeltaPayload(input.payload)
        if (!checked.ok) {
          return rejected(index, {
            kind: 'rejected',
            reason: 'forbidden_payload',
            code: checked.code,
            detail: checked.detail,
            position: initial
          })
        }
        payload = checked.payload
      }
      const nextCursor = cursor + 1
      const envelope = buildEnvelope({
        generation: this.generation,
        cursor: nextCursor,
        previousCursor: cursor,
        kind,
        family: input.family,
        entityId: input.entityId,
        payload,
        tombstone: input.tombstone ?? kind === 'tombstone',
        at: input.at ?? this.now()
      })
      const validation = validateEnvelope(envelope)
      if (!validation.ok) {
        return rejected(index, {
          kind: 'rejected',
          reason: 'invalid_envelope',
          detail: validation.error,
          position: initial
        })
      }
      const record: HostDeltaStoredRecord = {
        schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
        envelope,
        contentFingerprint: fingerprintEnvelope(envelope),
        retainedBytes: estimateBytes(envelope)
      }
      prepared.push({
        record,
        result: {
          kind: 'appended',
          record: cloneRecord(record),
          position: { generation: this.generation, cursor: nextCursor }
        }
      })
      cursor = nextCursor
    }
    return { ok: true, prepared }
  }

  private describeGroup(entry: HostDeltaGroupEntry): HostDeltaGroupDescriptor {
    return {
      commandId: entry.commandId,
      count: entry.count,
      setDigest: entry.setDigest,
      start: { generation: this.generation, cursor: entry.start },
      end: { generation: this.generation, cursor: entry.end },
      durable:
        entry.end <= this.durableCursor &&
        (this.groupWriteSeq.get(entry.commandId) ?? 0) <= this.durableWriteSeq
    }
  }

  private everythingDurable(): boolean {
    return this.cursor <= this.durableCursor && this.writeSeq <= this.durableWriteSeq
  }

  /**
   * Advance the durable head to `target` (an fsync covered it): notify the
   * newly durable records in cursor order, then resolve every waiter it
   * satisfies. A waiter from an earlier generation was made durable before
   * the reset that ended it.
   */
  private settleDurableThrough(
    target: HostCursor,
    writeSeq: number = this.writeSeq,
    records: ReadonlyMap<HostCursor, HostDeltaStoredRecord> = this.recordsByCursor
  ): void {
    if (writeSeq > this.durableWriteSeq) this.durableWriteSeq = writeSeq
    if (target > this.durableCursor) {
      const results: Array<Extract<HostDeltaAppendResult, { kind: 'appended' }>> = []
      for (let cursor = this.durableCursor + 1; cursor <= target; cursor += 1) {
        const record = records.get(cursor)
        if (!record) continue
        results.push({
          kind: 'appended',
          record: cloneRecord(record),
          position: { generation: this.generation, cursor }
        })
      }
      this.durableCursor = target
      this.notifyAppends(results)
    }
    const waiting = this.durabilityWaiters
    this.durabilityWaiters = []
    for (const waiter of waiting) {
      if (
        waiter.generation !== this.generation ||
        (waiter.target <= this.durableCursor && waiter.writeSeq <= this.durableWriteSeq)
      ) {
        waiter.resolve({ kind: 'durable', position: this.getPosition() })
      } else {
        this.durabilityWaiters.push(waiter)
      }
    }
  }

  /**
   * Start one async fsync covering everything appended so far, or, while one
   * is in flight, ask for another once it lands. Appends made during an
   * fsync are never counted as covered by it.
   */
  private requestFlush(): void {
    if (this.flushInFlight) {
      this.flushRequested = true
      return
    }
    const generation = this.generation
    const target = this.cursor
    const targetSeq = this.writeSeq
    // A created journal's name is owed until a directory fsync covers it; the
    // debt is settled only when that fsync succeeds, never when a flush starts.
    const owesDirectory = this.journalCreatedAtSeq > this.dirSyncedSeq
    this.flushInFlight = true
    this.flushRequested = false
    const flush = async (): Promise<void> => {
      await this.groupFsync(this.journalPath)
      if (owesDirectory && process.platform !== 'win32') await this.groupFsync(this.dataDir)
      if (targetSeq > this.dirSyncedSeq) this.dirSyncedSeq = targetSeq
    }
    const coveredElsewhere = () =>
      generation !== this.generation ||
      (target <= this.durableCursor && targetSeq <= this.durableWriteSeq)
    const done = (error: unknown): void => {
      this.flushInFlight = false
      if (this.failStop) {
        this.resolveWaiters({ kind: 'fail-stopped', detail: this.failStop.detail })
        return
      }
      if (error !== null && !coveredElsewhere()) {
        // Nothing says which of the unflushed bytes reached the disk, so
        // none of them is published: they complete at a generation reset.
        const detail = error instanceof Error ? error.message : String(error)
        // The directory debt is still owed, so the reset's own fsync pays it:
        // the reset line lands in the journal the group created.
        this.recoverFromGroupFailure(`group fsync failed: ${detail}`)
        return
      }
      if (generation === this.generation) this.settleDurableThrough(target, targetSeq)
      else this.settleDurableThrough(this.durableCursor, this.durableWriteSeq)
      if (this.flushRequested || this.durabilityWaiters.length > 0) this.requestFlush()
      // Compaction starts here, after a flush, and never inside an append.
      else this.maybeCompactInBackground()
    }
    const run = coveredElsewhere() ? Promise.resolve() : flush()
    run.then(
      () => done(null),
      (error: unknown) => done(error ?? new Error('Host delta group fsync failed'))
    )
  }

  /**
   * A group write or fsync failed (RR-7). Everything not yet durable leaves
   * memory and is never notified; the generation resets, and every pending
   * waiter completes at the reset. If the reset fails too, the store
   * fail-stops (§13 SF-2).
   */
  private recoverFromGroupFailure(detail: string): HostDeltaGroupFailureRecovery {
    if (this.failStop) return { kind: 'fail-stopped' }
    this.dropUndurable()
    let reset: HostDeltaAppendResult
    try {
      reset = this.appendGenerationReset({
        kind: 'generation-reset',
        family: 'snapshot-meta',
        payload: { reason: HOST_DELTA_GROUP_FAILURE_RESET_REASON },
        at: this.now()
      })
    } catch (error) {
      return this.failStopWith(
        `${detail}; generation reset failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (reset.kind !== 'appended') {
      return this.failStopWith(`${detail}; generation reset was ${reset.kind}`)
    }
    const position = this.getPosition()
    this.flushRequested = false
    this.resolveWaiters({ kind: 'reset', position, detail })
    return { kind: 'reset', position }
  }

  /** Forget every record and group past the durable head. */
  private dropUndurable(): void {
    for (const cursor of [...this.orderedCursors]) {
      if (cursor > this.durableCursor) this.dropRecord(cursor)
    }
    this.cursor = this.durableCursor
    this.recomputeLowest()
    for (const [commandId, entry] of this.groupsByCommand) {
      const seq = this.groupWriteSeq.get(commandId) ?? 0
      if (entry.end > this.durableCursor || seq > this.durableWriteSeq) {
        this.groupsByCommand.delete(commandId)
        this.groupWriteSeq.delete(commandId)
      }
    }
  }

  private failStopWith(detail: string): { kind: 'fail-stopped' } {
    if (!this.failStop) {
      this.failStop = { detail }
      this.appendAuthorityBlocked = true
      this.dropUndurable()
      this.flushRequested = false
      this.resolveWaiters({ kind: 'fail-stopped', detail })
      try {
        this.onFailStop?.(detail)
      } catch (error) {
        try {
          this.log(`[host-delta-store] fail-stop handler failed: ${String(error)}`)
        } catch {
          // Diagnostics cannot undo a fail-stop.
        }
      }
    }
    return { kind: 'fail-stopped' }
  }

  private resolveWaiters(result: HostDeltaDurabilityResult): void {
    const waiting = this.durabilityWaiters
    this.durabilityWaiters = []
    for (const waiter of waiting) waiter.resolve(result)
  }

  private notifyAppend(result: Extract<HostDeltaAppendResult, { kind: 'appended' }>): void {
    this.notifyAppends([result])
  }

  private notifyAppends(
    results: readonly Extract<HostDeltaAppendResult, { kind: 'appended' }>[]
  ): void {
    this.appendNotificationQueue.push(...results)
    if (this.notifyingAppends) return
    this.notifyingAppends = true
    try {
      for (;;) {
        const result = this.appendNotificationQueue.shift()
        if (!result) break
        for (const listener of this.appendListeners) {
          try {
            listener({
              record: cloneRecord(result.record),
              position: { ...result.position }
            })
          } catch (error) {
            try {
              this.log(`[host-delta-store] append listener failed: ${String(error)}`)
            } catch {
              // Diagnostics cannot interrupt delivery after durable commit.
            }
          }
        }
      }
    } finally {
      this.notifyingAppends = false
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
      this.groupsByCommand = new Map()
      return
    }

    if (event.op === 'group') {
      // parseJournalEvent already proved the line whole (count, digest, txn).
      if (event.generation !== this.generation || event.head !== this.cursor) {
        this.noteRecovery(
          'recovered-corrupt-interior',
          `skipped discontinuous group for command ${event.commandId}`
        )
        return
      }
      for (const record of event.records) this.applyJournalEvent({ op: 'append', record })
      const last = event.records[event.records.length - 1]
      if (last && this.cursor !== last.envelope.cursor) return
      this.groupsByCommand.set(event.commandId, {
        commandId: event.commandId,
        count: event.count,
        setDigest: event.setDigest,
        start: event.records[0]?.envelope.cursor ?? event.head,
        end: this.cursor
      })
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

  private compactAfterAppend(): void {
    try {
      this.maybeCompact()
    } catch (error) {
      // Journal fsync already committed the records. Leave compaction due for
      // retry; neither retention work nor diagnostics can undo that commit.
      try {
        this.log(
          `[HostDeltaStore] committed append compaction deferred: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      } catch {
        // Diagnostics cannot overturn a durable append.
      }
    }
  }

  private maybeCompact(): void {
    if (this.compactionDue()) this.writeCheckpointAndResetJournal()
  }

  private compactionDue(): boolean {
    return (
      this.journalRecordCount >= this.compactAfterRecords ||
      this.recordsByCursor.size > this.maxRecords ||
      this.retainedBytes > this.maxBytes
    )
  }

  /** Newest records within bounds, by cursor descending, returned ascending. */
  private selectRetained(
    cursors: readonly HostCursor[],
    records: ReadonlyMap<HostCursor, HostDeltaStoredRecord>
  ): { cursors: HostCursor[]; map: Map<HostCursor, HostDeltaStoredRecord>; bytes: number } {
    let bytes = 0
    const retained: HostCursor[] = []
    for (const cursor of [...cursors].sort((a, b) => b - a)) {
      const record = records.get(cursor)
      if (!record) continue
      if (retained.length >= this.maxRecords) break
      if (bytes + record.retainedBytes > this.maxBytes && retained.length > 0) break
      retained.push(cursor)
      bytes += record.retainedBytes
    }
    retained.sort((a, b) => a - b)
    const map = new Map<HostCursor, HostDeltaStoredRecord>()
    let mapBytes = 0
    for (const cursor of retained) {
      const record = records.get(cursor)
      if (!record) continue
      map.set(cursor, record)
      mapBytes += record.retainedBytes
    }
    // After compaction, if lowest retained is above 1 and clients may be behind,
    // since() will correctly return retention_gap.
    return { cursors: retained, map, bytes: mapBytes }
  }

  private checkpointDocument(
    generation: HostGeneration,
    cursor: HostCursor,
    retained: { cursors: HostCursor[]; map: Map<HostCursor, HostDeltaStoredRecord> },
    groups: readonly HostDeltaGroupEntry[],
    sealedThrough?: string
  ): CheckpointDocument {
    return {
      schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
      updatedAt: this.now(),
      generation,
      cursor,
      lowestRetainedCursor: retained.cursors[0] ?? 0,
      records: retained.cursors
        .map((c) => retained.map.get(c))
        .filter((r): r is HostDeltaStoredRecord => Boolean(r))
        .map(cloneRecord),
      // Legacy stores never hold a group, so their checkpoint bytes are unchanged.
      ...(groups.length > 0 ? { groups: groups.map((group) => ({ ...group })) } : {}),
      ...(sealedThrough !== undefined ? { sealedThrough } : {})
    }
  }

  /** False when it deferred to a background compaction in flight. */
  private writeCheckpointAndResetJournal(): boolean {
    if (this.compactionInFlight) {
      this.log('[HostDeltaStore] inline compaction deferred: a background compaction is in flight')
      return false
    }
    const retained = this.selectRetained(this.orderedCursors, this.recordsByCursor)
    const sealed = this.listSealedSegments()
    const lastSealed = sealed[sealed.length - 1]?.sequence
    if (lastSealed !== undefined && BigInt(lastSealed) > this.sealedSequenceFloor) {
      this.sealedSequenceFloor = BigInt(lastSealed)
    }
    const doc = this.checkpointDocument(
      this.generation,
      this.cursor,
      retained,
      [...this.groupsByCommand.values()],
      this.sealedSequenceFloor > 0n
        ? this.sealedSequenceFloor.toString().padStart(20, '0')
        : undefined
    )

    mkdirSync(this.dataDir, { recursive: true })
    const tmpPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      writeFileSync(tmpPath, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 })
      descriptor = openSync(tmpPath, 'r+')
      fsyncSync(descriptor)
      const descriptorToClose = descriptor
      descriptor = null
      closeSync(descriptorToClose)
      renameSync(tmpPath, this.checkpointPath)
      if (process.platform !== 'win32') this.syncDataDirectory()
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // Preserve the original checkpoint failure if descriptor cleanup fails.
        }
      }
      try {
        unlinkSync(tmpPath)
      } catch {
        // Cleanup is best-effort, including when rename already consumed the temp.
      }
      throw error
    }

    try {
      if (existsSync(this.journalPath)) {
        unlinkSync(this.journalPath)
      }
      // A failed background compaction can leave sealed segments; this
      // checkpoint covers everything they hold.
      for (const segment of sealed) unlinkSync(segment.path)
    } catch (err) {
      this.log(
        `[HostDeltaStore] journal reset failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return true
    }
    this.recordsByCursor = retained.map
    this.orderedCursors = retained.cursors
    this.retainedBytes = retained.bytes
    this.lowestRetainedCursor = retained.cursors[0] ?? 0
    this.journalRecordCount = 0
    return true
  }

  /**
   * Compaction off the append path (M4 §1: rotation under the lock,
   * checkpoint outside it). Only durable bytes rotate, so a sealed segment
   * never holds anything a later reset retracts. A skipped compaction costs
   * only a later one; there is no retry loop.
   */
  async compactInBackground(): Promise<HostDeltaCompactionResult> {
    if (this.failStop) return { kind: 'skipped', reason: 'fail-stopped' }
    if (this.compactionInFlight) return { kind: 'skipped', reason: 'in-flight' }
    this.compactionInFlight = true
    let tmpPath: string | null = null
    try {
      if (!this.everythingDurable()) {
        const durable = await this.awaitDurable()
        if (durable.kind === 'fail-stopped' || this.failStop) {
          return { kind: 'skipped', reason: 'fail-stopped' }
        }
        if (durable.kind !== 'durable' || !this.everythingDurable()) {
          return { kind: 'skipped', reason: 'not-durable' }
        }
      }

      // Rotation: synchronous and cheap, so no append interleaves with it.
      const sequence = this.nextSealedSequence()
      if (existsSync(this.journalPath)) {
        renameSync(this.journalPath, join(this.dataDir, sealedSegmentName(sequence)))
      }
      this.journalRecordCount = 0
      const generation = this.generation
      const cursor = this.cursor
      const cursors = [...this.orderedCursors]
      const records = new Map(this.recordsByCursor)
      const groups = [...this.groupsByCommand.values()].map((group) => ({ ...group }))
      await this.onCompactionStage?.('rotated')

      const retained = this.selectRetained(cursors, records)
      const doc = this.checkpointDocument(generation, cursor, retained, groups, sequence)
      mkdirSync(this.dataDir, { recursive: true })
      tmpPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`
      await this.checkpointWrite(tmpPath, `${JSON.stringify(doc)}\n`)
      await this.onCompactionStage?.('checkpoint-written')
      await renameAsync(tmpPath, this.checkpointPath)
      tmpPath = null
      // Also makes the rotation's rename durable.
      if (process.platform !== 'win32') await this.groupFsync(this.dataDir)
      await this.onCompactionStage?.('checkpoint-renamed')

      let sealedRemoved = 0
      for (const segment of this.listSealedSegments()) {
        if (segment.sequence > sequence) continue
        await unlinkAsync(segment.path)
        sealedRemoved += 1
      }

      if (generation === this.generation) {
        const kept = new Set(retained.cursors)
        const cut = cursors.filter((c) => !kept.has(c))
        for (const c of cut) {
          const record = this.recordsByCursor.get(c)
          if (!record) continue
          this.retainedBytes -= record.retainedBytes
          this.recordsByCursor.delete(c)
        }
        const cutSet = new Set(cut)
        this.orderedCursors = this.orderedCursors.filter((c) => !cutSet.has(c))
        this.recomputeLowest()
      }
      return { kind: 'compacted', checkpointCursor: cursor, sealedRemoved }
    } catch (error) {
      if (tmpPath !== null) {
        await unlinkAsync(tmpPath).catch(() => {})
      }
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    } finally {
      this.compactionInFlight = false
    }
  }

  private maybeCompactInBackground(): void {
    if (this.compactionInFlight || this.failStop || !this.compactionDue()) return
    void this.compactInBackground().then((result) => {
      if (result.kind === 'failed') {
        try {
          this.log(`[HostDeltaStore] background compaction failed: ${result.detail}`)
        } catch {
          // Diagnostics cannot fail a compaction that kept every sealed byte.
        }
      }
    })
  }

  /** Sealed segments, oldest first. */
  private listSealedSegments(): Array<{ sequence: string; path: string }> {
    let names: string[]
    try {
      names = readdirSync(this.dataDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
    return names
      .map((name) => ({ name, match: HOST_DELTA_SEALED_SEGMENT_PATTERN.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .map(({ name, match }) => ({ sequence: match[1]!, path: join(this.dataDir, name) }))
      .sort((left, right) => (left.sequence < right.sequence ? -1 : 1))
  }

  private nextSealedSequence(): string {
    const segments = this.listSealedSegments()
    const last = segments[segments.length - 1]?.sequence
    const highest =
      last && BigInt(last) > this.sealedSequenceFloor ? BigInt(last) : this.sealedSequenceFloor
    this.sealedSequenceFloor = highest + 1n
    return this.sealedSequenceFloor.toString().padStart(20, '0')
  }

  private appendJournalEvents(events: readonly JournalEvent[]): void {
    const write = this.appendJournalBatch(events)
    if (!write.ok) {
      if (!write.rolledBack) this.appendAuthorityBlocked = true
      throw write.error
    }
  }

  private appendJournalBatch(
    events: readonly JournalEvent[],
    options: { fsync: boolean } = { fsync: true }
  ):
    | { ok: true; created: boolean }
    | { ok: false; error: unknown; detail: string; rolledBack: boolean } {
    if (events.length === 0) return { ok: true, created: false }
    mkdirSync(this.dataDir, { recursive: true })
    const existed = existsSync(this.journalPath)
    let descriptor: number | null = null
    let previousLength: number | null = null
    try {
      descriptor = openSync(this.journalPath, 'a+', 0o600)
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new Error('Host delta journal length is invalid')
      }
      previousLength = stat.size
      const bytes = Buffer.from(
        events.map((event) => `${serializeJournalEvent(event)}\n`).join(''),
        'utf8'
      )
      let written = 0
      while (written < bytes.length) {
        const count = this.batchWrite(descriptor, bytes, written, bytes.length - written)
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error('Host delta batch journal write made no progress')
        }
        written += count
      }
      if (options.fsync) {
        this.batchFsync(descriptor)
        // A pending group may have created the journal: this fsync settles
        // that group too, so its name must be durable before it does.
        const owesDirectory = this.journalCreatedAtSeq > this.dirSyncedSeq
        if ((!existed || owesDirectory) && process.platform !== 'win32') {
          this.syncDataDirectory()
        }
        this.dirSyncedSeq = this.writeSeq
      }
      this.journalRecordCount += events.length
      return { ok: true, created: !existed }
    } catch (error) {
      let rolledBack = descriptor === null
      if (descriptor !== null && previousLength !== null) {
        // libuv opens O_APPEND handles with FILE_APPEND_DATA and without
        // FILE_WRITE_DATA, so truncating the 'a+' descriptor is refused on
        // Windows (EPERM) and every short write would report an uncertain
        // rollback. Roll back through a separate read/write descriptor.
        let rollbackDescriptor: number | null = null
        try {
          rollbackDescriptor = openSync(this.journalPath, 'r+')
          this.batchTruncate(rollbackDescriptor, previousLength)
          this.batchFsync(rollbackDescriptor)
          if (!existed && process.platform !== 'win32') this.syncDataDirectory()
          rolledBack = true
        } catch {
          rolledBack = false
        } finally {
          if (rollbackDescriptor !== null) {
            try {
              closeSync(rollbackDescriptor)
            } catch {
              // The truncate/fsync above already decided the rollback verdict.
            }
          }
        }
      }
      return {
        ok: false,
        error,
        detail: error instanceof Error ? error.message : String(error),
        rolledBack
      }
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          // The write/fsync or rollback boundary above decides authority.
        }
      }
    }
  }

  private syncDataDirectory(): void {
    const descriptor = openSync(this.dataDir, 'r')
    try {
      fsyncSync(descriptor)
    } catch (error) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the directory-sync failure when descriptor cleanup also fails.
      }
      throw error
    }
    closeSync(descriptor)
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
    let raw: string
    try {
      raw = readFileSync(this.checkpointPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
    // After compaction, the journal may contain only records after this cursor.
    // An unusable checkpoint cannot be treated as an empty initial store.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Native JSON parse errors can include a preview of private checkpoint bytes.
      throw new Error('Host delta checkpoint malformed JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Host delta checkpoint malformed (not an object)')
    }
    const doc = parsed as Partial<CheckpointDocument>
    if (doc.schemaVersion !== HOST_DELTA_STORE_SCHEMA_VERSION) {
      throw new Error('Host delta checkpoint schema mismatch')
    }
    if (
      !isNonNegativeInt(doc.generation) ||
      doc.generation < 1 ||
      !isNonNegativeInt(doc.cursor) ||
      !isNonNegativeInt(doc.lowestRetainedCursor) ||
      doc.lowestRetainedCursor > doc.cursor ||
      !Array.isArray(doc.records)
    ) {
      throw new Error('Host delta checkpoint fields invalid')
    }
    // The trusted header owns the acknowledged head. Retained rows are a
    // projection cache and may belong to an earlier protocol/projection version.
    // Keep only an unambiguous continuous suffix that reaches that exact head.
    const candidates = doc.records
      .map(normalizeStoredRecord)
      .filter(
        (record): record is HostDeltaStoredRecord =>
          record !== null &&
          record.envelope.generation === doc.generation &&
          record.envelope.cursor <= doc.cursor!
      )
      .sort((left, right) => left.envelope.cursor - right.envelope.cursor)
    const records: HostDeltaStoredRecord[] = []
    let nextCursor = doc.cursor
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const record = candidates[index]!
      if (record.envelope.cursor !== nextCursor) break
      if (index > 0 && candidates[index - 1]!.envelope.cursor === nextCursor) break
      records.push(record)
      nextCursor -= 1
    }
    records.reverse()
    const lowestRetainedCursor = records[0]?.envelope.cursor ?? 0
    if (
      records.length !== doc.records.length ||
      lowestRetainedCursor !== doc.lowestRetainedCursor ||
      (doc.cursor > 0 && records.length === 0)
    ) {
      this.noteRecovery(
        'degraded-checkpoint',
        'checkpoint retention degraded; acknowledged head preserved, missing deltas require resnapshot'
      )
    }
    // Group anchors outlive their records: D3 completes at `end` even after
    // retention trimmed the group's rows.
    const rawGroups: unknown[] = Array.isArray(doc.groups) ? doc.groups : []
    const groups = rawGroups
      .map((group) => normalizeGroupAnchor(group, doc.cursor!))
      .filter((group): group is HostDeltaGroupEntry => group !== null)
    if (groups.length !== rawGroups.length) {
      this.noteRecovery('degraded-checkpoint', 'checkpoint dropped invalid group anchor(s)')
    }
    return {
      schemaVersion: HOST_DELTA_STORE_SCHEMA_VERSION,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : this.now(),
      generation: doc.generation,
      cursor: doc.cursor,
      lowestRetainedCursor,
      records,
      ...(groups.length > 0 ? { groups } : {}),
      ...(typeof doc.sealedThrough === 'string' && /^\d{20}$/.test(doc.sealedThrough)
        ? { sealedThrough: doc.sealedThrough }
        : {})
    }
  }

  private readJournal(path: string): {
    events: JournalEvent[]
    truncatedTail: boolean
    corruptInterior: boolean
  } {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { events: [], truncatedTail: false, corruptInterior: false }
      }
      throw err
    }

    const events: JournalEvent[] = []
    let truncatedTail = false
    let corruptInterior = false
    let legacyResetWithoutEnvelope = false
    let repairLength: number | null = null
    let offset = 0
    let pendingReset: {
      event: Extract<JournalEvent, { op: 'generation-reset' }>
      offset: number
    } | null = null
    const lines = source.split('\n')
    const endsWithNewline = source.endsWith('\n')
    const lastContentIndex = endsWithNewline ? lines.length - 2 : lines.length - 1

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const lineOffset = offset
      offset += Buffer.byteLength(line, 'utf8') + 1
      if (!line) continue
      if (index === lastContentIndex && !endsWithNewline) {
        truncatedTail = true
        repairLength = pendingReset?.offset ?? lineOffset
        break
      }
      try {
        const event = parseJournalEvent(line)
        if (pendingReset) {
          // Current writes pair the fence with a reset envelope. Older stores
          // could recover a lone fence and then acknowledge ordinary records
          // in that generation; a following complete line preserves its fence.
          if (
            event?.op === 'append' &&
            event.record.envelope.kind === 'generation-reset' &&
            event.record.envelope.generation === pendingReset.event.generation &&
            event.record.envelope.cursor === 1 &&
            event.record.envelope.previousCursor === 0
          ) {
            events.push(pendingReset.event, event)
            pendingReset = null
            continue
          }
          events.push(pendingReset.event)
          legacyResetWithoutEnvelope = true
          corruptInterior = true
          pendingReset = null
        }
        if (event?.op === 'generation-reset') {
          pendingReset = { event, offset: lineOffset }
        } else if (event) {
          events.push(event)
        } else {
          corruptInterior = true
        }
      } catch {
        if (pendingReset) {
          events.push(pendingReset.event)
          legacyResetWithoutEnvelope = true
        }
        pendingReset = null
        corruptInterior = true
        this.log(`[HostDeltaStore] skipped corrupt journal line at index ${index}`)
      }
    }
    if (pendingReset) {
      truncatedTail = true
      repairLength = pendingReset.offset
    }
    if (legacyResetWithoutEnvelope) {
      this.noteRecovery(
        'recovered-corrupt-interior',
        'preserved legacy generation reset without its reset envelope'
      )
    }
    if (repairLength !== null) {
      // Leaving a discarded suffix on disk would concatenate it with the next
      // append and acknowledge a record that cannot be recovered. Reopen keeps
      // authority blocked if this repair cannot be made durable.
      const descriptor = openSync(path, 'r+')
      try {
        this.batchTruncate(descriptor, repairLength)
        this.batchFsync(descriptor)
      } finally {
        closeSync(descriptor)
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
    // Caller must run prepareHostDeltaPayload before persistence paths.
    envelope.payload = parts.payload
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
    return HOST_DELTA_MAX_PAYLOAD_BYTES
  }
}

/**
 * Fail-closed payload preparation for durable Host deltas.
 * Rejects forbidden structured key paths; oversized safe payloads keep only
 * length + digest metadata (never a raw prefix/preview).
 */
export function prepareHostDeltaPayload(payload: unknown): HostDeltaPayloadPrepareResult {
  const forbiddenPath = findForbiddenPayloadKey(payload)
  if (forbiddenPath) {
    return {
      ok: false,
      code: HOST_DELTA_FORBIDDEN_PAYLOAD_CODE,
      detail: `forbidden payload key path: ${forbiddenPath}`
    }
  }

  let json: string
  try {
    const serialized = JSON.stringify(payload)
    if (serialized === undefined) {
      return { ok: true, payload: null }
    }
    json = serialized
  } catch {
    return {
      ok: false,
      code: HOST_DELTA_FORBIDDEN_PAYLOAD_CODE,
      detail: 'unserializable payload'
    }
  }

  if (Buffer.byteLength(json, 'utf8') <= HOST_DELTA_MAX_PAYLOAD_BYTES) {
    return { ok: true, payload }
  }

  return {
    ok: true,
    payload: {
      _truncated: true,
      byteLength: Buffer.byteLength(json, 'utf8'),
      sha256: createHash('sha256').update(json, 'utf8').digest('hex')
    }
  }
}

function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/**
 * `HostUsageObservation.tokens` is a bounded numeric meter, not credential
 * material. Keep the generic `tokens` deny-wall everywhere else and admit the
 * field only when its complete containing object is the closed wire shape.
 */
function isBoundedHostUsageObservation(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((key) => !HOST_USAGE_PAYLOAD_KEYS.has(key))) return false
  if (typeof value.availability !== 'string' || !HOST_USAGE_AVAILABILITY.has(value.availability)) {
    return false
  }
  if (
    typeof value.tokens !== 'number' ||
    !Number.isFinite(value.tokens) ||
    value.tokens < 0 ||
    value.availability === 'unavailable'
  ) {
    return false
  }
  if (
    value.costText !== undefined &&
    (typeof value.costText !== 'string' || value.costText.length > 200)
  ) {
    return false
  }
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== 'string' || !HOST_USAGE_CONFIDENCE.has(value.confidence))
  ) {
    return false
  }
  return (
    value.band === undefined || (typeof value.band === 'string' && HOST_USAGE_BAND.has(value.band))
  )
}

function findForbiddenPayloadKey(value: unknown, path: string[] = []): string | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenPayloadKey(value[i], [...path, String(i)])
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      const normalizedKey = normalizePayloadKey(key)
      if (
        FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey) &&
        !(normalizedKey === 'tokens' && isBoundedHostUsageObservation(record))
      ) {
        return [...path, key].join('.')
      }
      const hit = findForbiddenPayloadKey(child, [...path, key])
      if (hit) return hit
    }
  }
  return null
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
  if (value.op === 'group') return parseGroupEvent(value)
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

/**
 * A group line is applied only whole: its count, its digest recomputed over
 * its own records, and every record's `txn` naming this command at its index.
 * The `txn` stamp is journal metadata and is dropped here.
 */
function parseGroupEvent(value: Record<string, unknown>): JournalEvent | null {
  const { generation, head, commandId, count, setDigest, records } = value
  if (
    !isNonNegativeInt(generation) ||
    generation < 1 ||
    !isNonNegativeInt(head) ||
    typeof commandId !== 'string' ||
    commandId.length === 0 ||
    commandId.length > MAX_ENTITY_ID ||
    !isNonNegativeInt(count) ||
    typeof setDigest !== 'string' ||
    !Array.isArray(records) ||
    records.length !== count
  ) {
    return null
  }
  const normalized: HostDeltaStoredRecord[] = []
  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index] as { txn?: unknown } | null
    const txn = raw && typeof raw === 'object' ? (raw.txn as Record<string, unknown>) : null
    if (!txn || txn.commandId !== commandId || txn.index !== index) return null
    const record = normalizeStoredRecord(raw)
    if (!record || record.envelope.generation !== generation) return null
    if (record.envelope.cursor !== head + index + 1) return null
    normalized.push(record)
  }
  if (
    hostDeltaGroupSetDigest(normalized.map((record) => record.contentFingerprint)) !== setDigest
  ) {
    return null
  }
  return { op: 'group', generation, head, commandId, count, setDigest, records: normalized }
}

function serializeJournalEvent(event: JournalEvent): string {
  if (event.op !== 'group') return JSON.stringify(event)
  return JSON.stringify({
    ...event,
    records: event.records.map((record, index) => ({
      ...record,
      txn: { commandId: event.commandId, index }
    }))
  })
}

/** SHA-256 hex over a group's record fingerprints, in cursor order. */
export function hostDeltaGroupSetDigest(fingerprints: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(fingerprints), 'utf8').digest('hex')
}

function normalizeGroupAnchor(value: unknown, cursor: HostCursor): HostDeltaGroupEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { commandId, count, setDigest, start, end } = value as Record<string, unknown>
  if (
    typeof commandId !== 'string' ||
    commandId.length === 0 ||
    commandId.length > MAX_ENTITY_ID ||
    !isNonNegativeInt(count) ||
    typeof setDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(setDigest) ||
    !isNonNegativeInt(start) ||
    !isNonNegativeInt(end) ||
    start > end ||
    end > cursor
  ) {
    return null
  }
  return { commandId, count, setDigest, start, end }
}

function sealedSegmentName(sequence: string): string {
  return `host-deltas.journal.${sequence}.sealed.jsonl`
}

async function writeAndFsyncFile(path: string, data: string): Promise<void> {
  await writeFileAsync(path, data, { encoding: 'utf8', mode: 0o600 })
  await fsyncPath(path)
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await openAsync(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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
