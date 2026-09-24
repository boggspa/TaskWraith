/** Coalesce metadata changes while a cold index fills; intermediate rows are replaceable. */
export function createThreadCatalogueUiPublisher<T extends { appChatId: string }>(
  publish: (row: T) => void,
  inventoryChanged: () => void
) {
  const pending = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inventoryTimer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    let count = 0
    for (const [id, row] of pending) {
      pending.delete(id)
      publish(row)
      if (++count === 100) break
    }
    if (!inventoryTimer) {
      inventoryTimer = setTimeout(() => {
        inventoryTimer = undefined
        inventoryChanged()
      }, 250)
      inventoryTimer.unref?.()
    }
    if (pending.size) {
      timer = setTimeout(flush, 25)
      timer.unref?.()
    }
  }
  return {
    enqueue(row: T): void {
      pending.set(row.appChatId, row)
      if (!timer) {
        timer = setTimeout(flush, 50)
        timer.unref?.()
      }
    },
    forget(id: string): void {
      pending.delete(id)
    },
    dispose(): void {
      if (timer) clearTimeout(timer)
      if (inventoryTimer) clearTimeout(inventoryTimer)
      pending.clear()
    }
  }
}
