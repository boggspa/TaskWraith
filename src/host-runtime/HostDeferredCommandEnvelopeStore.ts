/**
 * Durable Host-internal deferred command envelope store (Host Arc Wave 2E-2B).
 *
 * The compact deferred-command bridge intentionally does not retain command
 * targets or typed arguments. This store durably retains the exact canonical
 * governed HostCommand needed for restart-safe execution, while exposing only
 * actor-bound internal lookups and compact body-free recovery summaries.
 *
 * Persistence is an fsynced 0600 journal plus atomically replaced checkpoint
 * under an injected Host data directory. Stored and quarantined rows are never
 * evicted; consumed rows are the only capacity relief. Any malformed durable
 * evidence makes recovery unavailable, while intentional quarantine stays body-free.
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
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
  HOST_PROTOCOL_MAX_ID,
  decodeHostCommand,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName
} from '../shared/hostProtocol'
import { validateHostCommandArguments } from './HostCommandArguments'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import {
  isHostUuid,
  isSafeHostIdentifier,
  parseHostIdempotencyKey
} from '../host-shared/HostCommandIdentity'
import { parseGovernedMutationCommandName } from './HostCommandRouting'

export const HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION = 1 as const
export const HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME =
  'deferred-command-envelopes.checkpoint.json'
export const HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME =
  'deferred-command-envelopes.journal.jsonl'
export const DEFAULT_HOST_DEFERRED_COMMAND_ENVELOPE_MAX_RECORDS = 2_000
export const DEFAULT_HOST_DEFERRED_COMMAND_ENVELOPE_COMPACT_AFTER_RECORDS = 256

const MAX_TIMESTAMP_CHARS = 80
const COMMAND_FINGERPRINT_RE = /^[a-f0-9]{64}$/

export type HostDeferredCommandChallengeKind = 'approval' | 'question'
export type HostDeferredCommandEnvelopeLifecycle = 'stored' | 'consumed' | 'quarantined'
export type HostDeferredCommandEnvelopeQuarantineCode =
  | 'verification_failed'
  | 'body_missing'
  | 'fingerprint_mismatch'
  | 'actor_mismatch'
  | 'corrupt_record'

export interface HostDeferredCommandEnvelopeRecord {
  schemaVersion: typeof HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION
  deferredId: string
  challengeId: string
  challengeKind: HostDeferredCommandChallengeKind
  commandId: string
  idempotencyKey: string
  commandFingerprint: string
  commandName: HostCommandName
  actor: HostActorIdentity
  state: HostDeferredCommandEnvelopeLifecycle
  createdAt: string
  updatedAt: string
  /**
   * Present only for stored/consumed internal rows. Quarantined rows discard
   * the body and retain compact identity metadata only.
   */
  command?: HostCommand
  terminalAt?: string
  quarantineCode?: HostDeferredCommandEnvelopeQuarantineCode
}

export interface HostDeferredCommandEnvelopePutInput {
  deferredId: string
  challengeId: string
  challengeKind: HostDeferredCommandChallengeKind
  commandFingerprint: string
  command: HostCommand
}

export type HostDeferredCommandEnvelopeCollisionCode =
  | 'deferred_id_collision'
  | 'command_id_collision'
  | 'idempotency_key_collision'
  | 'challenge_id_collision'

export type HostDeferredCommandEnvelopeInvalidCode =
  | 'invalid_input'
  | 'invalid_command'
  | 'invalid_routing'
  | 'invalid_identity'
  | 'fingerprint_mismatch'

export type HostDeferredCommandEnvelopePutResult =
  | { kind: 'created' }
  | { kind: 'existing' }
  | { kind: 'conflict'; code: HostDeferredCommandEnvelopeCollisionCode }
  | { kind: 'invalid'; code: HostDeferredCommandEnvelopeInvalidCode }
  | { kind: 'store_full' }
  | { kind: 'unavailable' }

export type HostDeferredCommandEnvelopeLookupResult =
  | { kind: 'found'; record: HostDeferredCommandEnvelopeRecord }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }
  | { kind: 'unavailable' }

export type HostDeferredCommandEnvelopeTransitionResult =
  | { kind: 'updated'; state: 'consumed' | 'quarantined' }
  | { kind: 'existing'; state: 'consumed' | 'quarantined' }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }
  | { kind: 'state_conflict'; state: HostDeferredCommandEnvelopeLifecycle }
  | { kind: 'unavailable' }

