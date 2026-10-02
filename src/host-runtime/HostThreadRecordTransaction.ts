/**
 * The transactional `thread.record.persist` (Independent Threads M4, slice
 * 12a).
 *
 * One persist runs through five stages, taking its locks in the programme's
 * order (thread lane, legacy FIFO, commit gate, publication lock) and never
 * taking an earlier one while it holds a later one:
 *
 * 1. **lane**: the thread's scope, refused once the thread is deleted;
 * 2. **prepare**: the transfer worker's bounded descriptor (slice 11), the
 *    catalogue ticket, and the manifest's durable `prepare` record, all
 *    outside the gate so preparation never waits on it;
 * 3. **commit**: under the gate's committer mode, the CAS by file identity
 *    and one rename plus its directory fsync. After the rename there is no
 *    abort record (R1-SF3): only publication or indeterminate;
 * 4. **publish**: under the publication lock, the index diff and one group
 *    line. The index commits before the fsync (RR-7), and the gate is
 *    released before it;
 * 5. **complete**: once the group is durable, `published`, then the receipt
 *    at the group's end (NH-1's order), then the lane.
 *
 * A group whose fsync fails completes at the delta store's reset position,
 * as recovery's D1 does. A fail-stopped delta store leaves the receipt
 * pending for boot recovery (§13 SF-2).
 *
 * Unwired in this slice: 12b routes the authority here behind
 * `TASKWRAITH_HOST_TXN_PERSIST`.
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync, promises as fsPromises, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { ThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogue'
import type { HostCommandReceiptStore } from './HostCommandReceiptStore'
import type { HostCommitGate } from './HostCommitGate'
import type { HostDeltaStore } from './HostDeltaStore'
import { validateHostDomainEffectBatch } from './HostDomainDeltaPublisher'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  hostProfileRecordIdentityKey,
  type HostProfileDomainStore,
  type HostProfileThreadSummary
} from './HostProfileDomainStore'
import type { HostPublicWindowIgnored, HostPublicWindowIndex } from './HostPublicWindowIndex'
import {
  HOST_SCOPE_DELETED_ERROR_CODE,
  HOST_SCOPE_DELETED_MESSAGE,
  HOST_SCOPE_EPOCH_STALE_ERROR_CODE,
  HOST_SCOPE_EPOCH_STALE_MESSAGE,
  hostThreadScope,
  type HostScopeEpoch,
  type HostScopeLedger,
  type HostScopeSlot
} from './HostScopeLedger'
import type {
  HostThreadRecordPrepareInput,
  HostThreadRecordPrepareResult,
  HostThreadRecordPrepared,
  HostThreadRecordPreparedArtifact
} from './HostThreadRecordPrepare'
import type { HostThreadRecordModelled } from './HostThreadRecordEffectModel'
import { removeHostThreadRecordTransfer } from './HostThreadRecordTransfer'
import type { HostTransactionLog } from './HostTransactionLog'
import {
  hostCommitWitness,
  type HostFileIdentity,
  type HostTransactionPrepareRecord
} from './HostTransactionManifest'

/** A durable catalogue ticket: finished after the group, failed otherwise. */
export interface HostThreadRecordCatalogueTicket {
  finish(): void
  fail(): void
}

/** The chat file, as the transaction reads and replaces it. */
export interface HostThreadRecordCommitPort {
  /**
   * The committed revision and the identity it was read from, together; null
   * when there is no record. Throws when the record changed while it read.
   */
  current(threadId: string): { revision: number; identity: HostFileIdentity; key: string } | null
  /** `hostProfileRecordIdentityKey` of the chat file now; null when it is absent. */
  identityKey(threadId: string): Promise<string | null>
  /** Bigint `lstat` of the chat file; null when it is absent. */
  identity(threadId: string): Promise<HostFileIdentity | null>
  /** The catalogue ticket, durable on resolve; null when it would be untracked. */
  beginTicket(
    threadId: string,
    projection: ThreadCatalogueProjection
  ): Promise<HostThreadRecordCatalogueTicket | null>
  /**
   * The commit, in one synchronous step (M4 slice 13b): compare the chat
   * file's identity key with `expectedKey` (null: absent) and, only when it
   * matches, rename the artifact over it. Nothing awaits between the check
   * and the rename, so no synchronous writer can land between them.
   * `'changed'` renames nothing. Throws only when the check's `lstat` or the
   * rename itself throws.
   */
  commitRename(
    artifactPath: string,
    threadId: string,
    expectedKey: string | null
  ): 'renamed' | 'changed'
  /** Fsync the chats directory after a rename; retried once. */
  syncChatsDirectory(threadId: string): Promise<void>
  /** The revision cache and, when one was carried, the summary cache. */
  committed(threadId: string, revision: number, summary: HostProfileThreadSummary | null): void
  /** Remove a prepared artifact by its exact inode. Best effort. */
  discard(artifact: HostThreadRecordPreparedArtifact): void
  /**
   * Remove the transfer artifact a persist was sent with, when the persist
   * failed before prepare read it: no identity was taken, so it removes the
   * owner-only regular file at that transfer id. Best effort.
   */
  abandon(transferId: string): void
}

