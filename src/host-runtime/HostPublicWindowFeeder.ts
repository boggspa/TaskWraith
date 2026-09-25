/**
 * Keeps the public window index current for the Host's other writers
 * (Independent Threads M4, slice 13c1; R1-M5).
 *
 * The transactional persist feeds the index itself. Every other chat-file
 * write reaches here through the store's `onThreadRecordWritten` hook:
 *
 * - `record` (setup, the seat toggle, the legacy persist, catalogue
 *   adoption): the thread's full model is built from its committed file, in
 *   the transfer worker, outside every lock;
 * - `deleted`: a `delete` change, whose group must land; a group that fails
 *   is replaced by a generation reset, which lands it too;
 * - `run` (the run port): ignored until slice 13c2, which feeds it
 *   incrementally.
 *
 * Marks coalesce per thread and one drain runs at a time. Each drain is one
 * index transaction and one group, under the publication lock that the
 * transactions share, so groups publish in commit order. The index commits
 * before the group's fsync, which follows the lock (RR-7). A feed has no
 * receipt: its group's anchor is released once the group is durable.
 */
import type { HostCursorPosition } from '../shared/hostProtocol'
import type { HostDeltaStore } from './HostDeltaStore'
import { validateHostDomainEffectBatch } from './HostDomainDeltaPublisher'
import type { HostThreadRecordWrittenKind } from './HostProfileDomainStore'
import type { HostPublicWindowChange, HostPublicWindowIndex } from './HostPublicWindowIndex'
import type { HostThreadRecordFileModel } from './HostThreadRecordModel'

/** How many marked threads one drain takes. */
export const HOST_PUBLIC_WINDOW_FEED_BATCH = 32

export interface HostPublicWindowFeederOptions {
  readonly index: Pick<HostPublicWindowIndex, 'prepare'>
  readonly publicationLock: <T>(work: () => Promise<T> | T) => Promise<T>
  readonly deltas: Pick<
    HostDeltaStore,
    'appendGroup' | 'awaitDurable' | 'getPosition' | 'releaseGroup'
  >
  /** The thread's model from its committed file; production runs it in the worker. */
  readonly model: (threadId: string) => Promise<HostThreadRecordFileModel>
  readonly now: () => number
}

export interface HostPublicWindowFeederCounters {
  /** Drains that published a group (or a reset in its place). */
  readonly drained: number
  readonly absent: number
  readonly invalid: number
  readonly refused: number
  /** Changes the index set aside as older or deleted. */
  readonly ignored: number
  /** Drains whose group the delta store or its validation refused. */
  readonly rejected: number
  /** Drains whose group failed and was replaced by a generation reset. */
  readonly resets: number
  /** Model requests that threw (a dead worker); the mark is dropped, and the next write marks it again. */
  readonly failures: number
}

type Mark = Exclude<HostThreadRecordWrittenKind, 'run'>

export class HostPublicWindowFeeder {
  private readonly marked = new Map<string, Mark>()
  private draining: Promise<void> | null = null
  private closed = false
  private stopReason: string | null = null
  private sequence = 0
  private readonly idleWaiters = new Set<() => void>()
  private counts = {
    drained: 0,
    absent: 0,
    invalid: 0,
    refused: 0,
    ignored: 0,
    rejected: 0,
    resets: 0,
    failures: 0
  }

  constructor(private readonly options: HostPublicWindowFeederOptions) {}

  /** Why the feeder stopped (a fail-stopped delta store), or null. */
  get stopped(): string | null {
    return this.stopReason
  }

  counters(): HostPublicWindowFeederCounters {
    return { ...this.counts }
  }

  /** Synchronous and cheap: called from the store's write path. */
  mark(threadId: string, kind: HostThreadRecordWrittenKind): void {
    if (this.closed || this.stopReason !== null) return
    // The run port is slice 13c2's: it feeds one run incrementally.
    if (kind === 'run') return
    // A delete is final for the incarnation: a later mark cannot undo it.
    if (this.marked.get(threadId) === 'deleted') return
    this.marked.set(threadId, kind)
    this.schedule()
  }