export type HostDeferredCommandEnvelopeRecoverySummary =
  | {
      availability: 'available'
      size: number
      stored: number
      consumed: number
      quarantined: number
      storedCommandIds: string[]
      quarantinedCommandIds: string[]
    }
  | {
      availability: 'unavailable'
      size: null
      stored: null
      consumed: null
      quarantined: null
      storedCommandIds: null
      quarantinedCommandIds: null
    }

export type HostDeferredCommandEnvelopeCompactResult =
  | { kind: 'compacted' }
  | { kind: 'unavailable' }

export interface HostDeferredCommandEnvelopeStoreOptions {
  dataDir: string
  maxRecords?: number
  compactAfterRecords?: number
  now?: () => string
  log?: (line: string) => void
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION
  updatedAt: string
  records: HostDeferredCommandEnvelopeRecord[]
}

type JournalEvent =
  | { op: 'upsert'; record: HostDeferredCommandEnvelopeRecord }
  | { op: 'compact'; retainedDeferredIds: string[]; at: string }

type PersistenceReadResult<T> =
  | { availability: 'available'; values: T[] }
  | { availability: 'unavailable' }

interface NormalizedPut {
  deferredId: string
  challengeId: string
  challengeKind: HostDeferredCommandChallengeKind
  commandFingerprint: string
  command: HostCommand
}

type NormalizePutResult =
  | { ok: true; value: NormalizedPut }
  | { ok: false; code: HostDeferredCommandEnvelopeInvalidCode }

const RECORD_BASE_KEYS = [
  'schemaVersion',
  'deferredId',
  'challengeId',
  'challengeKind',
  'commandId',
  'idempotencyKey',
  'commandFingerprint',
  'commandName',
  'actor',
  'state',
  'createdAt',
  'updatedAt'
] as const

export class HostDeferredCommandEnvelopeStore {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly maxRecords: number
  private readonly compactAfterRecords: number
  private readonly now: () => string
  private readonly log: (line: string) => void

  private recordsByDeferredId = new Map<string, HostDeferredCommandEnvelopeRecord>()
  private deferredIdByCommandId = new Map<string, string>()
  private deferredIdByIdempotencyKey = new Map<string, string>()
  private deferredIdByChallengeId = new Map<string, string>()
  private journalRecordCount = 0
  private recoveryAvailability: 'available' | 'unavailable' = 'available'

