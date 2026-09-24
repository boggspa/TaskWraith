import { SIDEBAR_THREAD_DRAG_MIME, type SidebarThreadDragPayload } from './sidebarThreadOrder'

export interface SidebarThreadDragSession extends SidebarThreadDragPayload {
  generation: number
  enteredMultiview: boolean
  cancelled: boolean
}

/** Window-local gesture state: DataTransfer payloads are unreadable during dragover. */
export function createSidebarThreadDragSessionStore() {
  let current: SidebarThreadDragSession | null = null
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: SidebarThreadDragSession | null) => {
    if (current === next) return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: (payload: SidebarThreadDragPayload) => {
      publish({ ...payload, generation: ++generation, enteredMultiview: false, cancelled: false })
    },
    enterMultiview: () => {
      if (current && !current.enteredMultiview && !current.cancelled) {
        publish({ ...current, enteredMultiview: true })
      }
    },
    cancel: () => {
      if (current && !current.cancelled) publish({ ...current, cancelled: true })
    },
    end: (expectedGeneration = current?.generation) => {
      if (current?.generation === expectedGeneration) publish(null)
    },
    blocksSidebarDrop: () => Boolean(current?.enteredMultiview || current?.cancelled),
    accepts: (transfer: Pick<DataTransfer, 'types'>) =>
      Boolean(current && !current.cancelled && transfer.types.includes(SIDEBAR_THREAD_DRAG_MIME))
  }
}

export const sidebarThreadDragSession = createSidebarThreadDragSessionStore()
