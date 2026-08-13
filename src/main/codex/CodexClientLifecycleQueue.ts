export interface CodexClientLifecycleQueueSlot {
  /**
   * Wait for this exact FIFO position. A queued abort resolves `false` while
   * retaining the slot as a barrier until its predecessor releases, so a later
   * owner can never overtake the currently active lifecycle.
   */
  waitUntilAcquired(signal?: AbortSignal): Promise<boolean>
  /** Release an acquired slot, or safely cancel a slot that has not acquired. */
  release(): void
}

type SlotState = 'queued' | 'acquired' | 'released'

/**
 * Small FIFO used by the process-global Codex app-server lifecycle.
 *
 * Cancellation is deliberately not implemented with a bare Promise.race:
 * resolving a cancelled waiter's successor immediately would let it enter
 * while the predecessor still owns the app-server. Instead, a cancelled slot
 * resolves its caller promptly but releases its successor only after the
 * predecessor's barrier settles.
 */
export class CodexClientLifecycleQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue(): CodexClientLifecycleQueueSlot {
    const predecessor = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve
    })

    let state: SlotState = 'queued'
    let waitStarted = false

    const release = (): void => {
      if (state === 'released') return
      const acquired = state === 'acquired'
      state = 'released'
      if (acquired) {
        unlock()
        return
      }
      // Preserve FIFO when a queued slot is cancelled: its successor remains
      // blocked until this slot's predecessor has actually released.
      void predecessor.then(unlock, unlock)
    }

    return {
      waitUntilAcquired: async (signal) => {
        if (waitStarted) {
          throw new Error('Codex client lifecycle queue slots can only be awaited once.')
        }
        waitStarted = true
        if (state === 'released' || signal?.aborted) {
          release()
          return false
        }

        return await new Promise<boolean>((resolve) => {
          let settled = false
          const finish = (acquired: boolean): void => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            resolve(acquired)
          }
          const onAbort = (): void => {
            release()
            finish(false)
          }

          signal?.addEventListener('abort', onAbort, { once: true })
          void predecessor.then(
            () => {
              if (settled) return
              if (state !== 'queued' || signal?.aborted) {
                release()
                finish(false)
                return
              }
              state = 'acquired'
              finish(true)
            },
            () => {
              release()
              finish(false)
            }
          )
        })
      },
      release
    }
  }
}