  constructor(options: HostDeferredCommandEnvelopeStoreOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostDeferredCommandEnvelopeStore requires an injected dataDir')
    }
    this.dataDir = options.dataDir
    this.checkpointPath = join(this.dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_CHECKPOINT_FILENAME)
    this.journalPath = join(this.dataDir, HOST_DEFERRED_COMMAND_ENVELOPE_JOURNAL_FILENAME)
    this.maxRecords = Math.max(
      1,
      options.maxRecords ?? DEFAULT_HOST_DEFERRED_COMMAND_ENVELOPE_MAX_RECORDS
    )
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_HOST_DEFERRED_COMMAND_ENVELOPE_COMPACT_AFTER_RECORDS
    )
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = options.log ?? (() => {})
    this.reopen()
  }

  reopen(): void {
    this.resetIndexes()
    this.recoveryAvailability = 'available'

    const checkpoint = this.readCheckpoint()
    if (checkpoint.availability === 'unavailable') {
      this.recoveryAvailability = 'unavailable'
      return
    }
    const journal = this.readJournal()
    if (journal.availability === 'unavailable') {
      this.recoveryAvailability = 'unavailable'
      return
    }

    for (const record of checkpoint.values) {
      this.applyRecoveredRecord(record)
    }
    for (const event of journal.values) {
      this.journalRecordCount += 1
      if (event.op === 'upsert') {
        this.applyRecoveredRecord(event.record)
      } else {
        const retained = new Set(event.retainedDeferredIds)
        for (const deferredId of [...this.recordsByDeferredId.keys()]) {
          if (!retained.has(deferredId)) this.removeRecord(deferredId)
        }
      }
    }
  }

  put(input: unknown): HostDeferredCommandEnvelopePutResult {
    if (this.recoveryAvailability === 'unavailable') return { kind: 'unavailable' }
    const normalized = normalizePutInput(input)
    if (!normalized.ok) return { kind: 'invalid', code: normalized.code }
    const value = normalized.value

    const byDeferred = this.recordsByDeferredId.get(value.deferredId)
    if (byDeferred) {
      if (isExactRepeat(byDeferred, value)) return { kind: 'existing' }
      return { kind: 'conflict', code: 'deferred_id_collision' }
    }

    const byCommand = this.deferredIdByCommandId.get(value.command.commandId)
    if (byCommand) return { kind: 'conflict', code: 'command_id_collision' }

    const byKey = this.deferredIdByIdempotencyKey.get(value.command.idempotencyKey)
    if (byKey) return { kind: 'conflict', code: 'idempotency_key_collision' }

    const byChallenge = this.deferredIdByChallengeId.get(value.challengeId)
    if (byChallenge) return { kind: 'conflict', code: 'challenge_id_collision' }

    if (!this.makeRoomForInsert()) return { kind: 'store_full' }

    const createdAt = this.now()
    const record: HostDeferredCommandEnvelopeRecord = {
      schemaVersion: HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION,
      deferredId: value.deferredId,
      challengeId: value.challengeId,
      challengeKind: value.challengeKind,
      commandId: value.command.commandId,
      idempotencyKey: value.command.idempotencyKey,
      commandFingerprint: value.commandFingerprint,
      commandName: value.command.name,
      actor: cloneActor(value.command.actor),
      state: 'stored',
      createdAt,
      updatedAt: createdAt,
      command: cloneCommand(value.command)
    }

    this.replaceRecord(record)
    this.appendJournalEvent({ op: 'upsert', record })
    this.maybeCompact()
    return { kind: 'created' }
  }

  getByDeferredId(
    deferredId: string,
    actor: HostActorIdentity
  ): HostDeferredCommandEnvelopeLookupResult {
    if (this.recoveryAvailability === 'unavailable') return { kind: 'unavailable' }
    if (!isHostUuid(deferredId)) return { kind: 'not_found' }
    const record = this.recordsByDeferredId.get(deferredId)
    if (!record) return { kind: 'not_found' }
    return gateRecordForActor(record, actor)
  }

  getByCommandId(
    commandId: string,
    actor: HostActorIdentity
  ): HostDeferredCommandEnvelopeLookupResult {
    if (this.recoveryAvailability === 'unavailable') return { kind: 'unavailable' }
    if (!isHostUuid(commandId)) return { kind: 'not_found' }
    const deferredId = this.deferredIdByCommandId.get(commandId)
    if (!deferredId) return { kind: 'not_found' }
    return this.getByDeferredId(deferredId, actor)
  }

  markConsumed(
    deferredId: string,
    actor: HostActorIdentity
  ): HostDeferredCommandEnvelopeTransitionResult {
    const current = this.lookupMutable(deferredId, actor)
    if (current.kind !== 'found') return current
    if (current.record.state === 'consumed') {
      return { kind: 'existing', state: 'consumed' }
    }
    if (current.record.state !== 'stored') {
      return { kind: 'state_conflict', state: current.record.state }
    }

    const terminalAt = this.now()
    const next: HostDeferredCommandEnvelopeRecord = {
      ...current.record,
      state: 'consumed',
      updatedAt: terminalAt,
      terminalAt
    }
    this.replaceRecord(next)
    this.appendJournalEvent({ op: 'upsert', record: next })
    this.maybeCompact()
    return { kind: 'updated', state: 'consumed' }
  }

  markQuarantined(
    deferredId: string,
    actor: HostActorIdentity,
    quarantineCode: HostDeferredCommandEnvelopeQuarantineCode
  ): HostDeferredCommandEnvelopeTransitionResult {
    const current = this.lookupMutable(deferredId, actor)
    if (current.kind !== 'found') return current
    if (!isQuarantineCode(quarantineCode)) {
      return { kind: 'state_conflict', state: current.record.state }
    }
    if (current.record.state === 'quarantined') {
      if (current.record.quarantineCode === quarantineCode) {
        return { kind: 'existing', state: 'quarantined' }
      }
      return { kind: 'state_conflict', state: 'quarantined' }
    }
    if (current.record.state !== 'stored') {
      return { kind: 'state_conflict', state: current.record.state }
    }

    const terminalAt = this.now()
    const next: HostDeferredCommandEnvelopeRecord = {
      ...current.record,
      state: 'quarantined',
      updatedAt: terminalAt,
      terminalAt,
      quarantineCode
    }
    delete next.command

    this.replaceRecord(next)
    this.appendJournalEvent({ op: 'upsert', record: next })
    this.maybeCompact()
    return { kind: 'updated', state: 'quarantined' }
  }

  getRecoverySummary(): HostDeferredCommandEnvelopeRecoverySummary {
    if (this.recoveryAvailability === 'unavailable') {
      return {
        availability: 'unavailable',
        size: null,
        stored: null,
        consumed: null,
        quarantined: null,
        storedCommandIds: null,
        quarantinedCommandIds: null
      }
    }

    const records = [...this.recordsByDeferredId.values()]
    const storedCommandIds = records
      .filter((record) => record.state === 'stored')
      .map((record) => record.commandId)
      .sort()
    const quarantinedCommandIds = records
      .filter((record) => record.state === 'quarantined')
      .map((record) => record.commandId)
      .sort()
    return {
      availability: 'available',
      size: records.length,
      stored: storedCommandIds.length,
      consumed: records.filter((record) => record.state === 'consumed').length,
      quarantined: quarantinedCommandIds.length,
      storedCommandIds,
      quarantinedCommandIds
    }
  }

  compact(): HostDeferredCommandEnvelopeCompactResult {
    if (this.recoveryAvailability === 'unavailable') return { kind: 'unavailable' }
    this.writeCheckpointAndResetJournal(this.maxRecords)
    return { kind: 'compacted' }
  }

  get size(): number | null {
    return this.recoveryAvailability === 'available' ? this.recordsByDeferredId.size : null
  }

  private lookupMutable(
    deferredId: string,
    actor: HostActorIdentity
  ):
    | { kind: 'found'; record: HostDeferredCommandEnvelopeRecord }
    | { kind: 'not_found' }
    | { kind: 'actor_mismatch' }
    | { kind: 'unavailable' } {
    if (this.recoveryAvailability === 'unavailable') return { kind: 'unavailable' }
    if (!isHostUuid(deferredId)) return { kind: 'not_found' }
    const record = this.recordsByDeferredId.get(deferredId)
    if (!record) return { kind: 'not_found' }
    if (!actorsMatch(record.actor, actor)) return { kind: 'actor_mismatch' }
    return { kind: 'found', record }
  }

  private makeRoomForInsert(): boolean {
    if (this.recordsByDeferredId.size < this.maxRecords) return true
    this.writeCheckpointAndResetJournal(this.maxRecords - 1)
    return this.recordsByDeferredId.size < this.maxRecords
  }

  private maybeCompact(): void {
    if (this.journalRecordCount >= this.compactAfterRecords) {
      this.writeCheckpointAndResetJournal(this.maxRecords)
    }
  }

  private selectRecordsForRetention(limit: number): HostDeferredCommandEnvelopeRecord[] {
    const records = [...this.recordsByDeferredId.values()]
    const protectedRecords = records.filter((record) => record.state !== 'consumed')
    const consumed = records
      .filter((record) => record.state === 'consumed')
      .sort((a, b) => {
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
        return byUpdated !== 0 ? byUpdated : b.createdAt.localeCompare(a.createdAt)
      })
    const available = Math.max(0, limit - protectedRecords.length)
    return [...protectedRecords, ...consumed.slice(0, available)]
  }

  private writeCheckpointAndResetJournal(limit: number): void {
    const records = this.selectRecordsForRetention(limit).map(cloneRecord)
    this.resetIndexes()
    for (const record of records) this.replaceRecord(record)

    const document: CheckpointDocument = {
      schemaVersion: HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION,
      updatedAt: this.now(),
      records
    }

    mkdirSync(this.dataDir, { recursive: true })
    const temporaryPath = this.checkpointPath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    writeFileSync(temporaryPath, JSON.stringify(document) + '\n', {
      encoding: 'utf8',
      mode: 0o600
    })
    const descriptor = openSync(temporaryPath, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, this.checkpointPath)
    chmodSync(this.checkpointPath, 0o600)
    fsyncDirectory(this.dataDir)

    try {
      if (existsSync(this.journalPath)) unlinkSync(this.journalPath)
    } catch {
      this.log('[HostDeferredCommandEnvelopeStore] journal reset failed')
    }
    fsyncDirectory(this.dataDir)
    this.journalRecordCount = 0
  }

  private appendJournalEvent(event: JournalEvent): void {
    mkdirSync(this.dataDir, { recursive: true })
    const descriptor = openSync(this.journalPath, 'a', 0o600)
    try {
      appendFileSync(descriptor, JSON.stringify(event) + '\n', 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(this.journalPath, 0o600)
    this.journalRecordCount += 1
  }

  private readCheckpoint(): PersistenceReadResult<HostDeferredCommandEnvelopeRecord> {
    if (!existsSync(this.checkpointPath)) {
      return { availability: 'available', values: [] }
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.checkpointPath, 'utf8'))
      if (!isRecord(parsed) || !hasExactKeys(parsed, ['schemaVersion', 'updatedAt', 'records'])) {
        this.log('[HostDeferredCommandEnvelopeStore] checkpoint recovery unavailable')
        return { availability: 'unavailable' }
      }
      if (
        parsed.schemaVersion !== HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION ||
        typeof parsed.updatedAt !== 'string' ||
        !isBoundedTimestamp(parsed.updatedAt) ||
        !Array.isArray(parsed.records)
      ) {
        this.log('[HostDeferredCommandEnvelopeStore] checkpoint recovery unavailable')
        return { availability: 'unavailable' }
      }

      const values: HostDeferredCommandEnvelopeRecord[] = []
      for (const value of parsed.records) {
        const record = normalizeStoredRecord(value)
        if (!record || !persistedRecordMatchesNormalization(value, record)) {
          this.log('[HostDeferredCommandEnvelopeStore] checkpoint recovery unavailable')
          return { availability: 'unavailable' }
        }
        values.push(record)
      }
      return { availability: 'available', values }
    } catch {
      this.log('[HostDeferredCommandEnvelopeStore] checkpoint recovery unavailable')
      return { availability: 'unavailable' }
    }
  }

  private readJournal(): PersistenceReadResult<JournalEvent> {
    if (!existsSync(this.journalPath)) {
      return { availability: 'available', values: [] }
    }

    let source: string
    try {
      source = readFileSync(this.journalPath, 'utf8')
    } catch {
      this.log('[HostDeferredCommandEnvelopeStore] journal recovery unavailable')
      return { availability: 'unavailable' }
    }
    if (source.length === 0) {
      return { availability: 'available', values: [] }
    }

    const values: JournalEvent[] = []
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      try {
        values.push(parseJournalEvent(line))
      } catch {
        this.log(
          '[HostDeferredCommandEnvelopeStore] journal recovery unavailable at event ' +
            String(index)
        )
        return { availability: 'unavailable' }
      }
    }
    return { availability: 'available', values }
  }

  private applyRecoveredRecord(record: HostDeferredCommandEnvelopeRecord): void {
    const existing = this.recordsByDeferredId.get(record.deferredId)
    if (existing) {
      if (!sameIdentity(existing, record) || !isAllowedRecoveredTransition(existing, record)) {
        this.replaceRecord(quarantineRecord(existing, 'corrupt_record'))
        return
      }
      this.replaceRecord(record)
      return
    }

    const commandOwner = this.deferredIdByCommandId.get(record.commandId)
    const keyOwner = this.deferredIdByIdempotencyKey.get(record.idempotencyKey)
    const challengeOwner = this.deferredIdByChallengeId.get(record.challengeId)
    if (
      (commandOwner && commandOwner !== record.deferredId) ||
      (keyOwner && keyOwner !== record.deferredId) ||
      (challengeOwner && challengeOwner !== record.deferredId)
    ) {
      this.replaceRecord(quarantineRecord(record, 'corrupt_record'))
      return
    }
    this.replaceRecord(record)
  }

  private replaceRecord(record: HostDeferredCommandEnvelopeRecord): void {
    const previous = this.recordsByDeferredId.get(record.deferredId)
    if (previous) this.unindexRecord(previous)
    const cloned = cloneRecord(record)
    this.recordsByDeferredId.set(cloned.deferredId, cloned)
    if (!this.deferredIdByCommandId.has(cloned.commandId)) {
      this.deferredIdByCommandId.set(cloned.commandId, cloned.deferredId)
    }
    if (!this.deferredIdByIdempotencyKey.has(cloned.idempotencyKey)) {
      this.deferredIdByIdempotencyKey.set(cloned.idempotencyKey, cloned.deferredId)
    }
    if (!this.deferredIdByChallengeId.has(cloned.challengeId)) {
      this.deferredIdByChallengeId.set(cloned.challengeId, cloned.deferredId)
    }
  }

  private unindexRecord(record: HostDeferredCommandEnvelopeRecord): void {
    if (this.deferredIdByCommandId.get(record.commandId) === record.deferredId) {
      this.deferredIdByCommandId.delete(record.commandId)
    }
    if (this.deferredIdByIdempotencyKey.get(record.idempotencyKey) === record.deferredId) {
      this.deferredIdByIdempotencyKey.delete(record.idempotencyKey)
    }
    if (this.deferredIdByChallengeId.get(record.challengeId) === record.deferredId) {
      this.deferredIdByChallengeId.delete(record.challengeId)
    }
  }

  private removeRecord(deferredId: string): void {
    const record = this.recordsByDeferredId.get(deferredId)
    if (!record) return
    this.unindexRecord(record)
    this.recordsByDeferredId.delete(deferredId)
  }

  private resetIndexes(): void {
    this.recordsByDeferredId = new Map()
    this.deferredIdByCommandId = new Map()
    this.deferredIdByIdempotencyKey = new Map()
    this.deferredIdByChallengeId = new Map()
    this.journalRecordCount = 0
  }
}

