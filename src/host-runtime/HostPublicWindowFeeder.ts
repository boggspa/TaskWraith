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
 *
 * Refills (slice 13e). When a change leaves the run window short, the drain
 * absorbs refills into its one transaction: it aborts the prepare, reads the
 * exhausted thread's committed file in the worker with the lock free, and
 * prepares again with the refill added, so clients never see the short
 * window. A refill lands only at the revision the index holds (SF-3). A read
 * that fails, or a refill the index sets aside, publishes the short window
 * and schedules one retry; a second failure in a row waits for the thread's
 * next write. A transactional persist cannot absorb, as it holds the commit
 * gate, so its refills arrive through `refill()`.
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

/** How many times one drain aborts its prepare to read a refill. */
export const HOST_PUBLIC_WINDOW_ABSORB_ROUNDS = 8

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
  /**
   * Whether drains publish groups (slice 13f1). False while the index is
   * seeded: the index is fed and committed, but legacy captures are still
   * the authority, so nothing is appended until `startPublishing()`.
   */
  readonly publishing?: boolean
}

/** One seed of the index from committed files (slice 13f1). */
export interface HostPublicWindowSeedReport {
  readonly requested: number
  /** Seed reads that produced a model. */
  readonly modelled: number
  readonly absent: number
  readonly invalid: number
  readonly refused: number
  /** Seed reads that rejected once and were read again. */
  readonly retried: number
  /** Threads whose seed read rejected twice: absent until their next write. */
  readonly abandoned: readonly string[]
  /** The feeder closed before every thread was taken. */
  readonly aborted: boolean
  readonly ms: number
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
  /** Refills that landed in a published transaction. */
  readonly refills: number
  /** Refill reads of a committed file. */
  readonly refillReads: number
  /** Refill reads that failed, and refills the index set aside. */
  readonly refillFailures: number
  /** Refills scheduled for a later drain: by a persist, a failure, or the absorb bound. */
  readonly refillsScheduled: number
  /** Threads left short after a second failure in a row, until their next write. */
  readonly refillsAbandoned: number
  /** Prepares a drain aborted to read a refill. */
  readonly absorbRounds: number
  /** Drains that committed the index and appended no group: not yet publishing. */
  readonly suppressed: number
}

/**
 * A thread's pending change: modelled at mark time, from its file at drain,
 * deleted, or a refill to read.
 */
type Pending =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'file' }
  | { readonly kind: 'model'; readonly effects: HostThreadRecordEffectModel }
  | { readonly kind: 'refill' }
  | { readonly kind: 'seed' }

interface SeedState {
  readonly model: (threadId: string) => Promise<HostThreadRecordFileModel>
  /** Threads not yet taken into a drain. */
  readonly pending: Set<string>
  /** Threads whose seed read rejected once. */
  readonly rejected: Set<string>
  readonly report: {
    requested: number
    modelled: number
    absent: number
    invalid: number
    refused: number
    retried: number
    abandoned: string[]
  }
  readonly startedAt: number
  readonly resolve: (report: HostPublicWindowSeedReport) => void
}

type Published =
  | {
      readonly kind: 'published'
      /** The group's end, when a group was appended; its anchor is released once durable. */
      readonly end: HostCursorPosition | null
      /** Exhausted threads the index still names. */
      readonly refill: readonly string[]
      /** Refills the index set aside: source failures. */
      readonly setAside: readonly string[]
    }
  | { readonly kind: 'absorb'; readonly threads: readonly string[] }
  | { readonly kind: 'unpublished' }

