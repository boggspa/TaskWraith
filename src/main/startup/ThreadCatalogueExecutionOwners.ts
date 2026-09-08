import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type { ThreadCatalogueOpenResult } from '../../shared/threadCatalogueTypes'

/** Unknown inventory never becomes durable evidence that an execution lost its owner. */
export function catalogueExecutionOwnerStatus(
  mirror: ThreadCatalogueMirror | null,
  chatId: string,
  exists: (chatId: string) => boolean
): 'live' | 'missing' {
  if (!exists(chatId)) return 'missing'
  const row = mirror?.get(chatId)
  if (!row || row.sourceComplete === false) throw new Error('Execution owner metadata is loading')
  return row.summary.archived ? 'missing' : 'live'
}

export async function preloadCatalogueExecutionOwners(
  mirror: ThreadCatalogueMirror,
  chatIds: readonly string[]
): Promise<string[]> {
  const failed: string[] = []
  for (const chatId of new Set(chatIds)) {
    const epoch = mirror.observationEpoch
    try {
      const opened = await mirror.port.query<ThreadCatalogueOpenResult | null>({
        method: 'open',
        chatId,
        mode: 'metadata'
      })
      if (!opened) continue
      try {
        if (opened.entry.projection.sourceComplete === false)
          throw new Error('Execution owner source is incomplete')
        if (epoch !== mirror.observationEpoch) throw new Error('Execution owner view changed')
        mirror.observe(opened.entry.projection, opened.entry.sourceWitness)
      } finally {
        await mirror.port.query({ method: 'release', leaseId: opened.leaseId })
      }
    } catch {
      failed.push(chatId)
    }
  }
  return failed
}

/** Recovery waits for its own owners off main; other executions can still recover. */
export function startCatalogueExecutionRecovery(options: {
  mirror: ThreadCatalogueMirror
  ownerIds(): readonly string[]
  recover(): void
  onError(error: unknown): void
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const run = async (): Promise<void> => {
    let retry = false
    try {
      const failed = await preloadCatalogueExecutionOwners(options.mirror, options.ownerIds())
      if (stopped) return
      options.recover()
      retry = failed.length > 0
    } catch (error) {
      retry = true
      options.onError(error)
    }
    if (retry && !stopped) {
      timer = setTimeout(() => {
        void run()
      }, 2000)
      timer.unref?.()
    }
  }
  timer = setTimeout(() => {
    void run()
  }, 0)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