function normalizePutInput(input: unknown): NormalizePutResult {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'deferredId',
      'challengeId',
      'challengeKind',
      'commandFingerprint',
      'command'
    ])
  ) {
    return { ok: false, code: 'invalid_input' }
  }
  if (!isHostUuid(input.deferredId) || !isSafeHostIdentifier(input.deferredId)) {
    return { ok: false, code: 'invalid_identity' }
  }
  if (!isHostUuid(input.challengeId) || !isSafeHostIdentifier(input.challengeId)) {
    return { ok: false, code: 'invalid_identity' }
  }
  if (input.challengeKind !== 'approval' && input.challengeKind !== 'question') {
    return { ok: false, code: 'invalid_input' }
  }
  const command = normalizeCanonicalCommand(input.command)
  if (!command.ok) return command
  const commandFingerprint = normalizeFingerprint(input.commandFingerprint)
  if (!commandFingerprint) return { ok: false, code: 'invalid_input' }
  const recomputed = fingerprintHostCommand(command.value).fingerprint
  if (recomputed !== commandFingerprint) {
    return { ok: false, code: 'fingerprint_mismatch' }
  }
  return {
    ok: true,
    value: {
      deferredId: input.deferredId,
      challengeId: input.challengeId,
      challengeKind: input.challengeKind,
      commandFingerprint,
      command: command.value
    }
  }
}

