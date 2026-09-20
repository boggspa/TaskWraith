import { describe, expect, it, vi } from 'vitest'
import { createSidebarThreadDragSessionStore } from './sidebarThreadDragSession'
import { SIDEBAR_THREAD_DRAG_MIME } from './sidebarThreadOrder'

describe('sidebar thread drag session', () => {
  it('keeps sidebar-only drags available to the existing reorder and pin targets', () => {
    const store = createSidebarThreadDragSessionStore()
    store.start({ listId: 'code:recents', chatId: 'bravo' })
    expect(store.blocksSidebarDrop()).toBe(false)
    expect(store.accepts({ types: [SIDEBAR_THREAD_DRAG_MIME] })).toBe(true)
    expect(store.accepts({ types: ['Files', 'text/plain'] })).toBe(false)
  })

  it('latches sidebar cancellation until a multiview gesture ends', () => {
    const store = createSidebarThreadDragSessionStore()
    store.start({ listId: 'code:pinned', chatId: 'bravo' })
    store.enterMultiview()
    expect(store.blocksSidebarDrop()).toBe(true)
    expect(store.accepts({ types: [SIDEBAR_THREAD_DRAG_MIME] })).toBe(true)
    store.end()
    expect(store.blocksSidebarDrop()).toBe(false)
    expect(store.getSnapshot()).toBeNull()
  })

  it('rejects placement after Escape or blur and permits the next gesture', () => {
    const store = createSidebarThreadDragSessionStore()
    store.start({ listId: 'code:recents', chatId: 'bravo' })
    store.cancel()
    store.enterMultiview()
    expect(store.blocksSidebarDrop()).toBe(true)
    expect(store.accepts({ types: [SIDEBAR_THREAD_DRAG_MIME] })).toBe(false)
    store.end()
    store.start({ listId: 'code:recents', chatId: 'charlie' })
    expect(store.blocksSidebarDrop()).toBe(false)
    expect(store.accepts({ types: [SIDEBAR_THREAD_DRAG_MIME] })).toBe(true)
  })

  it('does not let delayed cleanup from an earlier drop erase a new drag', () => {
    const store = createSidebarThreadDragSessionStore()
    store.start({ listId: 'code:recents', chatId: 'bravo' })
    const first = store.getSnapshot()!.generation
    store.start({ listId: 'code:recents', chatId: 'charlie' })
    store.end(first)
    expect(store.getSnapshot()?.chatId).toBe('charlie')
  })

  it('only notifies observers when gesture state changes', () => {
    const store = createSidebarThreadDragSessionStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.start({ listId: 'code:recents', chatId: 'bravo' })
    store.enterMultiview()
    store.enterMultiview()
    store.cancel()
    store.cancel()
    store.end()
    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
    store.start({ listId: 'code:recents', chatId: 'charlie' })
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
