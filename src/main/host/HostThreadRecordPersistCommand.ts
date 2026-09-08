/**
 * Desktop -> Host outbound client for `thread.record.persist`.
 *
 * WHY THIS EXISTS: since the Desktop cutover the legacy store writer gate is
 * Host-owned, so `AppStore.saveChat` can no longer write `chats/<id>.json`.
 * Ensemble round-start persistence must therefore travel to the Host. A raw
 * ChatRecord can exceed the authenticated control line (HostLocalServer's
 * MAX_LINE_BYTES is 256_000), so the record rides an owner-only transfer
 * artifact and the command carries only the bounded descriptor.
 *
 * SHAPE: copied from HostThreadKindCommand (the existing outbound precedent) —
 * broker submitCommand, receipt polling, desktop actor identity. Note that
 * HostBridgeCommandExecutor is the INBOUND Host->Desktop path and is not this
 * seam.
 *
 * THE SYNC/ASYNC PROBLEM THIS PORT SOLVES: `AppStore.saveChat` is synchronous
 * with 86 non-test callers, and `EnsembleOrchestrator.startRound` is synchronous
 * too, so neither can be made async. The port therefore offers a synchronous
 * `enqueue` plus an awaitable per-chat `drain`, letting a caller persist from a
 * sync path and still raise a real durability barrier before it dispatches
 * participants. `drain` rethrows the first typed failure rather than letting a
 * lost write pass silently.
 *
 * Per chat, work is serialized in revision order. Complete snapshots may
 * coalesce only when they share the exact same expected Host revision; entries
 * on different revisions form a FIFO CAS chain and can never be skipped.
 * Revision conflicts are offered to one bounded, injected rebase callback
 * inside the lane before a durability barrier can observe the failure.
 */

import { randomUUID } from 'node:crypto'

import {
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer
} from '../../host-runtime/HostThreadRecordTransfer'
import type {
  HostActorIdentity,
  HostCapability,
  HostCommand,
  HostCommandReceipt
} from '../../shared/hostProtocol'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID
} from '../../shared/hostProtocol'
import type { ChatRecord } from '../store/types'
import type {
  HostProjectionCommandResult,
  HostProjectionReceiptLookupResult
} from './HostProjectionBroker'
import { createHostProjectionBroker } from './HostProjectionBroker'

/**
 * IDENTITY IS LOAD-BEARING — do not give this client its own client id.
 *
 * HostThreadKindCommand uses a per-command client id, and that is fine for
 * `thread.configure`. It is NOT fine here: `thread.record.persist` overwrites a
 * whole chat record, so HostProductionAuthorityEvaluator.isExactDesktopInternalActor
 * admits exactly ONE identity and compares it three times — the authenticated
 * socket client, the call-context actor, and command.actor. A bespoke id is
 * denied in production while every unit test that injects its own actor still
 * passes. That mismatch shipped once; the factory tests below now pin it.
 */
/** Mirrors HostThreadKindCommand exactly: a proven submit + receipt-poll capability set. */
const PERSIST_HOST_CAPABILITIES = [
  'bootstrap',
  'commands',
  'receipts',
  'setup'
] as const satisfies readonly HostCapability[]

/**
 * The intersection of two independently authored bounds:
 *   - hostProtocol HOST_THREAD_RECORD_TRANSFER_ID_RE: /^[A-Za-z0-9][A-Za-z0-9_-]*$/
 *     (no dot, bounded only by HOST_PROTOCOL_MAX_ID = 512)
 *   - HostThreadRecordTransfer TRANSFER_ID_PATTERN: allows dot, bounded at 128
 * An id must satisfy BOTH: the wire rejects dots, the artifact layer rejects
 * anything past 128. Generated ids are validated against this intersection so a
 * future generator change cannot silently produce an id one layer refuses.
 */
const TRANSFER_ID_INTEROP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type HostThreadRecordPersistErrorCode =
  | 'invalid_input'
  | 'artifact_publish_failed'
  | 'host_unavailable'
  | 'host_timeout'
  | 'invalid_host_receipt'
  | 'revision_conflict'
  | 'host_rejected'

export class HostThreadRecordPersistError extends Error {
  readonly code: HostThreadRecordPersistErrorCode
  /** Raw Host error code when the Host rejected the command; preserved, never swallowed. */
  readonly hostErrorCode?: string
  readonly receipt?: HostCommandReceipt

