/**
 * Durable Host deferred-command correlation + resolution bridge (Wave 2D-2 Lane E).
 *
 * Crash-safe bounded journal + checkpoint under an injected data directory.
 * Correlates a pending Host command (commandId + fingerprint + name + actor)
 * with a compact challenge id (approval/question) so a later allow/deny/cancel
 * can resume without inventing a new attempt.
 *
 * Persistence is compact only: IDs, fingerprint, command name, actor, challenge,
 * state, timestamps, and terminal codes. Never credentials, raw args, tool
 * output, hidden reasoning, diffs, or unrestricted transcript/file content.
 *
 * Orchestration ports are injected callbacks — this module does not import or
 * mutate HostCommandReceiptStore / HostDeltaStore. Not wired into
 * AppStoreHostAuthority or composition roots yet.
 *
 * Reopen policy:
 * - `awaiting` (pre-execution) survives reopen and may still be resolved.
 * - `execution_claimed` (execution may have begun) becomes explicit
 *   `indeterminate` and can never execute again.
 */

import { randomUUID } from 'node:crypto'
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

import type { HostClientClass, HostCommandName } from '../shared/hostProtocol'

export const HOST_DEFERRED_COMMAND_SCHEMA_VERSION = 1 as const
export const HOST_DEFERRED_COMMAND_CHECKPOINT_FILENAME = 'deferred-commands.checkpoint.json'
export const HOST_DEFERRED_COMMAND_JOURNAL_FILENAME = 'deferred-commands.journal.jsonl'

/** Default bound on retained deferred records after compaction. */
export const DEFAULT_HOST_DEFERRED_COMMAND_MAX_RECORDS = 2000

/** Default journal record count before compaction is attempted. */
export const DEFAULT_HOST_DEFERRED_COMMAND_COMPACT_AFTER_RECORDS = 256

const MAX_ID_CHARS = 200
const MAX_TERMINAL_CODE_CHARS = 80
const MAX_EFFECTS = 32
const MAX_EFFECT_KIND_CHARS = 80
const MAX_EFFECT_SUMMARY_CHARS = 200

const COMMAND_FINGERPRINT_HEX_RE = /^[a-f0-9]{64}$/

const HOST_COMMAND_NAME_SET = new Set<string>([
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'channel.member.revoke',
  'channel.close',
  'thread.select',
  'ping'
])

export type HostDeferredCommandState =
  | 'awaiting'
  | 'execution_claimed'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'indeterminate'

export type HostDeferredChallengeKind = 'approval' | 'question'

export type HostDeferredDecision = 'allow' | 'deny' | 'cancel'

export type HostDeferredCommandActor = {
  clientId: string
  actorId: string
  clientClass: HostClientClass
}

/** Compact domain-effect DTO published after a successful allow-path execution. */
export type HostDeferredCompactEffect = {
  kind: string
  entityId?: string
  summaryCode?: string
}

export type HostDeferredCommandRecord = {
  schemaVersion: typeof HOST_DEFERRED_COMMAND_SCHEMA_VERSION
  deferredId: string
  commandId: string
  idempotencyKey: string
  commandFingerprint: string
  commandName: HostCommandName
  actor: HostDeferredCommandActor
  challengeId: string
  challengeKind: HostDeferredChallengeKind
  state: HostDeferredCommandState
  createdAt: string
  updatedAt: string
  completedAt?: string
  terminalCode?: string
  decision?: HostDeferredDecision
}

export type HostDeferredCommandRegisterInput = {
  deferredId?: string
  commandId: string
  idempotencyKey: string
  commandFingerprint: string
  commandName: HostCommandName
  actor: HostDeferredCommandActor
  challengeId: string
  challengeKind: HostDeferredChallengeKind
  createdAt?: string
}

export type HostDeferredCommandResolveInput = {
  challengeId: string
  actor: HostDeferredCommandActor
  decision: HostDeferredDecision
  /**
   * Optional exact command binding. When supplied, must match the durable
   * record or the resolve fails closed.
   */
  commandId?: string
  commandFingerprint?: string
}

export type HostDeferredCommandLookupResult =
  | { kind: 'found'; record: HostDeferredCommandRecord }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }

export type HostDeferredCommandRegisterResult =
  | { kind: 'created'; record: HostDeferredCommandRecord }
  | { kind: 'existing'; record: HostDeferredCommandRecord }
  | { kind: 'actor_denied' }
  | {
      kind: 'conflict'
      reason:
        | 'challenge_mismatch'
        | 'command_mismatch'
        | 'deferred_id_mismatch'
        | 'challenge_occupied'
      existing?: HostDeferredCommandRecord
    }