export class HostPublicWindowFeeder {
  private readonly marked = new Map<string, Pending>()
  /** Threads deleted in this incarnation: refill readers skip them. */
  private readonly deleted = new Set<string>()
  /** Threads whose last refill failed: the next failure abandons them. */
  private readonly retried = new Set<string>()
  private draining: Promise<void> | null = null
  private closed = false
  private stopReason: string | null = null
  private sequence = 0
  private readonly idleWaiters = new Set<() => void>()
  private publishingNow: boolean
  private seeding: SeedState | null = null
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
    eagerMs: 0,
    refills: 0,
    refillReads: 0,
    refillFailures: 0,
    refillsScheduled: 0,
    refillsAbandoned: 0,
    absorbRounds: 0,
    suppressed: 0
  }

  constructor(private readonly options: HostPublicWindowFeederOptions) {
    this.publishingNow = options.publishing ?? true
  }

  /** Whether drains append groups. */
  get publishing(): boolean {
    return this.publishingNow
  }

  /**
   * Publish from now on. The caller holds the publication lock, so no drain
   * is between its index commit and its append.
   */
  startPublishing(): void {
    this.publishingNow = true
  }

  /**
   * Seed the index from committed files: each thread is read once through
   * `model` (the seed's own workers), unless a live mark already covers it.
   * A live mark later replaces a pending seed read. Resolves once every
   * thread has been taken into a drain.
   */
  seed(
    threadIds: readonly string[],
    model: (threadId: string) => Promise<HostThreadRecordFileModel>
  ): Promise<HostPublicWindowSeedReport> {
    if (this.seeding !== null) return Promise.reject(new Error('The index is already seeding.'))
    return new Promise((resolve) => {
      const state: SeedState = {
        model,
        pending: new Set(),
        rejected: new Set(),
        report: {
          requested: 0,
          modelled: 0,
          absent: 0,
          invalid: 0,
          refused: 0,
          retried: 0,
          abandoned: []
        },
        startedAt: performance.now(),
        resolve
      }
      this.seeding = state
      for (const threadId of new Set(threadIds)) {
        state.report.requested += 1
        if (this.closed || this.stopReason !== null || this.marked.has(threadId)) continue
        if (this.deleted.has(threadId)) continue
        state.pending.add(threadId)
        this.marked.set(threadId, { kind: 'seed' })
      }
      if (this.closed || this.stopReason !== null) {
        this.finishSeed(true)
        return
      }
      if (state.pending.size === 0) this.finishSeed(false)
      else this.schedule()
    })
  }

  private finishSeed(aborted: boolean): void {
    const state = this.seeding
    if (state === null) return
    this.seeding = null
    for (const threadId of state.pending) {
      if (this.marked.get(threadId)?.kind === 'seed') this.marked.delete(threadId)
    }
    state.resolve({
      ...state.report,
      abandoned: [...state.report.abandoned],
      aborted,
      ms: performance.now() - state.startedAt
    })
  }

  /**
   * A thread taken into a drain in any form leaves the seed's pending set.
   * The seed resolves once the drain that took its last thread has
   * committed, so the index holds every seeded thread when it does.
   */
  private taken(threadId: string): void {
    this.seeding?.pending.delete(threadId)
  }

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
    this.retried.delete(threadId)
    if (kind === 'deleted') {
      this.deleted.add(threadId)
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

  /**
   * Schedule refills for threads a short window exhausted. A thread already
   * pending is left as it is (any pending change models it at least as
   * well), and a deleted thread is never read.
   */
  refill(threadIds: readonly string[]): void {
    if (this.closed || this.stopReason !== null) return
    let scheduled = false
    for (const threadId of threadIds) {
      if (this.deleted.has(threadId) || this.marked.has(threadId)) continue
      this.marked.set(threadId, { kind: 'refill' })
      this.counts.refillsScheduled += 1
      scheduled = true
    }
    if (scheduled) this.schedule()
  }

  /** Resolves once nothing is marked and no drain runs. */
  idle(): Promise<void> {
    if (this.draining === null && this.marked.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** Refuse new marks and let the running drain, and those it leaves, finish. */
  async close(): Promise<void> {
    this.closed = true
    // A seed does not hold shutdown: its unread threads are dropped.
    this.finishSeed(true)
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
      if (this.seeding?.pending.size === 0) this.finishSeed(false)
    }
    if (this.stopReason !== null) {
      this.marked.clear()
      this.finishSeed(true)
    }
  }

  private async drain(batch: ReadonlyArray<readonly [string, Pending]>): Promise<void> {
    // Model outside every lock: the worker (or the seed's own workers) reads
    // and decodes each file, the batch's files at once.
    const seedModel = this.seeding?.model
    const reads = batch.map(([threadId, pending]) => {
      if (pending.kind === 'file') return this.readFile(this.options.model, threadId)
      if (pending.kind === 'seed' && seedModel) return this.readFile(seedModel, threadId)
      return null
    })
    const results = await Promise.all(reads)
    const changes: HostPublicWindowChange[] = []
    const refilled = new Set<string>()
    const failed = new Set<string>()
    for (let index = 0; index < batch.length; index += 1) {
      const [threadId, pending] = batch[index]!
      const result = results[index]
      if (pending.kind === 'seed') {
        if (result && this.seedRead(threadId, result, changes)) continue
        this.taken(threadId)
        continue
      }
      this.taken(threadId)
      if (pending.kind === 'deleted') {
        changes.push({ kind: 'delete', threadId })
        continue
      }
      if (pending.kind === 'refill') {
        await this.readRefill(threadId, changes, refilled, failed)
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
      if (!result || result.kind === 'rejected') {
        this.counts.failures += 1
        // A later write marks it again; do not spin on a dead worker here.
        continue
      }
      const modelled = result.model
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

    const commandId = `feed:${++this.sequence}`
    let published: Published = { kind: 'unpublished' }
    for (let round = 0; ; round += 1) {
      if (changes.length === 0) break
      // Past the bound, publish what the window holds and read the rest later.
      const absorbing = round < HOST_PUBLIC_WINDOW_ABSORB_ROUNDS ? refilled : null
      const attempt = await this.options.publicationLock(() =>
        this.publish(commandId, changes, absorbing)
      )
      if (attempt.kind !== 'absorb') {
        published = attempt
        break
      }
      this.counts.absorbRounds += 1
      for (const threadId of attempt.threads) {
        await this.readRefill(threadId, changes, refilled, failed)
      }
    }

    if (published.kind === 'published') {
      for (const threadId of published.setAside) failed.add(threadId)
    }
    // A failed refill publishes short: one retry, then wait for a write.
    for (const threadId of failed) {
      if (this.retried.has(threadId)) {
        this.retried.delete(threadId)
        this.counts.refillsAbandoned += 1
        continue
      }
      this.retried.add(threadId)
      this.refill([threadId])
    }
    if (published.kind !== 'published') return
    for (const threadId of refilled) {
      if (!failed.has(threadId)) this.retried.delete(threadId)
    }
    // Threads the absorb bound left for later.
    this.refill(published.refill.filter((threadId) => !refilled.has(threadId)))
    if (published.end === null) return
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

  private async readFile(
    model: (threadId: string) => Promise<HostThreadRecordFileModel>,
    threadId: string
  ): Promise<{ kind: 'read'; model: HostThreadRecordFileModel } | { kind: 'rejected' }> {
    try {
      return { kind: 'read', model: await model(threadId) }
    } catch {
      return { kind: 'rejected' }
    }
  }

  /**
   * Account one seed read. Returns true when the thread stays pending: its
   * read rejected for the first time and it is read again.
   */
  private seedRead(
    threadId: string,
    result: { kind: 'read'; model: HostThreadRecordFileModel } | { kind: 'rejected' },
    changes: HostPublicWindowChange[]
  ): boolean {
    const state = this.seeding
    if (state === null) return false
    const report = state.report
    if (result.kind === 'rejected') {
      if (state.rejected.has(threadId)) {
        report.abandoned.push(threadId)
        return false
      }
      state.rejected.add(threadId)
      // A live mark taken since covers the thread; otherwise read it again.
      if (this.marked.has(threadId) || this.closed || this.stopReason !== null) return false
      report.retried += 1
      this.marked.set(threadId, { kind: 'seed' })
      return true
    }
    const modelled = result.model
    if (modelled.kind === 'absent') {
      report.absent += 1
      this.counts.absent += 1
    } else if (modelled.kind === 'invalid') {
      report.invalid += 1
      this.counts.invalid += 1
    } else if (modelled.effects.kind === 'refused') {
      report.refused += 1
      this.counts.refused += 1
    } else {
      report.modelled += 1
      changes.push({ kind: 'model', model: modelled.effects })
    }
    return false
  }

  /** Read one refill with every lock free; a failure is recorded, not thrown. */
  private async readRefill(
    threadId: string,
    changes: HostPublicWindowChange[],
    refilled: Set<string>,
    failed: Set<string>
  ): Promise<void> {
    // Never a deleted thread: `refill()` skips one, a delete mark replaces a
    // pending refill, and the index names no deleted thread as exhausted.
    refilled.add(threadId)
    this.counts.refillReads += 1
    let modelled: HostThreadRecordFileModel
    try {
      modelled = await this.options.model(threadId)
    } catch {
      modelled = { kind: 'invalid' }
    }
    if (modelled.kind !== 'modelled' || modelled.effects.kind === 'refused') {
      this.counts.refillFailures += 1
      failed.add(threadId)
      return
    }
    changes.push({ kind: 'refill', model: modelled.effects })
  }

  /**
   * Under the publication lock: diff, append, settle the index transaction.
   * With `absorbing`, a prepare that names an exhausted thread not yet read
   * is aborted so the thread can be read with the lock free.
   */
  private publish(
    commandId: string,
    changes: readonly HostPublicWindowChange[],
    absorbing: ReadonlySet<string> | null
  ): Published {
    let transaction: ReturnType<HostPublicWindowIndex['prepare']>
    try {
      transaction = this.options.index.prepare(changes, {
        generatedAt: new Date(this.options.now()).toISOString()
      })
    } catch {
      this.counts.rejected += 1
      return { kind: 'unpublished' }
    }
    let settled = false
    try {
      if (absorbing !== null) {
        const unread = transaction.refill.filter((threadId) => !absorbing.has(threadId))
        if (unread.length > 0) return { kind: 'absorb', threads: unread }
      }
      this.counts.ignored += transaction.ignored.length
      const done = (end: HostCursorPosition | null): Published => {
        const ignored = new Set(transaction.ignored.map((entry) => entry.threadId))
        const setAside: string[] = []
        for (const change of changes) {
          if (change.kind !== 'refill') continue
          if (ignored.has(change.model.threadId)) {
            // A refill the index sets aside is a source failure (§12.2).
            this.counts.refillFailures += 1
            setAside.push(change.model.threadId)
          } else {
            this.counts.refills += 1
          }
        }
        return { kind: 'published', end, refill: transaction.refill, setAside }
      }
      if (!this.publishingNow) {
        // Seeding: the index is fed, legacy captures still publish (13f1).
        transaction.commit()
        settled = true
        this.counts.suppressed += 1
        return done(null)
      }
      const validated = validateHostDomainEffectBatch(transaction.effects)
      if (!validated.ok) {
        this.counts.rejected += 1
        return { kind: 'unpublished' }
      }
      if (validated.prepared.length === 0) {
        // Nothing changes on the wire (every change set aside, or a delete of
        // a thread the index never held): commit the index's bookkeeping and
        // spend no group on it.
        transaction.commit()
        settled = true
        return done(null)
      }
      const appended = this.options.deltas.appendGroup({
        commandId,
        effects: validated.prepared.map(({ input }) => input)
      })
      if (appended.kind === 'appended' || appended.kind === 'exists') {
        transaction.commit()
        settled = true
        this.counts.drained += 1
        return done(appended.group.end)
      }
      if (appended.kind === 'write-failed' && appended.recovery.kind === 'reset') {
        // The reset replaces the group; a delete lands through it.
        transaction.commit()
        settled = true
        this.counts.drained += 1
        this.counts.resets += 1
        return done(null)
      }
      if (appended.kind === 'write-failed') {
        this.stopReason = appended.detail
        return { kind: 'unpublished' }
      }
      this.counts.rejected += 1
      return { kind: 'unpublished' }
    } catch {
      this.counts.rejected += 1
      return { kind: 'unpublished' }
    } finally {
      // An open transaction refuses every later change (R2-M3).
      if (!settled) transaction.abort()
    }
  }
}