  constructor(
    code: HostThreadRecordPersistErrorCode,
    message: string,
    options?: { hostErrorCode?: string; receipt?: HostCommandReceipt; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HostThreadRecordPersistError'
    this.code = code
    if (options?.hostErrorCode !== undefined) this.hostErrorCode = options.hostErrorCode
    if (options?.receipt !== undefined) this.receipt = options.receipt
  }
}

export interface HostThreadRecordPersistBrokerPort {
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
}

/** Injectable artifact seam so callers and tests can stage publish failures. */
export interface HostThreadRecordTransferPort {
  publish(input: { profilePath: string; transferId: string; record: unknown }): {
    transferId: string
    sha256: string
    byteLength: number
  }
  remove(input: { profilePath: string; transferId: string }): boolean
}

/**
 * Process-local, opt-in diagnostics. These are client observations, never Host
 * durable service spans or the full AppStore.awaitChatRecordPersisted barrier.
 * Context contains opaque correlation IDs only (no prompt, record or profile).
 * Starts without an end remain censored to the consumer; in particular the
 * existing receipt deadline starts only after submission/recovery returns.
 * No timer is added to bound a hung initial broker submission. A sink must not
 * mutate application state; synchronous sink cost remains on the caller's loop.
 */
export interface HostPersistenceDiagnosticContext {
  readonly requestId?: string
  /** Links materialization to client enqueue/attempts without retaining every caller. */
  readonly lineageId?: string
  readonly runId?: string
  readonly roundId?: string
  readonly participantId?: string
  readonly laneId?: string
}

export interface HostPersistenceObservationFields {
  readonly chatId?: string
  readonly context?: HostPersistenceDiagnosticContext
  readonly parentOperationId?: string | null
  readonly relatedOperationId?: string | null
  readonly commandId?: string
  readonly commandName?: HostCommand['name']
  readonly expectedRevision?: number
  readonly sequence?: number
  readonly relatedSequence?: number
  readonly reason?: 'blocked' | 'stale' | 'duplicate' | 'replaced' | 'staged' | 'deleting'
  readonly attempt?: number
  readonly count?: number
  readonly bytes?: number
  readonly requestedDelayMs?: number
  readonly receiptStatus?: HostCommandReceipt['status']
  readonly errorCode?: HostThreadRecordPersistErrorCode | 'unknown'
}

export interface HostPersistenceObservation extends HostPersistenceObservationFields {
  readonly schemaVersion: 1
  readonly process: 'main'
  readonly component: 'persist-client' | 'compatibility'
  readonly phase:
    | 'persist'
    | 'transfer_stage'
    | 'submit'
    | 'recovery_lookup'
    | 'poll_delay'
    | 'poll_lookup'
    | 'client_receipt_wait'
    | 'enqueue'
    | 'superseded'
    | 'retry'
    | 'drain'
    | 'stage'
    | 'materialize'
    | 'rebase'
    | 'barrier'
    | 'barrier_join'
    | 'barrier_quiet'
    | 'barrier_rejected'
  readonly operationId: string | null
  readonly outcome:
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'pending'
    | 'superseded'
    | 'joined'
    | 'skipped'
  readonly durationMs: number | null
  readonly timing: 'measured' | 'unavailable' | 'instant'
}

export interface HostPersistenceDiagnosticOptions {
  /** Must be nonblocking and observational. Async rejection is consumed, never awaited. */
  readonly observer?: (event: HostPersistenceObservation) => void | Promise<void>
  /** Independent of business timeout/issuedAt clocks. Never read without an observer. */
  readonly diagnosticNowMs?: () => number
  /** Independent of transfer/command IDs. Failures produce null correlation, not new work. */
  readonly diagnosticCreateId?: () => string
}

export interface HostPersistenceObservationOperation {
  readonly operationId: string | null
  finish(
    outcome: HostPersistenceObservation['outcome'],
    fields?: HostPersistenceObservationFields
  ): void
}

/**
 * Shared by the two existing client seams. Retains no event/ID lists. One small
 * token per live operation, plus one entry per existing queued item, is sufficient
 * for streamed joins/supersessions; the consumer owns bounded event retention.
 * No helper is constructed when the sink is absent. IDs are observer-local, not
 * authenticated run identity. Invalid clocks yield null durations, never zero.
 */
export class HostPersistenceDiagnostics {
  private lastTime: number | null = null
  private clockFaults = 0
  private readonly clock: () => number
  private readonly createId: () => string

  constructor(
    private readonly component: HostPersistenceObservation['component'],
    private readonly options: HostPersistenceDiagnosticOptions
  ) {
    this.clock = options.diagnosticNowMs ?? (() => performance.now())
    this.createId = options.diagnosticCreateId ?? randomUUID
  }

  private time(): number | null {
    try {
      const value = this.clock()
      if (!Number.isFinite(value) || value < 0 || (this.lastTime !== null && value < this.lastTime))
        throw new Error('Invalid diagnostic clock')
      this.lastTime = value
      return value
    } catch {
      this.clockFaults += 1
      return null
    }
  }

