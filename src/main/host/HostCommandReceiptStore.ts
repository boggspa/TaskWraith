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
 * Not wired to BridgeActionExecutor or control server yet.
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

import type { HostClientClass, HostCommandName } from '../../shared/hostProtocol'

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
  /**
   * When status is `conflict`: commandId of the original receipt that owns the
   * idempotency key. Never raw args/tool output.
   */
  conflictCommandId?: string
  /** Set when a pending receipt was reopened after Host crash/restart. */
  recoveryState?: 'recoverable-indeterminate'
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
}

export type HostCommandReceiptTerminalStatus = 'succeeded' | 'failed' | 'denied' | 'cancelled'

export type HostCommandReceiptCompleteInput = {
  commandId: string
  status: HostCommandReceiptTerminalStatus
  completedAt?: string
  errorCode?: string
  errorMessage?: string
  resultSummary?: string
  /** Optional authority update at completion (e.g. final deny reason). */
  authority?: HostCommandReceiptAuthority
}

export type HostCommandReceiptBeginResult =
  | { kind: 'created'; receipt: HostCommandReceiptRecord }
  | { kind: 'existing'; receipt: HostCommandReceiptRecord }
  /**
   * Exact fingerprint match exists but caller actor does not match the owner.
   * Never includes the original receipt body.
   */
  | { kind: 'actor_denied' }
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

/** Actor-bound receipt lookup — never returns another actor's receipt body. */
export type HostCommandReceiptLookupResult =
  | { kind: 'found'; receipt: HostCommandReceiptRecord }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }
  /** Legacy/incomplete identity or position — retained but not safely accessible. */
  | { kind: 'incomplete' }

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
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_COMMAND_RECEIPT_SCHEMA_VERSION
  updatedAt: string
  records: HostCommandReceiptRecord[]
}

type JournalEvent =
  | { op: 'upsert'; record: HostCommandReceiptRecord }
  | { op: 'compact'; retainedCommandIds: string[]; at: string }

export class HostCommandReceiptStore {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly maxRecords: number
  private readonly compactAfterRecords: number
  private readonly getPosition: () => HostCommandReceiptPosition
  private readonly now: () => string
  private readonly log: (line: string) => void