export interface HostThreadRecordTransactionPorts {
  readonly ledger: HostScopeLedger
  readonly gate: HostCommitGate
  readonly log: Pick<HostTransactionLog, 'append'>
  readonly index: Pick<HostPublicWindowIndex, 'prepare'>
  readonly deltas: Pick<HostDeltaStore, 'appendGroup' | 'awaitDurable' | 'getPosition'> &
    Partial<Pick<HostDeltaStore, 'resetGeneration'>>
  readonly receipts: Pick<
    HostCommandReceiptStore,
    'complete' | 'markIndeterminate' | 'demoteTransactionalCommand'
  >
  readonly prepare: (input: HostThreadRecordPrepareInput) => Promise<HostThreadRecordPrepareResult>
  readonly records: HostThreadRecordCommitPort
  /** Today's path, for a persist prepare cannot take; run while the lane is held. */
  /** Its result is the caller's own (the authority's receipt answer); passed through untouched. */
  readonly legacy: () => Promise<unknown>
  /** A serial queue for the index diff and the group append. */
  readonly publicationLock: <T>(work: () => Promise<T> | T) => Promise<T>
  readonly profilePath: string
  readonly now: () => number
}

export interface HostThreadRecordTransactionInput {
  readonly commandId: string
  readonly threadId: string
  readonly descriptor: HostThreadRecordPrepareInput['descriptor']
  readonly expectedRevision: number
  /** The scope epoch captured when the command was admitted. */
  readonly epoch: HostScopeEpoch
}

export type HostThreadRecordTransactionOutcome =
  | {
      readonly kind: 'succeeded'
      readonly position: HostCursorPosition
      /** Whether the manifest's `published` record became durable. */
      readonly publishedRecord: 'durable' | 'failed'
      readonly refill: readonly string[]
      readonly ignored: readonly HostPublicWindowIgnored[]
    }
  | { readonly kind: 'failed'; readonly errorCode: string }
  | { readonly kind: 'indeterminate'; readonly reason: string }
  /** The delta store fail-stopped: the receipt stays pending for boot recovery. */
  | { readonly kind: 'fail-stopped'; readonly detail: string }
  /** Prepared as `unsupported`: today's path ran, and the caller completes it. */
  | { readonly kind: 'legacy'; readonly result: unknown }

/** The transfer module's artifact suffix; a prepared artifact always carries it. */
const ARTIFACT_SUFFIX = '.record.json'

type PublishResult = Awaited<ReturnType<HostThreadRecordTransaction['publish']>>

/** What the gated half of the commit decided; acted on once the gate is released. */
type CommitStep =
  | { readonly kind: 'abort'; readonly reason: string; readonly errorCode: string }
  | { readonly kind: 'indeterminate'; readonly reason: string }
  | { readonly kind: 'published'; readonly published: PublishResult }

const PERSISTED_SUMMARY = 'thread_record_persisted'
const PERSIST_FAILED = 'thread_record_persist_failed'
const REVISION_CONFLICT = 'thread_record_revision_conflict'
const SHUTTING_DOWN = 'host_shutting_down'
const COMMIT_INDETERMINATE = 'transaction_commit_indeterminate'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * The ticket is catalogue bookkeeping: the receipt never depends on it, so a
 * throwing ticket is swallowed here (the catalogue recovers an outstanding
 * ticket from the record).
 */
function settleTicket(ticket: HostThreadRecordCatalogueTicket, how: 'finish' | 'fail'): void {
  try {
    if (how === 'finish') ticket.finish()
    else ticket.fail()
  } catch {
    // As above.
  }
}

/** The prepare record's diagnostic effect set: the model's size and thread row. */
function modelDigest(model: HostThreadRecordModelled): { count: number; setDigest: string } {
  return {
    count: model.runs.candidates.length,
    setDigest: createHash('sha256').update(JSON.stringify(model.thread), 'utf8').digest('hex')
  }
}

