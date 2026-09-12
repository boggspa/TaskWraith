import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import type { ThreadCatalogueReadQuery } from '../../shared/threadCatalogueProtocol'
import type { ThreadCatalogueOpenResult } from '../../shared/threadCatalogueTypes'

export interface ThreadCatalogueReadPort {
  query<T = unknown>(
    query: ThreadCatalogueReadQuery,
    options?: { priority?: 'foreground' | 'background' }
  ): Promise<T>
}
export interface ThreadCatalogueListPage {
  entries: Array<{ projection: ThreadCatalogueProjection; sourceWitness?: string }>
  next: { updatedAt: number; chatId: string } | null
  coverage: 'partial' | 'complete'
  repairPending: string[]
}
interface Changes {
  progress?: { total: number; indexed: number; failed: number }
  reset: boolean
  changes: Array<{ chatId: string; removed: boolean }>
  position: { incarnation: string; sequence: number }
}

/**
 * A full listing in progress. It outlives the refresh that began it so a page
 * that fails resumes where it stopped instead of discarding the pages that
 * already landed. `position` is the cursor captured before the first page and
 * is adopted only once the listing completes.
 */
interface Listing {
  position: Changes['position']
  before: ThreadCatalogueListPage['next']
  present: Set<string>
  startedAt: number
  suspended: boolean
}

/**
 * Conservative structural equality over the plain-data projection shape:
 * primitives, arrays, and plain objects only (projections are built either
 * from object literals or through JSON round-trips, so they carry nothing
 * else). An explicit-undefined key compares unequal to an absent one — a
 * false positive (one extra notification), never a false negative, and only
 * in the notify direction: a real semantic change always alters a defined
 * value or a key set.
 */
export function catalogueProjectionDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray || bArray) {
    if (!aArray || !bArray) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!catalogueProjectionDataEqual(a[i], b[i])) return false
    }
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  const bKeys = Object.keys(bo)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false
    if (!catalogueProjectionDataEqual(ao[key], bo[key])) return false
  }
  return true
}

/**
 * True when re-applying `next` would present exactly what `previous` already
 * presents: same revision/row content and same source witness. Used to keep
 * the per-row apply idempotent — the poll re-applies indexed rows every pass,
 * and without this each pass fanned listeners out again.
 */
export function catalogueProjectionReapplyEqual(
  previous: ThreadCatalogueProjection,
  previousWitness: string | undefined,
  next: ThreadCatalogueProjection,
  nextWitness: string | undefined
): boolean {
  return (
    (previousWitness ?? undefined) === (nextWitness ?? undefined) &&
    previous.sourceComplete === next.sourceComplete &&
    previous.revision === next.revision &&
    catalogueProjectionDataEqual(previous.summary, next.summary) &&
    catalogueProjectionDataEqual(previous.recovery, next.recovery)
  )
}

/** Main/Host display mirror. Refreshes are bounded worker requests, with no disk/body fallback. */
export class ThreadCatalogueMirror {
  private readonly witnesses = new Map<string, string>()
  private readonly rows = new Map<string, ThreadCatalogueProjection>()
  private readonly pendingLocalReads = new Set<string>()
  private readGeneration = 0
  private erasureGeneration = 0
  private readonly localWriteStamps = new Map<string, number>()
  private position: Changes['position'] | undefined
  private listing: Listing | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private coverage: 'partial' | 'complete' = 'partial'
  private error: string | null = null
  private failures = 0
  private readonly listeners = new Set<
    (row: ThreadCatalogueProjection | null, chatId: string) => void
  >()
  private polling: Promise<void> | null = null
  constructor(readonly port: ThreadCatalogueReadPort) {}