function normalizeCanonicalCommand(
  value: unknown
): { ok: true; value: HostCommand } | { ok: false; code: HostDeferredCommandEnvelopeInvalidCode } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'commandId',
      'idempotencyKey',
      'actor',
      'name',
      'target',
      'arguments',
      'issuedAt'
    ])
  ) {
    return { ok: false, code: 'invalid_command' }
  }
  if (
    !isRecord(value.actor) ||
    !hasExactKeys(value.actor, ['actorId', 'clientId', 'clientClass'])
  ) {
    return { ok: false, code: 'invalid_command' }
  }

  const decoded = decodeHostCommand(value)
  if (!decoded.ok) return { ok: false, code: 'invalid_command' }
  const validated = validateHostCommandArguments(decoded.value)
  if (!validated.ok) return { ok: false, code: 'invalid_command' }
  if (!parseGovernedMutationCommandName(validated.value.name)) {
    return { ok: false, code: 'invalid_routing' }
  }
  if (!isHostUuid(validated.value.commandId)) {
    return { ok: false, code: 'invalid_identity' }
  }
  const parsedKey = parseHostIdempotencyKey(validated.value.idempotencyKey)
  if (
    !parsedKey.ok ||
    parsedKey.value.clientClass !== validated.value.actor.clientClass ||
    parsedKey.value.clientId !== validated.value.actor.clientId
  ) {
    return { ok: false, code: 'invalid_identity' }
  }
  return { ok: true, value: cloneCommand(validated.value) }
}

