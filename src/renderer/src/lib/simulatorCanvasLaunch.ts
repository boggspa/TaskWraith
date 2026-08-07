/**
 * A tiny renderer-local handoff from the composer to the chat-owned Canvas
 * dock. The request stays in memory just long enough for the dock to mount;
 * it never represents a grant or an agent capability.
 */
export interface SimulatorCanvasOpenRequest {
  id: number
  chatId: string
}

let nextRequestId = 0
let pendingRequest: SimulatorCanvasOpenRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function requestSimulatorCanvasOpen(chatId: string): void {
  pendingRequest = { id: ++nextRequestId, chatId }
  emit()
}

export function getPendingSimulatorCanvasOpenRequest(): SimulatorCanvasOpenRequest | null {
  return pendingRequest
}

export function consumeSimulatorCanvasOpenRequest(id: number): void {
  if (pendingRequest?.id !== id) return
  pendingRequest = null
  emit()
}

export function subscribeSimulatorCanvasOpenRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
