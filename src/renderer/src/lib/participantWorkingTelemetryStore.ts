import { useCallback, useSyncExternalStore } from 'react'
import type { ParticipantWorkingTelemetryEvent } from '../../../shared/participantWorkingTelemetry'

export type ParticipantWorkingTokenSnapshot = Extract<
  ParticipantWorkingTelemetryEvent,
  { type: 'snapshot' }
>

type StoreListener = () => void

const snapshotsByRunId = new Map<string, ParticipantWorkingTokenSnapshot>()
const listenersByRunId = new Map<string, Set<StoreListener>>()
let stopIpcSubscription: (() => void) | null = null

function positiveInteger(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

function notifyRun(runId: string): void {
  for (const listener of listenersByRunId.get(runId) || []) listener()
}

function ensureIpcSubscription(): void {
  if (stopIpcSubscription || typeof window === 'undefined') return
  const subscribe = window.api?.onParticipantWorkingTelemetry
  if (typeof subscribe !== 'function') return
  stopIpcSubscription = subscribe((event) => ingestParticipantWorkingTelemetry(event))
}

/**
 * In-memory only: snapshots land directly from main over a dedicated IPC
 * channel. Nothing here touches App state, ChatRecord, or the transcript.
 * Exported for focused store tests and harmless when called by the preload
 * listener in production.
 */
export function ingestParticipantWorkingTelemetry(event: unknown): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return
  const payload = event as Partial<ParticipantWorkingTelemetryEvent>
  const runId = typeof payload.runId === 'string' ? payload.runId : ''
  if (!runId) return

  if (payload.type === 'clear') {
    if (snapshotsByRunId.delete(runId)) notifyRun(runId)
    return
  }
  if (payload.type !== 'snapshot') return

  const next: ParticipantWorkingTokenSnapshot = {
    type: 'snapshot',
    chatId: typeof payload.chatId === 'string' ? payload.chatId : '',
    roundId: typeof payload.roundId === 'string' ? payload.roundId : '',
    participantId: typeof payload.participantId === 'string' ? payload.participantId : '',
    runId,
    startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : '',
    provider: payload.provider as ParticipantWorkingTokenSnapshot['provider'],
    inputTokens: positiveInteger(payload.inputTokens),
    outputTokens: positiveInteger(payload.outputTokens),
    totalTokens: positiveInteger(payload.totalTokens),
    estimated: payload.estimated === true
  }
  const previous = snapshotsByRunId.get(runId)
  if (
    previous &&
    previous.inputTokens === next.inputTokens &&
    previous.outputTokens === next.outputTokens &&
    previous.totalTokens === next.totalTokens &&
    previous.estimated === next.estimated
  ) {
    return
  }
  snapshotsByRunId.set(runId, next)
  notifyRun(runId)
}

export function participantWorkingTokenSnapshot(
  runId: string | null | undefined
): ParticipantWorkingTokenSnapshot | null {
  return runId ? snapshotsByRunId.get(runId) || null : null
}

export function subscribeParticipantWorkingTokenSnapshot(
  runId: string | null | undefined,
  listener: StoreListener
): () => void {
  if (!runId) return () => {}
  ensureIpcSubscription()
  const listeners = listenersByRunId.get(runId) || new Set<StoreListener>()
  listeners.add(listener)
  listenersByRunId.set(runId, listeners)
  return () => {
    const current = listenersByRunId.get(runId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByRunId.delete(runId)
  }
}

/**
 * A keyed external-store hook: a new usage snapshot only rerenders the one
 * working-indicator leaf whose active run id matches it.
 */
export function useParticipantWorkingTokenSnapshot(
  runId: string | null | undefined
): ParticipantWorkingTokenSnapshot | null {
  const subscribe = useCallback(
    (listener: StoreListener) => subscribeParticipantWorkingTokenSnapshot(runId, listener),
    [runId]
  )
  const getSnapshot = useCallback(() => participantWorkingTokenSnapshot(runId), [runId])
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/** Test-only reset; it also releases the preload listener when one was installed. */
export function resetParticipantWorkingTelemetryStore(): void {
  snapshotsByRunId.clear()
  listenersByRunId.clear()
  stopIpcSubscription?.()
  stopIpcSubscription = null
}

// Start listening as soon as the transcript bundle is evaluated so a provider
// usage snapshot that arrives just before the first working row mounts is kept
// for that row. This remains one lightweight IPC listener for the renderer.
ensureIpcSubscription()