export type HostDeferredCommandResolveResult =
  | { kind: 'completed'; record: HostDeferredCommandRecord }
  | { kind: 'existing'; record: HostDeferredCommandRecord }
  | { kind: 'not_found' }
  | { kind: 'actor_mismatch' }
  | { kind: 'command_mismatch' }
  | { kind: 'indeterminate'; record: HostDeferredCommandRecord }
  | { kind: 'not_awaiting'; record: HostDeferredCommandRecord }
  | {
      kind: 'failed'
      code:
        | 'claim_failed'
        | 'executor_failed'
        | 'effects_failed'
        | 'receipt_failed'
        | 'invalid_decision'
      record?: HostDeferredCommandRecord
    }

export type HostDeferredExecutorResult = {
  status: 'succeeded' | 'failed' | 'cancelled'
  terminalCode?: string
  effects?: HostDeferredCompactEffect[]
}

export type HostDeferredCompleteReceiptInput = {
  commandId: string
  status: 'succeeded' | 'failed' | 'denied' | 'cancelled'
  terminalCode?: string
  actor: HostDeferredCommandActor
  commandFingerprint: string
  commandName: HostCommandName
}

export type HostDeferredPublishEffectsInput = {
  commandId: string
  deferredId: string
  effects: HostDeferredCompactEffect[]
  actor: HostDeferredCommandActor
}

export type HostDeferredExecuteCommandInput = {
  commandId: string
  deferredId: string
  commandFingerprint: string
  commandName: HostCommandName
  actor: HostDeferredCommandActor
  challengeId: string
  challengeKind: HostDeferredChallengeKind
}

/**
 * Injected orchestration ports. Implementations may wrap receipt/delta stores;
 * this bridge never imports those modules.
 */
export type HostDeferredCommandBridgePorts = {
  completeReceipt: (input: HostDeferredCompleteReceiptInput) => void | Promise<void>
  executeCommand: (
    input: HostDeferredExecuteCommandInput
  ) => HostDeferredExecutorResult | Promise<HostDeferredExecutorResult>
  publishEffects: (input: HostDeferredPublishEffectsInput) => void | Promise<void>
}

export interface HostDeferredCommandBridgeOptions {
  dataDir: string
  ports: HostDeferredCommandBridgePorts
  maxRecords?: number
  compactAfterRecords?: number
  now?: () => string
  log?: (line: string) => void
}

interface CheckpointDocument {
  schemaVersion: typeof HOST_DEFERRED_COMMAND_SCHEMA_VERSION
  updatedAt: string
  records: HostDeferredCommandRecord[]
}

type JournalEvent =
  | { op: 'upsert'; record: HostDeferredCommandRecord }
  | { op: 'compact'; retainedDeferredIds: string[]; at: string }

export class HostDeferredCommandBridge {
  private readonly dataDir: string
  private readonly checkpointPath: string
  private readonly journalPath: string
  private readonly maxRecords: number
  private readonly compactAfterRecords: number
  private readonly ports: HostDeferredCommandBridgePorts
  private readonly now: () => string
  private readonly log: (line: string) => void

  private recordsByDeferredId = new Map<string, HostDeferredCommandRecord>()
  private deferredIdByChallengeId = new Map<string, string>()
  private deferredIdByCommandId = new Map<string, string>()
  private journalRecordCount = 0
  /** In-process lock so concurrent resolve cannot double-execute. */
  private resolveInFlight = new Set<string>()

  constructor(options: HostDeferredCommandBridgeOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostDeferredCommandBridge requires an injected dataDir')
    }
    if (!options.ports || typeof options.ports !== 'object') {
      throw new Error('HostDeferredCommandBridge requires injected ports')
    }
    if (typeof options.ports.completeReceipt !== 'function') {
      throw new Error('HostDeferredCommandBridge requires ports.completeReceipt')
    }
    if (typeof options.ports.executeCommand !== 'function') {
      throw new Error('HostDeferredCommandBridge requires ports.executeCommand')
    }
    if (typeof options.ports.publishEffects !== 'function') {
      throw new Error('HostDeferredCommandBridge requires ports.publishEffects')
    }

