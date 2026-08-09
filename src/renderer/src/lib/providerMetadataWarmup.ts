export const PROVIDER_METADATA_WARMUP_QUIET_MS = 20_000

type WarmupTimerHandle = unknown

type WarmupEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export interface ProviderMetadataWarmupController {
  dispose: () => void
  noteActivity: () => void
}

export interface ProviderMetadataWarmupOptions<Provider extends string> {
  providers: readonly Provider[]
  refresh: (provider: Provider) => Promise<unknown>
  eventTarget?: WarmupEventTarget
  quietMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => WarmupTimerHandle
  clearTimer?: (handle: WarmupTimerHandle) => void
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'] as const

/**
 * Warms non-active provider metadata without competing with the user's first
 * interactions. Only one provider may probe at a time, and every provider
 * requires a fresh quiet window. Activity during a probe cannot cancel the
 * provider subprocess already in flight, but it does hold the rest of the
 * queue until the user has gone quiet again.
 */
export function scheduleProviderMetadataWarmup<Provider extends string>(
  options: ProviderMetadataWarmupOptions<Provider>
): ProviderMetadataWarmupController {
  const eventTarget = options.eventTarget ?? window
  const quietMs = Math.max(0, options.quietMs ?? PROVIDER_METADATA_WARMUP_QUIET_MS)
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle: WarmupTimerHandle) => window.clearTimeout(handle as number))
  const pending = [...new Set(options.providers)]

  let disposed = false
  let running = false
  let timer: WarmupTimerHandle | null = null
  let lastActivityAt = now()

  const clearScheduledRun = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const scheduleNext = (delayMs = quietMs): void => {
    clearScheduledRun()
    if (disposed || running || pending.length === 0) return
    timer = setTimer(
      () => {
        timer = null
        void runNext()
      },
      Math.max(0, delayMs)
    )
  }

  const runNext = async (): Promise<void> => {
    if (disposed || running || pending.length === 0) return
    const quietForMs = now() - lastActivityAt
    if (quietForMs < quietMs) {
      scheduleNext(quietMs - quietForMs)
      return
    }

    const provider = pending.shift()
    if (!provider) return
    running = true
    try {
      await options.refresh(provider)
    } catch {
      // Discovery is advisory. Explicit picker/settings refreshes remain the
      // surfaced recovery path, while one provider failure must not strand the
      // rest of the background queue.
    } finally {
      running = false
      scheduleNext()
    }
  }

  const noteActivity = (): void => {
    if (disposed) return
    lastActivityAt = now()
    if (!running) scheduleNext()
  }

  for (const eventName of ACTIVITY_EVENTS) {
    eventTarget.addEventListener(eventName, noteActivity, { capture: true, passive: true })
  }
  scheduleNext()

  return {
    noteActivity,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearScheduledRun()
      for (const eventName of ACTIVITY_EVENTS) {
        eventTarget.removeEventListener(eventName, noteActivity, { capture: true })
      }
    }
  }
}
