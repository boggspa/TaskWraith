import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueOpenResult } from '../shared/threadCatalogueTypes'
import type { HostCatalogueRunWindow, HostProfileRun } from '../host-runtime/HostProfileDomainStore'

type RunWindowEntry = { chatId: string; sourceWitness: string; run: HostProfileRun }

const REFRESH_DEBOUNCE_MS = 100
const STALE_RETRY_MAX_DELAY_MS = 5_000
const STALE_RETRY_LIMIT = 8

/** The Host's existing 1,800-run display window, independent of the per-thread last run. */
export class ThreadCatalogueHostRunWindow {
  private rows: RunWindowEntry[] = []
  private total = 0
  private settled = false
  /** The last read's own verdict: every chat it returned was listed, and it was not torn. */
  private readSettled = false
  private refreshPromise: Promise<boolean> | null = null
  private readonly staleRetries = new Map<string, number>()
  private tornRetries = 0
  private repeatedRuns = new Set<string>()
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDueAt = 0
  private readonly unsubscribe: () => void
  constructor(
    private readonly mirror: ThreadCatalogueMirror,
    private readonly changed: () => void
  ) {
    this.unsubscribe = mirror.subscribe((row, id) => {
      if (!row) this.rows = this.rows.filter((entry) => entry.chatId !== id)
      this.settled = false
      // Only a chat's own event restores its stale-retry budget.
      this.staleRetries.delete(id)
      this.schedule()
    })
    this.schedule()
  }
  /**
   * A chat's last indexed rows outlive a change of its source witness until a
   * refresh replaces them. A persist moves the witness before the index has
   * caught up; hiding the rows then read as the chat's runs being deleted, and
   * the persist's own command-scoped diff tombstoned every one of them. Rows
   * whose witness is not current leave the window incomplete, and `refreshFor`
   * never counts one as proof.
   */
  snapshot(): HostCatalogueRunWindow {
    return {
      entries: [...this.rows],
      total: this.total,
      complete:
        this.settled &&
        this.mirror.complete &&
        this.refreshPromise === null &&
        this.rows.every((row) => this.isCurrent(row))
    }
  }

  /**
   * The served rows are a whole window: a read has completed over a complete
   * mirror without skipping a chat or tearing. False until the first such
   * read, so a capture before it never stands for the profile's runs. Rows
   * whose witness moved since are still their chat's last indexed rows, so
   * staleness does not unload the window; a mirror event alone neither.
   */
  get loaded(): boolean {
    return this.readSettled && this.mirror.complete
  }

  private isCurrent(row: RunWindowEntry): boolean {
    return this.mirror.sourceWitnessFor(row.chatId) === row.sourceWitness
  }