    this.dataDir = options.dataDir
    this.checkpointPath = join(this.dataDir, HOST_DEFERRED_COMMAND_CHECKPOINT_FILENAME)
    this.journalPath = join(this.dataDir, HOST_DEFERRED_COMMAND_JOURNAL_FILENAME)
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_HOST_DEFERRED_COMMAND_MAX_RECORDS)
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_HOST_DEFERRED_COMMAND_COMPACT_AFTER_RECORDS
    )
    this.ports = options.ports
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = options.log ?? (() => {})
    this.reopen()
  }

  /**
   * Re-read checkpoint + journal. `awaiting` survives. Any `execution_claimed`
   * row is promoted to explicit indeterminate and can never execute again.
   */
  reopen(): void {
    this.recordsByDeferredId = new Map()
    this.deferredIdByChallengeId = new Map()
    this.deferredIdByCommandId = new Map()
    this.journalRecordCount = 0
    this.resolveInFlight.clear()

    for (const record of this.readCheckpoint()) {
      this.indexRecord(record)
    }

    for (const event of this.readJournal()) {
      this.journalRecordCount += 1
      if (event.op === 'upsert') {
        this.indexRecord(event.record)
      } else if (event.op === 'compact') {
        const retain = new Set(event.retainedDeferredIds)
        for (const deferredId of [...this.recordsByDeferredId.keys()]) {
          if (!retain.has(deferredId)) {
            const existing = this.recordsByDeferredId.get(deferredId)
            if (existing) {
              this.unindexRecord(existing)
            }
          }
        }
      }
    }

    let claimedPromoted = false
    for (const [, record] of this.recordsByDeferredId) {
      if (record.state === 'execution_claimed') {
        const promoted: HostDeferredCommandRecord = {
          ...record,
          state: 'indeterminate',
          terminalCode: 'execution_may_have_begun',
          updatedAt: this.now(),
          completedAt: this.now()
        }
        this.indexRecord(promoted)
        this.appendJournalEvent({ op: 'upsert', record: promoted })
        claimedPromoted = true
      }
    }
    if (claimedPromoted) {
      this.maybeCompact()
    }
  }

  get size(): number {
    return this.recordsByDeferredId.size
  }

  /** Host-internal listing for recovery summaries — not a client access path. */
  list(): HostDeferredCommandRecord[] {
    return [...this.recordsByDeferredId.values()]
      .map(cloneRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getByChallengeId(
    challengeId: string,
    actor: HostDeferredCommandActor
  ): HostDeferredCommandLookupResult {
    const id = normalizeId(challengeId, 'challengeId')
    const deferredId = this.deferredIdByChallengeId.get(id)
    if (!deferredId) return { kind: 'not_found' }
    return this.getByDeferredId(deferredId, actor)
  }

  getByCommandId(
    commandId: string,
    actor: HostDeferredCommandActor
  ): HostDeferredCommandLookupResult {
    const id = normalizeId(commandId, 'commandId')
    const deferredId = this.deferredIdByCommandId.get(id)
    if (!deferredId) return { kind: 'not_found' }
    return this.getByDeferredId(deferredId, actor)
  }

  getByDeferredId(
    deferredId: string,
    actor: HostDeferredCommandActor
  ): HostDeferredCommandLookupResult {
    const id = normalizeId(deferredId, 'deferredId')
    const record = this.recordsByDeferredId.get(id)
    if (!record) return { kind: 'not_found' }
    if (!actorsMatch(record.actor, normalizeExactActor(actor))) {
      return { kind: 'actor_mismatch' }
    }
    return { kind: 'found', record: cloneRecord(record) }
  }

  /**
   * Register a deferred command ↔ challenge correlation in `awaiting` state.
   * Exact repeats with matching actor return the existing row. Mismatches fail
   * closed as conflict / actor_denied.
   */
  register(input: HostDeferredCommandRegisterInput): HostDeferredCommandRegisterResult {
    const commandId = normalizeId(input.commandId, 'commandId')
    const idempotencyKey = normalizeId(input.idempotencyKey, 'idempotencyKey')
    const commandFingerprint = normalizeFingerprint(input.commandFingerprint)
    const commandName = normalizeCommandName(input.commandName)
    const actor = normalizeExactActor(input.actor)
    const challengeId = normalizeId(input.challengeId, 'challengeId')
    const challengeKind = normalizeChallengeKind(input.challengeKind)
    const deferredId = input.deferredId ? normalizeId(input.deferredId, 'deferredId') : randomUUID()

    const byDeferred = this.recordsByDeferredId.get(deferredId)
    if (byDeferred) {
      return this.matchExistingRegistration(byDeferred, {
        deferredId,
        commandId,
        idempotencyKey,
        commandFingerprint,
        commandName,
        actor,
        challengeId,
        challengeKind
      })
    }

    const byChallenge = this.deferredIdByChallengeId.get(challengeId)
    if (byChallenge) {
      const existing = this.recordsByDeferredId.get(byChallenge)
      if (existing) {
        return this.matchExistingRegistration(existing, {
          deferredId,
          commandId,
          idempotencyKey,
          commandFingerprint,
          commandName,
          actor,
          challengeId,
          challengeKind
        })
      }
    }

    const byCommand = this.deferredIdByCommandId.get(commandId)
    if (byCommand) {
      const existing = this.recordsByDeferredId.get(byCommand)
      if (existing) {
        return this.matchExistingRegistration(existing, {
          deferredId,
          commandId,
          idempotencyKey,
          commandFingerprint,
          commandName,
          actor,
          challengeId,
          challengeKind
        })
      }
    }

    const createdAt = input.createdAt ?? this.now()
    const record: HostDeferredCommandRecord = {
      schemaVersion: HOST_DEFERRED_COMMAND_SCHEMA_VERSION,
      deferredId,
      commandId,
      idempotencyKey,
      commandFingerprint,
      commandName,
      actor,
      challengeId,
      challengeKind,
      state: 'awaiting',
      createdAt,
      updatedAt: createdAt
    }

    this.indexRecord(record)
    this.appendJournalEvent({ op: 'upsert', record })
    this.maybeCompact()
    return { kind: 'created', record: cloneRecord(record) }
  }

  /**
   * Resolve an awaiting deferred command.
   *
   * allow: durable claim → execute once → publish compact effects → complete
   *        original receipt → terminalize.
   * deny / cancel: no executor / effects → complete original receipt → terminalize.
   */
  async resolve(input: HostDeferredCommandResolveInput): Promise<HostDeferredCommandResolveResult> {
    const challengeId = normalizeId(input.challengeId, 'challengeId')
    const actor = normalizeExactActor(input.actor)
    const decision = normalizeDecision(input.decision)

    const deferredId = this.deferredIdByChallengeId.get(challengeId)
    if (!deferredId) return { kind: 'not_found' }

    const current = this.recordsByDeferredId.get(deferredId)
    if (!current) return { kind: 'not_found' }

    if (!actorsMatch(current.actor, actor)) {
      return { kind: 'actor_mismatch' }
    }

    if (input.commandId !== undefined) {
      const commandId = normalizeId(input.commandId, 'commandId')
      if (commandId !== current.commandId) {
        return { kind: 'command_mismatch' }
      }
    }
    if (input.commandFingerprint !== undefined) {
      const fingerprint = normalizeFingerprint(input.commandFingerprint)
      if (fingerprint !== current.commandFingerprint) {
        return { kind: 'command_mismatch' }
      }
    }

    if (current.state === 'indeterminate') {
      return { kind: 'indeterminate', record: cloneRecord(current) }
    }

    if (
      current.state === 'succeeded' ||
      current.state === 'failed' ||
      current.state === 'denied' ||
      current.state === 'cancelled'
    ) {
      if (current.decision === decision) {
        return { kind: 'existing', record: cloneRecord(current) }
      }
      return { kind: 'not_awaiting', record: cloneRecord(current) }
    }

    if (current.state === 'execution_claimed') {
      // Live process still holding a claim — do not double-execute.
      return { kind: 'not_awaiting', record: cloneRecord(current) }
    }

    if (current.state !== 'awaiting') {
      return { kind: 'not_awaiting', record: cloneRecord(current) }
    }

    if (this.resolveInFlight.has(deferredId)) {
      return { kind: 'not_awaiting', record: cloneRecord(current) }
    }
    this.resolveInFlight.add(deferredId)

    try {
      if (decision === 'deny' || decision === 'cancel') {
        return await this.resolveWithoutExecution(current, decision)
      }
      if (decision === 'allow') {
        return await this.resolveAllow(current)
      }
      return { kind: 'failed', code: 'invalid_decision', record: cloneRecord(current) }
    } finally {
      this.resolveInFlight.delete(deferredId)
    }
  }

  compact(): void {
    this.writeCheckpointAndResetJournal()
  }

  private async resolveWithoutExecution(
    current: HostDeferredCommandRecord,
    decision: 'deny' | 'cancel'
  ): Promise<HostDeferredCommandResolveResult> {
    const receiptStatus = decision === 'deny' ? 'denied' : 'cancelled'
    const terminalCode = decision === 'deny' ? 'authority_denied' : 'authority_cancelled'
    try {
      await this.ports.completeReceipt({
        commandId: current.commandId,
        status: receiptStatus,
        terminalCode,
        actor: current.actor,
        commandFingerprint: current.commandFingerprint,
        commandName: current.commandName
      })
    } catch {
      return { kind: 'failed', code: 'receipt_failed', record: cloneRecord(current) }
    }

    const completedAt = this.now()
    const next: HostDeferredCommandRecord = {
      ...current,
      state: receiptStatus,
      decision,
      terminalCode,
      updatedAt: completedAt,
      completedAt
    }
    this.persist(next)
    return { kind: 'completed', record: cloneRecord(next) }
  }

  private async resolveAllow(
    current: HostDeferredCommandRecord
  ): Promise<HostDeferredCommandResolveResult> {
    // 1) Durable claim BEFORE any executor side effect.
    const claimedAt = this.now()
    const claimed: HostDeferredCommandRecord = {
      ...current,
      state: 'execution_claimed',
      decision: 'allow',
      updatedAt: claimedAt
    }
    try {
      this.persist(claimed)
    } catch {
      return { kind: 'failed', code: 'claim_failed', record: cloneRecord(current) }
    }

    // 2) Executor at most once.
    let executorResult: HostDeferredExecutorResult
    try {
      executorResult = await this.ports.executeCommand({
        commandId: claimed.commandId,
        deferredId: claimed.deferredId,
        commandFingerprint: claimed.commandFingerprint,
        commandName: claimed.commandName,
        actor: claimed.actor,
        challengeId: claimed.challengeId,
        challengeKind: claimed.challengeKind
      })
    } catch {
      const failed = this.terminalizeClaimed(claimed, 'failed', 'executor_threw')
      return { kind: 'failed', code: 'executor_failed', record: failed }
    }

    if (
      !executorResult ||
      (executorResult.status !== 'succeeded' &&
        executorResult.status !== 'failed' &&
        executorResult.status !== 'cancelled')
    ) {
      const failed = this.terminalizeClaimed(claimed, 'failed', 'executor_invalid_result')
      return { kind: 'failed', code: 'executor_failed', record: failed }
    }

    let effects: HostDeferredCompactEffect[] = []
    try {
      effects = normalizeEffects(executorResult.effects ?? [])
    } catch {
      const failed = this.terminalizeClaimed(claimed, 'failed', 'executor_invalid_effects')
      return { kind: 'failed', code: 'executor_failed', record: failed }
    }

    // 3) Publish compact effects only after a successful executor result.
    if (executorResult.status === 'succeeded' && effects.length > 0) {
      try {
        await this.ports.publishEffects({
          commandId: claimed.commandId,
          deferredId: claimed.deferredId,
          effects,
          actor: claimed.actor
        })
      } catch {
        const failed = this.terminalizeClaimed(claimed, 'failed', 'effects_threw')
        return { kind: 'failed', code: 'effects_failed', record: failed }
      }
    }

    // 4) Complete the original receipt, then terminalize the bridge row.
    const terminalCode =
      executorResult.terminalCode !== undefined
        ? truncateText(executorResult.terminalCode, MAX_TERMINAL_CODE_CHARS)
        : executorResult.status === 'succeeded'
          ? 'executed'
          : executorResult.status

    try {
      await this.ports.completeReceipt({
        commandId: claimed.commandId,
        status: executorResult.status,
        terminalCode,
        actor: claimed.actor,
        commandFingerprint: claimed.commandFingerprint,
        commandName: claimed.commandName
      })
    } catch {
      const failed = this.terminalizeClaimed(claimed, 'failed', 'receipt_threw')
      return { kind: 'failed', code: 'receipt_failed', record: failed }
    }

    const completed = this.terminalizeClaimed(claimed, executorResult.status, terminalCode)
    return { kind: 'completed', record: completed }
  }

  private terminalizeClaimed(
    claimed: HostDeferredCommandRecord,
    state: 'succeeded' | 'failed' | 'cancelled',
    terminalCode: string
  ): HostDeferredCommandRecord {
    const completedAt = this.now()
    const next: HostDeferredCommandRecord = {
      ...claimed,
      state,
      decision: 'allow',
      terminalCode: truncateText(terminalCode, MAX_TERMINAL_CODE_CHARS),
      updatedAt: completedAt,
      completedAt
    }
    this.persist(next)
    return cloneRecord(next)
  }

  private matchExistingRegistration(
    existing: HostDeferredCommandRecord,
    attempted: {
      deferredId: string
      commandId: string
      idempotencyKey: string
      commandFingerprint: string
      commandName: HostCommandName
      actor: HostDeferredCommandActor
      challengeId: string
      challengeKind: HostDeferredChallengeKind
    }
  ): HostDeferredCommandRegisterResult {
    const sameCore =
      existing.commandId === attempted.commandId &&
      existing.idempotencyKey === attempted.idempotencyKey &&
      existing.commandFingerprint === attempted.commandFingerprint &&
      existing.commandName === attempted.commandName &&
      existing.challengeId === attempted.challengeId &&
      existing.challengeKind === attempted.challengeKind

    if (sameCore) {
      if (!actorsMatch(existing.actor, attempted.actor)) {
        return { kind: 'actor_denied' }
      }
      return { kind: 'existing', record: cloneRecord(existing) }
    }

    if (existing.deferredId === attempted.deferredId) {
      const conflict: HostDeferredCommandRegisterResult = {
        kind: 'conflict',
        reason: 'deferred_id_mismatch'
      }
      if (actorsMatch(existing.actor, attempted.actor)) {
        conflict.existing = cloneRecord(existing)
      }
      return conflict
    }

    if (existing.challengeId === attempted.challengeId) {
      const conflict: HostDeferredCommandRegisterResult = {
        kind: 'conflict',
        reason:
          existing.commandId === attempted.commandId ? 'command_mismatch' : 'challenge_occupied'
      }
      if (actorsMatch(existing.actor, attempted.actor)) {
        conflict.existing = cloneRecord(existing)
      }
      return conflict
    }

    const conflict: HostDeferredCommandRegisterResult = {
      kind: 'conflict',
      reason: 'command_mismatch'
    }
    if (actorsMatch(existing.actor, attempted.actor)) {
      conflict.existing = cloneRecord(existing)
    }
    return conflict
  }

  private persist(record: HostDeferredCommandRecord): void {
    this.indexRecord(record)
    this.appendJournalEvent({ op: 'upsert', record })
    this.maybeCompact()
  }

  private indexRecord(record: HostDeferredCommandRecord): void {
    this.recordsByDeferredId.set(record.deferredId, record)
    this.deferredIdByChallengeId.set(record.challengeId, record.deferredId)
    this.deferredIdByCommandId.set(record.commandId, record.deferredId)
  }

  private unindexRecord(record: HostDeferredCommandRecord): void {
    this.recordsByDeferredId.delete(record.deferredId)
    if (this.deferredIdByChallengeId.get(record.challengeId) === record.deferredId) {
      this.deferredIdByChallengeId.delete(record.challengeId)
    }
    if (this.deferredIdByCommandId.get(record.commandId) === record.deferredId) {
      this.deferredIdByCommandId.delete(record.commandId)
    }
  }

  private maybeCompact(): void {
    if (
      this.journalRecordCount >= this.compactAfterRecords ||
      this.recordsByDeferredId.size > this.maxRecords
    ) {
      this.writeCheckpointAndResetJournal()
    }
  }

  private selectRecordsForRetention(all: HostDeferredCommandRecord[]): HostDeferredCommandRecord[] {
    if (all.length <= this.maxRecords) return all
    // Prefer non-terminal awaiting / claimed, then newest updatedAt.
    const rank = (r: HostDeferredCommandRecord): number => {
      if (r.state === 'awaiting') return 0
      if (r.state === 'execution_claimed') return 1
      if (r.state === 'indeterminate') return 2
      return 3
    }
    return [...all]
      .sort((a, b) => {
        const byRank = rank(a) - rank(b)
        if (byRank !== 0) return byRank
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
        if (byUpdated !== 0) return byUpdated
        return b.createdAt.localeCompare(a.createdAt)
      })
      .slice(0, this.maxRecords)
  }

  private writeCheckpointAndResetJournal(): void {
    const records = this.selectRecordsForRetention([...this.recordsByDeferredId.values()])

    this.recordsByDeferredId = new Map()
    this.deferredIdByChallengeId = new Map()
    this.deferredIdByCommandId = new Map()
    for (const record of records) {
      this.indexRecord(record)
    }

    const doc: CheckpointDocument = {
      schemaVersion: HOST_DEFERRED_COMMAND_SCHEMA_VERSION,
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
        `[HostDeferredCommandBridge] journal reset failed: ${
          err instanceof Error ? err.message : String(err)
        }`
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

  private readCheckpoint(): HostDeferredCommandRecord[] {
    if (!existsSync(this.checkpointPath)) return []
    try {
      const raw = readFileSync(this.checkpointPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log('[HostDeferredCommandBridge] checkpoint malformed; starting empty')
        return []
      }
      const doc = parsed as Partial<CheckpointDocument>
      if (
        doc.schemaVersion !== HOST_DEFERRED_COMMAND_SCHEMA_VERSION ||
        !Array.isArray(doc.records)
      ) {
        this.log('[HostDeferredCommandBridge] checkpoint schema mismatch; starting empty')
        return []
      }
      return doc.records
        .map(normalizeStoredRecord)
        .filter((r): r is HostDeferredCommandRecord => r !== null)
    } catch (err) {
      this.log(
        `[HostDeferredCommandBridge] checkpoint load failed: ${
          err instanceof Error ? err.message : String(err)
        }`
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
        `[HostDeferredCommandBridge] journal read failed: ${
          err instanceof Error ? err.message : String(err)
        }`
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
          this.log('[HostDeferredCommandBridge] dropped truncated journal tail')
          break
        }
        this.log(`[HostDeferredCommandBridge] skipped corrupt journal line at index ${index}`)
      }
    }
    return events
  }
}

function cloneRecord(record: HostDeferredCommandRecord): HostDeferredCommandRecord {
  return JSON.parse(JSON.stringify(record)) as HostDeferredCommandRecord
}

function actorsMatch(a: HostDeferredCommandActor, b: HostDeferredCommandActor): boolean {
  return a.clientId === b.clientId && a.actorId === b.actorId && a.clientClass === b.clientClass
}

function normalizeId(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`HostDeferredCommandBridge: ${field} is required`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_CHARS) {
    throw new Error(`HostDeferredCommandBridge: ${field} is invalid`)
  }
  if (trimmed !== value) {
    throw new Error(`HostDeferredCommandBridge: ${field} must not have leading/trailing whitespace`)
  }
  return trimmed
}

function normalizeFingerprint(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('HostDeferredCommandBridge: commandFingerprint is required')
  }
  const trimmed = value.trim().toLowerCase()
  if (!COMMAND_FINGERPRINT_HEX_RE.test(trimmed)) {
    throw new Error(
      'HostDeferredCommandBridge: commandFingerprint must be a 64-char lowercase hex SHA-256 digest'
    )
  }
  return trimmed
}

