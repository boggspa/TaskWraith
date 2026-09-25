/**
 * Durable Host command receipt + idempotency store (Host Arc Wave 2A/2B).
 *
 * Crash-safe bounded journal + checkpoint under an injected data directory.
 * Receipts reopen across simulated Host restart. Interrupted pending commands
 * surface as explicit recoverable/indeterminate state and are never blindly
 * re-executed. Exact command repeats return the original receipt only when the
 * caller actor matches; cross-actor exact replay and lookup never expose the
 * original receipt body. The same idempotency key with a different canonical
 * command fingerprint produces a durable conflict receipt for the attempted
 * commandId without stealing the original idempotency-key mapping. Occupied
 * commandId mismatches conflict immediately with no second durable row.
 * Terminal statuses include cancelled.
 *
 * New receipts persist HostCommandName, exact HostActorIdentity, and
 * generation/cursor sourced only through an injected HostDeltaStore position
 * callback. Legacy rows missing identity/position/name are retained on disk
 * but fail closed for actor-bound access and wire projection (no invent /
 * reassign). Records retain target + authority for Host-internal use without
 * credentials, unrestricted arguments/tool output, or hidden reasoning.
 *
 * Durable-before-witness: every mutator appends and fsyncs its journal event
 * before the in-memory index or any returned receipt reflects it. A failed
 * append is rolled back (truncate + fsync on the same journal); an unproven
 * rollback blocks this instance's write authority until a fresh instance
 * reopens from repaired disk state. Reads of already-durable receipts stay
 * available while writes are blocked.
 *
 * Not wired to BridgeActionExecutor or control server yet.
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
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

import {
  decodeHostResultRef,
  HOST_QUEUED_START_PHASES,
  type HostClientClass,
  type HostCommandName,
  type HostQueuedStartPhase,
  type HostResultRef
} from '../shared/hostProtocol'
import type { WorkSpanRecorder } from '../host-shared/perf/WorkSpanRecorder'
import type { HostCommandExecutionClass } from './HostCommandExecutionClass'

export const HOST_COMMAND_RECEIPT_SCHEMA_VERSION = 1 as const
export const HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME = 'command-receipts.checkpoint.json'
export const HOST_COMMAND_RECEIPT_JOURNAL_FILENAME = 'command-receipts.journal.jsonl'

/** Default bound on retained receipts after compaction. */
export const DEFAULT_HOST_COMMAND_RECEIPT_MAX_RECORDS = 2000

/** Default journal record count before compaction is attempted. */
export const DEFAULT_HOST_COMMAND_RECEIPT_COMPACT_AFTER_RECORDS = 256

const MAX_ID_CHARS = 200
const MAX_REASON_CHARS = 500
const MAX_SUMMARY_CHARS = 500
const MAX_ERROR_CHARS = 500
const MAX_KIND_CHARS = 80

/**
 * Fixed non-grant authority on durable conflict receipts. Callers may have
 * supplied `allowed`; the conflict path never persists a grant.
 */
const CONFLICT_RECEIPT_AUTHORITY: HostCommandReceiptAuthority = {
  decision: 'denied',
  reason: 'idempotency_key_command_mismatch'
}

export type HostCommandReceiptStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'indeterminate'
  | 'conflict'

export type HostCommandAuthorityDecision = 'allowed' | 'denied' | 'deferred'

export type HostCommandReceiptClientClass = HostClientClass

/**
 * Exact actor identity for new receipts — mirrors wire HostActorIdentity.
 * Legacy rows may lack actorId/clientClass; those fail closed for access /
 * projection rather than inventing identity.
 */
export interface HostCommandReceiptActor {
  clientId: string
  actorId?: string
  clientClass?: HostCommandReceiptClientClass
}

/** Compact command target identity — no unrestricted paths or payloads. */
export interface HostCommandReceiptTarget {
  kind: string
  id?: string
}

/** Authority evaluation retained on the receipt. */
export interface HostCommandReceiptAuthority {
  decision: HostCommandAuthorityDecision
  reason?: string
  policy?: string
}

export type HostCommandReceiptPosition = {
  generation: number
  cursor: number
}

/** Host-internal fsynced execution-claim position; never projected to clients. */
export interface HostCommandReceiptExecutionClaimCursor {
  coverageEpoch: string
  sequence: number
}

/**
 * Durable receipt record. `commandFingerprint` is a caller-supplied digest of
 * the canonical command (type + target + bounded arg digest). Raw args, tool
 * output, and hidden reasoning must never be stored here.
 *
 * `commandName`, `generation`, and `cursor` are required on newly minted
 * receipts. Legacy rows may omit them; access and projection fail closed
 * without inventing or reassigning those fields.
 */
export interface HostCommandReceiptRecord {
  schemaVersion: typeof HOST_COMMAND_RECEIPT_SCHEMA_VERSION
  commandId: string
  idempotencyKey: string
  commandFingerprint: string
  status: HostCommandReceiptStatus
  /**
   * Optional queued-start lifecycle phase. Separate from status: phase-only
   * updates are pending-only and never certify command completion.
   */
  phase?: HostQueuedStartPhase
  /** Host-internal claim evidence anchor. Never projected onto the wire receipt. */
  executionClaimCursor?: HostCommandReceiptExecutionClaimCursor
  actor: HostCommandReceiptActor
  target: HostCommandReceiptTarget
  authority: HostCommandReceiptAuthority
  createdAt: string
  updatedAt: string
  /** Wire HostCommandName — required on new receipts; absent on incomplete legacy. */
  commandName?: HostCommandName
  /** Delta-store generation at mint — required on new receipts. */
  generation?: number
  /** Delta-store cursor at mint — required on new receipts. */
  cursor?: number
  completedAt?: string
  errorCode?: string
  errorMessage?: string
  resultSummary?: string
  /** Strict opaque setup result locator, retained across Host restart. */
  resultRef?: HostResultRef
  /**
   * When status is `conflict`: commandId of the original receipt that owns the
   * idempotency key. Never raw args/tool output.
   */
  conflictCommandId?: string
  /** Set when a pending receipt was reopened after Host crash/restart. */
  recoveryState?: 'recoverable-indeterminate'
  /**
   * The execution class `begin` recorded (M4 §1 decision 1). Host-internal:
   * the wire projection never carries it. Absent on unclassified receipts.
   */
  commandClass?: HostCommandExecutionClass
}

export type HostCommandReceiptBeginInput = {
  commandId: string
  idempotencyKey: string
  /** Wire command name persisted for reconnect-safe receipt projection. */
  commandName: HostCommandName
  /** SHA-256 hex (or other stable digest) of the canonical command. */
  commandFingerprint: string
  /** Exact actor identity (actorId + clientId + clientClass required). */
  actor: HostCommandReceiptActor
  target: HostCommandReceiptTarget
  authority: HostCommandReceiptAuthority
  createdAt?: string
  /** Recorded durably with the receipt; `txn-record-persist` stays pending on reopen. */
  commandClass?: HostCommandExecutionClass
}

export type HostCommandReceiptTerminalStatus = 'succeeded' | 'failed' | 'denied' | 'cancelled'

export type HostCommandReceiptCompleteInput = {
  commandId: string
  status: HostCommandReceiptTerminalStatus
  completedAt?: string
  errorCode?: string
  errorMessage?: string
  resultSummary?: string
  /** Accepted only with a successful terminal receipt. */
  resultRef?: HostResultRef
  /** Optional authority update at completion (e.g. final deny reason). */
  authority?: HostCommandReceiptAuthority
  /**
   * Optional refreshed sole-journal position. When present, it is validated
   * before any terminal receipt mutation and persisted with the completion.
   */
  position?: HostCommandReceiptPosition
}

/**
 * Closed body-free vocabulary for explicit markIndeterminate promotion.
 * Arbitrary prose/secret-shaped text is never persisted as an errorCode.
 */
export type HostCommandReceiptIndeterminateCode =
  | 'deferred_envelope_unavailable'
  | 'deferred_envelope_missing'
  | 'deferred_envelope_actor_mismatch'
  | 'deferred_envelope_verification_failed'
  | 'deferred_effects_partial'
  | 'deferred_effects_unavailable'
  | 'deferred_receipt_uncertain'
  | 'deferred_execution_may_have_begun'
  | 'observation_after_snapshot_capture_failed'
  | 'observation_after_snapshot_decode_failed'
  | 'observation_after_snapshot_privacy_failed'
  | 'observation_after_projection_truncated'
  | 'observation_diff_decode_failed'
  | 'observation_diff_privacy_failed'
  | 'observation_diff_generation_mismatch'
  | 'observation_diff_cursor_mismatch'
  | 'observation_diff_incoherent'
  /** The M4 manifest recovery's `indeterminate` action on a pending receipt. */
  | 'transaction_recovery_indeterminate'
  /** A live M4 transaction that could not tell whether, or could not publish what, it committed. */
  | 'transaction_commit_indeterminate'

