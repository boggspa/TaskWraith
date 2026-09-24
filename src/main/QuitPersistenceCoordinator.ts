export interface QuitPersistenceEvent {
  preventDefault(): void
}

/**
 * Upper bound on the quit-time persistence flush. The Host drain inside it is
 * already bounded; this cap guarantees the quit itself completes even when a
 * flush stalls for a reason the drain cannot see (a full disk, a wedged
 * writer), because a quit that never returns leaves the windows closed, the
 * process alive, and a pending update never installed.
 */
export const QUIT_PERSISTENCE_DRAIN_TIMEOUT_MS = 30_000

export interface QuitPersistenceCoordinatorOptions {
  flush: () => Promise<void>
  requestQuit: () => void
  scheduleRetry?: (callback: () => void) => void
  onDrainError?: (error: unknown) => void
  drainTimeoutMs?: number
}

export interface QuitPersistenceCoordinator {
  handle(event: QuitPersistenceEvent): void
  beginTeardown(): boolean
}

/**
 * Electron cannot await `will-quit`. Cancel the first request while the
 * persistence barrier runs, then retry from a later event-loop turn so the
 * cancelled native quit transaction has fully unwound.
 */
export function createQuitPersistenceCoordinator(
  options: QuitPersistenceCoordinatorOptions
): QuitPersistenceCoordinator {
  let state: 'idle' | 'draining' | 'ready' = 'idle'
  let teardownStarted = false
  const scheduleRetry = options.scheduleRetry ?? ((callback) => setImmediate(callback))
  const drainTimeoutMs =
    typeof options.drainTimeoutMs === 'number' && Number.isFinite(options.drainTimeoutMs)
      ? options.drainTimeoutMs
      : QUIT_PERSISTENCE_DRAIN_TIMEOUT_MS

  return {
    handle(event) {
      if (state === 'ready') return

      event.preventDefault()
      if (state === 'draining') return
      state = 'draining'

      let drain: Promise<void>
      try {
        drain = options.flush()
      } catch (error) {
        drain = Promise.reject(error)
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        state = 'ready'
        scheduleRetry(options.requestQuit)
      }

      if (drainTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          options.onDrainError?.(
            new Error(
              `Quit persistence flush did not finish within ${drainTimeoutMs}ms; quitting without waiting further`
            )
          )
          finish()
        }, drainTimeoutMs)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }

      void drain
        .catch((error) => {
          if (!settled) options.onDrainError?.(error)
        })
        .finally(finish)
    },
    beginTeardown() {
      if (state !== 'ready' || teardownStarted) return false
      teardownStarted = true
      return true
    }
  }
}