  private schedule(delayMs = REFRESH_DEBOUNCE_MS): void {
    if (this.stopped) return
    // Monotonic, as timers are: a clock step or sleep must not reorder them.
    const dueAt = performance.now() + delayMs
    if (this.timer) {
      // An earlier refresh replaces a later one, so a stale chat's backoff
      // never delays the refresh a mirror event asks for.
      if (dueAt >= this.timerDueAt) return
      clearTimeout(this.timer)
    }
    this.timerDueAt = dueAt
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, delayMs)
    this.timer.unref?.()
  }

  private cancelScheduledRefresh(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private refresh(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.refreshPromise) {
      this.schedule()
      return this.refreshPromise
    }
    const pending = this.performRefresh().finally(() => {
      this.refreshPromise = null
      if (!this.stopped) this.changed()
    })
    this.refreshPromise = pending
    return pending
  }

  private async performRefresh(): Promise<boolean> {
    try {
      const rows: RunWindowEntry[] = []
      let total = 0
      let offset: number | null = 0
      do {
        const page: { entries: RunWindowEntry[]; total: number; next: number | null } =
          await this.mirror.port.query({ method: 'host-runs', offset })
        rows.push(...page.entries)
        total = page.total
        offset = page.next
      } while (offset !== null && !this.stopped)
      if (this.stopped) return false
      // Offset pages over the index's moving order can return one run twice,
      // from before and after a re-index of its chat: keep one row per run,
      // the copy whose witness is current, else the later page's. The mirror
      // holds no witness for a chat it has removed, not yet listed, or failed
      // to witness: an index that still serves its rows cannot restore them,
      // and the mirror announces a chat it learns.
      const byRun = new Map<string, RunWindowEntry>()
      const repeated = new Set<string>()
      let unknownChats = 0
      let reindexed = false
      for (const row of rows) {
        if (this.mirror.sourceWitnessFor(row.chatId) === undefined) {
          unknownChats += 1
          continue
        }
        const key = `${row.chatId.length}:${row.chatId}:${row.run.runId}`
        const kept = byRun.get(key)
        if (kept && kept.sourceWitness !== row.sourceWitness) reindexed = true
        else if (kept) repeated.add(key)
        if (!kept || !this.isCurrent(kept) || this.isCurrent(row)) byRun.set(key, row)
      }
      // A repeat under one witness is the record's own, or a page boundary
      // that another chat's move up the order crossed mid-read, skipping that
      // chat's rows: settle on it only once the next read repeats it too.
      const unconfirmed = [...repeated].some((key) => !this.repeatedRuns.has(key))
      this.repeatedRuns = repeated
      this.rows = [...byRun.values()]
      this.total = total
      this.settled = unknownChats === 0 && !reindexed && !unconfirmed
      this.readSettled = this.settled
      this.retryUntilCurrent(reindexed || unconfirmed)
      return true
    } catch {
      if (!this.stopped) this.schedule()
      return false
    }
  }

  /**
   * The mirror fans out nothing when the index catches up with a witness it
   * already observed, so a window holding stale rows, or read while the order
   * moved, asks again itself: 100 ms doubling to a 5 s cap. Each stale chat
   * has eight retries, restored only by a mirror event about that chat, so a
   * chat the index never catches up with cannot keep the window asking on
   * other chats' events. Torn reads have eight of their own, restored by a
   * read that is not torn.
   */
  private retryUntilCurrent(torn: boolean): void {
    const stale = new Set<string>()
    for (const row of this.rows) if (!this.isCurrent(row)) stale.add(row.chatId)
    for (const chatId of [...this.staleRetries.keys()]) {
      if (!stale.has(chatId)) this.staleRetries.delete(chatId)
    }
    if (!torn) this.tornRetries = 0
    const due = [...stale].filter(
      (chatId) => (this.staleRetries.get(chatId) ?? 0) < STALE_RETRY_LIMIT
    )
    const tornDue = torn && this.tornRetries < STALE_RETRY_LIMIT
    if (due.length === 0 && !tornDue) return
    const attempt = Math.min(
      ...due.map((chatId) => this.staleRetries.get(chatId) ?? 0),
      ...(tornDue ? [this.tornRetries] : [])
    )
    for (const chatId of due) {
      this.staleRetries.set(chatId, (this.staleRetries.get(chatId) ?? 0) + 1)
    }
    if (tornDue) this.tornRetries += 1
    this.schedule(Math.min(STALE_RETRY_MAX_DELAY_MS, REFRESH_DEBOUNCE_MS * 2 ** attempt))
  }

  /**
   * Bypass the 100 ms display-window debounce for a persist-proven queued
   * start. An older refresh is not sufficient: wait for it, then query again
   * so the result is current with respect to the mirror observation that
   * invalidated the command's prior run row.
   */
  async refreshFor(chatId: string, runId: string): Promise<boolean> {
    if (this.stopped) return false
    this.cancelScheduledRefresh()
    const olderRefresh = this.refreshPromise
    if (olderRefresh) await olderRefresh
    if (this.stopped) return false
    // The older refresh (or a mirror observation during it) may have armed a
    // new debounce. This explicit barrier owns the next query.
    this.cancelScheduledRefresh()
    let opened: ThreadCatalogueOpenResult | null = null
    let refreshed = false
    try {
      // `changed` only arms the worker's own 100 ms debounce. The mirror's
      // established metadata-open barrier awaits foreground indexing, making
      // the new source witness queryable now without an arbitrary sleep.
      opened = await this.mirror.port.query({ method: 'open', chatId, mode: 'metadata' })
      if (!opened || opened.entry.snapshot || opened.entry.projection.sourceComplete === false) {
        return false
      }
      refreshed = true
      if (!(await this.refresh())) return false
      return this.rows.some(
        (entry) => entry.chatId === chatId && entry.run.runId === runId && this.isCurrent(entry)
      )
    } catch {
      return false
    } finally {
      if (opened) {
        await this.mirror.port
          .query({ method: 'release', leaseId: opened.leaseId })
          .catch(() => undefined)
      }
      // This barrier cancelled any pending refresh. One it did not run itself
      // must not leave the window waiting on a mirror event.
      if (!refreshed && !this.stopped) {
        if (this.settled) this.retryUntilCurrent(false)
        else this.schedule()
      }
    }
  }
  dispose(): void {
    this.stopped = true
    this.unsubscribe()
    if (this.timer) clearTimeout(this.timer)
    this.rows = []
  }
}