export class HostThreadRecordTransaction {
  constructor(private readonly ports: HostThreadRecordTransactionPorts) {}

  async execute(
    input: HostThreadRecordTransactionInput
  ): Promise<HostThreadRecordTransactionOutcome> {
    const { ledger } = this.ports
    const acquired = await ledger.acquire(hostThreadScope(input.threadId), {
      owner: input.commandId,
      epoch: input.epoch
    })
    if (!acquired.ok) {
      this.ports.records.abandon(input.descriptor.transferId)
      if (acquired.reason === 'epoch_stale') {
        return this.fail(input, HOST_SCOPE_EPOCH_STALE_ERROR_CODE, HOST_SCOPE_EPOCH_STALE_MESSAGE)
      }
      if (acquired.reason === 'deleted') {
        return this.fail(input, HOST_SCOPE_DELETED_ERROR_CODE, HOST_SCOPE_DELETED_MESSAGE)
      }
      return this.fail(input, SHUTTING_DOWN)
    }
    const slot = acquired.slot
    try {
      return await this.underLane(input, slot)
    } finally {
      slot.release()
    }
  }

  private async underLane(
    input: HostThreadRecordTransactionInput,
    slot: HostScopeSlot
  ): Promise<HostThreadRecordTransactionOutcome> {
    const { records } = this.ports

    // Prepare: the revision and the identity it came from, read together.
    let state: ReturnType<HostThreadRecordCommitPort['current']>
    try {
      state = records.current(input.threadId)
    } catch {
      records.abandon(input.descriptor.transferId)
      return this.fail(input, PERSIST_FAILED)
    }
    let prepared: HostThreadRecordPrepareResult
    try {
      prepared = await this.ports.prepare({
        profilePath: this.ports.profilePath,
        threadId: input.threadId,
        descriptor: input.descriptor,
        expectedRevision: input.expectedRevision,
        currentRevision: state?.revision ?? null,
        now: this.ports.now()
      })
    } catch {
      // The worker failed or died: its descriptor never arrived. A normalized
      // artifact it may have written is left for the startup sweep (slice 14).
      records.abandon(input.descriptor.transferId)
      return this.fail(input, 'thread_record_transfer_failed')
    }
    if (prepared.kind === 'rejected') return this.fail(input, prepared.errorCode)
    if (prepared.kind === 'unsupported') {
      // The legacy write is not transactional: its receipt must be judged as
      // today's are after a crash, so it leaves the transactional class first.
      let demoted: boolean
      try {
        demoted = this.ports.receipts.demoteTransactionalCommand(input.commandId).kind === 'demoted'
      } catch {
        demoted = false
      }
      if (!demoted) {
        records.abandon(input.descriptor.transferId)
        return this.fail(input, PERSIST_FAILED)
      }
      return { kind: 'legacy', result: await this.ports.legacy() }
    }
    if (prepared.effects.kind === 'refused') {
      records.discard(prepared.artifact)
      return this.fail(input, PERSIST_FAILED)
    }
    const model = prepared.effects

    // The catalogue ticket, durable before the gate (§13 MF-2).
    let ticket: HostThreadRecordCatalogueTicket | null
    try {
      ticket = await records.beginTicket(input.threadId, model.projection)
    } catch {
      ticket = null
    }
    if (!ticket) {
      records.discard(prepared.artifact)
      return this.fail(input, PERSIST_FAILED)
    }

    const prepareRecord: HostTransactionPrepareRecord = {
      kind: 'prepare',
      commandId: input.commandId,
      threadId: input.threadId,
      epoch: input.epoch,
      expectedRevision: input.expectedRevision,
      resultingRevision: prepared.persistenceRevision,
      prior: state?.identity ?? null,
      resulting: {
        dev: prepared.artifact.identity.dev,
        ino: prepared.artifact.identity.ino,
        size: prepared.artifact.byteLength
      },
      effects: modelDigest(model),
      preparedAt: this.ports.now()
    }
    const logged = await this.appendLog(prepareRecord)
    if (logged !== 'durable') {
      settleTicket(ticket, 'fail')
      records.discard(prepared.artifact)
      return this.fail(input, PERSIST_FAILED)
    }

    return this.commit(input, slot, prepared, model, prepareRecord, state?.key ?? null, ticket)
  }