function normalizeStoredRecord(value: unknown): HostDeferredCommandEnvelopeRecord | null {
  if (!isRecord(value)) return null
  const base = normalizeRawBase(value)
  if (!base) return null

  const expected =
    value.state === 'stored'
      ? [...RECORD_BASE_KEYS, 'command']
      : value.state === 'consumed'
        ? [...RECORD_BASE_KEYS, 'command', 'terminalAt']
        : [...RECORD_BASE_KEYS, 'terminalAt', 'quarantineCode']

  if (!hasExactKeys(value, expected)) {
    return quarantineRecord(base, 'corrupt_record')
  }

  if (value.state === 'quarantined') {
    if (
      typeof value.terminalAt !== 'string' ||
      !isBoundedTimestamp(value.terminalAt) ||
      !isQuarantineCode(value.quarantineCode)
    ) {
      return quarantineRecord(base, 'corrupt_record')
    }
    return {
      ...base,
      state: 'quarantined',
      terminalAt: value.terminalAt,
      quarantineCode: value.quarantineCode
    }
  }

  const command = normalizeCanonicalCommand(value.command)
  if (!command.ok) return quarantineRecord(base, 'corrupt_record')
  let recomputed: string
  try {
    recomputed = fingerprintHostCommand(command.value).fingerprint
  } catch {
    return quarantineRecord(base, 'corrupt_record')
  }
  if (
    recomputed !== base.commandFingerprint ||
    command.value.commandId !== base.commandId ||
    command.value.idempotencyKey !== base.idempotencyKey ||
    command.value.name !== base.commandName ||
    !actorsMatch(command.value.actor, base.actor)
  ) {
    return quarantineRecord(base, 'corrupt_record')
  }

  if (value.state === 'consumed') {
    if (typeof value.terminalAt !== 'string' || !isBoundedTimestamp(value.terminalAt)) {
      return quarantineRecord(base, 'corrupt_record')
    }
    return {
      ...base,
      state: 'consumed',
      command: command.value,
      terminalAt: value.terminalAt
    }
  }

  return { ...base, state: 'stored', command: command.value }
}

