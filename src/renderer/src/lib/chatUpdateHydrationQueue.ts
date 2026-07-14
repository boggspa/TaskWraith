export interface QueuedChatUpdateOptions {
  coalesce?: boolean
}

export type QueuedChatUpdater<T> = (value: T) => T

interface PendingHydration<T> {
  hydrating: boolean
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
  resolveAvailableBase: (key: string) => T | null
  resolveBase: (key: string, hydrated: T) => T
  apply: (
    key: string,
    base: T,
    updater: QueuedChatUpdater<T>,
    options?: QueuedChatUpdateOptions
  ) => T | null
}

/**
 * Serialises functional updates which arrive while a record is represented by
 * a summary stub. Every key owns at most one hydration request; updates queued
 * behind it are composed in arrival order and committed once. A full local base
 * can synchronously take ownership from an in-flight or failed hydration.
 */
export class ChatUpdateHydrationQueue<T> {
  private readonly pendingByKey = new Map<string, PendingHydration<T>>()

  private drain(
    request: EnqueueHydratedChatUpdate<T>,
    pending: PendingHydration<T>,
    base: T
  ): T | null {
    if (this.pendingByKey.get(request.key) !== pending) return null
    this.pendingByKey.delete(request.key)

    const queued = pending.updates.slice()
    const composed: QueuedChatUpdater<T> = (value) =>
      queued.reduce((next, entry) => entry.updater(next), value)
    const options = queued.every((entry) => entry.options?.coalesce === true)
      ? { coalesce: true }
      : undefined
    return request.apply(request.key, base, composed, options)
  }

  private recover(
    request: EnqueueHydratedChatUpdate<T>,
    pending: PendingHydration<T>
  ): T | null {
    if (this.pendingByKey.get(request.key) !== pending) return null
    pending.hydrating = false
    const availableBase = request.resolveAvailableBase(request.key)
    return availableBase !== null ? this.drain(request, pending, availableBase) : null
  }

  private hydrate(
    request: EnqueueHydratedChatUpdate<T>,
    pending: PendingHydration<T>
  ): T | null {
    pending.hydrating = true
    let hydration: Promise<T | null>
    try {
      hydration = request.hydrate(request.key)
    } catch {
      return this.recover(request, pending)
    }

    void hydration
      .then((hydrated) => {
        if (this.pendingByKey.get(request.key) !== pending) return
        if (!hydrated) {
          this.recover(request, pending)
          return
        }
        this.drain(request, pending, request.resolveBase(request.key, hydrated))
      })
      .catch(() => {
        this.recover(request, pending)
      })
    return null
  }

  hasPending(key: string): boolean {
    return this.pendingByKey.has(key)
  }

  cancel(key: string): void {
    this.pendingByKey.delete(key)
  }

  enqueue(request: EnqueueHydratedChatUpdate<T>): T | null {
    const existing = this.pendingByKey.get(request.key)
    if (existing) {
      existing.updates.push({ updater: request.updater, options: request.options })
      const availableBase = request.resolveAvailableBase(request.key)
      if (availableBase !== null) return this.drain(request, existing, availableBase)
      return existing.hydrating ? null : this.hydrate(request, existing)
    }

    const pending: PendingHydration<T> = {
      hydrating: false,
      updates: [{ updater: request.updater, options: request.options }]
    }
    this.pendingByKey.set(request.key, pending)
    return this.hydrate(request, pending)
  }

  clear(): void {
    this.pendingByKey.clear()
  }
}