  private async commit(
    input: HostThreadRecordTransactionInput,
    slot: HostScopeSlot,
    prepared: HostThreadRecordPrepared,
    model: HostThreadRecordModelled,
    prepareRecord: HostTransactionPrepareRecord,
    priorKey: string | null,
    ticket: HostThreadRecordCatalogueTicket
  ): Promise<HostThreadRecordTransactionOutcome> {
    const entered = await this.ports.gate.enter('committer', { label: `txn:${input.commandId}` })
    if (!entered.ok) {
      return this.abort(input, prepared, ticket, 'gate_closed', SHUTTING_DOWN)
    }
    // Decide under the hold; write abort and indeterminate records after it:
    // the hold covers one fsync, the rename's directory (§13 MF-2).
    const lease = entered.lease
    let step: CommitStep
    try {
      step = await this.commitUnderGate(input, slot, prepared, model, prepareRecord, priorKey)
    } finally {
      lease.release()
    }

    if (step.kind === 'abort') {
      return this.abort(input, prepared, ticket, step.reason, step.errorCode)
    }
    if (step.kind === 'indeterminate') return this.indeterminate(input, ticket, step.reason)
    const published = step.published
    if (published.kind === 'unpublishable') {
      const recovered = await this.resetCommitted(input, model, published.reason)
      if (recovered) return this.complete(input, slot, ticket, recovered.position, recovered)
      return this.indeterminate(input, ticket, published.reason)
    }
    if (published.kind === 'fail-stopped') {
      return { kind: 'fail-stopped', detail: published.detail }
    }

    let position: HostCursorPosition
    if (published.kind === 'reset') {
      position = published.position
    } else {
      const durable = await this.ports.deltas.awaitDurable()
      if (durable.kind === 'fail-stopped') return { kind: 'fail-stopped', detail: durable.detail }
      // A reset by another writer settles earlier waiters as durable in the
      // new generation: complete there, where clients can follow, as D1 does.
      position =
        durable.kind === 'durable' && durable.position.generation === published.end.generation
          ? published.end
          : durable.position
    }
    return this.complete(input, slot, ticket, position, published)
  }

  /** D1 for a known rename: repair the snapshot and reset without replay. */
  private async resetCommitted(
    input: HostThreadRecordTransactionInput,
    model: HostThreadRecordModelled,
    reason: string
  ): Promise<{
    position: HostCursorPosition
    refill: readonly string[]
    ignored: readonly HostPublicWindowIgnored[]
  } | null> {
    const reset = this.ports.deltas.resetGeneration
    if (!reset) return null
    const entered = await this.ports.gate.enter('exclusive', {
      label: `txn-reset:${input.commandId}`
    })
    if (!entered.ok) return null
    try {
      return await this.ports.publicationLock(() => {
        // D1: repair the snapshot source from the known committed model,
        // then reset. Never replay an effect group or rename the file again.
        const transaction = this.ports.index.prepare([{ kind: 'model', model }], {
          generatedAt: iso(this.ports.now())
        })
        transaction.commit()
        const result = reset.call(this.ports.deltas, `transaction committed: ${reason}`)
        if (result.kind !== 'appended') return null
        return {
          position: result.position,
          refill: transaction.refill,
          ignored: transaction.ignored
        }
      })
    } catch {
      return null
    } finally {
      entered.lease.release()
    }
  }

  /** The CAS, the rename and the publication; everything that needs the gate. */
  private async commitUnderGate(
    input: HostThreadRecordTransactionInput,
    slot: HostScopeSlot,
    prepared: HostThreadRecordPrepared,
    model: HostThreadRecordModelled,
    prepareRecord: HostTransactionPrepareRecord,
    priorKey: string | null
  ): Promise<CommitStep> {
    const { records } = this.ports
    // CAS by the store's full identity and the rename, as one synchronous
    // step: nothing rewrote the file, by rename or in place, since its
    // revision was read, and no writer can land between the check and the
    // rename (§23.3). A writer that landed first fails this persist as a
    // revision conflict, as today's persist does.
    let renamed = false
    try {
      const committed = records.commitRename(prepared.artifact.path, input.threadId, priorKey)
      if (committed === 'changed') {
        return { kind: 'abort', reason: 'identity_changed', errorCode: REVISION_CONFLICT }
      }
      renamed = true
    } catch {
      let after: HostFileIdentity | null
      try {
        after = await records.identity(input.threadId)
      } catch {
        return { kind: 'indeterminate', reason: 'rename_unverifiable' }
      }
      const witness = hostCommitWitness(prepareRecord, after)
      if (witness === 'not_committed') {
        return { kind: 'abort', reason: 'rename_failed', errorCode: PERSIST_FAILED }
      }
      if (witness === 'indeterminate')
        return { kind: 'indeterminate', reason: 'rename_indeterminate' }
      // Committed: the rename landed although the call threw.
      renamed = true
    }
    if (renamed) {
      try {
        await records.syncChatsDirectory(input.threadId)
      } catch {
        // The rename landed; a directory fsync that failed twice is carried
        // as today's persist carries it: the witness finds it committed.
      }
    }

    // From here the record is committed: publish or D1 reset, never abort.
    try {
      records.committed(input.threadId, prepared.persistenceRevision, prepared.summary)
    } catch {
      // The caches re-derive from the file; the commit stands.
    }
    try {
      slot.commit(prepared.persistenceRevision)
    } catch {
      // Bookkeeping only: the ledger's version never orders a commit.
    }
    return { kind: 'published', published: await this.publish(input, model) }
  }