  private id(): string | null {
    try {
      const value = this.createId()
      return typeof value === 'string' && value.trim() && value.length <= 256 ? value : null
    } catch {
      return null
    }
  }

  context(
    context?: HostPersistenceDiagnosticContext,
    lineageId?: string | null
  ): HostPersistenceDiagnosticContext {
    const copied: Record<string, string> = {}
    for (const key of [
      'requestId',
      'runId',
      'roundId',
      'participantId',
      'laneId',
      'lineageId'
    ] as const) {
      try {
        const value = context?.[key]
        if (typeof value === 'string' && value.trim() && value.length <= 256) copied[key] = value
      } catch {
        // Unreadable diagnostic metadata cannot affect persistence.
      }
    }
    if (lineageId) copied.lineageId = lineageId
    return Object.freeze(copied)
  }

  private fields(input: HostPersistenceObservationFields): HostPersistenceObservationFields {
    const { context, ...fields } = input
    // Call sites supply scalar fields only. Bound IDs without truncating them
    // into another identity; missing IDs remain uncorrelated diagnostics.
    for (const key of ['chatId', 'commandId', 'parentOperationId', 'relatedOperationId'] as const) {
      const value = fields[key]
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== 'string' || !value.trim() || value.length > 512)
      )
        delete fields[key]
    }
    return context ? { ...fields, context: this.context(context) } : fields
  }

  private emit(event: HostPersistenceObservation): void {
    try {
      const result = this.options.observer?.(Object.freeze(event))
      if (result) void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Diagnostics never replace the original persistence outcome.
    }
  }

  begin(
    phase: HostPersistenceObservation['phase'],
    fields: HostPersistenceObservationFields
  ): HostPersistenceObservationOperation {
    const operationId = this.id()
    const safeFields = this.fields(fields)
    const started = this.time()
    const faults = this.clockFaults
    const base = {
      ...safeFields,
      schemaVersion: 1 as const,
      process: 'main' as const,
      component: this.component,
      phase,
      operationId
    }
    this.emit({ ...base, outcome: 'started', durationMs: null, timing: 'instant' })
    let finished = false
    return {
      operationId,
      finish: (outcome, extra = {}) => {
        if (finished) return
        finished = true
        const ended = this.time()
        const valid = started !== null && ended !== null && faults === this.clockFaults
        this.emit({
          ...base,
          ...this.fields(extra),
          outcome,
          durationMs: valid ? ended - started : null,
          timing: valid ? 'measured' : 'unavailable'
        })
      }
    }
  }

  event(
    phase: HostPersistenceObservation['phase'],
    outcome: HostPersistenceObservation['outcome'],
    fields: HostPersistenceObservationFields
  ): string | null {
    const operationId = this.id()
    this.emit({
      ...this.fields(fields),
      schemaVersion: 1,
      process: 'main',
      component: this.component,
      phase,
      operationId,
      outcome,
      durationMs: null,
      timing: 'instant'
    })
    return operationId
  }
}

/** Error messages, causes, receipts and provider contents never enter telemetry. */
function diagnosticError(error: unknown): HostPersistenceObservationFields {
  return { errorCode: error instanceof HostThreadRecordPersistError ? error.code : 'unknown' }
}

export interface HostThreadRecordPersistInput {
  readonly chatId: string
  readonly record: ChatRecord
  readonly expectedRevision: number
  readonly diagnosticContext?: HostPersistenceDiagnosticContext
}

/** The seam the AppStore/orchestrator slice depends on. That slice owns its own files. */
export interface HostThreadRecordPersistPort {
  /** Awaited single persist. Throws HostThreadRecordPersistError on any failure. */
  persist(input: HostThreadRecordPersistInput): Promise<HostCommandReceipt>
  /** Synchronous hand-off for sync call sites such as AppStore.saveChat. Never throws. */
  enqueue(input: HostThreadRecordPersistInput): void
  /** Durability barrier: resolves when this chat is quiet, rethrows the first failure. */
  drain(chatId: string): Promise<void>
  /** Barrier across every chat with outstanding work. */
  drainAll(): Promise<void>
  /** Outstanding queued/in-flight entries for a chat. */
  pending(chatId: string): number
}

export interface HostThreadRecordDeleteInput {
  readonly chatId: string
  readonly expectedRevision: number
}

/**
 * Deletion is a SEPARATE port on purpose.
 *
 * The persist consumers — the ensemble durability barrier and the shutdown
 * drain — have no business knowing a chat can be erased, and folding
 * `deleteRecord` into HostThreadRecordPersistPort would force every one of their
 * test doubles to stub a method they never call. The erasure transaction depends
 * on this narrower port instead; HostThreadRecordPersistClient implements both.
 */
