export interface QueuedChatUpdateOptions {
  coalesce?: boolean
}

export type QueuedChatUpdater<T> = (value: T) => T

interface PendingHydration<T> {
  updates: Array<{
    updater: QueuedChatUpdater<T>
    options?: QueuedChatUpdateOptions
  }>
}

export interface EnqueueHydratedChatUpdate<T> {
  key: string
  updater: QueuedChatUpdater<T>
  options?: QueuedChatUpdateOptions
  hydrate: (key: string) => Promise<T | null>
  resolveBase: (key: string, hydrated: T) => T
  apply: (
    key: string,
    base: T,
    updater: QueuedChatUpdater<T>,
    options?: QueuedChatUpdateOptions
  ) => void
}

/**
 * Serialises functional updates which arrive while a record is represented by
 * a summary stub. Every key owns at most one hydration request; updates queued
 * behind it are composed in arrival order and committed once.
 */
export class ChatUpdateHydrationQueue<T> {
  private readonly pendingByKey = new Map<string, PendingHydration<T>>()

  hasPending(key: string): boolean {
    return this.pendingByKey.has(key)
  }

  cancel(key: string): void {
    this.pendingByKey.delete(key)
  }

  enqueue(request: EnqueueHydratedChatUpdate<T>): void {
    const existing = this.pendingByKey.get(request.key)
    if (existing) {
      existing.updates.push({ updater: request.updater, options: request.options })
      return
    }

    const pending: PendingHydration<T> = {
      updates: [{ updater: request.updater, options: request.options }]
    }
    this.pendingByKey.set(request.key, pending)

    let hydration: Promise<T | null>
    try {
      hydration = request.hydrate(request.key)
    } catch {
      this.pendingByKey.delete(request.key)
      return
    }

    void hydration
      .then((hydrated) => {
        if (this.pendingByKey.get(request.key) !== pending) return
        this.pendingByKey.delete(request.key)
        if (!hydrated) return

        const queued = pending.updates.slice()
        const composed: QueuedChatUpdater<T> = (base) =>
          queued.reduce((next, entry) => entry.updater(next), base)
        const options = queued.every((entry) => entry.options?.coalesce === true)
          ? { coalesce: true }
          : undefined
        request.apply(
          request.key,
          request.resolveBase(request.key, hydrated),
          composed,
          options
        )
      })
      .catch(() => {
        if (this.pendingByKey.get(request.key) === pending) {
          this.pendingByKey.delete(request.key)
        }
      })
  }

  clear(): void {
    this.pendingByKey.clear()
  }
}
