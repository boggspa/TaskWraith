import { describe, expect, it } from 'vitest'
import {
  loadSidebarThreadOrderState,
  normalizeSidebarThreadOrderState,
  orderSidebarThreads,
  parseSidebarThreadDragPayload,
  reorderSidebarThreadOrder,
  saveSidebarThreadOrderState,
  serializeSidebarThreadDragPayload,
  SIDEBAR_THREAD_ORDER_STORAGE_KEY,
  SIDEBAR_THREAD_ORDER_STORAGE_VERSION,
  SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY,
  type SidebarThreadOrderStorage
} from './sidebarThreadOrder'

function storage(): SidebarThreadOrderStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

const threads = (ids: string[]) => ids.map((appChatId) => ({ appChatId }))

describe('sidebarThreadOrder', () => {
  it('loads only the versioned, valid per-list state', () => {
    const target = storage()
    target.values.set(
      SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY,
      SIDEBAR_THREAD_ORDER_STORAGE_VERSION
    )
    target.values.set(
      SIDEBAR_THREAD_ORDER_STORAGE_KEY,
      JSON.stringify({
        'code:workspace:a': ['chat-2', 'chat-2', '', 4, 'chat-1'],
        '': ['ignored'],
        broken: 'ignored'
      })
    )

    expect(loadSidebarThreadOrderState(target)).toEqual({
      'code:workspace:a': ['chat-2', 'chat-1']
    })
  })

  it('ignores a version mismatch and malformed state', () => {
    const target = storage()
    target.values.set(SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY, 'old')
    target.values.set(SIDEBAR_THREAD_ORDER_STORAGE_KEY, '{not json')
    expect(loadSidebarThreadOrderState(target)).toEqual({})
    expect(normalizeSidebarThreadOrderState(['not an object'])).toEqual({})
  })

  it('preserves the current list for new threads while applying saved order', () => {
    const state = { 'code:workspace:a': ['chat-3', 'stale', 'chat-1'] }
    expect(
      orderSidebarThreads(threads(['chat-1', 'chat-2', 'chat-3']), 'code:workspace:a', state)
    ).toEqual(threads(['chat-3', 'chat-1', 'chat-2']))
  })

  it('moves a thread before or after another thread within one list', () => {
    const state = { 'work:project:a': ['chat-1', 'chat-2', 'chat-3'] }
    const before = reorderSidebarThreadOrder(
      state,
      'work:project:a',
      ['chat-1', 'chat-2', 'chat-3'],
      'chat-3',
      'chat-1',
      'before'
    )
    expect(before['work:project:a']).toEqual(['chat-3', 'chat-1', 'chat-2'])

    const after = reorderSidebarThreadOrder(
      state,
      'work:project:a',
      ['chat-1', 'chat-2', 'chat-3'],
      'chat-1',
      'chat-3',
      'after'
    )
    expect(after['work:project:a']).toEqual(['chat-2', 'chat-3', 'chat-1'])
  })

  it('does not mutate state for a missing or same-list target', () => {
    const state = { 'code:workspace:a': ['chat-1', 'chat-2'] }
    expect(
      reorderSidebarThreadOrder(state, 'code:workspace:a', ['chat-1', 'chat-2'], 'chat-1', 'chat-1')
    ).toBe(state)
    expect(
      reorderSidebarThreadOrder(state, 'code:workspace:a', ['chat-1', 'chat-2'], 'chat-9', 'chat-1')
    ).toBe(state)
  })

  it('round-trips the drag payload and rejects malformed payloads', () => {
    const encoded = serializeSidebarThreadDragPayload({
      listId: 'code:workspace:a',
      chatId: 'chat-1'
    })
    expect(parseSidebarThreadDragPayload(encoded)).toEqual({
      listId: 'code:workspace:a',
      chatId: 'chat-1'
    })
    expect(parseSidebarThreadDragPayload('null')).toBeNull()
    expect(parseSidebarThreadDragPayload('{"listId":"","chatId":"chat-1"}')).toBeNull()
  })

  it('saves a version marker with the order state', () => {
    const target = storage()
    const state = { 'chat:chats': ['chat-2', 'chat-1'] }
    saveSidebarThreadOrderState(state, target)
    expect(target.values.get(SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY)).toBe(
      SIDEBAR_THREAD_ORDER_STORAGE_VERSION
    )
    expect(loadSidebarThreadOrderState(target)).toEqual(state)
  })
})