export interface HostThreadRecordDeletePort {
  /**
   * Awaited whole-record deletion. Supersedes any persist queued for this chat
   * so a pending save can never land after the delete and resurrect the record.
   */
  deleteRecord(input: HostThreadRecordDeleteInput): Promise<void>
}

export interface HostThreadRecordPersistClientOptions extends HostPersistenceDiagnosticOptions {
  readonly broker: HostThreadRecordPersistBrokerPort
  /** Host profile directory. On Desktop this is app userData (bootstrap.ts:146-148). */
  readonly profilePath: string
  readonly transfer?: HostThreadRecordTransferPort
  readonly actor?: HostActorIdentity
  readonly nowMs?: () => number
  readonly createId?: () => string
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  /** Non-authoritative local acknowledgement after the exact record lands. */
  readonly onPersisted?: (input: HostThreadRecordPersistInput, receipt: HostCommandReceipt) => void
  /** Rebase one revision conflict against the latest Host-owned record. */
  readonly recoverConflict?: (
    input: HostThreadRecordPersistInput,
    error: HostThreadRecordPersistError,
    attempt: number
  ) => HostThreadRecordPersistInput | null | Promise<HostThreadRecordPersistInput | null>
  readonly maxConflictRetries?: number
}

interface PersistLane {
  queued: HostThreadRecordPersistInput[]
  running: boolean
  chain: Promise<void>
  error: HostThreadRecordPersistError | null
  /** True while a delete owns this chat: queued and incoming persists are superseded. */
  superseded: boolean
  /** Parallel, bounded by the existing pending queue; absent without a sink. */
  observations?: Array<string | null>
}