  /** Resolves once nothing is marked and no drain runs. */
  idle(): Promise<void> {
    if (this.draining === null && this.marked.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** Refuse new marks and let the running drain, and those it leaves, finish. */
  async close(): Promise<void> {
    this.closed = true
    await this.idle()
  }

  private schedule(): void {
    if (this.draining !== null) return
    this.draining = this.drainAll().finally(() => {
      this.draining = null
      if (this.marked.size > 0 && this.stopReason === null) {
        this.schedule()
        return
      }
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    })
  }

  private async drainAll(): Promise<void> {
    // Let the current turn's marks coalesce before the first model request.
    await Promise.resolve()
    while (this.marked.size > 0 && this.stopReason === null) {
      const batch = [...this.marked].slice(0, HOST_PUBLIC_WINDOW_FEED_BATCH)
      for (const [threadId] of batch) this.marked.delete(threadId)
      await this.drain(batch)
    }
    if (this.stopReason !== null) this.marked.clear()
  }

  private async drain(batch: ReadonlyArray<readonly [string, Mark]>): Promise<void> {
    // Model outside every lock: the worker reads and decodes the file.
    const changes: HostPublicWindowChange[] = []
    for (const [threadId, kind] of batch) {
      if (kind === 'deleted') {
        changes.push({ kind: 'delete', threadId })
        continue
      }
      let modelled: HostThreadRecordFileModel
      try {
        modelled = await this.options.model(threadId)
      } catch {
        this.counts.failures += 1
        // A later write marks it again; do not spin on a dead worker here.
        continue
      }
      if (modelled.kind === 'absent') {
        this.counts.absent += 1
        continue
      }
      if (modelled.kind === 'invalid') {
        this.counts.invalid += 1
        continue
      }
      if (modelled.effects.kind === 'refused') {
        this.counts.refused += 1
        continue
      }
      changes.push({ kind: 'model', model: modelled.effects })
    }
    if (changes.length === 0) return

    const commandId = `feed:${++this.sequence}`
    const published = await this.options.publicationLock(() => this.publish(commandId, changes))
    if (published === null) return
    const durable = await this.options.deltas.awaitDurable()
    if (durable.kind === 'fail-stopped') {
      this.stopReason = durable.detail
    } else if (durable.kind === 'reset') {
      this.counts.resets += 1
    }
    try {
      this.options.deltas.releaseGroup(commandId)
    } catch {
      // The anchor stays until the next checkpoint; nothing depends on it.
    }
  }

  /** Under the publication lock: diff, append, settle the index transaction. */
  private publish(
    commandId: string,
    changes: readonly HostPublicWindowChange[]
  ): HostCursorPosition | null {
    let transaction: ReturnType<HostPublicWindowIndex['prepare']>
    try {
      transaction = this.options.index.prepare(changes, {
        generatedAt: new Date(this.options.now()).toISOString()
      })
    } catch {
      this.counts.rejected += 1
      return null
    }
    let settled = false
    try {
      this.counts.ignored += transaction.ignored.length
      const validated = validateHostDomainEffectBatch(transaction.effects)
      if (!validated.ok) {
        this.counts.rejected += 1
        return null
      }
      if (validated.prepared.length === 0) {
        // Nothing changes on the wire (every change set aside, or a delete of
        // a thread the index never held): commit the index's bookkeeping and
        // spend no group on it.
        transaction.commit()
        settled = true
        return null
      }
      const appended = this.options.deltas.appendGroup({
        commandId,
        effects: validated.prepared.map(({ input }) => input)
      })
      if (appended.kind === 'appended' || appended.kind === 'exists') {
        transaction.commit()
        settled = true
        this.counts.drained += 1
        return appended.group.end
      }
      if (appended.kind === 'write-failed' && appended.recovery.kind === 'reset') {
        // The reset replaces the group; a delete lands through it.
        transaction.commit()
        settled = true
        this.counts.drained += 1
        this.counts.resets += 1
        return null
      }
      if (appended.kind === 'write-failed') {
        this.stopReason = appended.detail
        return null
      }
      this.counts.rejected += 1
      return null
    } catch {
      this.counts.rejected += 1
      return null
    } finally {
      // An open transaction refuses every later change (R2-M3).
      if (!settled) transaction.abort()
    }
  }
}
