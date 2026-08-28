export interface QuitPersistenceEvent {
  preventDefault(): void
}

export interface QuitPersistenceCoordinatorOptions {
  flush: () => Promise<void>
  requestQuit: () => void
  scheduleRetry?: (callback: () => void) => void
  onDrainError?: (error: unknown) => void
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

      void drain
        .catch((error) => {
          options.onDrainError?.(error)
        })
        .finally(() => {
          state = 'ready'
          scheduleRetry(options.requestQuit)
        })
    },
    beginTeardown() {
      if (state !== 'ready' || teardownStarted) return false
      teardownStarted = true
      return true
    }
  }
}