function normalizeCommandName(value: unknown): HostCommandName {
  if (typeof value !== 'string' || !HOST_COMMAND_NAME_SET.has(value)) {
    throw new Error('HostDeferredCommandBridge: commandName is invalid')
  }
  return value as HostCommandName
}

function normalizeExactActor(actor: HostDeferredCommandActor): HostDeferredCommandActor {
  const clientId = normalizeId(actor.clientId, 'actor.clientId')
  const actorId = normalizeId(actor.actorId, 'actor.actorId')
  if (!isClientClass(actor.clientClass)) {
    throw new Error('HostDeferredCommandBridge: actor.clientClass is required')
  }
  return { clientId, actorId, clientClass: actor.clientClass }
}

function isClientClass(value: unknown): value is HostClientClass {
  return value === 'desktop' || value === 'tui' || value === 'ios' || value === 'test'
}

function normalizeChallengeKind(value: unknown): HostDeferredChallengeKind {
  if (value === 'approval' || value === 'question') return value
  throw new Error('HostDeferredCommandBridge: challengeKind must be approval|question')
}

function normalizeDecision(value: unknown): HostDeferredDecision {
  if (value === 'allow' || value === 'deny' || value === 'cancel') return value
  throw new Error('HostDeferredCommandBridge: decision must be allow|deny|cancel')
}

