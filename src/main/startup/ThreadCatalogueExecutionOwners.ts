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

/**
 * Spacing of the passes that follow one that could not finish, because an
 * owner failed to preload or the pass threw. It doubles to a one-minute cap
 * and allows fifteen re-runs, so the bound is on passes, not on wall time:
 * the waits add up to about eleven minutes, and each pass's own owner preload
 * comes on top (with a catalogue that takes 20 s a request, the last pass
 * lands after about sixteen minutes). That gives a slow catalogue or Host
 * time to heal the paused owners, while a condition that never clears is left
 * to the notices it raised rather than retried for the whole session.
 */
export const CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  ...Array<number>(10).fill(60_000)
])

/**
 * Recovery waits for its own owners off main; other executions can still
 * recover. A pass runs again, on the backoff above, while an owner failed to
 * preload or the pass threw. `onError` hears every throw, and whether another
 * pass follows it.
 */
export function startCatalogueExecutionRecovery(options: {
  mirror: ThreadCatalogueMirror
  ownerIds(): readonly string[]
  recover(): void
  onError(error: unknown, retrying: boolean): void
  retryDelaysMs?: readonly number[]
}): () => void {
  const delays = options.retryDelaysMs ?? CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS
  let stopped = false
  let reruns = 0
  let timer: ReturnType<typeof setTimeout>
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void run()
    }, delayMs)
    timer.unref?.()
  }
  const run = async (): Promise<void> => {
    let failure: { readonly error: unknown } | undefined
    let ownersPending = false
    try {
      const failed = await preloadCatalogueExecutionOwners(options.mirror, options.ownerIds())
      if (stopped) return
      options.recover()
      ownersPending = failed.length > 0
    } catch (error) {
      failure = { error }
    }
    const retrying = (failure !== undefined || ownersPending) && !stopped && reruns < delays.length
    if (failure) options.onError(failure.error, retrying)
    if (retrying) schedule(delays[reruns++])
  }
  schedule(0)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