  private recordsByCommandId = new Map<string, HostCommandReceiptRecord>()
  private commandIdByIdempotencyKey = new Map<string, string>()
  private journalRecordCount = 0

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
    this.log = options.log ?? (() => {})
    this.reopen()
  }

  /**
   * Re-read checkpoint + journal from disk. Any still-pending receipt is marked
   * indeterminate (recoverable) so callers never re-execute blindly.
   */
  reopen(): void {
    this.recordsByCommandId = new Map()
    this.commandIdByIdempotencyKey = new Map()
    this.journalRecordCount = 0

    const checkpointRecords = this.readCheckpoint()
    for (const record of checkpointRecords) {
      this.indexRecord(record)
    }

    const journalEvents = this.readJournal()
    for (const event of journalEvents) {
      this.journalRecordCount += 1
      if (event.op === 'upsert') {
        this.indexRecord(event.record)
      } else if (event.op === 'compact') {
        const retain = new Set(event.retainedCommandIds)
        for (const commandId of [...this.recordsByCommandId.keys()]) {
          if (!retain.has(commandId)) {
            const existing = this.recordsByCommandId.get(commandId)
            if (existing) {
              // Delete the idempotency mapping only when it currently maps to
              // this removed non-conflict owner. Evicting a conflict must not
              // erase a live owner's key.
              if (
                existing.status !== 'conflict' &&
                this.commandIdByIdempotencyKey.get(existing.idempotencyKey) === commandId
              ) {
                this.commandIdByIdempotencyKey.delete(existing.idempotencyKey)
              }
              this.recordsByCommandId.delete(commandId)
            }
          }
        }
      }
    }

    // Host restart while a command was in-flight: surface indeterminate recovery
    // state. Do not auto-succeed, auto-fail, or re-run.
    let pendingPromoted = false
    for (const [, record] of this.recordsByCommandId) {
      if (record.status === 'pending') {
        const promoted: HostCommandReceiptRecord = {
          ...record,
          status: 'indeterminate',
          recoveryState: 'recoverable-indeterminate',
          updatedAt: this.now()
        }
        this.indexRecord(promoted)
        pendingPromoted = true
        this.appendJournalEvent({ op: 'upsert', record: promoted })
      }
    }
    if (pendingPromoted) {
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

        this.indexRecord(conflictRecord)
        this.appendJournalEvent({ op: 'upsert', record: conflictRecord })
        this.maybeCompact()
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
      updatedAt: createdAt
    }

    this.indexRecord(record)
    this.appendJournalEvent({ op: 'upsert', record })
    this.maybeCompact()
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
    if (!current) return null

    if (
      current.status === 'succeeded' ||
      current.status === 'failed' ||
      current.status === 'denied' ||
      current.status === 'cancelled' ||
      current.status === 'conflict'
    ) {
      if (current.status === input.status) {
        return cloneRecord(current)
      }
      throw new Error(
        `HostCommandReceiptStore: receipt ${commandId} is already terminal (${current.status})`
      )
    }

    const completedAt = input.completedAt ?? this.now()
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
        : {})
    }
    delete next.recoveryState

    this.indexRecord(next)
    this.appendJournalEvent({ op: 'upsert', record: next })
    this.maybeCompact()
    return cloneRecord(next)
  }

  /** Force compaction of journal into checkpoint, enforcing maxRecords. */
  compact(): void {
    this.writeCheckpointAndResetJournal()
  }

  get size(): number {
    return this.recordsByCommandId.size
  }

  private indexRecord(record: HostCommandReceiptRecord): void {
    this.recordsByCommandId.set(record.commandId, record)
    // Conflict receipts never claim or steal the idempotency-key mapping.
    // The original non-conflict receipt remains the sole getByIdempotencyKey owner.
    if (record.status !== 'conflict') {
      this.commandIdByIdempotencyKey.set(record.idempotencyKey, record.commandId)
    }
  }

  private maybeCompact(): void {
    if (this.journalRecordCount >= this.compactAfterRecords) {
      this.writeCheckpointAndResetJournal()
    } else if (this.recordsByCommandId.size > this.maxRecords) {
      this.writeCheckpointAndResetJournal()
    }
  }

  /**
   * Bounded retention that prefers non-conflict idempotency owners over
   * conflicts. A retained conflict never outlives its conflictCommandId owner:
   * if maxRecords cannot hold both (including maxRecords=1), the conflict is
   * evicted and the owner is kept. Never exceeds the configured bound.
   */
  private selectRecordsForRetention(all: HostCommandReceiptRecord[]): HostCommandReceiptRecord[] {
    if (all.length <= this.maxRecords) {
      return all
    }

    const sorted = [...all].sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
      if (byUpdated !== 0) return byUpdated
      return b.createdAt.localeCompare(a.createdAt)
    })

    const selected = new Map<string, HostCommandReceiptRecord>()

    // Phase 1: retain non-conflict owners newest-first (prefer original owners).
    for (const record of sorted) {
      if (record.status === 'conflict') continue
      if (selected.size >= this.maxRecords) break
      selected.set(record.commandId, record)
    }

    // Phase 2: fill remaining slots with conflicts whose owners are retained.
    // Never retain a conflict without its conflictCommandId owner in the set.
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

  private writeCheckpointAndResetJournal(): void {
    const records = this.selectRecordsForRetention([...this.recordsByCommandId.values()])

    this.recordsByCommandId = new Map()
    this.commandIdByIdempotencyKey = new Map()
    for (const record of records) {
      this.indexRecord(record)
    }

    const doc: CheckpointDocument = {
      schemaVersion: HOST_COMMAND_RECEIPT_SCHEMA_VERSION,
      updatedAt: this.now(),
      records: records.map(cloneRecord)
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
        `[HostCommandReceiptStore] journal reset failed: ${err instanceof Error ? err.message : String(err)}`
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

  private readCheckpoint(): HostCommandReceiptRecord[] {
    if (!existsSync(this.checkpointPath)) return []
    try {
      const raw = readFileSync(this.checkpointPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log('[HostCommandReceiptStore] checkpoint malformed (not an object); starting empty')
        return []
      }
      const doc = parsed as Partial<CheckpointDocument>
      if (
        doc.schemaVersion !== HOST_COMMAND_RECEIPT_SCHEMA_VERSION ||
        !Array.isArray(doc.records)
      ) {
        this.log('[HostCommandReceiptStore] checkpoint schema mismatch; starting empty')
        return []
      }
      return doc.records
        .map(normalizeStoredRecord)
        .filter((r): r is HostCommandReceiptRecord => r !== null)
    } catch (err) {
      this.log(
        `[HostCommandReceiptStore] checkpoint load failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  private readJournal(): JournalEvent[] {
    if (!existsSync(this.journalPath)) return []
    let source: string
    try {
      source = readFileSync(this.journalPath, 'utf8')
    } catch (err) {
      this.log(
        `[HostCommandReceiptStore] journal read failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }

    const events: JournalEvent[] = []
    const lines = source.split('\n')
    const endsWithNewline = source.endsWith('\n')
    const lastContentIndex = endsWithNewline ? lines.length - 2 : lines.length - 1

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        const event = parseJournalEvent(line)
        if (event) events.push(event)
      } catch {
        if (index === lastContentIndex && !endsWithNewline) {
          this.log('[HostCommandReceiptStore] dropped truncated journal tail')
          break
        }
        this.log(`[HostCommandReceiptStore] skipped corrupt journal line at index ${index}`)
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
  'thread.select',
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
    if (typeof raw.completedAt === 'string') record.completedAt = raw.completedAt
    if (typeof raw.errorCode === 'string')
      record.errorCode = truncateText(raw.errorCode, MAX_KIND_CHARS)
    if (typeof raw.errorMessage === 'string') {
      record.errorMessage = truncateText(raw.errorMessage, MAX_ERROR_CHARS)
    }
    if (typeof raw.resultSummary === 'string') {
      record.resultSummary = truncateText(raw.resultSummary, MAX_SUMMARY_CHARS)
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

function parseJournalEvent(line: string): JournalEvent | null {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed journal event')
  }
  const raw = parsed as Record<string, unknown>
  if (raw.op === 'upsert') {
    const record = normalizeStoredRecord(raw.record)
    if (!record) throw new Error('malformed upsert record')
    return { op: 'upsert', record }
  }
  if (raw.op === 'compact') {
    if (!Array.isArray(raw.retainedCommandIds) || typeof raw.at !== 'string') {
      throw new Error('malformed compact event')
    }
    const retainedCommandIds = raw.retainedCommandIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    )
    return { op: 'compact', retainedCommandIds, at: raw.at }
  }
  throw new Error('unknown journal op')
}
