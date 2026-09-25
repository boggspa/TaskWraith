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
 * - a write that carries the record it published (every store write since
 *   slice 13c2, the run port's included) is modelled at once from that
 *   in-memory record: the same function over the same object as the file
 *   model, with no re-read. Measured at 2–10 ms for the largest real
 *   records, under 5% of the write's own read and parse (§23.8). Only the
 *   model is retained, never the record.
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
import { performance } from 'node:perf_hooks'

import type { HostProfileThread, HostThreadRecordWrittenKind } from './HostProfileDomainStore'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordEffectModel
} from './HostThreadRecordEffectModel'
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
  /**
   * Models that threw, at mark time or in the worker (a dead worker); the
   * thread's pending entry is dropped, and the next write marks it again.
   */
  readonly failures: number
  /** Models computed at mark time from the written record (slice 13c2). */
  readonly eager: number
  /** Their total time, in milliseconds. */
  readonly eagerMs: number
}

/** A thread's pending change: modelled at mark time, from its file at drain, or deleted. */
type Pending =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'file' }
  | { readonly kind: 'model'; readonly effects: HostThreadRecordEffectModel }

export class HostPublicWindowFeeder {
  private readonly marked = new Map<string, Pending>()
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
    failures: 0,
    eager: 0,
    eagerMs: 0
  }

  constructor(private readonly options: HostPublicWindowFeederOptions) {}

  /** Why the feeder stopped (a fail-stopped delta store), or null. */
  get stopped(): string | null {
    return this.stopReason
  }

  counters(): HostPublicWindowFeederCounters {
    return { ...this.counts }
  }

  /**
   * Synchronous: called from the store's write path. With the record the
   * write published, the model is computed here and only it is kept.
   */
  mark(threadId: string, kind: HostThreadRecordWrittenKind, thread?: HostProfileThread): void {
    if (this.closed || this.stopReason !== null) return
    // A delete is final for the incarnation: a later mark cannot undo it.
    if (this.marked.get(threadId)?.kind === 'deleted') return
    if (kind === 'deleted') {
      this.marked.set(threadId, { kind: 'deleted' })
    } else if (thread) {
      const startedAt = performance.now()
      let effects: HostThreadRecordEffectModel
      try {
        effects = modelHostThreadRecordEffects(thread)
      } catch {
        this.counts.failures += 1
        this.marked.delete(threadId)
        return
      } finally {
        this.counts.eagerMs += performance.now() - startedAt
      }
      this.counts.eager += 1
      this.marked.set(threadId, { kind: 'model', effects })
    } else {
      this.marked.set(threadId, { kind: 'file' })
    }
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

  private async drain(batch: ReadonlyArray<readonly [string, Pending]>): Promise<void> {
    // Model outside every lock: the worker reads and decodes the file.
    const changes: HostPublicWindowChange[] = []
    for (const [threadId, pending] of batch) {
      if (pending.kind === 'deleted') {
        changes.push({ kind: 'delete', threadId })
        continue
      }
      if (pending.kind === 'model') {
        if (pending.effects.kind === 'refused') {
          this.counts.refused += 1
          continue
        }
        changes.push({ kind: 'model', model: pending.effects })
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
