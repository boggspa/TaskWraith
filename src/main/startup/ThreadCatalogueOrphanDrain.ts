/** Late inventory discoveries use the same durable deletion coordinator as boot. */
export function createCatalogueOrphanDrain(options: {
  enabled(): boolean
  drain(): Promise<void>
  onError(error: unknown): void
}): { notify(): void; dispose(): void } {
  let running = false
  let requested = false
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const pump = async (): Promise<void> => {
    if (running || stopped || !options.enabled()) return
    running = true
    try {
      while (requested && !stopped && options.enabled()) {
        requested = false
        await options.drain()
      }
    } catch (error) {
      requested = true
      options.onError(error)
      retry = setTimeout(() => {
        retry = undefined
        void pump()
      }, 2000)
      retry.unref?.()
    } finally {
      running = false
    }
  }
  return {
    notify() {
      requested = true
      if (!retry) void pump()
    },
    dispose() {
      stopped = true
      if (retry) clearTimeout(retry)
    }
  }
}