function normalizeRawBase(
  value: Record<string, unknown>
): HostDeferredCommandEnvelopeRecord | null {
  if (value.schemaVersion !== HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION) return null
  if (!isHostUuid(value.deferredId) || !isHostUuid(value.challengeId)) return null
  if (value.challengeKind !== 'approval' && value.challengeKind !== 'question') return null
  if (!isHostUuid(value.commandId)) return null
  if (typeof value.idempotencyKey !== 'string') return null
  const commandFingerprint = normalizeFingerprint(value.commandFingerprint)
  if (!commandFingerprint) return null
  const commandName = parseGovernedMutationCommandName(value.commandName)
  if (!commandName) return null
  const actor = normalizeActor(value.actor)
  if (!actor) return null
  const parsedKey = parseHostIdempotencyKey(value.idempotencyKey)
  if (
    !parsedKey.ok ||
    parsedKey.value.clientClass !== actor.clientClass ||
    parsedKey.value.clientId !== actor.clientId
  ) {
    return null
  }
  if (
    (value.state !== 'stored' && value.state !== 'consumed' && value.state !== 'quarantined') ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isBoundedTimestamp(value.createdAt) ||
    !isBoundedTimestamp(value.updatedAt)
  ) {
    return null
  }
  return {
    schemaVersion: HOST_DEFERRED_COMMAND_ENVELOPE_SCHEMA_VERSION,
    deferredId: value.deferredId,
    challengeId: value.challengeId,
    challengeKind: value.challengeKind,
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    commandFingerprint,
    commandName,
    actor,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function persistedRecordMatchesNormalization(
  value: unknown,
  record: HostDeferredCommandEnvelopeRecord
): boolean {
  if (!isRecord(value) || value.state !== record.state) return false
  return value.state !== 'quarantined' || value.quarantineCode === record.quarantineCode
}

function parseJournalEvent(line: string): JournalEvent {
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed)) throw new Error('malformed journal event')
  if (parsed.op === 'upsert') {
    if (!hasExactKeys(parsed, ['op', 'record']) || !isRecord(parsed.record)) {
      throw new Error('malformed upsert')
    }
    const record = normalizeStoredRecord(parsed.record)
    if (!record || !persistedRecordMatchesNormalization(parsed.record, record)) {
      throw new Error('malformed upsert record')
    }
    return { op: 'upsert', record }
  }
  if (parsed.op === 'compact') {
    if (
      !hasExactKeys(parsed, ['op', 'retainedDeferredIds', 'at']) ||
      !Array.isArray(parsed.retainedDeferredIds) ||
      typeof parsed.at !== 'string' ||
      !isBoundedTimestamp(parsed.at)
    ) {
      throw new Error('malformed compact event')
    }
    const retainedDeferredIds = parsed.retainedDeferredIds.filter((id): id is string =>
      isHostUuid(id)
    )
    if (retainedDeferredIds.length !== parsed.retainedDeferredIds.length) {
      throw new Error('malformed compact identifiers')
    }
    return { op: 'compact', retainedDeferredIds, at: parsed.at }
  }
  throw new Error('unknown journal operation')
}

