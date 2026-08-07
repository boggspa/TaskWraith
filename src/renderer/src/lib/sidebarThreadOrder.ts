/**
 * Renderer-local ordering for the thread lists in the sidebar.
 *
 * A list id is part of the ordering contract. The same thread can appear in
 * several sidebar surfaces, so each surface gets an independent order and a
 * drag can only rewrite the list it started in.
 */

export const SIDEBAR_THREAD_ORDER_STORAGE_KEY = 'taskwraith-sidebar-thread-order'
export const SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY = 'taskwraith-sidebar-thread-order-version'
export const SIDEBAR_THREAD_ORDER_STORAGE_VERSION = 'thread-order-v1'
export const SIDEBAR_THREAD_DRAG_MIME = 'application/x-taskwraith-sidebar-thread'

export type SidebarThreadOrderState = Record<string, string[]>

export interface SidebarThreadOrderStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SidebarThreadDragPayload {
  listId: string
  chatId: string
}

function resolveStorage(storage?: SidebarThreadOrderStorage): SidebarThreadOrderStorage | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

export function normalizeSidebarThreadOrderState(value: unknown): SidebarThreadOrderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: SidebarThreadOrderState = {}
  for (const [listId, threadIds] of Object.entries(value)) {
    if (!listId.trim()) continue
    const normalized = normalizeList(threadIds)
    if (normalized.length > 0) result[listId] = normalized
  }
  return result
}

export function loadSidebarThreadOrderState(
  storage?: SidebarThreadOrderStorage
): SidebarThreadOrderState {
  const source = resolveStorage(storage)
  if (!source) return {}
  try {
    if (
      source.getItem(SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY) !==
      SIDEBAR_THREAD_ORDER_STORAGE_VERSION
    ) {
      return {}
    }
    const raw = source.getItem(SIDEBAR_THREAD_ORDER_STORAGE_KEY)
    return raw ? normalizeSidebarThreadOrderState(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

export function saveSidebarThreadOrderState(
  state: SidebarThreadOrderState,
  storage?: SidebarThreadOrderStorage
): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    target.setItem(SIDEBAR_THREAD_ORDER_STORAGE_VERSION_KEY, SIDEBAR_THREAD_ORDER_STORAGE_VERSION)
    target.setItem(SIDEBAR_THREAD_ORDER_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ordering is a preference; private-mode and quota failures are harmless.
  }
}

function mergeListOrder(listIds: readonly string[], persistedIds: readonly string[]): string[] {
  const available = new Set(listIds)
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of persistedIds) {
    if (available.has(id) && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  for (const id of listIds) {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

export function orderSidebarThreads<T extends { appChatId: string }>(
  threads: readonly T[],
  listId: string,
  state: SidebarThreadOrderState
): T[] {
  if (!listId || threads.length < 2) return [...threads]
  const byId = new Map<string, T>()
  const listIds: string[] = []
  for (const thread of threads) {
    if (byId.has(thread.appChatId)) continue
    byId.set(thread.appChatId, thread)
    listIds.push(thread.appChatId)
  }
  return mergeListOrder(listIds, state[listId] ?? [])
    .map((id) => byId.get(id))
    .filter((thread): thread is T => Boolean(thread))
}

export function reorderSidebarThreadOrder(
  state: SidebarThreadOrderState,
  listId: string,
  listIds: readonly string[],
  draggedChatId: string,
  targetChatId: string | null,
  placement: 'before' | 'after' = 'before'
): SidebarThreadOrderState {
  if (!listId || !draggedChatId || !listIds.includes(draggedChatId)) return state
  if (targetChatId === draggedChatId) return state
  if (targetChatId !== null && !listIds.includes(targetChatId)) return state

  const current = mergeListOrder(listIds, state[listId] ?? [])
  const sourceIndex = current.indexOf(draggedChatId)
  if (sourceIndex < 0) return state
  current.splice(sourceIndex, 1)

  if (targetChatId === null) {
    current.push(draggedChatId)
  } else {
    const targetIndex = current.indexOf(targetChatId)
    if (targetIndex < 0) return state
    current.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, draggedChatId)
  }

  if (current.every((id, index) => id === mergeListOrder(listIds, state[listId] ?? [])[index])) {
    return state
  }
  return { ...state, [listId]: current }
}

export function serializeSidebarThreadDragPayload(payload: SidebarThreadDragPayload): string {
  return JSON.stringify(payload)
}

export function parseSidebarThreadDragPayload(value: string): SidebarThreadDragPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<SidebarThreadDragPayload>
    if (
      !parsed ||
      typeof parsed.listId !== 'string' ||
      !parsed.listId.trim() ||
      typeof parsed.chatId !== 'string' ||
      !parsed.chatId.trim()
    ) {
      return null
    }
    return { listId: parsed.listId, chatId: parsed.chatId }
  } catch {
    return null
  }
}