/** Runtime membership set for HostCommandReceiptIndeterminateCode. */
export const HOST_COMMAND_RECEIPT_INDETERMINATE_CODES: ReadonlySet<HostCommandReceiptIndeterminateCode> =
  new Set<HostCommandReceiptIndeterminateCode>([
    'deferred_envelope_unavailable',
    'deferred_envelope_missing',
    'deferred_envelope_actor_mismatch',
    'deferred_envelope_verification_failed',
    'deferred_effects_partial',
    'deferred_effects_unavailable',
    'deferred_receipt_uncertain',
    'deferred_execution_may_have_begun',
    'observation_after_snapshot_capture_failed',
    'observation_after_snapshot_decode_failed',
    'observation_after_snapshot_privacy_failed',
    'observation_after_projection_truncated',
    'observation_diff_decode_failed',
    'observation_diff_privacy_failed',
    'observation_diff_generation_mismatch',
    'observation_diff_cursor_mismatch',
    'observation_diff_incoherent',
    'transaction_recovery_indeterminate',
    'transaction_commit_indeterminate'
  ])

/**
 * Body-free input for explicit pending → recoverable-indeterminate promotion.
 * Callers supply only identity, sole-journal position, and a closed static
 * recovery/error code — never command args, tool output, or hidden reasoning.
 */
export type HostCommandReceiptMarkIndeterminateInput = {
  commandId: string
  /** Required sole-journal position; validated before any mutation. */
  position: HostCommandReceiptPosition
  /** Closed static recovery/error code from HostCommandReceiptIndeterminateCode. */
  errorCode: HostCommandReceiptIndeterminateCode
  /** Optional clock override; defaults to the store clock. */
  updatedAt?: string
}

/**
 * Body-free result for markIndeterminate. Never returns unrestricted command
 * bodies; success paths return only the compact durable receipt record.
 */
export type HostCommandReceiptMarkIndeterminateResult =
  | { kind: 'marked'; receipt: HostCommandReceiptRecord }
  | { kind: 'already_indeterminate'; receipt: HostCommandReceiptRecord }
  | { kind: 'not_found' }
  | {
      kind: 'terminal_refused'
      status: Exclude<HostCommandReceiptStatus, 'pending' | 'indeterminate'>
    }
  | {
      kind: 'invalid'
      code: 'invalid_command_id' | 'invalid_position' | 'invalid_error_code'
    }

export type HostCommandReceiptBeginResult =
  | { kind: 'created'; receipt: HostCommandReceiptRecord }
  | { kind: 'existing'; receipt: HostCommandReceiptRecord }
  /**
   * Exact fingerprint match exists but caller actor does not match the owner.
   * Never includes the original receipt body.
   */
  | { kind: 'actor_denied' }
  /**
   * Protected anchors (pending + indeterminate) already consume maxRecords.
   * Refused before any index or journal mutation. Exact command/idempotency
   * replay remains available at capacity. A new idempotency conflict is
   * admitted only when its owner and durable conflict receipt can both fit.
   * Body-free — never exposes receipt/actor/target/body.
   */
  | { kind: 'capacity_refused' }
  | {
      kind: 'conflict'
      reason: 'idempotency_key_command_mismatch' | 'command_id_mismatch'
      /**
       * Original receipt — only included when the caller actor matches the
       * owner. Cross-actor conflicts omit this to avoid body exposure.
       */
      existing?: HostCommandReceiptRecord
      requestedFingerprint: string
      /**
       * Durable conflict receipt for a NEW commandId that collided on an
       * existing idempotency key. Absent when the conflict is an occupied
       * commandId (no second durable row written).
       */
      receipt?: HostCommandReceiptRecord
    }

export type HostCommandReceiptPhaseUpdateResult =
  | { kind: 'updated'; receipt: HostCommandReceiptRecord }
  | { kind: 'unchanged'; receipt: HostCommandReceiptRecord }
  | { kind: 'not_found' }
  | {
      kind: 'status_refused'
      status: Exclude<HostCommandReceiptStatus, 'pending'>
    }
  | {
      kind: 'regression_refused'
      currentPhase: HostQueuedStartPhase
      requestedPhase: HostQueuedStartPhase
    }
  | {
      kind: 'invalid'
      code:
        | 'invalid_command_id'
        | 'invalid_phase'
        | 'invalid_execution_claim_cursor'
        | 'execution_claim_cursor_conflict'
    }

/** Actor-bound receipt lookup — never returns another actor's receipt body. */
export type HostCommandReceiptLookupResult =
  | { kind: 'found'; receipt: HostCommandReceiptRecord }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }
  /** Legacy/incomplete identity or position — retained but not safely accessible. */
  | { kind: 'incomplete' }

/**
 * Whether this store instance may still append durable journal events.
 * `unavailable` preserves the last durable in-memory view and refuses writes
 * or adoption of further disk evidence. Recovery requires a fresh instance.
 */
export type HostCommandReceiptDurabilityStatus =
  | { kind: 'ok' }
  | {
      kind: 'unavailable'
      code: 'journal_append_uncertain' | 'reopen_failed' | 'checkpoint_unreadable'
    }

export interface HostCommandReceiptStoreOptions {
  /** Injected Host data directory. Required — no Electron app path lookup. */
  dataDir: string
  /**
   * Sole position source for newly minted receipts. Must read HostDeltaStore
   * (typically via HostRuntimeBootstrap.getPosition). Never invents a second
   * generation/cursor journal.
   */
  getPosition: () => HostCommandReceiptPosition
  maxRecords?: number
  compactAfterRecords?: number
  now?: () => string
  log?: (line: string) => void
  /** Optional M1 receipt_delivery sink. Absence is safe. */
  spans?: WorkSpanRecorder
  /** Millisecond clock for receipt_delivery durations; defaults to Date.now. */
  nowMs?: () => number
  /**
   * Optional lookup for §1.1 control actions whose receipt target is not a
   * thread (`approval.decide`, `question.answer`). Called at begin, while the
   * pending card still exists. Absence skips those kinds. Must not throw.
   */
  resolveSpanChatId?: (record: HostCommandReceiptRecord) => string | undefined
  /**
   * Runs a compaction `complete()` found due, on a later turn, off the
   * command's commit path (M4 slice 9). Defaults to `setImmediate`.
   */
  scheduleCompaction?: (run: () => void) => void
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_COMMAND_RECEIPT_SCHEMA_VERSION
  updatedAt: string
  /** Last durable journal sequence this checkpoint covers; absent on legacy files. */
  journalSeq?: number
  records: HostCommandReceiptRecord[]
}

type JournalEvent =
  | { op: 'upsert'; record: HostCommandReceiptRecord; seq?: number }
  | { op: 'compact'; retainedCommandIds: string[]; at: string; seq?: number }

type HostCommandReceiptRetentionPin = {
  ownerCommandId: string
  conflictCommandId: string
}

export class HostCommandReceiptStore {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly maxRecords: number
  private readonly compactAfterRecords: number
  private readonly getPosition: () => HostCommandReceiptPosition
  private readonly now: () => string
  private readonly log: (line: string) => void
  private readonly spans?: WorkSpanRecorder
  private readonly nowMs: () => number
  private readonly resolveSpanChatId?: (record: HostCommandReceiptRecord) => string | undefined
  private readonly scheduleCompaction: (run: () => void) => void
  private compactionScheduled = false
  /** chatId resolved at begin (approval/question lookup is only valid then). */
  private readonly spanChatIds = new Map<string, string>()

  private recordsByCommandId = new Map<string, HostCommandReceiptRecord>()
  private commandIdByIdempotencyKey = new Map<string, string>()
  private journalRecordCount = 0
  /** Monotonic durable journal sequence; the checkpoint records the last one it covers. */
  private journalSeq = 0
  private durability: HostCommandReceiptDurabilityStatus = { kind: 'ok' }

  constructor(options: HostCommandReceiptStoreOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostCommandReceiptStore requires an injected dataDir')
    }
    if (typeof options.getPosition !== 'function') {
      throw new Error(
        'HostCommandReceiptStore requires an injected getPosition callback (HostDeltaStore sole journal)'
      )
    }
    this.dataDir = options.dataDir
    this.checkpointPath = join(this.dataDir, HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME)
    this.journalPath = join(this.dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_HOST_COMMAND_RECEIPT_MAX_RECORDS)
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_HOST_COMMAND_RECEIPT_COMPACT_AFTER_RECORDS
    )
    this.getPosition = options.getPosition
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = (message) => {
      try {
        options.log?.(message)
      } catch {
        // Diagnostics must not change recovery authority or a committed result.
      }
    }
    this.spans = options.spans
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.resolveSpanChatId = options.resolveSpanChatId
    this.scheduleCompaction =
      options.scheduleCompaction ??
      ((run) => {
        setImmediate(run)
      })
    this.reopen()
  }

  private spanChatIdFor(record: HostCommandReceiptRecord): string | undefined {
    if (record.target.kind === 'thread') {
      const id = record.target.id
      return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined
    }
    if (record.target.kind !== 'approval' && record.target.kind !== 'question') return undefined
    if (!record.target.id || !this.resolveSpanChatId) return undefined
    let resolved: string | undefined
    try {
      resolved = this.resolveSpanChatId(record)
    } catch {
      return undefined
    }
    return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : undefined
  }

  /**
   * In-memory begin-time span chatId cache size. Diagnostic only — not durable
   * and not part of the receipt schema. Retention pin for M1 A1.22.
   */
  get spanChatIdCacheSize(): number {
    return this.spanChatIds.size
  }

  private rememberSpanChatId(record: HostCommandReceiptRecord): void {
    // Desktop HostMainComposition constructs the receipt store without a
    // recorder; remembering there would grow forever on every persist.
    if (this.spans === undefined) return
    // Thread targets recompute from record.target.id at complete. Only
    // approval/question need the begin-time lookup (pending card is gone later).
    if (record.target.kind !== 'approval' && record.target.kind !== 'question') return
    const chatId = this.spanChatIdFor(record)
    if (chatId) this.spanChatIds.set(record.commandId, chatId)
  }

  private forgetSpanChatId(commandId: string): void {
    this.spanChatIds.delete(commandId)
  }

  private recordReceiptDelivery(record: HostCommandReceiptRecord, startedAt: number): void {
    const chatId = this.spanChatIds.get(record.commandId) ?? this.spanChatIdFor(record)
    this.forgetSpanChatId(record.commandId)
    if (this.spans === undefined) return
    if (chatId === undefined) return
    try {
      this.spans.record({
        chatId,
        runId: record.commandId,
        kind: 'receipt_delivery',
        resource: 'host_chain',
        startedAt,
        durationMs: Math.max(0, this.nowMs() - startedAt)
      })
    } catch {
      // Instrumentation must never alter a receipt result.
    }
  }

  /**
   * Re-read checkpoint + journal from disk. Any still-pending receipt is marked
   * indeterminate (recoverable) so callers never re-execute blindly.
   *
   * Recovery is built privately and swapped in only after it succeeds, so a
   * failed reopen leaves the prior durable view readable while write authority
   * is blocked. A blocked instance keeps that view without touching disk;
   * only a fresh instance can recover and sync new evidence before exposing it.
   */
  reopen(): void {
    if (this.durability.kind !== 'ok') return
    try {
      this.reopenFromDisk()
    } catch (error) {
      if (this.durability.kind === 'ok') {
        this.durability = { kind: 'unavailable', code: 'reopen_failed' }
      }
      throw error
    }
  }

  private reopenFromDisk(): void {
    const records = new Map<string, HostCommandReceiptRecord>()
    const idempotencyOwners = new Map<string, string>()
    const index = (record: HostCommandReceiptRecord): void => {
      records.set(record.commandId, record)
      if (record.status !== 'conflict') {
        idempotencyOwners.set(record.idempotencyKey, record.commandId)
      }
    }

    const checkpoint = this.readCheckpoint()
    if (checkpoint === 'unreadable') {
      // A checkpoint that exists but cannot be read as a document is not an
      // empty store. Replaying the journal over unknown retained state, or
      // accepting new writes, would invent history: fail closed for writes.
      // Keep any already-durable in-memory reads on a failed same-instance reopen.
      this.durability = { kind: 'unavailable', code: 'checkpoint_unreadable' }
      return
    }
    for (const record of checkpoint?.records ?? []) {
      index(record)
    }

    // Journal events the durable checkpoint already covers must not replay
    // over it: a checkpoint can be durable while retiring the old journal
    // failed, and replaying would resurrect evicted rows. A sequenced checkpoint
    // also covers the legacy prefix present at upgrade, including journalSeq=0.
    // Downgrading the writer after upgrade is unsupported; readJournal rejects
    // unsequenced rows after a sequenced row instead of guessing their coverage.
    const checkpointSeq = checkpoint?.journalSeq
    let journalSeq = checkpointSeq ?? 0
    let journalRecordCount = 0
    let retired = 0
    const journalEvents = this.readJournal()
    for (const event of journalEvents ?? []) {
      journalRecordCount += 1
      if (checkpointSeq !== undefined && (event.seq === undefined || event.seq <= checkpointSeq)) {
        retired += 1
        continue
      }
      if (event.seq !== undefined) journalSeq = event.seq
      if (event.op === 'upsert') {
        index(event.record)
      } else if (event.op === 'compact') {
        const retain = new Set(event.retainedCommandIds)
        for (const commandId of [...records.keys()]) {
          if (!retain.has(commandId)) {
            const existing = records.get(commandId)
            if (existing) {
              // Delete the idempotency mapping only when it currently maps to
              // this removed non-conflict owner. Evicting a conflict must not
              // erase a live owner's key.
              if (
                existing.status !== 'conflict' &&
                idempotencyOwners.get(existing.idempotencyKey) === commandId
              ) {
                idempotencyOwners.delete(existing.idempotencyKey)
              }
              records.delete(commandId)
            }
          }
        }
      }
    }
    if (retired > 0) {
      this.log(
        `[HostCommandReceiptStore] skipped ${retired} journal event(s) already covered by the checkpoint`
      )
    }

    // Recovery must fail before pending -> indeterminate promotion mutates the
    // journal. A lowered bound cannot partially rewrite durable evidence and
    // then throw from compaction.
    if (countProtectedAnchorsIn(records) > this.maxRecords) {
      throw new Error(
        'HostCommandReceiptStore: protected anchors exceed maxRecords during recovery'
      )
    }

    // Readable bytes may survive a killed process or a failed append sync.
    // Validate and sync every recovered file, then its directory entry, before
    // any terminal row becomes visible. A failed barrier leaves prior maps intact.
    if (checkpoint !== null) this.syncRecoveredFile(this.checkpointPath)
    if (journalEvents !== null) this.syncRecoveredFile(this.journalPath)
    if ((checkpoint !== null || journalEvents !== null) && process.platform !== 'win32') {
      this.syncDataDirectory()
    }

    // Host restart while a command was in-flight: surface indeterminate recovery
    // state. Do not auto-succeed, auto-fail, or re-run. Each promotion is
    // durable before it is indexed.
    const promotions: HostCommandReceiptRecord[] = []
    for (const [, record] of records) {
      // A transactional receipt is the manifest recovery's to decide (M4
      // R1-M1): promoting it here would hide D1, D3 and D4 behind a
      // recoverable indeterminate before that recovery runs.
      if (record.status === 'pending' && record.commandClass !== 'txn-record-persist') {
        promotions.push({
          ...record,
          status: 'indeterminate',
          recoveryState: 'recoverable-indeterminate',
          updatedAt: this.now()
        })
      }
    }
    for (const promoted of promotions) {
      const seq = journalSeq + 1
      this.writeJournalEvent({ op: 'upsert', seq, record: promoted })
      journalSeq = seq
      journalRecordCount += 1
      index(promoted)
    }

    this.recordsByCommandId = records
    this.commandIdByIdempotencyKey = idempotencyOwners
    this.spanChatIds.clear()
    this.journalRecordCount = journalRecordCount
    this.journalSeq = journalSeq
    if (promotions.length > 0) {
      this.maybeCompact()
    }
  }

  /**
   * Actor-bound lookup by commandId. Cross-actor and incomplete-identity rows
   * never return the receipt body.
   */
  getByCommandId(
    commandId: string,
    actor: HostCommandReceiptActor
  ): HostCommandReceiptLookupResult {
    const id = normalizeId(commandId, 'commandId')
    const record = this.recordsByCommandId.get(id)
    if (!record) return { kind: 'not_found' }
    return gateRecordForActor(record, actor)
  }

  /**
   * Actor-bound lookup by idempotency key. Cross-actor and incomplete-identity
   * rows never return the receipt body. Conflict rows never own the key index.
   */
  getByIdempotencyKey(
    idempotencyKey: string,
    actor: HostCommandReceiptActor
  ): HostCommandReceiptLookupResult {
    const key = normalizeId(idempotencyKey, 'idempotencyKey')
    const commandId = this.commandIdByIdempotencyKey.get(key)
    if (!commandId) return { kind: 'not_found' }
    return this.getByCommandId(commandId, actor)
  }

  /**
   * Host-internal listing for recovery summaries. Not a client access path —
   * does not apply actor gating.
   */
  list(): HostCommandReceiptRecord[] {
    return [...this.recordsByCommandId.values()]
      .map(cloneRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Persist a monotonic queued-start phase on an existing pending receipt.
   * This is storage/projection foundation only: it does not establish the
   * lifecycle witness or complete the command.
   */
  updatePhase(
    commandIdInput: string,
    phaseInput: HostQueuedStartPhase,
    executionClaimCursorInput?: HostCommandReceiptExecutionClaimCursor
  ): HostCommandReceiptPhaseUpdateResult {
    let commandId: string
    try {
      commandId = normalizeId(commandIdInput, 'commandId')
    } catch {
      return { kind: 'invalid', code: 'invalid_command_id' }
    }

    let phase: HostQueuedStartPhase
    try {
      phase = normalizeQueuedStartPhase(phaseInput)
    } catch {
      return { kind: 'invalid', code: 'invalid_phase' }
    }

    let executionClaimCursor: HostCommandReceiptExecutionClaimCursor | undefined
    if (executionClaimCursorInput !== undefined) {
      try {
        executionClaimCursor = normalizeExecutionClaimCursor(executionClaimCursorInput)
      } catch {
        return { kind: 'invalid', code: 'invalid_execution_claim_cursor' }
      }
    }

    const current = this.recordsByCommandId.get(commandId)
    if (!current) return { kind: 'not_found' }
    if (current.status !== 'pending') {
      return { kind: 'status_refused', status: current.status }
    }
    if (executionClaimCursor !== undefined && phase !== 'starting') {
      return { kind: 'invalid', code: 'invalid_execution_claim_cursor' }
    }
    if (
      current.executionClaimCursor &&
      executionClaimCursor &&
      (current.executionClaimCursor.coverageEpoch !== executionClaimCursor.coverageEpoch ||
        current.executionClaimCursor.sequence !== executionClaimCursor.sequence)
    ) {
      return { kind: 'invalid', code: 'execution_claim_cursor_conflict' }
    }
    const cursorChanges =
      executionClaimCursor !== undefined && current.executionClaimCursor === undefined
    if (current.phase === phase && !cursorChanges) {
      return { kind: 'unchanged', receipt: cloneRecord(current) }
    }
    if (
      current.phase !== undefined &&
      queuedStartPhaseRank(phase) < queuedStartPhaseRank(current.phase)
    ) {
      return {
        kind: 'regression_refused',
        currentPhase: current.phase,
        requestedPhase: phase
      }
    }

    const next: HostCommandReceiptRecord = {
      ...current,
      phase,
      ...(executionClaimCursor ? { executionClaimCursor } : {}),
      updatedAt: this.now()
    }
    // Phase is non-terminal evidence and must never stamp completion.
    delete next.completedAt

    this.appendJournalEvent({ op: 'upsert', record: next })
    this.indexRecord(next)
    this.maybeCompact()
    return { kind: 'updated', receipt: cloneRecord(next) }
  }

  /**
   * Begin (or look up) a command receipt.
   * - Exact same commandId + fingerprint + idempotencyKey + matching actor:
   *   returns the original receipt.
   * - Exact match with a different actor: actor_denied (no body).
   * - Same idempotencyKey with a different fingerprint and a NEW commandId:
   *   durable conflict receipt for the attempt; original remains sole
   *   idempotency-key owner. Original body only returned when actors match.
   * - Same commandId with mismatched identity fields: immediate conflict,
   *   no second durable row (occupied id cannot be overwritten).
   */
  begin(input: HostCommandReceiptBeginInput): HostCommandReceiptBeginResult {
    const commandId = normalizeId(input.commandId, 'commandId')
    const idempotencyKey = normalizeId(input.idempotencyKey, 'idempotencyKey')
    const commandFingerprint = normalizeFingerprint(input.commandFingerprint)
    const commandName = normalizeCommandName(input.commandName)
    const actor = normalizeExactActor(input.actor)
    const commandClass =
      input.commandClass === undefined ? undefined : normalizeCommandClass(input.commandClass)
    const position = normalizePosition(this.getPosition())

    const byId = this.recordsByCommandId.get(commandId)
    if (byId) {
      if (
        byId.commandFingerprint === commandFingerprint &&
        byId.idempotencyKey === idempotencyKey
      ) {
        if (!isProjectableRecord(byId) || !actorsMatchExact(byId.actor, actor)) {
          // Exact replay requires matching exact actor; never expose body.
          return { kind: 'actor_denied' }
        }
        return { kind: 'existing', receipt: cloneRecord(byId) }
      }
      // Occupied commandId: never overwrite; no second durable row.
      const conflict: HostCommandReceiptBeginResult = {
        kind: 'conflict',
        reason: 'command_id_mismatch',
        requestedFingerprint: commandFingerprint
      }
      if (isProjectableRecord(byId) && actorsMatchExact(byId.actor, actor)) {
        conflict.existing = cloneRecord(byId)
      }
      return conflict
    }

    const existingCommandId = this.commandIdByIdempotencyKey.get(idempotencyKey)
    if (existingCommandId) {
      const existing = this.recordsByCommandId.get(existingCommandId)
      if (existing) {
        if (existing.commandFingerprint === commandFingerprint) {
          if (!isProjectableRecord(existing) || !actorsMatchExact(existing.actor, actor)) {
            return { kind: 'actor_denied' }
          }
          return { kind: 'existing', receipt: cloneRecord(existing) }
        }

        // A returned conflict receipt is a reconnect-safe durable result. If
        // protected anchors plus its owner and the new conflict cannot all fit,
        // refuse before indexing or appending instead of returning a receipt
        // that inline compaction would immediately erase.
        if (!this.canRetainDurableConflict(existing.commandId)) {
          return { kind: 'capacity_refused' }
        }

        // Distinct commandId + same key + different fingerprint → durable conflict.
        // Conflicts always persist fixed non-grant authority (denied), even when
        // the caller supplied allowed/deferred — never grant via conflict path.
        const createdAt = input.createdAt ?? this.now()
        const conflictRecord: HostCommandReceiptRecord = {
          schemaVersion: HOST_COMMAND_RECEIPT_SCHEMA_VERSION,
          commandId,
          idempotencyKey,
          commandFingerprint,
          commandName,
          status: 'conflict',
          actor,
          target: normalizeTarget(input.target),
          authority: CONFLICT_RECEIPT_AUTHORITY,
          generation: position.generation,
          cursor: position.cursor,
          createdAt,
          updatedAt: createdAt,
          completedAt: createdAt,
          conflictCommandId: existing.commandId,
          errorCode: 'idempotency_key_command_mismatch'
        }

        this.appendJournalEvent({ op: 'upsert', record: conflictRecord })
        this.indexRecord(conflictRecord)
        this.maybeCompact({
          ownerCommandId: existing.commandId,
          conflictCommandId: conflictRecord.commandId
        })
        const conflict: HostCommandReceiptBeginResult = {
          kind: 'conflict',
          reason: 'idempotency_key_command_mismatch',
          requestedFingerprint: commandFingerprint,
          receipt: cloneRecord(conflictRecord)
        }
        if (isProjectableRecord(existing) && actorsMatchExact(existing.actor, actor)) {
          conflict.existing = cloneRecord(existing)
        }
        return conflict
      }
    }

    // Refuse new distinct commands when protected anchors already consume
    // maxRecords. Exact replay and occupied-commandId paths above remain
    // available at capacity. Refuse before any index or journal mutation.
    if (this.countProtectedAnchors() >= this.maxRecords) {
      return { kind: 'capacity_refused' }
    }

    const createdAt = input.createdAt ?? this.now()
    const record: HostCommandReceiptRecord = {
      schemaVersion: HOST_COMMAND_RECEIPT_SCHEMA_VERSION,
      commandId,
      idempotencyKey,
      commandFingerprint,
      commandName,
      status: 'pending',
      actor,
      target: normalizeTarget(input.target),
      authority: normalizeAuthority(input.authority),
      generation: position.generation,
      cursor: position.cursor,
      createdAt,
      updatedAt: createdAt,
      ...(commandClass !== undefined ? { commandClass } : {})
    }

    this.appendJournalEvent({ op: 'upsert', record })
    this.indexRecord(record)
    this.maybeCompact()
    this.rememberSpanChatId(record)
    return { kind: 'created', receipt: cloneRecord(record) }
  }

  /**
   * Complete a pending or indeterminate receipt. Terminal statuses (including
   * cancelled) are idempotent when the same terminal status is re-applied.
   * Conflict receipts are terminal and cannot be completed further.
   */
  complete(input: HostCommandReceiptCompleteInput): HostCommandReceiptRecord | null {
    const commandId = normalizeId(input.commandId, 'commandId')
    const current = this.recordsByCommandId.get(commandId)
    if (!current) {
      this.forgetSpanChatId(commandId)
      return null
    }
    // Normalize once before any terminal check or mutation. An invalid
    // post-effect position must fail closed without writing a journal event.
    const position = input.position === undefined ? undefined : normalizePosition(input.position)

    if (
      current.status === 'succeeded' ||
      current.status === 'failed' ||
      current.status === 'denied' ||
      current.status === 'cancelled' ||
      current.status === 'conflict'
    ) {
      if (current.status === input.status) {
        this.forgetSpanChatId(commandId)
        return cloneRecord(current)
      }
      this.forgetSpanChatId(commandId)
      throw new Error(
        `HostCommandReceiptStore: receipt ${commandId} is already terminal (${current.status})`
      )
    }

    let startedAt: number | undefined
    try {
      startedAt = this.nowMs()
    } catch {
      startedAt = undefined
    }
    const completedAt = input.completedAt ?? this.now()
    const resultRef =
      input.status === 'succeeded' && input.resultRef !== undefined
        ? normalizeResultRef(input.resultRef)
        : undefined
    const next: HostCommandReceiptRecord = {
      ...current,
      status: input.status,
      updatedAt: completedAt,
      completedAt,
      ...(input.authority ? { authority: normalizeAuthority(input.authority) } : {}),
      ...(input.errorCode !== undefined
        ? { errorCode: truncateText(input.errorCode, MAX_KIND_CHARS) }
        : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: truncateText(input.errorMessage, MAX_ERROR_CHARS) }
        : {}),
      ...(input.resultSummary !== undefined
        ? { resultSummary: truncateText(input.resultSummary, MAX_SUMMARY_CHARS) }
        : {}),
      ...(resultRef !== undefined ? { resultRef } : {}),
      ...(position !== undefined
        ? { generation: position.generation, cursor: position.cursor }
        : {})
    }
    delete next.recoveryState

    try {
      this.appendJournalEvent({ op: 'upsert', record: next })
      this.indexRecord(next)
      // Compaction is housekeeping: never on the command's commit path.
      this.scheduleCompactionIfDue()
      if (startedAt !== undefined) this.recordReceiptDelivery(next, startedAt)
      return cloneRecord(next)
    } finally {
      // Journal/compaction throw must not leak the begin-time cache (Kimi A1.22 residual).
      this.forgetSpanChatId(commandId)
    }
  }

  /**
   * Explicit body-free promotion of a pending receipt to recoverable
   * indeterminate. Refreshes generation/cursor from a validated sole-journal
   * position. Does not set completedAt and never executes the command.
   *
   * - pending → indeterminate with recoveryState + errorCode (mutates once)
   * - already indeterminate → idempotent, no rewrite
   * - succeeded/failed/denied/cancelled/conflict → terminal_refused, no write
   * - invalid commandId/position/errorCode → invalid, no write
   * - missing commandId → not_found, no write
   *
   * Later complete() may still resolve recoverable indeterminate as before.
   */
  markIndeterminate(
    input: HostCommandReceiptMarkIndeterminateInput
  ): HostCommandReceiptMarkIndeterminateResult {
    // Normalize all inputs before any lookup or mutation so invalid fields
    // fail closed with zero journal writes.
    let commandId: string
    try {
      commandId = normalizeId(input.commandId, 'commandId')
    } catch {
      return { kind: 'invalid', code: 'invalid_command_id' }
    }

    let position: HostCommandReceiptPosition
    try {
      position = normalizePosition(input.position)
    } catch {
      return { kind: 'invalid', code: 'invalid_position' }
    }

    let errorCode: HostCommandReceiptIndeterminateCode
    try {
      errorCode = normalizeIndeterminateErrorCode(input.errorCode)
    } catch {
      return { kind: 'invalid', code: 'invalid_error_code' }
    }

    const current = this.recordsByCommandId.get(commandId)
    if (!current) return { kind: 'not_found' }

    if (current.status === 'indeterminate') {
      // Idempotent: do not rewrite generation/cursor/errorCode/updatedAt.
      return { kind: 'already_indeterminate', receipt: cloneRecord(current) }
    }

    if (
      current.status === 'succeeded' ||
      current.status === 'failed' ||
      current.status === 'denied' ||
      current.status === 'cancelled' ||
      current.status === 'conflict'
    ) {
      return { kind: 'terminal_refused', status: current.status }
    }

    // Only pending reaches here (status union is exhaustive above).
    const updatedAt =
      typeof input.updatedAt === 'string' && input.updatedAt.trim()
        ? truncateText(input.updatedAt, MAX_ID_CHARS)
        : this.now()

    const next: HostCommandReceiptRecord = {
      ...current,
      status: 'indeterminate',
      recoveryState: 'recoverable-indeterminate',
      generation: position.generation,
      cursor: position.cursor,
      errorCode,
      updatedAt
    }
    // Explicit indeterminate is non-terminal: never stamp completedAt.
    delete next.completedAt

    this.appendJournalEvent({ op: 'upsert', record: next })
    this.indexRecord(next)
    this.maybeCompact()
    return { kind: 'marked', receipt: cloneRecord(next) }
  }

  /**
   * Force compaction of journal into checkpoint, enforcing maxRecords. Unlike
   * inline compaction after a durable append, an explicit compact reports its
   * failure to the caller.
   */
  compact(): void {
    this.writeCheckpointAndResetJournal()
  }

  get size(): number {
    return this.recordsByCommandId.size
  }

  /**
   * Whether this instance may still append durable journal events. Reads of
   * already-durable receipts remain available while unavailable.
   */
  get durabilityStatus(): HostCommandReceiptDurabilityStatus {
    return { ...this.durability }
  }

  private assertWritable(): void {
    if (this.durability.kind === 'ok') return
    throw new Error(
      `HostCommandReceiptStore: durable journal state is uncertain (${this.durability.code}); reopen a fresh store instance`
    )
  }

  /**
   * Exactly-once anchors (NH-2). One leaves only when `complete()` makes its
   * receipt terminal: for a transactional command, the live persist or the
   * M4 recovery driver acting on the manifest. An indeterminate receipt the
   * manifest records as final stays an anchor. The ceiling is `maxRecords`,
   * past which `begin` answers `capacity_refused`.
   */
  getAnchorCounts(): { pending: number; indeterminate: number; transactionalPending: number } {
    let pending = 0
    let indeterminate = 0
    let transactionalPending = 0
    for (const [, record] of this.recordsByCommandId) {
      if (record.status === 'pending') {
        pending += 1
        if (record.commandClass === 'txn-record-persist') transactionalPending += 1
      } else if (record.status === 'indeterminate') {
        indeterminate += 1
      }
    }
    return { pending, indeterminate, transactionalPending }
  }

  private countProtectedAnchors(): number {
    return countProtectedAnchorsIn(this.recordsByCommandId)
  }

  private scheduleCompactionIfDue(): void {
    if (this.compactionScheduled) return
    if (
      this.journalRecordCount < this.compactAfterRecords &&
      this.recordsByCommandId.size <= this.maxRecords
    ) {
      return
    }
    this.compactionScheduled = true
    this.scheduleCompaction(() => {
      this.compactionScheduled = false
      // Due again by now? maybeCompact re-checks, and logs a failure.
      if (this.durability.kind === 'ok') this.maybeCompact()
    })
  }

  private canRetainDurableConflict(ownerCommandId: string): boolean {
    const requiredCommandIds = new Set<string>()
    for (const [, record] of this.recordsByCommandId) {
      if (record.status === 'pending' || record.status === 'indeterminate') {
        requiredCommandIds.add(record.commandId)
      }
    }
    requiredCommandIds.add(ownerCommandId)
    // The new conflict has a distinct commandId (occupied ids were handled
    // before this path), so it requires one additional retention slot.
    return requiredCommandIds.size + 1 <= this.maxRecords
  }

  private indexRecord(record: HostCommandReceiptRecord): void {
    this.recordsByCommandId.set(record.commandId, record)
    // Conflict receipts never claim or steal the idempotency-key mapping.
    // The original non-conflict receipt remains the sole getByIdempotencyKey owner.
    if (record.status !== 'conflict') {
      this.commandIdByIdempotencyKey.set(record.idempotencyKey, record.commandId)
    }
  }

  /**
   * Inline compaction runs only after the triggering event is durable. It is
   * housekeeping: a failure is logged and retried on the next durable event,
   * and never undoes or hides the witness that was just committed.
   */
  private maybeCompact(retentionPin?: HostCommandReceiptRetentionPin): void {
    const due =
      this.journalRecordCount >= this.compactAfterRecords ||
      this.recordsByCommandId.size > this.maxRecords
    if (!due) return
    try {
      this.writeCheckpointAndResetJournal(retentionPin)
    } catch (err) {
      this.log(
        `[HostCommandReceiptStore] deferred compaction after durable append: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Bounded retention that prefers non-conflict idempotency owners over
   * conflicts. A retained conflict never outlives its conflictCommandId owner.
   * The creating begin call may pin an admitted owner/conflict pair; later
   * ordinary compaction may evict the conflict when both no longer fit.
   * Never exceeds the configured bound.
   */
  private selectRecordsForRetention(
    all: HostCommandReceiptRecord[],
    retentionPin?: HostCommandReceiptRetentionPin
  ): HostCommandReceiptRecord[] {
    if (all.length <= this.maxRecords) {
      return all
    }

    const sorted = [...all].sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
      if (byUpdated !== 0) return byUpdated
      return b.createdAt.localeCompare(a.createdAt)
    })

    const selected = new Map<string, HostCommandReceiptRecord>()

    // Phase 1: retain ALL protected exactly-once anchors (pending/indeterminate)
    // first, regardless of recency. Terminal receipts and conflicts must never
    // displace these anchors.
    for (const record of sorted) {
      if (record.status !== 'pending' && record.status !== 'indeterminate') continue
      selected.set(record.commandId, record)
    }

    // During the begin call that durably creates a conflict, retain that exact
    // conflict and its owner together ahead of ordinary terminal rows. The
    // admission preflight guarantees these pins do not displace anchors or
    // exceed maxRecords. Later unrelated compaction uses ordinary retention.
    if (retentionPin) {
      const owner = all.find((record) => record.commandId === retentionPin.ownerCommandId)
      const conflict = all.find(
        (record) =>
          record.commandId === retentionPin.conflictCommandId &&
          record.status === 'conflict' &&
          record.conflictCommandId === retentionPin.ownerCommandId
      )
      if (owner && conflict) {
        selected.set(owner.commandId, owner)
        selected.set(conflict.commandId, conflict)
      }
    }

    // Phase 2: retain non-conflict terminal owners newest-first within
    // remaining capacity (after protected anchors).
    for (const record of sorted) {
      if (record.status === 'pending' || record.status === 'indeterminate') continue
      if (record.status === 'conflict') continue
      if (selected.has(record.commandId)) continue
      if (selected.size >= this.maxRecords) break
      selected.set(record.commandId, record)
    }

    // Phase 3: fill any remaining slots with conflicts whose owners are
    // retained. Never retain a conflict without its conflictCommandId owner.
    if (selected.size < this.maxRecords) {
      for (const record of sorted) {
        if (record.status !== 'conflict') continue
        if (selected.has(record.commandId)) continue
        const ownerId = record.conflictCommandId
        if (!ownerId || !selected.has(ownerId)) continue
        if (selected.size >= this.maxRecords) break
        selected.set(record.commandId, record)
      }
    }

    return [...selected.values()]
  }

  private writeCheckpointAndResetJournal(retentionPin?: HostCommandReceiptRetentionPin): void {
    this.assertWritable()
    const records = this.selectRecordsForRetention(
      [...this.recordsByCommandId.values()],
      retentionPin
    )

    // Fail closed: if protected anchors alone exceed maxRecords the retained
    // set will be larger than the configured bound.  Do not rewrite evidence
    // and do not return a silently compacted over-bound store.
    if (records.length > this.maxRecords) {
      throw new Error(
        `HostCommandReceiptStore: protected anchor count (${records.length}) exceeds maxRecords (${this.maxRecords}); refusing compaction to preserve on-disk evidence`
      )
    }

    const doc: CheckpointDocument = {
      schemaVersion: HOST_COMMAND_RECEIPT_SCHEMA_VERSION,
      updatedAt: this.now(),
      journalSeq: this.journalSeq,
      records: records.map(cloneRecord)
    }

    mkdirSync(this.dataDir, { recursive: true })
    const tmpPath = `${this.checkpointPath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      writeFileSync(tmpPath, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 })
      descriptor = openSync(tmpPath, 'r+')
      fsyncSync(descriptor)
      const closing = descriptor
      descriptor = null
      closeSync(closing)
      renameSync(tmpPath, this.checkpointPath)
    } catch (error) {
      if (descriptor !== null) {
        const closing = descriptor
        descriptor = null
        try {
          closeSync(closing)
        } catch {
          // Preserve the original write/fsync failure and never retry close.
        }
      }
      try {
        unlinkSync(tmpPath)
      } catch {
        // The temp file may never have been created; the live checkpoint is untouched.
      }
      throw error
    }
    // The rename is durable only once its directory entry is. Never retire the
    // journal, or switch memory to the retained set, before that witness.
    if (process.platform !== 'win32') this.syncDataDirectory()

    try {
      if (existsSync(this.journalPath)) {
        unlinkSync(this.journalPath)
      }
    } catch (err) {
      // The checkpoint is durable and records journalSeq, so reopen skips the
      // events it already covers. Keep memory and the journal count so the
      // next compaction retries retirement; memory never shrinks ahead of disk.
      this.log(
        `[HostCommandReceiptStore] journal retirement failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    this.recordsByCommandId = new Map()
    this.commandIdByIdempotencyKey = new Map()
    for (const record of records) {
      this.indexRecord(record)
    }
    this.journalRecordCount = 0
  }

  /** Durable append for mutators: assigns the next sequence and refuses while blocked. */
  private appendJournalEvent(event: JournalEvent): void {
    this.assertWritable()
    const seq = this.journalSeq + 1
    this.writeJournalEvent({ ...event, seq })
    this.journalSeq = seq
    this.journalRecordCount += 1
  }

  /**
   * Append one journal line and return only once it is durable. On failure the
   * partial write is rolled back on the same journal; an unproven rollback
   * leaves the tail uncertain and blocks this instance's write authority.
   */
  private writeJournalEvent(event: JournalEvent): void {
    const write = this.appendJournalLine(`${JSON.stringify(event)}\n`)
    if (!write.ok) {
      if (!write.rolledBack) {
        this.durability = { kind: 'unavailable', code: 'journal_append_uncertain' }
      }
      throw write.error
    }
  }

  private appendJournalLine(
    line: string
  ): { ok: true } | { ok: false; error: unknown; rolledBack: boolean } {
    mkdirSync(this.dataDir, { recursive: true })
    const existed = existsSync(this.journalPath)
    let descriptor: number | null = null
    let previousLength: number | null = null
    try {
      descriptor = openSync(this.journalPath, 'a+', 0o600)
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new Error('HostCommandReceiptStore: journal length is invalid')
      }
      previousLength = stat.size
      const bytes = Buffer.from(line, 'utf8')
      let written = 0
      while (written < bytes.length) {
        const count = writeSync(descriptor, bytes, written, bytes.length - written, null)
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error('HostCommandReceiptStore: journal write made no progress')
        }
        written += count
      }
      fsyncSync(descriptor)
      // A newly created journal is durable only once its directory entry is.
      if (!existed && process.platform !== 'win32') this.syncDataDirectory()
      return { ok: true }
    } catch (error) {
      let rolledBack = descriptor === null
      if (descriptor !== null && previousLength !== null) {
        // O_APPEND descriptors refuse truncation on Windows, so roll back through
        // a separate read/write descriptor on the same journal.
        let rollbackDescriptor: number | null = null
        try {
          rollbackDescriptor = openSync(this.journalPath, 'r+')
          ftruncateSync(rollbackDescriptor, previousLength)
          fsyncSync(rollbackDescriptor)
          if (!existed && process.platform !== 'win32') this.syncDataDirectory()
          rolledBack = true
        } catch {
          rolledBack = false
        } finally {
          if (rollbackDescriptor !== null) {
            const closing = rollbackDescriptor
            rollbackDescriptor = null
            try {
              closeSync(closing)
            } catch {
              // The truncate/fsync above already decided the rollback verdict.
            }
          }
        }
      }
      return { ok: false, error, rolledBack }
    } finally {
      if (descriptor !== null) {
        const closing = descriptor
        descriptor = null
        try {
          closeSync(closing)
        } catch {
          // The write/fsync or rollback boundary above decides authority.
        }
      }
    }
  }

  private syncRecoveredFile(path: string): void {
    let descriptor: number | null = openSync(path, 'r+')
    try {
      fsyncSync(descriptor)
      const closing = descriptor
      descriptor = null
      closeSync(closing)
    } finally {
      if (descriptor !== null) {
        const closing = descriptor
        descriptor = null
        try {
          closeSync(closing)
        } catch {
          // Preserve the sync failure; closing cannot establish durability.
        }
      }
    }
  }

  private syncDataDirectory(): void {
    let descriptor: number | null = openSync(this.dataDir, 'r')
    try {
      fsyncSync(descriptor)
      const closing = descriptor
      descriptor = null
      closeSync(closing)
    } finally {
      if (descriptor !== null) {
        const closing = descriptor
        descriptor = null
        try {
          closeSync(closing)
        } catch {
          // Preserve the fsync failure that prevented the directory witness.
        }
      }
    }
  }

  /**
   * `null` when no checkpoint exists. `'unreadable'` when one exists but is
   * not a checkpoint document — never silently an empty store. Read I/O
   * errors other than ENOENT propagate so reopen fails closed.
   */
  private readCheckpoint():
    | { records: HostCommandReceiptRecord[]; journalSeq?: number }
    | null
    | 'unreadable' {
    let raw: string
    try {
      raw = readFileSync(this.checkpointPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log('[HostCommandReceiptStore] checkpoint JSON malformed; write authority blocked')
      return 'unreadable'
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.log(
        '[HostCommandReceiptStore] checkpoint malformed (not an object); write authority blocked'
      )
      return 'unreadable'
    }
    const doc = parsed as Partial<CheckpointDocument>
    if (doc.schemaVersion !== HOST_COMMAND_RECEIPT_SCHEMA_VERSION || !Array.isArray(doc.records)) {
      this.log('[HostCommandReceiptStore] checkpoint schema mismatch; write authority blocked')
      return 'unreadable'
    }
    if (
      Object.prototype.hasOwnProperty.call(doc, 'journalSeq') &&
      (typeof doc.journalSeq !== 'number' ||
        !Number.isSafeInteger(doc.journalSeq) ||
        doc.journalSeq < 0)
    ) {
      this.log(
        '[HostCommandReceiptStore] checkpoint journal sequence invalid; write authority blocked'
      )
      return 'unreadable'
    }
    const records: HostCommandReceiptRecord[] = []
    for (const row of doc.records) {
      const record = normalizeStoredRecord(row)
      if (!record) {
        this.log('[HostCommandReceiptStore] checkpoint record malformed; write authority blocked')
        return 'unreadable'
      }
      records.push(record)
    }
    const journalSeq = doc.journalSeq
    return journalSeq === undefined ? { records } : { records, journalSeq }
  }

  /**
   * Read journal events. A final line without its newline never finished
   * landing, even when it happens to parse: it is discarded and durably
   * truncated so the next append cannot
   * concatenate it into an accepted record. Read I/O errors other than
   * ENOENT propagate so reopen fails closed instead of starting empty.
   */
  private readJournal(): JournalEvent[] | null {
    let source: string
    try {
      source = readFileSync(this.journalPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }

    const events: JournalEvent[] = []
    let previousSeq: number | undefined
    let repairLength: number | null = null
    let offset = 0
    const lines = source.split('\n')
    const endsWithNewline = source.endsWith('\n')
    const lastContentIndex = endsWithNewline ? lines.length - 2 : lines.length - 1

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const lineOffset = offset
      offset += Buffer.byteLength(line, 'utf8') + 1
      if (!line) continue
      if (index === lastContentIndex && !endsWithNewline) {
        repairLength = lineOffset
        this.log('[HostCommandReceiptStore] dropped truncated journal tail')
        break
      }
      let event: JournalEvent
      try {
        event = parseJournalEvent(line)
      } catch {
        // Parser errors can quote persisted payloads. Keep diagnostics content-free.
        throw new Error(`HostCommandReceiptStore: corrupt journal line at index ${index}`)
      }
      if (event.seq === undefined) {
        if (previousSeq !== undefined) {
          throw new Error(
            'HostCommandReceiptStore: unsequenced journal event after sequenced event'
          )
        }
      } else {
        if (previousSeq !== undefined && event.seq <= previousSeq) {
          throw new Error('HostCommandReceiptStore: nonmonotonic journal sequence')
        }
        previousSeq = event.seq
      }
      events.push(event)
    }

    if (repairLength !== null) {
      // Reopen fails closed if this repair cannot be made durable.
      let descriptor: number | null = openSync(this.journalPath, 'r+')
      try {
        ftruncateSync(descriptor, repairLength)
        fsyncSync(descriptor)
        const closing = descriptor
        descriptor = null
        closeSync(closing)
      } finally {
        if (descriptor !== null) {
          const closing = descriptor
          descriptor = null
          try {
            closeSync(closing)
          } catch {
            // Preserve the truncate/fsync failure; close cannot repair the tail.
          }
        }
      }
    }
    return events
  }
}

/** Stable SHA-256 fingerprint helper for callers building canonical digests. */
export function hostCommandFingerprint(parts: {
  type: string
  targetKind: string
  targetId?: string
  /** Pre-bounded arg digest (never raw unrestricted args). */
  argsDigest?: string
}): string {
  const canonical = JSON.stringify({
    type: parts.type,
    targetKind: parts.targetKind,
    targetId: parts.targetId ?? null,
    argsDigest: parts.argsDigest ?? null
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function cloneRecord(record: HostCommandReceiptRecord): HostCommandReceiptRecord {
  return JSON.parse(JSON.stringify(record)) as HostCommandReceiptRecord
}

/** Exhaustive by type: a new execution class fails to compile until listed. */
const COMMAND_CLASSES: Record<HostCommandExecutionClass, true> = {
  'txn-record-persist': true,
  'legacy-observed': true,
  control: true,
  'queued-start': true,
  setup: true
}

function isCommandClass(value: unknown): value is HostCommandExecutionClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_CLASSES, value)
}

function normalizeCommandClass(value: unknown): HostCommandExecutionClass {
  if (!isCommandClass(value)) {
    throw new Error('HostCommandReceiptStore: commandClass is not a known execution class')
  }
  return value
}

function countProtectedAnchorsIn(records: ReadonlyMap<string, HostCommandReceiptRecord>): number {
  let count = 0
  for (const [, record] of records) {
    if (record.status === 'pending' || record.status === 'indeterminate') {
      count += 1
    }
  }
  return count
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`HostCommandReceiptStore: ${field} is required`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_CHARS) {
    throw new Error(`HostCommandReceiptStore: ${field} is invalid`)
  }
  return trimmed
}

/** Exact SHA-256 hex acceptance: 64 lowercase [a-f0-9] characters. */
const COMMAND_FINGERPRINT_HEX_RE = /^[a-f0-9]{64}$/

function normalizeFingerprint(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('HostCommandReceiptStore: commandFingerprint is required')
  }
  const trimmed = value.trim().toLowerCase()
  if (!COMMAND_FINGERPRINT_HEX_RE.test(trimmed)) {
    throw new Error(
      'HostCommandReceiptStore: commandFingerprint must be a 64-char lowercase hex SHA-256 digest'
    )
  }
  return trimmed
}

function normalizeActor(actor: HostCommandReceiptActor): HostCommandReceiptActor {
  const clientId = normalizeId(actor.clientId, 'actor.clientId')
  const out: HostCommandReceiptActor = { clientId }
  if (actor.actorId) out.actorId = truncateText(actor.actorId, MAX_ID_CHARS)
  if (actor.clientClass && isClientClass(actor.clientClass)) {
    out.clientClass = actor.clientClass
  }
  return out
}

/** New receipts require exact HostActorIdentity (actorId + clientId + clientClass). */
function normalizeExactActor(actor: HostCommandReceiptActor): HostCommandReceiptActor {
  const clientId = normalizeId(actor.clientId, 'actor.clientId')
  if (typeof actor.actorId !== 'string' || !actor.actorId.trim()) {
    throw new Error('HostCommandReceiptStore: actor.actorId is required')
  }
  const actorId = truncateText(actor.actorId, MAX_ID_CHARS)
  if (!actorId) {
    throw new Error('HostCommandReceiptStore: actor.actorId is required')
  }
  if (!isClientClass(actor.clientClass)) {
    throw new Error('HostCommandReceiptStore: actor.clientClass is required')
  }
  return { clientId, actorId, clientClass: actor.clientClass }
}

function isClientClass(value: unknown): value is HostCommandReceiptClientClass {
  return value === 'desktop' || value === 'tui' || value === 'ios' || value === 'test'
}

const HOST_COMMAND_NAME_SET = new Set<string>([
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'thread.record.persist',
  'thread.record.delete',
  'channel.member.revoke',
  'channel.close',
  'thread.select',
  'workspace.record.upsert',
  'workspace.record.remove',
  'workspace.records.clear',
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel',
  'ping'
])

function normalizeCommandName(value: unknown): HostCommandName {
  if (typeof value !== 'string' || !HOST_COMMAND_NAME_SET.has(value)) {
    throw new Error('HostCommandReceiptStore: commandName is invalid')
  }
  return value as HostCommandName
}

function normalizePosition(value: HostCommandReceiptPosition): HostCommandReceiptPosition {
  if (
    typeof value?.generation !== 'number' ||
    !Number.isInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isFinite(value.generation)
  ) {
    throw new Error('HostCommandReceiptStore: getPosition().generation is invalid')
  }
  if (
    typeof value?.cursor !== 'number' ||
    !Number.isInteger(value.cursor) ||
    value.cursor < 0 ||
    !Number.isFinite(value.cursor)
  ) {
    throw new Error('HostCommandReceiptStore: getPosition().cursor is invalid')
  }
  return { generation: value.generation, cursor: value.cursor }
}

/**
 * Closed indeterminate errorCode — exact Set membership only.
 * Never trims/truncates arbitrary text into a valid code.
 */
function normalizeIndeterminateErrorCode(value: unknown): HostCommandReceiptIndeterminateCode {
  if (typeof value !== 'string') {
    throw new Error('HostCommandReceiptStore: errorCode is required')
  }
  if (!HOST_COMMAND_RECEIPT_INDETERMINATE_CODES.has(value as HostCommandReceiptIndeterminateCode)) {
    throw new Error('HostCommandReceiptStore: errorCode is invalid')
  }
  return value as HostCommandReceiptIndeterminateCode
}

/** Exact actor match — both sides must carry full identity; incomplete never matches. */
export function actorsMatchExact(
  stored: HostCommandReceiptActor,
  caller: HostCommandReceiptActor
): boolean {
  if (!isExactActor(stored) || !isExactActor(caller)) return false
  return (
    stored.clientId === caller.clientId &&
    stored.actorId === caller.actorId &&
    stored.clientClass === caller.clientClass
  )
}

export function isExactActor(
  actor: HostCommandReceiptActor
): actor is Required<HostCommandReceiptActor> {
  return (
    typeof actor.clientId === 'string' &&
    actor.clientId.length > 0 &&
    typeof actor.actorId === 'string' &&
    actor.actorId.length > 0 &&
    isClientClass(actor.clientClass)
  )
}

/** New receipts are projectable; legacy incomplete rows fail closed. */
export function isProjectableRecord(record: HostCommandReceiptRecord): boolean {
  if (!record.commandName || !HOST_COMMAND_NAME_SET.has(record.commandName)) return false
  if (
    typeof record.generation !== 'number' ||
    !Number.isInteger(record.generation) ||
    record.generation < 0
  ) {
    return false
  }
  if (typeof record.cursor !== 'number' || !Number.isInteger(record.cursor) || record.cursor < 0) {
    return false
  }
  return isExactActor(record.actor)
}

function gateRecordForActor(
  record: HostCommandReceiptRecord,
  actor: HostCommandReceiptActor
): HostCommandReceiptLookupResult {
  if (!isProjectableRecord(record)) {
    return { kind: 'incomplete' }
  }
  if (!isExactActor(actor) || !actorsMatchExact(record.actor, actor)) {
    return { kind: 'actor_mismatch' }
  }
  return { kind: 'found', receipt: cloneRecord(record) }
}

function normalizeTarget(target: HostCommandReceiptTarget): HostCommandReceiptTarget {
  const kind = truncateText(target.kind, MAX_KIND_CHARS)
  if (!kind) throw new Error('HostCommandReceiptStore: target.kind is required')
  const out: HostCommandReceiptTarget = { kind }
  if (target.id) out.id = truncateText(target.id, MAX_ID_CHARS)
  return out
}

function normalizeResultRef(value: unknown): HostResultRef {
  const decoded = decodeHostResultRef(value)
  if (!decoded.ok || decoded.value === undefined) {
    throw new Error('HostCommandReceiptStore: resultRef is invalid')
  }
  return decoded.value
}

function normalizeQueuedStartPhase(value: unknown): HostQueuedStartPhase {
  if (
    typeof value !== 'string' ||
    !(HOST_QUEUED_START_PHASES as readonly string[]).includes(value)
  ) {
    throw new Error('HostCommandReceiptStore: queued-start phase is invalid')
  }
  return value as HostQueuedStartPhase
}

function queuedStartPhaseRank(phase: HostQueuedStartPhase): number {
  return HOST_QUEUED_START_PHASES.indexOf(phase)
}

function normalizeExecutionClaimCursor(value: unknown): HostCommandReceiptExecutionClaimCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('HostCommandReceiptStore: execution-claim cursor is invalid')
  }
  const cursor = value as Record<string, unknown>
  if (
    typeof cursor.coverageEpoch !== 'string' ||
    !/^[0-9a-f]{64}$/.test(cursor.coverageEpoch) ||
    typeof cursor.sequence !== 'number' ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 1
  ) {
    throw new Error('HostCommandReceiptStore: execution-claim cursor is invalid')
  }
  return { coverageEpoch: cursor.coverageEpoch, sequence: cursor.sequence }
}

function normalizeAuthority(authority: HostCommandReceiptAuthority): HostCommandReceiptAuthority {
  const decision = authority.decision
  if (decision !== 'allowed' && decision !== 'denied' && decision !== 'deferred') {
    throw new Error('HostCommandReceiptStore: authority.decision is invalid')
  }
  const out: HostCommandReceiptAuthority = { decision }
  if (authority.reason) out.reason = truncateText(authority.reason, MAX_REASON_CHARS)
  if (authority.policy) out.policy = truncateText(authority.policy, MAX_KIND_CHARS)
  return out
}

function truncateText(value: string, max: number): string {
  const trimmed = String(value).trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}

function normalizeStoredRecord(value: unknown): HostCommandReceiptRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== HOST_COMMAND_RECEIPT_SCHEMA_VERSION) return null
  if (typeof raw.commandId !== 'string' || !raw.commandId) return null
  if (typeof raw.idempotencyKey !== 'string' || !raw.idempotencyKey) return null
  if (typeof raw.commandFingerprint !== 'string' || !raw.commandFingerprint) return null
  if (
    raw.status !== 'pending' &&
    raw.status !== 'succeeded' &&
    raw.status !== 'failed' &&
    raw.status !== 'denied' &&
    raw.status !== 'cancelled' &&
    raw.status !== 'indeterminate' &&
    raw.status !== 'conflict'
  ) {
    return null
  }
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null
  if (!raw.actor || typeof raw.actor !== 'object' || Array.isArray(raw.actor)) return null
  if (!raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) return null
  if (!raw.authority || typeof raw.authority !== 'object' || Array.isArray(raw.authority))
    return null

  try {
    // Legacy rows may lack exact actor/name/position — retain without inventing.
    // Map historical clientKind → clientClass only when the token is already a
    // valid HostClientClass; never invent a class for unknown kinds.
    const rawActor = raw.actor as Record<string, unknown>
    const actorInput: HostCommandReceiptActor = {
      clientId: typeof rawActor.clientId === 'string' ? rawActor.clientId : ''
    }
    if (typeof rawActor.actorId === 'string') actorInput.actorId = rawActor.actorId
    if (isClientClass(rawActor.clientClass)) {
      actorInput.clientClass = rawActor.clientClass
    } else if (isClientClass(rawActor.clientKind)) {
      actorInput.clientClass = rawActor.clientKind
    }
    const actor = normalizeActor(actorInput)
    const target = normalizeTarget(raw.target as HostCommandReceiptTarget)
    const authority = normalizeAuthority(raw.authority as HostCommandReceiptAuthority)
    const record: HostCommandReceiptRecord = {
      schemaVersion: HOST_COMMAND_RECEIPT_SCHEMA_VERSION,
      commandId: normalizeId(raw.commandId, 'commandId'),
      idempotencyKey: normalizeId(raw.idempotencyKey, 'idempotencyKey'),
      commandFingerprint: normalizeFingerprint(raw.commandFingerprint),
      status: raw.status,
      actor,
      target,
      authority,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    }
    // Only attach name/position when present and valid — never invent.
    if (typeof raw.commandName === 'string' && HOST_COMMAND_NAME_SET.has(raw.commandName)) {
      record.commandName = raw.commandName as HostCommandName
    }
    if (
      typeof raw.generation === 'number' &&
      Number.isInteger(raw.generation) &&
      raw.generation >= 0 &&
      Number.isFinite(raw.generation) &&
      typeof raw.cursor === 'number' &&
      Number.isInteger(raw.cursor) &&
      raw.cursor >= 0 &&
      Number.isFinite(raw.cursor)
    ) {
      record.generation = raw.generation
      record.cursor = raw.cursor
    }
    if (raw.phase !== undefined) {
      record.phase = normalizeQueuedStartPhase(raw.phase)
    }
    if (raw.executionClaimCursor !== undefined) {
      try {
        record.executionClaimCursor = normalizeExecutionClaimCursor(raw.executionClaimCursor)
      } catch {
        // A malformed legacy/tampered cursor proves nothing. Retain the
        // receipt without it so recovery remains conservative.
      }
    }
    // An unknown class string reads back unclassified: it proves nothing.
    if (isCommandClass(raw.commandClass)) record.commandClass = raw.commandClass
    if (typeof raw.completedAt === 'string') record.completedAt = raw.completedAt
    if (typeof raw.errorCode === 'string')
      record.errorCode = truncateText(raw.errorCode, MAX_KIND_CHARS)
    if (typeof raw.errorMessage === 'string') {
      record.errorMessage = truncateText(raw.errorMessage, MAX_ERROR_CHARS)
    }
    if (typeof raw.resultSummary === 'string') {
      record.resultSummary = truncateText(raw.resultSummary, MAX_SUMMARY_CHARS)
    }
    if (raw.resultRef !== undefined) {
      const resultRef = normalizeResultRef(raw.resultRef)
      if (record.status !== 'succeeded') return null
      record.resultRef = resultRef
    }
    if (typeof raw.conflictCommandId === 'string') {
      record.conflictCommandId = truncateText(raw.conflictCommandId, MAX_ID_CHARS)
    }
    if (raw.recoveryState === 'recoverable-indeterminate') {
      record.recoveryState = 'recoverable-indeterminate'
    }
    return record
  } catch {
    return null
  }
}

function parseJournalEvent(line: string): JournalEvent {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed journal event')
  }
  const raw = parsed as Record<string, unknown>
  let seq: number | undefined
  if (Object.prototype.hasOwnProperty.call(raw, 'seq')) {
    if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
      throw new Error('invalid journal sequence')
    }
    seq = raw.seq
  }
  if (raw.op === 'upsert') {
    const record = normalizeStoredRecord(raw.record)
    if (!record) throw new Error('malformed upsert record')
    return seq === undefined ? { op: 'upsert', record } : { op: 'upsert', record, seq }
  }
  if (raw.op === 'compact') {
    if (
      !Array.isArray(raw.retainedCommandIds) ||
      !raw.retainedCommandIds.every((id) => typeof id === 'string' && id.length > 0) ||
      typeof raw.at !== 'string'
    ) {
      throw new Error('malformed compact event')
    }
    const retainedCommandIds: string[] = raw.retainedCommandIds
    return seq === undefined
      ? { op: 'compact', retainedCommandIds, at: raw.at }
      : { op: 'compact', retainedCommandIds, at: raw.at, seq }
  }
  throw new Error('unknown journal op')
}
