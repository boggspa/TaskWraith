import type { WorkspaceLockRuntime } from './WorkspaceLockRuntime'

export type WorkspaceLockAvailabilitySource = Partial<Pick<WorkspaceLockRuntime, 'subscribe'>>

/** Contention is an activity notice, not evidence that an edit scope became available. */
export function waitForWorkspaceLockStateChange(
  runtime: WorkspaceLockAvailabilitySource,
  stillWanted: () => boolean
): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    let settled = false
    let subscription: ReturnType<WorkspaceLockRuntime['subscribe']> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(fallback)
      subscription?.unsubscribe()
      resolveWait()
    }
    // Also covers another desktop process and release-before-subscribe races.
    const fallback = setTimeout(finish, 250)
    fallback.unref?.()
    try {
      subscription =
        runtime.subscribe?.({}, (update) => {
          if (update?.reason !== 'contended') finish()
        }) || null
      // Some adapters notify synchronously before returning their subscription.
      if (settled) subscription?.unsubscribe()
      if (!stillWanted()) finish()
    } catch (error) {
      clearTimeout(fallback)
      subscription?.unsubscribe()
      rejectWait(error)
    }
  })
}
