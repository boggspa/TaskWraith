import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import type { ThreadCatalogueRecoveryHold } from '../host-shared/thread-catalogue/ThreadCatalogue'
import type {
  HostCatalogueRunOrigin,
  PreparedThreadMutation,
  ThreadCatalogueOpenResult,
  ThreadIndexedObject
} from '../shared/threadCatalogueTypes'

/** A Host lease proves only its own prior incarnation ended; legacy/Desktop rows are not guessed. */
export class ThreadCatalogueHostRecovery {
  private readonly queued = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly cleanups = new Map<
    string,
    { token: string; timer?: ReturnType<typeof setTimeout> }
  >()
  private running = false
  private stopped = false
  constructor(
    private readonly options: {
      client: Pick<ThreadCatalogueClient, 'query'>
      mirror: ThreadCatalogueMirror
      controller: ThreadCatalogueRecoveryController
      origin: HostCatalogueRunOrigin
    }
  ) {
    const enqueue = (chatId: string): void => {
      if (
        options.mirror.get(chatId)?.sourceComplete === false ||
        !options.mirror.get(chatId)?.recovery.unsettledRuns ||
        this.stopped
      )
        return
      this.queued.add(chatId)
      void this.pump()
    }
    this.unsubscribe = options.mirror.subscribe((row, id) => {
      if (row) enqueue(id)
    })
    for (const row of options.mirror.projections()) enqueue(row.summary.chatId)
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.queued.size && !this.stopped) {
        const id = this.queued.values().next().value!
        this.queued.delete(id)
        if (this.cleanups.has(id)) continue
        await this.recover(id).catch(() => this.retry(id))
      }
    } finally {
      this.running = false
    }
  }

  private async recover(chatId: string): Promise<void> {
    const { client, controller, origin } = this.options
    const opened = await client.query<ThreadCatalogueOpenResult | null>({
      method: 'open',
      chatId,
      mode: 'metadata'
    })
    if (!opened) return
    let hold: ThreadCatalogueRecoveryHold | null = null
    try {
      const runs: Array<{ runId: string }> = []
      let after: number | undefined
      for (;;) {
        const page = await client.query<ThreadIndexedObject[] | null>({
          method: 'objects',
          leaseId: opened.leaseId,
          kind: 'recovery',
          direction: 'newer',
          ...(after === undefined ? {} : { after }),
          maxObjects: 64,
          maxBytes: 256 * 1024
        })
        if (!page?.length) break
        for (const item of page) {
          after = item.ordinal
          if (item.kind !== 'inline') continue
          const run = item.value as {
            kind?: string
            runId?: string
            hostRunOrigin?: HostCatalogueRunOrigin
          }
          const owner = run.hostRunOrigin
          if (
            run.kind === 'run' &&
            typeof run.runId === 'string' &&
            owner?.schemaVersion === 1 &&
            owner.kind === 'host-node' &&
            owner.hostId === origin.hostId &&
            typeof owner.incarnation === 'string' &&
            owner.incarnation.length > 0 &&
            owner.incarnation !== origin.incarnation
          )
            runs.push({ runId: run.runId })
        }
        if (runs.length >= 1000 || this.stopped) break
      }
      if (!runs.length || this.stopped || opened.entry.snapshot) return
      hold = controller.beginHost(chatId)
      const prepared = await client.query<PreparedThreadMutation | null>({
        method: 'prepare',
        chatId,
        recoveryToken: hold.token,
        sourceWitness: opened.entry.sourceWitness,
        mutation: {
          kind: 'settle-runs',
          nowIso: new Date().toISOString(),
          minAgeMs: 0,
          runs: runs.slice(0, 1000)
        }
      })
      if (prepared && !this.stopped) await controller.adopt(chatId, hold.token, prepared.preparedId)
    } finally {
      try {
        if (hold) controller.end(chatId, hold.token)
      } catch {
        this.cleanups.set(chatId, { token: hold!.token })
        this.retryCleanup(chatId)
      } finally {
        await client.query({ method: 'release', leaseId: opened.leaseId })
      }
    }
  }

  private retry(id: string): void {
    if (this.stopped || this.retries.has(id)) return
    const timer = setTimeout(() => {
      this.retries.delete(id)
      if (this.options.mirror.get(id)?.recovery.unsettledRuns) {
        this.queued.add(id)
        void this.pump()
      }
    }, 2000)
    timer.unref?.()
    this.retries.set(id, timer)
  }
  private retryCleanup(id: string): void {
    const cleanup = this.cleanups.get(id)
    if (!cleanup || cleanup.timer || this.stopped) return
    cleanup.timer = setTimeout(() => {
      cleanup.timer = undefined
      try {
        this.options.controller.end(id, cleanup.token)
        this.cleanups.delete(id)
        this.retry(id)
      } catch {
        this.retryCleanup(id)
      }
    }, 1000)
    cleanup.timer.unref?.()
  }
  dispose(): void {
    this.stopped = true
    this.queued.clear()
    this.unsubscribe()
    for (const timer of this.retries.values()) clearTimeout(timer)
    for (const cleanup of this.cleanups.values()) if (cleanup.timer) clearTimeout(cleanup.timer)
  }
}