function gateRecordForActor(
  record: HostDeferredCommandEnvelopeRecord,
  actor: HostActorIdentity
): HostDeferredCommandEnvelopeLookupResult {
  if (!actorsMatch(record.actor, actor)) return { kind: 'actor_mismatch' }
  return { kind: 'found', record: cloneRecord(record) }
}

function actorsMatch(left: HostActorIdentity, right: HostActorIdentity): boolean {
  const normalized = normalizeActor(right)
  return (
    normalized !== null &&
    left.actorId === normalized.actorId &&
    left.clientId === normalized.clientId &&
    left.clientClass === normalized.clientClass
  )
}

function normalizeActor(value: unknown): HostActorIdentity | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['actorId', 'clientId', 'clientClass']) ||
    !isSafeHostIdentifier(value.actorId, HOST_PROTOCOL_MAX_ID) ||
    !isSafeHostIdentifier(value.clientId, HOST_PROTOCOL_MAX_ID) ||
    (value.clientClass !== 'desktop' &&
      value.clientClass !== 'tui' &&
      value.clientClass !== 'ios' &&
      value.clientClass !== 'test')
  ) {
    return null
  }
  return {
    actorId: value.actorId,
    clientId: value.clientId,
    clientClass: value.clientClass
  }
}

function isExactRepeat(record: HostDeferredCommandEnvelopeRecord, value: NormalizedPut): boolean {
  return (
    record.state !== 'quarantined' &&
    record.deferredId === value.deferredId &&
    record.challengeId === value.challengeId &&
    record.challengeKind === value.challengeKind &&
    record.commandId === value.command.commandId &&
    record.idempotencyKey === value.command.idempotencyKey &&
    record.commandFingerprint === value.commandFingerprint &&
    record.commandName === value.command.name &&
    actorsMatch(record.actor, value.command.actor) &&
    record.command !== undefined &&
    JSON.stringify(record.command) === JSON.stringify(value.command)
  )
}

function sameIdentity(
  left: HostDeferredCommandEnvelopeRecord,
  right: HostDeferredCommandEnvelopeRecord
): boolean {
  return (
    left.deferredId === right.deferredId &&
    left.challengeId === right.challengeId &&
    left.challengeKind === right.challengeKind &&
    left.commandId === right.commandId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.commandFingerprint === right.commandFingerprint &&
    left.commandName === right.commandName &&
    actorsMatch(left.actor, right.actor)
  )
}

function isAllowedRecoveredTransition(
  current: HostDeferredCommandEnvelopeRecord,
  next: HostDeferredCommandEnvelopeRecord
): boolean {
  if (current.state === 'stored') {
    if (next.state === 'stored' || next.state === 'consumed') {
      return commandsMatch(current.command, next.command)
    }
    return next.state === 'quarantined'
  }
  if (current.state === 'consumed') {
    return next.state === 'consumed' && commandsMatch(current.command, next.command)
  }
  return next.state === 'quarantined'
}

function commandsMatch(left: HostCommand | undefined, right: HostCommand | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function quarantineRecord(
  record: HostDeferredCommandEnvelopeRecord,
  quarantineCode: HostDeferredCommandEnvelopeQuarantineCode
): HostDeferredCommandEnvelopeRecord {
  const quarantined: HostDeferredCommandEnvelopeRecord = {
    ...record,
    state: 'quarantined',
    terminalAt: record.terminalAt ?? record.updatedAt,
    quarantineCode
  }
  delete quarantined.command
  return quarantined
}

function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  if (normalized !== value || !COMMAND_FINGERPRINT_RE.test(normalized)) return null
  return normalized
}

function isQuarantineCode(value: unknown): value is HostDeferredCommandEnvelopeQuarantineCode {
  return (
    value === 'verification_failed' ||
    value === 'body_missing' ||
    value === 'fingerprint_mismatch' ||
    value === 'actor_mismatch' ||
    value === 'corrupt_record'
  )
}

function isBoundedTimestamp(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TIMESTAMP_CHARS
}

function cloneActor(actor: HostActorIdentity): HostActorIdentity {
  return {
    actorId: actor.actorId,
    clientId: actor.clientId,
    clientClass: actor.clientClass
  }
}

function cloneCommand(command: HostCommand): HostCommand {
  return JSON.parse(JSON.stringify(command)) as HostCommand
}

function cloneRecord(record: HostDeferredCommandEnvelopeRecord): HostDeferredCommandEnvelopeRecord {
  return JSON.parse(JSON.stringify(record)) as HostDeferredCommandEnvelopeRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch {
    // Directory fsync is best-effort across supported host filesystems.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
