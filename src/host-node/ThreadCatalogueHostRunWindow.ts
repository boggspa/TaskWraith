import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { HostCatalogueRunWindow, HostProfileRun } from '../host-runtime/HostProfileDomainStore'

type RunWindowEntry = { chatId: string; sourceWitness: string; run: HostProfileRun }

/** The Host's existing 1,800-run display window, independent of the per-thread last run. */
export class ThreadCatalogueHostRunWindow {
  private rows: RunWindowEntry[] = []
  private total = 0
  private settled = false
  private running = false
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
      complete: this.settled && this.mirror.complete && !this.running
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
  private async refresh(): Promise<void> {
    if (this.running || this.stopped) {
      this.schedule()
      return
    }
    this.running = true
    try {
      const rows: RunWindowEntry[] = []
      let offset: number | null = 0
      do {
        const page: { entries: RunWindowEntry[]; total: number; next: number | null } =
          await this.mirror.port.query({ method: 'host-runs', offset })
        rows.push(...page.entries)
        this.total = page.total
        offset = page.next
      } while (offset !== null && !this.stopped)
      if (!this.stopped) {
        this.rows = rows.filter(
          (row) => this.mirror.sourceWitnessFor(row.chatId) === row.sourceWitness
        )
        this.settled = this.rows.length === rows.length
      }
    } catch {
      if (!this.stopped) this.schedule()
    } finally {
      this.running = false
      if (!this.stopped) this.changed()
    }
  }
  dispose(): void {
    this.stopped = true
    this.unsubscribe()
    if (this.timer) clearTimeout(this.timer)
    this.rows = []
  }
}
