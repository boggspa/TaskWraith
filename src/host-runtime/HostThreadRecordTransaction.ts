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
import { constants, promises as fsPromises } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { ThreadCatalogueProjection } from '../host-shared/thread-catalogue/ThreadCatalogue'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostCommandReceiptStore } from './HostCommandReceiptStore'
import type { HostCommitGate } from './HostCommitGate'
import type { HostDeltaStore } from './HostDeltaStore'
import { validateHostDomainEffectBatch } from './HostDomainDeltaPublisher'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
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
  sameHostFileIdentity,
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
  current(threadId: string): { revision: number; identity: HostFileIdentity } | null
  /** Bigint `lstat` of the chat file; null when it is absent. */
  identity(threadId: string): Promise<HostFileIdentity | null>
  /** The catalogue ticket, durable on resolve; null when it would be untracked. */
  beginTicket(
    threadId: string,
    projection: ThreadCatalogueProjection
  ): Promise<HostThreadRecordCatalogueTicket | null>
  /** Rename the artifact into the chat file, then fsync the chats directory. */
  rename(artifactPath: string, threadId: string): Promise<void>
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
  readonly deltas: Pick<HostDeltaStore, 'appendGroup' | 'awaitDurable' | 'getPosition'>
  readonly receipts: Pick<HostCommandReceiptStore, 'complete' | 'markIndeterminate'>
  readonly prepare: (input: HostThreadRecordPrepareInput) => Promise<HostThreadRecordPrepareResult>
  readonly records: HostThreadRecordCommitPort
  /** Today's path, for a persist prepare cannot take; run while the lane is held. */
  readonly legacy: () => Promise<HostCommandExecutionResult>
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
  | { readonly kind: 'legacy'; readonly result: HostCommandExecutionResult }

/** The transfer module's artifact suffix; a prepared artifact always carries it. */
const ARTIFACT_SUFFIX = '.record.json'

const PERSISTED_SUMMARY = 'thread_record_persisted'
const PERSIST_FAILED = 'thread_record_persist_failed'
const REVISION_CONFLICT = 'thread_record_revision_conflict'
const SHUTTING_DOWN = 'host_shutting_down'
const COMMIT_INDETERMINATE = 'transaction_commit_indeterminate'

function iso(ms: number): string {
  return new Date(ms).toISOString()
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
    let state: { revision: number; identity: HostFileIdentity } | null
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
      ticket.fail()
      records.discard(prepared.artifact)
      return this.fail(input, PERSIST_FAILED)
    }

    return this.commit(input, slot, prepared, model, prepareRecord, ticket)
  }

  private async commit(
    input: HostThreadRecordTransactionInput,
    slot: HostScopeSlot,
    prepared: HostThreadRecordPrepared,
    model: HostThreadRecordModelled,
    prepareRecord: HostTransactionPrepareRecord,
    ticket: HostThreadRecordCatalogueTicket
  ): Promise<HostThreadRecordTransactionOutcome> {
    const { records } = this.ports
    const entered = await this.ports.gate.enter('committer', { label: `txn:${input.commandId}` })
    if (!entered.ok) {
      return this.abort(input, prepared, ticket, 'gate_closed', SHUTTING_DOWN)
    }
    const lease = entered.lease
    let published: Awaited<ReturnType<HostThreadRecordTransaction['publish']>>
    try {
      // CAS by identity: nothing replaced the file since its revision was read.
      let observed: HostFileIdentity | null
      try {
        observed = await records.identity(input.threadId)
      } catch {
        return this.abort(input, prepared, ticket, 'identity_unreadable', PERSIST_FAILED)
      }
      const unchanged =
        prepareRecord.prior === null
          ? observed === null
          : observed !== null && sameHostFileIdentity(observed, prepareRecord.prior)
      if (!unchanged) {
        return this.abort(input, prepared, ticket, 'identity_changed', REVISION_CONFLICT)
      }

      try {
        await records.rename(prepared.artifact.path, input.threadId)
      } catch {
        let after: HostFileIdentity | null
        try {
          after = await records.identity(input.threadId)
        } catch {
          return this.indeterminate(input, ticket, 'rename_unverifiable')
        }
        const witness = hostCommitWitness(prepareRecord, after)
        if (witness === 'not_committed') {
          return this.abort(input, prepared, ticket, 'rename_failed', PERSIST_FAILED)
        }
        if (witness === 'indeterminate') {
          return this.indeterminate(input, ticket, 'rename_indeterminate')
        }
        // Committed: the rename landed and only its directory fsync failed.
      }

      // From here the record is committed: publish or indeterminate, never abort.
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

      published = await this.publish(input, model)
    } finally {
      lease.release()
    }

    if (published.kind === 'unpublishable') {
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
      position = durable.kind === 'durable' ? published.end : durable.position
    }
    return this.complete(input, slot, ticket, position, published)
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
    ticket.finish()
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
    ticket.fail()
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
    ticket.fail()
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
    beginTicket: options.beginTicket,
    rename: async (artifactPath, threadId) => {
      const target = chatPath(threadId)
      await fsPromises.rename(artifactPath, target)
      // One fsync under the committer hold (§13 MF-2): the target directory.
      // The transfer directory's entry may reappear after a crash; it names
      // the committed inode, and cleanup removes artifacts by exact inode.
      await fsyncDirectory(dirname(target))
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