const defaultTransferPort: HostThreadRecordTransferPort = {
  publish: (input) => publishHostThreadRecordTransfer(input),
  remove: (input) => removeHostThreadRecordTransfer(input)
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function receiptMatches(
  command: HostCommand,
  receipt: HostCommandReceipt,
  actor: HostActorIdentity
): boolean {
  return (
    receipt.commandId === command.commandId &&
    receipt.idempotencyKey === command.idempotencyKey &&
    receipt.name === command.name &&
    receipt.actor.actorId === actor.actorId &&
    receipt.actor.clientId === actor.clientId &&
    receipt.actor.clientClass === actor.clientClass
  )
}

/**
 * Classifies a Host rejection. A revision conflict is retryable after refreshing
 * the revision; every other rejection is terminal for this attempt. The raw Host
 * code is always preserved on the error.
 *
 * NOTE FOR THE HOST EXECUTION SLICE: the store raises a plain
 * `Error('Thread persistence revision mismatch')`, so the message fallback below
 * exists only until a stable machine code is emitted. Pin one and this narrows
 * to an exact match.
 */
export function classifyHostPersistRejection(receipt: HostCommandReceipt): {
  code: HostThreadRecordPersistErrorCode
  hostErrorCode?: string
} {
  const rawCode = typeof receipt.errorCode === 'string' ? receipt.errorCode : undefined
  const haystack = `${rawCode ?? ''} ${receipt.errorMessage ?? ''}`.toLowerCase()
  if (haystack.includes('revision') || haystack.includes('conflict')) {
    return { code: 'revision_conflict', ...(rawCode ? { hostErrorCode: rawCode } : {}) }
  }
  return { code: 'host_rejected', ...(rawCode ? { hostErrorCode: rawCode } : {}) }
}

function hostPersistRejectionMessage(
  receipt: HostCommandReceipt,
  classified: ReturnType<typeof classifyHostPersistRejection>
): string {
  if (classified.code === 'revision_conflict') {
    return 'Host record persistence revision conflicted.'
  }
  const code = classified.hostErrorCode ?? ''
  if (code === 'pre_execution_before_projection_truncated') {
    return 'Host record persistence was blocked because its command-scoped snapshot was truncated before execution.'
  }
  if (code.startsWith('pre_execution_')) {
    return 'Host record persistence could not obtain a complete pre-execution snapshot.'
  }
  if (
    code === 'observation_diff_generation_mismatch' ||
    code === 'observation_diff_cursor_mismatch'
  ) {
    return 'Host record persistence executed, but its before/after snapshot position changed; the result is indeterminate.'
  }
  if (code.startsWith('observation_')) {
    return 'Host record persistence executed, but its effects could not be observed coherently; the result is indeterminate.'
  }
  return `Host record persistence ended with ${receipt.status}.`
}

export class HostThreadRecordPersistClient
  implements HostThreadRecordPersistPort, HostThreadRecordDeletePort
{
  private readonly broker: HostThreadRecordPersistBrokerPort
  private readonly profilePath: string
  private readonly transfer: HostThreadRecordTransferPort
  private readonly actor: HostActorIdentity
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly onPersisted?: HostThreadRecordPersistClientOptions['onPersisted']
  private readonly recoverConflict?: HostThreadRecordPersistClientOptions['recoverConflict']
  private readonly maxConflictRetries: number
  private readonly lanes = new Map<string, PersistLane>()
  private readonly diagnostics?: HostPersistenceDiagnostics

  constructor(options: HostThreadRecordPersistClientOptions) {
    if (
      !options?.broker ||
      typeof options.broker.submitCommand !== 'function' ||
      typeof options.broker.lookupReceipt !== 'function'
    ) {
      throw new Error('HostThreadRecordPersistClient requires a Host broker.')
    }
    if (typeof options.profilePath !== 'string' || options.profilePath.length === 0) {
      throw new Error('HostThreadRecordPersistClient requires a profile path.')
    }
    this.diagnostics =
      typeof options.observer === 'function'
        ? new HostPersistenceDiagnostics('persist-client', options)
        : undefined
    this.broker = options.broker
    this.profilePath = options.profilePath
    this.transfer = options.transfer ?? defaultTransferPort
    this.actor = options.actor ?? { ...TASKWRAITH_DESKTOP_HOST_ACTOR }
    this.nowMs = options.nowMs ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.wait = options.wait ?? defaultWait
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
    this.timeoutMs = Math.max(this.pollIntervalMs, options.timeoutMs ?? 30_000)
    this.onPersisted = typeof options.onPersisted === 'function' ? options.onPersisted : undefined
    this.recoverConflict =
      typeof options.recoverConflict === 'function' ? options.recoverConflict : undefined
    this.maxConflictRetries =
      Number.isSafeInteger(options.maxConflictRetries) && (options.maxConflictRetries ?? -1) >= 0
        ? options.maxConflictRetries!
        : 3
  }

  async persist(
    input: HostThreadRecordPersistInput,
    /** Internal queue lineage; never changes the wire command or input body. */
    lineage?: Pick<HostPersistenceObservationFields, 'parentOperationId' | 'attempt'>
  ): Promise<HostCommandReceipt> {
    this.assertInput(input)
    const operation = this.diagnostics?.begin('persist', {
      chatId: input.chatId,
      context: input.diagnosticContext,
      expectedRevision: input.expectedRevision,
      ...lineage
    })
    try {
      const transferId = this.nextTransferId()
      const staging = this.diagnostics?.begin('transfer_stage', {
        chatId: input.chatId,
        parentOperationId: operation?.operationId,
        context: input.diagnosticContext,
        expectedRevision: input.expectedRevision
      })

      let descriptor: { transferId: string; sha256: string; byteLength: number }
      try {
        descriptor = this.transfer.publish({
          profilePath: this.profilePath,
          transferId,
          record: input.record
        })
        staging?.finish('succeeded', { bytes: descriptor.byteLength })
      } catch (error) {
        staging?.finish('failed', { errorCode: 'artifact_publish_failed' })
        throw new HostThreadRecordPersistError(
          'artifact_publish_failed',
          'The chat record could not be staged for the Host.',
          { cause: error }
        )
      }

      const commandId = this.createId()
      const command: HostCommand = {
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId,
        idempotencyKey: `thread:record-persist:${commandId}`,
        actor: { ...this.actor },
        name: 'thread.record.persist',
        target: { threadId: input.chatId },
        // The digest comes from publish, never recomputed here: one serialization
        // point makes publisher/consumer drift unrepresentable.
        arguments: {
          transferId: descriptor.transferId,
          sha256: descriptor.sha256,
          byteLength: descriptor.byteLength,
          expectedRevision: input.expectedRevision
        },
        issuedAt: new Date(this.nowMs()).toISOString()
      }

      try {
        const receipt = await this.execute(
          command,
          operation,
          this.diagnostics ? input.diagnosticContext : undefined
        )
        try {
          this.onPersisted?.(input, receipt)
        } catch {
          // The Host write is already durable. Local rebase bookkeeping must
          // never turn that success into a failed receipt or a duplicate retry.
        }
        operation?.finish('succeeded', {
          commandId,
          commandName: command.name,
          receiptStatus: receipt.status
        })
        return receipt
      } catch (error) {
        // The Host removes the artifact only when it actually consumes it, so a
        // command that never landed would otherwise leak an owner-only file.
        try {
          this.transfer.remove({ profilePath: this.profilePath, transferId: descriptor.transferId })
        } catch {
          // Best-effort: the persist failure is the reportable fault.
        }
        operation?.finish('failed', {
          commandId,
          commandName: command.name,
          ...diagnosticError(error)
        })
        throw error
      }
    } catch (error) {
      operation?.finish('failed', diagnosticError(error))
      throw error
    }
  }

  enqueue(input: HostThreadRecordPersistInput): void {
    let lane: PersistLane
    try {
      this.assertInput(input)
      lane = this.laneFor(input.chatId)
    } catch (error) {
      // A sync caller cannot handle a throw here; surface it at the barrier.
      const chatId = typeof input?.chatId === 'string' && input.chatId ? input.chatId : '<unknown>'
      const lazy = this.laneFor(chatId)
      lazy.error =
        lazy.error ??
        (error instanceof HostThreadRecordPersistError
          ? error
          : new HostThreadRecordPersistError('invalid_input', 'Invalid persist request.', {
              cause: error
            }))
      return
    }
    // A delete owns this chat: the record is going away, so a save enqueued
    // before the delete settles must never be submitted.
    if (lane.superseded) {
      this.diagnostics?.event('superseded', 'superseded', {
        chatId: input.chatId,
        context: input.diagnosticContext,
        count: 1
      })
      return
    }
    // A revision-bearing snapshot may replace only another snapshot based on
    // the SAME Host revision. Dropping a different-revision predecessor leaves
    // a CAS gap: the replacement expects a revision that was never written.
    const tail = lane.queued[lane.queued.length - 1]
    const queuedId = this.diagnostics?.event('enqueue', 'pending', {
      chatId: input.chatId,
      context: input.diagnosticContext,
      expectedRevision: input.expectedRevision
    })
    if (tail?.expectedRevision === input.expectedRevision) {
      lane.queued[lane.queued.length - 1] = input
      if (lane.observations) {
        this.diagnostics?.event('superseded', 'superseded', {
          chatId: input.chatId,
          relatedOperationId: lane.observations.at(-1),
          parentOperationId: queuedId,
          count: 1
        })
        lane.observations[lane.observations.length - 1] = queuedId ?? null
      }
    } else {
      lane.queued.push(input)
      lane.observations?.push(queuedId ?? null)
    }
    if (!lane.running) {
      lane.running = true
      lane.chain = this.runLane(input.chatId)
    }
  }

  async drain(chatId: string): Promise<void> {
    const lane = this.lanes.get(chatId)
    const observation = this.diagnostics?.begin('drain', { chatId, count: this.pending(chatId) })
    try {
      if (!lane) return
      while (lane.running || lane.queued.length > 0) {
        await lane.chain
      }
      const error = lane.error
      lane.error = null
      if (error) throw error
    } catch (error) {
      observation?.finish('failed', diagnosticError(error))
      throw error
    } finally {
      observation?.finish('succeeded')
    }
  }

  async drainAll(): Promise<void> {
    let first: HostThreadRecordPersistError | null = null
    for (const chatId of [...this.lanes.keys()]) {
      try {
        await this.drain(chatId)
      } catch (error) {
        first =
          first ??
          (error instanceof HostThreadRecordPersistError
            ? error
            : new HostThreadRecordPersistError('host_rejected', 'Host persistence failed.', {
                cause: error
              }))
      }
    }
    if (first) throw first
  }

  pending(chatId: string): number {
    const lane = this.lanes.get(chatId)
    if (!lane) return 0
    return lane.queued.length + (lane.running ? 1 : 0)
  }

  /**
   * A delete is the LATEST write intent for its chat, so anything queued before
   * it — or enqueued while it is in flight — is superseded and must never be
   * submitted. Letting a queued save land after the delete would recreate the
   * record: the user deletes a chat, it silently reappears, and no error is ever
   * raised. That is why this is not simply a queued operation.
   *
   * An ALREADY-SUBMITTED persist is different: it cannot be un-submitted, so the
   * delete waits for it and lands afterwards. The durable end state is still
   * "deleted", which is the outcome the caller asked for.
   */
  async deleteRecord(input: HostThreadRecordDeleteInput): Promise<void> {
    this.assertDeleteInput(input)
    const lane = this.laneFor(input.chatId)
    this.dropQueuedObservations(input.chatId, lane)
    lane.queued = []
    lane.superseded = true
    try {
      while (lane.running) {
        await lane.chain
        // Anything that slipped in while awaiting is superseded by this delete.
        this.dropQueuedObservations(input.chatId, lane)
        lane.queued = []
      }
      // A superseded persist's failure is moot once the record is being removed.
      lane.error = null
      await this.executeDelete(input)
    } finally {
      lane.superseded = false
    }
  }

  private async executeDelete(input: HostThreadRecordDeleteInput): Promise<void> {
    const commandId = this.createId()
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId,
      idempotencyKey: `thread:record-delete:${commandId}`,
      actor: { ...this.actor },
      name: 'thread.record.delete',
      target: { threadId: input.chatId },
      // Exactly { expectedRevision } — threadId is carried by the target.
      arguments: { expectedRevision: input.expectedRevision },
      issuedAt: new Date(this.nowMs()).toISOString()
    }
    // A missing record is idempotent success on the Host side, so a successful
    // receipt is the only signal this client needs.
    await this.execute(command)
  }

  private assertDeleteInput(input: HostThreadRecordDeleteInput): void {
    if (!input || typeof input.chatId !== 'string' || input.chatId.length === 0) {
      throw new HostThreadRecordPersistError('invalid_input', 'A chat id is required to delete.')
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new HostThreadRecordPersistError(
        'invalid_input',
        'A non-negative expected revision is required.'
      )
    }
  }

  private laneFor(chatId: string): PersistLane {
    const existing = this.lanes.get(chatId)
    if (existing) return existing
    const created: PersistLane = {
      queued: [],
      running: false,
      chain: Promise.resolve(),
      error: null,
      superseded: false,
      ...(this.diagnostics ? { observations: [] } : {})
    }
    this.lanes.set(chatId, created)
    return created
  }

  private async runLane(chatId: string): Promise<void> {
    const lane = this.laneFor(chatId)
    try {
      while (lane.queued.length > 0) {
        let next = lane.queued.shift()!
        const parentOperationId = lane.observations?.shift()
        let conflictAttempt = 0
        for (;;) {
          try {
            await this.persist(
              next,
              this.diagnostics ? { parentOperationId, attempt: conflictAttempt } : undefined
            )
            break
          } catch (error) {
            if (
              error instanceof HostThreadRecordPersistError &&
              error.code === 'revision_conflict' &&
              this.recoverConflict &&
              conflictAttempt < this.maxConflictRetries
            ) {
              // Every queued successor was authored on the failed revision
              // chain. AppStore's accumulated intent already subsumes them;
              // discard those stale CAS entries and retry the one rebased
              // snapshot returned by the authoritative callback.
              this.dropQueuedObservations(chatId, lane, parentOperationId)
              lane.queued = []
              this.diagnostics?.event('retry', 'pending', {
                chatId,
                parentOperationId,
                attempt: conflictAttempt + 1,
                context: next.diagnosticContext
              })
              const recovered = await this.recoverConflict(next, error, conflictAttempt)
              conflictAttempt += 1
              if (recovered) {
                this.assertInput(recovered)
                if (recovered.chatId !== chatId) {
                  throw new HostThreadRecordPersistError(
                    'invalid_input',
                    'Conflict recovery changed the target chat.'
                  )
                }
                next =
                  !recovered.diagnosticContext && next.diagnosticContext
                    ? { ...recovered, diagnosticContext: next.diagnosticContext }
                    : recovered
                continue
              }
            }
            throw error
          }
        }
      }
    } catch (error) {
      lane.error =
        lane.error ??
        (error instanceof HostThreadRecordPersistError
          ? error
          : new HostThreadRecordPersistError('host_rejected', 'Host persistence failed.', {
              cause: error
            }))
      // A failed entry must not strand later work in a permanently queued state.
      this.dropQueuedObservations(chatId, lane)
      lane.queued = []
    } finally {
      lane.running = false
    }
  }

  private dropQueuedObservations(
    chatId: string,
    lane: PersistLane,
    parentOperationId?: string | null
  ): void {
    if (!lane.observations) return
    for (const relatedOperationId of lane.observations) {
      this.diagnostics?.event('superseded', 'superseded', {
        chatId,
        parentOperationId,
        relatedOperationId,
        count: 1
      })
    }
    lane.observations = []
  }

  private nextTransferId(): string {
    const candidate = this.createId()
    if (typeof candidate !== 'string' || !TRANSFER_ID_INTEROP_PATTERN.test(candidate)) {
      throw new HostThreadRecordPersistError(
        'invalid_input',
        'Generated transfer id is not accepted by both the wire and artifact bounds.'
      )
    }
    return candidate
  }

  private assertInput(input: HostThreadRecordPersistInput): void {
    if (!input || typeof input.chatId !== 'string' || input.chatId.length === 0) {
      throw new HostThreadRecordPersistError('invalid_input', 'A chat id is required to persist.')
    }
    if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
      throw new HostThreadRecordPersistError('invalid_input', 'A chat record object is required.')
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new HostThreadRecordPersistError(
        'invalid_input',
        'A non-negative expected revision is required.'
      )
    }
  }

  private async execute(
    command: HostCommand,
    parent?: HostPersistenceObservationOperation,
    context?: HostPersistenceDiagnosticContext
  ): Promise<HostCommandReceipt> {
    const fields = this.diagnostics
      ? {
          chatId: command.target?.threadId,
          commandId: command.commandId,
          commandName: command.name,
          parentOperationId: parent?.operationId,
          context
        }
      : undefined
    const observation = fields && this.diagnostics?.begin('client_receipt_wait', fields)
    let phase: HostPersistenceObservationOperation | undefined
    try {
      phase = fields
        ? this.diagnostics?.begin('submit', {
            ...fields,
            parentOperationId: observation?.operationId
          })
        : undefined
      const submitted = await this.broker.submitCommand(command)
      phase?.finish(submitted.ok ? 'succeeded' : 'failed')
      phase = undefined
      let receipt: HostCommandReceipt
      if (submitted.ok) {
        receipt = submitted.receipt
      } else {
        phase = fields
          ? this.diagnostics?.begin('recovery_lookup', {
              ...fields,
              parentOperationId: observation?.operationId
            })
          : undefined
        const recovered = await this.broker.lookupReceipt(command.commandId)
        phase?.finish(recovered.ok ? 'succeeded' : 'failed')
        phase = undefined
        if (!recovered.ok) {
          throw new HostThreadRecordPersistError(
            'host_unavailable',
            submitted.error.slice(0, 200) || 'The Host did not accept the persist command.'
          )
        }
        receipt = recovered.receipt
      }

      let settled = this.settle(command, receipt, observation)
      if (settled) {
        observation?.finish('succeeded', { receiptStatus: settled.status })
        return settled
      }
      const deadline = this.nowMs() + this.timeoutMs
      while (this.nowMs() < deadline) {
        phase = fields
          ? this.diagnostics?.begin('poll_delay', {
              ...fields,
              parentOperationId: observation?.operationId,
              requestedDelayMs: this.pollIntervalMs
            })
          : undefined
        await this.wait(this.pollIntervalMs)
        phase?.finish('succeeded')
        phase = fields
          ? this.diagnostics?.begin('poll_lookup', {
              ...fields,
              parentOperationId: observation?.operationId
            })
          : undefined
        const lookup = await this.broker.lookupReceipt(command.commandId)
        phase?.finish(lookup.ok ? 'succeeded' : 'failed')
        phase = undefined
        if (!lookup.ok) {
          throw new HostThreadRecordPersistError(
            'host_unavailable',
            lookup.error.slice(0, 200) || 'The Host receipt could not be read.'
          )
        }
        settled = this.settle(command, lookup.receipt, observation)
        if (settled) {
          observation?.finish('succeeded', { receiptStatus: settled.status })
          return settled
        }
      }
      throw new HostThreadRecordPersistError(
        'host_timeout',
        'Host record persistence did not settle before the timeout.'
      )
    } catch (error) {
      phase?.finish('failed', diagnosticError(error))
      observation?.finish('failed', diagnosticError(error))
      throw error
    }
  }

  /** Returns the receipt once terminal, null while pending, throws on rejection. */
  private settle(
    command: HostCommand,
    receipt: HostCommandReceipt,
    observation?: HostPersistenceObservationOperation
  ): HostCommandReceipt | null {
    if (!receiptMatches(command, receipt, this.actor)) {
      throw new HostThreadRecordPersistError(
        'invalid_host_receipt',
        'Host receipt did not match the record-persist command.',
        { receipt }
      )
    }
    if (receipt.status === 'pending') return null
    if (receipt.status === 'succeeded') return receipt
    const classified = classifyHostPersistRejection(receipt)
    observation?.finish('failed', { receiptStatus: receipt.status, errorCode: classified.code })
    throw new HostThreadRecordPersistError(
      classified.code,
      receipt.errorMessage ?? hostPersistRejectionMessage(receipt, classified),
      { ...(classified.hostErrorCode ? { hostErrorCode: classified.hostErrorCode } : {}), receipt }
    )
  }
}

export function createDesktopHostThreadRecordPersistClient(
  input: HostPersistenceDiagnosticOptions & {
    userDataPath: string
    appVersion: string
    onPersisted?: HostThreadRecordPersistClientOptions['onPersisted']
    recoverConflict?: HostThreadRecordPersistClientOptions['recoverConflict']
  }
): HostThreadRecordPersistClient {
  const broker = createHostProjectionBroker({
    userDataPath: input.userDataPath,
    appVersion: input.appVersion,
    client: {
      clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
      clientClass: TASKWRAITH_DESKTOP_HOST_ACTOR.clientClass,
      clientVersion: input.appVersion
    },
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    capabilities: PERSIST_HOST_CAPABILITIES
  })
  // bootstrap.ts:146-148 derives both the Host profile path and userDataPath
  // from the same canonicalized app userData directory.
  return new HostThreadRecordPersistClient({
    broker,
    profilePath: input.userDataPath,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    observer: input.observer,
    diagnosticNowMs: input.diagnosticNowMs,
    diagnosticCreateId: input.diagnosticCreateId,
    ...(input.onPersisted ? { onPersisted: input.onPersisted } : {}),
    ...(input.recoverConflict ? { recoverConflict: input.recoverConflict } : {})
  })
}
