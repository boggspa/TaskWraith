import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueOpenResult } from '../shared/threadCatalogueTypes'
import type { HostCatalogueRunWindow, HostProfileRun } from '../host-runtime/HostProfileDomainStore'

type RunWindowEntry = { chatId: string; sourceWitness: string; run: HostProfileRun }

/** The Host's existing 1,800-run display window, independent of the per-thread last run. */
export class ThreadCatalogueHostRunWindow {
  private rows: RunWindowEntry[] = []
  private total = 0
  private settled = false
  private refreshPromise: Promise<boolean> | null = null
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly unsubscribe: () => void
  constructor(
    private readonly mirror: ThreadCatalogueMirror,
    private readonly changed: () => void
  ) {
    this.unsubscribe = mirror.subscribe((row, id) => {
      if (!row) this.rows = this.rows.filter((entry) => entry.chatId !== id)
      this.settled = false
      this.schedule()
    })
    this.schedule()
  }
  snapshot(): HostCatalogueRunWindow {
    return {
      entries: this.rows.filter(
        (row) => this.mirror.sourceWitnessFor(row.chatId) === row.sourceWitness
      ),
      total: this.total,
      complete: this.settled && this.mirror.complete && this.refreshPromise === null
    }
  }
  private schedule(): void {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, 100)
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
      this.rows = rows.filter(
        (row) => this.mirror.sourceWitnessFor(row.chatId) === row.sourceWitness
      )
      this.total = total
      this.settled = this.rows.length === rows.length
      return true
    } catch {
      if (!this.stopped) this.schedule()
      return false
    }
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
    try {
      // `changed` only arms the worker's own 100 ms debounce. The mirror's
      // established metadata-open barrier awaits foreground indexing, making
      // the new source witness queryable now without an arbitrary sleep.
      opened = await this.mirror.port.query({ method: 'open', chatId, mode: 'metadata' })
      if (
        !opened ||
        opened.entry.snapshot ||
        opened.entry.projection.sourceComplete === false ||
        !(await this.refresh())
      ) {
        return false
      }
      return this.snapshot().entries.some(
        (entry) => entry.chatId === chatId && entry.run.runId === runId
      )
    } catch {
      return false
    } finally {
      if (opened) {
        await this.mirror.port
          .query({ method: 'release', leaseId: opened.leaseId })
          .catch(() => undefined)
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