function truncateText(value: string, max: number): string {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : value.slice(0, max)
}

function normalizeEffects(effects: HostDeferredCompactEffect[]): HostDeferredCompactEffect[] {
  if (!Array.isArray(effects)) {
    throw new Error('HostDeferredCommandBridge: effects must be an array')
  }
  if (effects.length > MAX_EFFECTS) {
    throw new Error('HostDeferredCommandBridge: effects exceed bound')
  }
  const out: HostDeferredCompactEffect[] = []
  for (const effect of effects) {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      throw new Error('HostDeferredCommandBridge: effect is invalid')
    }
    const keys = Object.keys(effect).sort()
    for (const key of keys) {
      if (key !== 'kind' && key !== 'entityId' && key !== 'summaryCode') {
        throw new Error('HostDeferredCommandBridge: effect has unknown keys')
      }
    }
    if (typeof effect.kind !== 'string' || !effect.kind.trim()) {
      throw new Error('HostDeferredCommandBridge: effect.kind is required')
    }
    const kind = truncateText(effect.kind.trim(), MAX_EFFECT_KIND_CHARS)
    const next: HostDeferredCompactEffect = { kind }
    if (effect.entityId !== undefined) {
      next.entityId = normalizeId(effect.entityId, 'effect.entityId')
    }
    if (effect.summaryCode !== undefined) {
      if (typeof effect.summaryCode !== 'string' || !effect.summaryCode.trim()) {
        throw new Error('HostDeferredCommandBridge: effect.summaryCode is invalid')
      }
      next.summaryCode = truncateText(effect.summaryCode.trim(), MAX_EFFECT_SUMMARY_CHARS)
    }
    out.push(next)
  }
  return out
}