  /** The index diff and the group line, under the publication lock. */
  private publish(
    input: HostThreadRecordTransactionInput,
    model: HostThreadRecordModelled
  ): Promise<
    | {
        kind: 'appended'
        end: HostCursorPosition
        refill: readonly string[]
        ignored: readonly HostPublicWindowIgnored[]
      }
    | {
        kind: 'reset'
        position: HostCursorPosition
        refill: readonly string[]
        ignored: readonly HostPublicWindowIgnored[]
      }
    | { kind: 'fail-stopped'; detail: string }
    | { kind: 'unpublishable'; reason: string }
  > {
    return this.ports.publicationLock(() => {
      let transaction: ReturnType<HostPublicWindowIndex['prepare']>
      try {
        transaction = this.ports.index.prepare([{ kind: 'model', model }], {
          generatedAt: iso(this.ports.now())
        })
      } catch {
        return { kind: 'unpublishable' as const, reason: 'index_prepare_failed' }
      }
      const { refill, ignored } = transaction
      const validated = validateHostDomainEffectBatch(transaction.effects)
      if (!validated.ok) {
        transaction.abort()
        return { kind: 'unpublishable' as const, reason: 'group_invalid' }
      }
      let appended: ReturnType<HostDeltaStore['appendGroup']>
      try {
        appended = this.ports.deltas.appendGroup({
          commandId: input.commandId,
          effects: validated.prepared.map(({ input: effect }) => effect)
        })
      } catch {
        transaction.abort()
        return { kind: 'unpublishable' as const, reason: 'group_append_threw' }
      }
      if (appended.kind === 'appended' || appended.kind === 'exists') {
        transaction.commit()
        return { kind: 'appended' as const, end: appended.group.end, refill, ignored }
      }
      if (appended.kind === 'write-failed') {
        if (appended.recovery.kind === 'reset') {
          // The reset replaces the group: clients re-snapshot from the index.
          transaction.commit()
          return {
            kind: 'reset' as const,
            position: appended.recovery.position,
            refill,
            ignored
          }
        }
        transaction.abort()
        return { kind: 'fail-stopped' as const, detail: appended.detail }
      }
      transaction.abort()
      return { kind: 'unpublishable' as const, reason: 'group_rejected' }
    })
  }

  private async complete(
    input: HostThreadRecordTransactionInput,
    slot: HostScopeSlot,
    ticket: HostThreadRecordCatalogueTicket,
    position: HostCursorPosition,
    published: { refill: readonly string[]; ignored: readonly HostPublicWindowIgnored[] }
  ): Promise<HostThreadRecordTransactionOutcome> {
    // NH-1: the manifest's mark first, then the receipt.
    const marked = await this.appendLog({
      kind: 'published',
      commandId: input.commandId,
      position,
      at: this.ports.now()
    })
    settleTicket(ticket, 'finish')
    this.ports.receipts.complete({
      commandId: input.commandId,
      status: 'succeeded',
      completedAt: iso(this.ports.now()),
      resultSummary: PERSISTED_SUMMARY,
      position: { generation: position.generation, cursor: position.cursor }
    })
    try {
      slot.published(position)
    } catch {
      // Bookkeeping only.
    }
    return {
      kind: 'succeeded',
      position,
      publishedRecord: marked === 'durable' ? 'durable' : 'failed',
      refill: published.refill,
      ignored: published.ignored
    }
  }

