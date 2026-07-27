/**
 * A tiny renderer-local handoff from the composer to the chat-owned Canvas
 * dock. The request stays in memory just long enough for the dock to mount;
 * it never represents a grant or an agent capability.
 */
export interface MeshCanvasOpenRequest {
  id: number
  chatId: string
}

let nextRequestId = 0
let pendingRequest: MeshCanvasOpenRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function requestMeshCanvasOpen(chatId: string): void {
  pendingRequest = { id: ++nextRequestId, chatId }
  emit()
}

export function getPendingMeshCanvasOpenRequest(): MeshCanvasOpenRequest | null {
  return pendingRequest
}

export function consumeMeshCanvasOpenRequest(id: number): void {
  if (pendingRequest?.id !== id) return
  pendingRequest = null
  emit()
}

export function subscribeMeshCanvasOpenRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