function normalizeStoredRecord(value: unknown): HostDeferredCommandRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  try {
    const actorRaw = raw.actor
    if (!actorRaw || typeof actorRaw !== 'object' || Array.isArray(actorRaw)) return null
    const actorObj = actorRaw as Record<string, unknown>
    const record: HostDeferredCommandRecord = {
      schemaVersion: HOST_DEFERRED_COMMAND_SCHEMA_VERSION,
      deferredId: normalizeId(String(raw.deferredId ?? ''), 'deferredId'),
      commandId: normalizeId(String(raw.commandId ?? ''), 'commandId'),
      idempotencyKey: normalizeId(String(raw.idempotencyKey ?? ''), 'idempotencyKey'),
      commandFingerprint: normalizeFingerprint(String(raw.commandFingerprint ?? '')),
      commandName: normalizeCommandName(raw.commandName),
      actor: normalizeExactActor({
        clientId: String(actorObj.clientId ?? ''),
        actorId: String(actorObj.actorId ?? ''),
        clientClass: actorObj.clientClass as HostClientClass
      }),
      challengeId: normalizeId(String(raw.challengeId ?? ''), 'challengeId'),
      challengeKind: normalizeChallengeKind(raw.challengeKind),
      state: normalizeStoredState(raw.state),
      createdAt: String(raw.createdAt ?? ''),
      updatedAt: String(raw.updatedAt ?? '')
    }
    if (typeof raw.completedAt === 'string') record.completedAt = raw.completedAt
    if (typeof raw.terminalCode === 'string') {
      record.terminalCode = truncateText(raw.terminalCode, MAX_TERMINAL_CODE_CHARS)
    }
    if (raw.decision !== undefined) {
      record.decision = normalizeDecision(raw.decision)
    }
    if (!record.createdAt || !record.updatedAt) return null
    // Reject privacy-shaped extras on stored rows.
    const allowed = new Set([
      'schemaVersion',
      'deferredId',
      'commandId',
      'idempotencyKey',
      'commandFingerprint',
      'commandName',
      'actor',
      'challengeId',
      'challengeKind',
      'state',
      'createdAt',
      'updatedAt',
      'completedAt',
      'terminalCode',
      'decision'
    ])
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) return null
    }
    return record
  } catch {
    return null
  }
}

function normalizeStoredState(value: unknown): HostDeferredCommandState {
  if (
    value === 'awaiting' ||
    value === 'execution_claimed' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'denied' ||
    value === 'cancelled' ||
    value === 'indeterminate'
  ) {
    return value
  }
  throw new Error('invalid state')
}

function parseJournalEvent(line: string): JournalEvent | null {
  const parsed: unknown = JSON.parse(line)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  if (raw.op === 'upsert') {
    const record = normalizeStoredRecord(raw.record)
    if (!record) throw new Error('invalid upsert record')
    return { op: 'upsert', record }
  }
  if (raw.op === 'compact') {
    if (!Array.isArray(raw.retainedDeferredIds) || typeof raw.at !== 'string') {
      throw new Error('invalid compact event')
    }
    const retainedDeferredIds = raw.retainedDeferredIds.map((id) =>
      normalizeId(String(id), 'retainedDeferredId')
    )
    return { op: 'compact', retainedDeferredIds, at: raw.at }
  }
  throw new Error('unknown journal op')
}