  /** Before the rename: record the abort, fail the ticket, drop the artifact, fail the receipt. */
  private async abort(
    input: HostThreadRecordTransactionInput,
    prepared: HostThreadRecordPrepared,
    ticket: HostThreadRecordCatalogueTicket,
    reason: string,
    errorCode: string
  ): Promise<HostThreadRecordTransactionOutcome> {
    await this.appendLog({
      kind: 'abort',
      commandId: input.commandId,
      reason,
      at: this.ports.now()
    })
    settleTicket(ticket, 'fail')
    this.ports.records.discard(prepared.artifact)
    return this.fail(input, errorCode)
  }

  private async indeterminate(
    input: HostThreadRecordTransactionInput,
    ticket: HostThreadRecordCatalogueTicket,
    reason: string
  ): Promise<HostThreadRecordTransactionOutcome> {
    await this.appendLog({
      kind: 'indeterminate',
      commandId: input.commandId,
      reason,
      at: this.ports.now()
    })
    settleTicket(ticket, 'fail')
    const position = this.ports.deltas.getPosition()
    this.ports.receipts.markIndeterminate({
      commandId: input.commandId,
      position: { generation: position.generation, cursor: position.cursor },
      errorCode: COMMIT_INDETERMINATE
    })
    return { kind: 'indeterminate', reason }
  }

  private fail(
    input: HostThreadRecordTransactionInput,
    errorCode: string,
    errorMessage?: string
  ): HostThreadRecordTransactionOutcome {
    this.ports.receipts.complete({
      commandId: input.commandId,
      status: 'failed',
      completedAt: iso(this.ports.now()),
      errorCode,
      ...(errorMessage === undefined ? {} : { errorMessage })
    })
    return { kind: 'failed', errorCode }
  }

  private async appendLog(record: unknown): Promise<'durable' | 'failed'> {
    try {
      const result = await this.ports.log.append(record)
      return result.kind === 'durable' || result.kind === 'duplicate' ? 'durable' : 'failed'
    } catch {
      return 'failed'
    }
  }
}

/** Bigint `lstat`, with `dev` and `ino` as strings, as the manifest records them. */
async function lstatIdentity(path: string): Promise<HostFileIdentity | null> {
  try {
    const stat = await fsPromises.lstat(path, { bigint: true })
    return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsPromises.open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The real commit port over a profile store and its chats directory. */
export function createHostThreadRecordCommitPort(options: {
  readonly store: Pick<HostProfileDomainStore, 'threadRecordState' | 'admitCommittedThreadRecord'>
  readonly profilePath: string
  readonly beginTicket: HostThreadRecordCommitPort['beginTicket']
}): HostThreadRecordCommitPort {
  const chatPath = (threadId: string): string =>
    join(options.profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  return {
    current: (threadId) => options.store.threadRecordState(threadId),
    identity: (threadId) => lstatIdentity(chatPath(threadId)),
    identityKey: async (threadId) => {
      try {
        return hostProfileRecordIdentityKey(
          await fsPromises.lstat(chatPath(threadId), { bigint: true })
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    beginTicket: options.beginTicket,
    commitRename: (artifactPath, threadId, expectedKey) => {
      const target = chatPath(threadId)
      let key: string | null
      try {
        key = hostProfileRecordIdentityKey(lstatSync(target, { bigint: true }))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        key = null
      }
      if (key !== expectedKey) return 'changed'
      renameSync(artifactPath, target)
      return 'renamed'
    },
    syncChatsDirectory: async (threadId) => {
      // One fsync under the committer hold (§13 MF-2): the target directory.
      // The transfer directory's entry may reappear after a crash; it names
      // the committed inode, and cleanup removes artifacts by exact inode.
      const directory = dirname(chatPath(threadId))
      try {
        await fsyncDirectory(directory)
      } catch {
        await fsyncDirectory(directory)
      }
    },
    committed: (threadId, revision, summary) =>
      options.store.admitCommittedThreadRecord(threadId, revision, summary),
    discard: (artifact) => {
      const name = basename(artifact.path)
      if (!name.endsWith(ARTIFACT_SUFFIX)) return
      const transferId = name.slice(0, -ARTIFACT_SUFFIX.length)
      try {
        removeHostThreadRecordTransfer({
          profilePath: options.profilePath,
          transferId,
          expectedIdentity: artifact.identity
        })
      } catch {
        // A stranded artifact is owner-only inside the profile.
      }
    },
    abandon: (transferId) => {
      try {
        removeHostThreadRecordTransfer({ profilePath: options.profilePath, transferId })
      } catch {
        // As above.
      }
    }
  }
}