  subscribe(listener: (row: ThreadCatalogueProjection | null, chatId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get status(): { complete: boolean; loaded: number; failed: number; error: string | null } {
    return {
      complete: this.complete,
      loaded: this.rows.size,
      failed: this.failures,
      error: this.error
    }
  }

  get observationEpoch(): number {
    return this.readGeneration
  }

  get complete(): boolean {
    return this.coverage === 'complete'
  }
  sourceWitnessFor(chatId: string): string | undefined {
    return this.witnesses.get(chatId)
  }
  get(chatId: string): ThreadCatalogueProjection | undefined {
    return this.rows.get(chatId)
  }
  projections(): readonly ThreadCatalogueProjection[] {
    return [...this.rows.values()]
  }
  /** Optimistic chrome from an already-loaded writer; no historical read is initiated here. */
  observe(projection: ThreadCatalogueProjection, witness?: string): void {
    this.readGeneration += 1
    this.localWriteStamps.set(projection.summary.chatId, this.readGeneration)
    this.pendingLocalReads.add(projection.summary.chatId)
    this.apply(projection, witness)
  }

  private apply(projection: ThreadCatalogueProjection, witness?: string): void {
    const chatId = projection.summary.chatId
    const previous = this.rows.get(chatId)
    if (
      previous &&
      catalogueProjectionReapplyEqual(previous, this.witnesses.get(chatId), projection, witness)
    ) {
      // The poll re-applies indexed rows every pass; a same-content apply is
      // not news and must not fan listeners out again. One save produced 5-8
      // saveless invalidations purely through these duplicates, and the
      // renderer's refresh coordinator owns bounded retries now, so a
      // genuinely lost pull no longer depends on the storm to re-arm.
      return
    }
    if (witness) this.witnesses.set(chatId, witness)
    else this.witnesses.delete(chatId)
    this.rows.set(chatId, projection)
    for (const listener of this.listeners) listener(projection, chatId)
  }

  private canApplyIndexed(chatId: string, startedAt: number): boolean {
    return (this.localWriteStamps.get(chatId) ?? 0) <= startedAt
  }

  private applyIndexed(
    projection: ThreadCatalogueProjection,
    witness: string | undefined,
    startedAt: number
  ): void {
    if (!this.canApplyIndexed(projection.summary.chatId, startedAt)) return
    // The worker's list/summary APIs return only rows whose publication and
    // source witness still match ThreadCatalogue.read(). A request begun after
    // the local observation is positive current-state evidence, including a
    // later same-revision metadata-only overlay with a different witness.
    // Keep the write stamp: an older concurrent refresh may still resume.
    this.pendingLocalReads.delete(projection.summary.chatId)
    this.apply(projection, witness)
  }

  start(): void {
    void this.poll()
  }

  private poll(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.refresh()
      .catch((error) => {
        this.error = error instanceof Error ? error.message : 'History is unavailable'
        this.coverage = 'partial'
      })
      .finally(() => {
        this.polling = null
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            void this.poll()
          }, 500)
          this.timer.unref?.()
        }
      })
    return this.polling
  }

  async refresh(): Promise<void> {
    if (this.stopped) return
    const generation = this.erasureGeneration
    const confirmed = new Set<string>()
    const valid = (): boolean => {
      if (generation === this.erasureGeneration && !this.stopped) return true
      this.position = undefined
      this.listing = undefined
      return false
    }
    let changes = await this.port.query<Changes>({
      method: 'changes',
      ...(this.position ? { position: this.position } : {})
    })
    if (!valid()) return
    // A suspended listing still owns the cursor it captured, so only its own
    // resumption may adopt it. A pass that finds another one still in flight
    // leaves it alone and takes the incremental path.
    if ((!this.position && !this.listing) || changes.reset || this.listing?.suspended) {
      // Capture the changes cursor BEFORE listing, then replay anything that
      // moves between pages. A live reorder cannot silently omit a thread.
      // The cursor is adopted only once the listing completes: a page that
      // throws must leave the listing resumable, never permanently skipped.
      if (!this.listing || changes.reset)
        this.listing = {
          position: changes.position,
          before: null,
          present: new Set<string>(),
          startedAt: this.readGeneration,
          suspended: false
        }
      const listing = this.listing
      listing.suspended = false
      try {
        do {
          const pageStartedAt = this.readGeneration
          const page: ThreadCatalogueListPage = await this.port.query({
            method: 'list',
            limit: 100,
            ...(listing.before ? { before: listing.before } : {})
          })
          if (!valid()) return
          for (const entry of page.entries) {
            listing.present.add(entry.projection.summary.chatId)
            this.applyIndexed(entry.projection, entry.sourceWitness, pageStartedAt)
          }
          // Advance the resume cursor before the next request so a failure
          // restarts at the page that failed, not at the ones already applied.
          listing.before = page.next
          this.coverage = page.coverage
        } while (listing.before)
      } catch (error) {
        listing.suspended = true
        throw error
      }
      // Partial indexing is not evidence of deletion. Only a complete listing
      // or an explicit deletion event may remove an existing displayed thread.
      if (this.coverage === 'complete')
        for (const id of this.rows.keys())
          if (!listing.present.has(id) && this.canApplyIndexed(id, listing.startedAt))
            this.removeIndexed(id)
      this.position = listing.position
      this.listing = undefined
      changes = await this.port.query<Changes>({ method: 'changes', position: this.position })
      if (!valid()) return
    }
    if (changes.reset) {
      this.position = undefined
      return
    }
    for (const change of changes.changes) {
      if (change.removed) {
        if (this.rows.has(change.chatId) && !confirmed.has(change.chatId)) {
          confirmed.add(change.chatId)
          if (!(await this.confirmIndexedState(change.chatId, valid))) return
        }
      } else {
        const summaryStartedAt = this.readGeneration
        const entry = await this.port.query<{
          projection: ThreadCatalogueProjection
          sourceWitness: string
        } | null>({
          method: 'summary',
          chatId: change.chatId
        })
        if (!valid()) return
        if (entry) this.applyIndexed(entry.projection, entry.sourceWitness, summaryStartedAt)
      }
    }
    // Local writes can precede the first changes cursor. Confirm a locally
    // observed row once even if the first partial listing omitted it. This is
    // pending read work, never a witness/sequence hold on later authority.
    for (const chatId of [...this.pendingLocalReads]) {
      // A local write during confirmation stays queued for the next poll.
      if (confirmed.has(chatId)) continue
      confirmed.add(chatId)
      if (!(await this.confirmIndexedState(chatId, valid))) return
    }
    this.error = null
    this.failures = changes.progress?.failed ?? 0
    this.position = changes.position
    if (this.coverage === 'partial') {
      const page = await this.port.query<ThreadCatalogueListPage>({ method: 'list', limit: 1 })
      if (!valid()) return
      this.coverage = page.coverage
    }
  }

  forget(chatId: string): void {
    this.readGeneration += 1
    this.erasureGeneration += 1
    this.localWriteStamps.delete(chatId)
    this.coverage = 'partial'
    this.position = undefined
    this.listing = undefined
    this.pendingLocalReads.delete(chatId)
    this.remove(chatId)
  }
  forgetAll(): void {
    this.erasureGeneration += 1
    this.localWriteStamps.clear()
    this.coverage = 'partial'
    this.readGeneration += 1
    this.position = undefined
    this.listing = undefined
    this.pendingLocalReads.clear()
    for (const id of this.rows.keys()) this.remove(id)
  }

  private async confirmIndexedState(chatId: string, valid: () => boolean): Promise<boolean> {
    let opened: ThreadCatalogueOpenResult | null = null
    const startedAt = this.readGeneration
    try {
      // Removed changes are historical events. One metadata confirmation tells
      // absence from a recreated source without consulting transcript pages.
      opened = await this.port.query<ThreadCatalogueOpenResult | null>({
        method: 'open',
        chatId,
        mode: 'metadata'
      })
      if (valid() && this.canApplyIndexed(chatId, startedAt)) {
        // A metadata request can join a record/page import. Its unpublished read
        // snapshot is not current indexed authority; leave the cursor for retry.
        if (opened?.entry.snapshot) throw new Error('History changed during indexing')
        if (opened)
          this.applyIndexed(opened.entry.projection, opened.entry.sourceWitness, startedAt)
        else this.removeIndexed(chatId)
      }
    } finally {
      if (opened) await this.port.query({ method: 'release', leaseId: opened.leaseId })
    }
    return valid()
  }

  private removeIndexed(chatId: string): void {
    this.pendingLocalReads.delete(chatId)
    this.remove(chatId)
  }

  private remove(chatId: string): void {
    this.rows.delete(chatId)
    this.witnesses.delete(chatId)
    for (const listener of this.listeners) listener(null, chatId)
  }

  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.polling
    this.listeners.clear()
    this.rows.clear()
    this.witnesses.clear()
    this.pendingLocalReads.clear()
    this.localWriteStamps.clear()
    this.listing = undefined
  }
}
