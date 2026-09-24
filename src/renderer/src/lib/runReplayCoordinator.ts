/**
 * Bounds run-event replay traffic for RunCard.
 *
 * History: RunCard polled `getRunEventReplay` every 2s per card. The push
 * migration swapped that poll for an `onRunEventsChanged` subscription, which
 * removed the timer but NOT the fetch. `RunRepository.appendRunEvent` emits one
 * event per appended run event — driven by CLI socket data callbacks — so a
 * streaming run produced a FULL replay fetch per event, per card. For a run
 * emitting faster than every 2s that is strictly worse than the poll it
 * replaced, and it multiplies by the number of cards watching the same run.
 *
 * This module keeps the listener multiplexing (one IPC listener and one
 * `visibilitychange` listener for the whole renderer) and adds the part that
 * was missing: at most ONE in-flight replay fetch per runId, behind a trailing
 * debounce window, with the result fanned out to every card watching that run.
 *
 * It is deliberately DOM-free and dependency-injected: the repo has no jsdom or
 * testing-library, so a mounted-component burst test cannot exist. Keeping the
 * bounding here is what makes it testable at all.
 */

import type { RunEventReplay } from '../../../main/store/types'

/**
 * Payload of the `run-events-changed` channel.
 *
 * Verified against the emitter (`emitRunEventsChanged` in src/main/index.ts):
 * it always sends an object literal with these four fields, so `runId` is the
 * correct key and the payload is never null/undefined.
 */
export interface RunEventsChangedPayload {
  runId: string
  chatId?: string
  workspaceId?: string
  sequence: number
}

type RunEventListener = (payload: RunEventsChangedPayload) => void
type VisibilityListener = () => void
type ReplayListener = (replay: RunEventReplay) => void

interface RunReplayEntry {
  listeners: Set<ReplayListener>
  timer: ReturnType<typeof setTimeout> | undefined
  inFlight: boolean
  refetchQueued: boolean
}

const DEFAULT_DEBOUNCE_MS = 150

const entries = new Map<string, RunReplayEntry>()

let debounceMs = DEFAULT_DEBOUNCE_MS
let fetchOverride: ((runId: string) => Promise<RunEventReplay>) | undefined

// ---------------------------------------------------------------------------
// run-events-changed listener multiplexer (N cards -> 1 IPC listener)
// ---------------------------------------------------------------------------

const runEventListeners = new Set<RunEventListener>()
let runEventUnsubscribe: (() => void) | undefined

export function subscribeToRunEvents(listener: RunEventListener): () => void {
  runEventListeners.add(listener)
  if (runEventListeners.size === 1 && typeof window !== 'undefined') {
    const attach = window.api?.onRunEventsChanged
    if (typeof attach === 'function') {
      runEventUnsubscribe = attach((payload: RunEventsChangedPayload) => {
        for (const callback of [...runEventListeners]) callback(payload)
      })
    }
  }
  return () => {
    runEventListeners.delete(listener)
    if (runEventListeners.size === 0 && runEventUnsubscribe) {
      runEventUnsubscribe()
      runEventUnsubscribe = undefined
    }
  }
}

/** True when the renderer can receive pushed run events at all. */
export function canPushRunEvents(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.api?.onRunEventsChanged === 'function'
}

// ---------------------------------------------------------------------------
// visibilitychange multiplexer (N cards -> 1 document listener)
// ---------------------------------------------------------------------------

const visibilityListeners = new Set<VisibilityListener>()
let visibilityUnsubscribe: (() => void) | undefined

export function subscribeToVisibility(listener: VisibilityListener): () => void {
  visibilityListeners.add(listener)
  if (visibilityListeners.size === 1 && typeof document !== 'undefined') {
    const handler = (): void => {
      for (const callback of [...visibilityListeners]) callback()
    }
    document.addEventListener('visibilitychange', handler)
    visibilityUnsubscribe = () => document.removeEventListener('visibilitychange', handler)
  }
  return () => {
    visibilityListeners.delete(listener)
    if (visibilityListeners.size === 0 && visibilityUnsubscribe) {
      visibilityUnsubscribe()
      visibilityUnsubscribe = undefined
    }
  }
}

export function isDocumentHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.hidden === true
}

// ---------------------------------------------------------------------------
// Replay fetch coordination
// ---------------------------------------------------------------------------

function resolveFetch(): ((runId: string) => Promise<RunEventReplay>) | undefined {
  if (fetchOverride) return fetchOverride
  if (typeof window === 'undefined') return undefined
  const fetchReplay = window.api?.getRunEventReplay
  if (typeof fetchReplay !== 'function') return undefined
  return (runId: string) => Promise.resolve(fetchReplay(runId) as Promise<RunEventReplay>)
}

/**
 * Register interest in a run's replay. Every card watching the same runId
 * shares one fetch; the resolved replay is fanned out to all of them.
 */
export function subscribeToRunReplay(runId: string, listener: ReplayListener): () => void {
  let entry = entries.get(runId)
  if (!entry) {
    entry = { listeners: new Set(), timer: undefined, inFlight: false, refetchQueued: false }
    entries.set(runId, entry)
  }
  entry.listeners.add(listener)
  return () => {
    const current = entries.get(runId)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    if (current.timer !== undefined) clearTimeout(current.timer)
    entries.delete(runId)
  }
}

async function performFetch(runId: string): Promise<void> {
  const entry = entries.get(runId)
  if (!entry) return
  // ONE in-flight fetch per run. An event landing mid-flight is folded into a
  // single trailing refetch instead of opening a second concurrent request,
  // so a fast run cannot stack replays no matter how many cards watch it.
  if (entry.inFlight) {
    entry.refetchQueued = true
    return
  }
  const fetchReplay = resolveFetch()
  if (!fetchReplay) return
  entry.inFlight = true
  try {
    const replay = await fetchReplay(runId)
    const current = entries.get(runId)
    if (!current) return
    for (const listener of [...current.listeners]) listener(replay)
  } catch {
    // A failed replay leaves the last good aggregate in place, exactly as the
    // previous poll did. Surfacing a transient IPC error would blank the card.
  } finally {
    const current = entries.get(runId)
    if (current) {
      current.inFlight = false
      if (current.refetchQueued) {
        current.refetchQueued = false
        requestRunReplay(runId)
      }
    }
  }
}

/**
 * Ask for a refreshed replay of `runId`.
 *
 * `immediate` is for first paint and for returning from a hidden window, where
 * waiting out the debounce would show a visibly stale card.
 */
export function requestRunReplay(runId: string, options: { immediate?: boolean } = {}): void {
  const entry = entries.get(runId)
  if (!entry) return
  if (options.immediate) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    void performFetch(runId)
    return
  }
  // Trailing window: the first request arms the timer and every request inside
  // that window is absorbed by it, so an N-event burst costs exactly one fetch.
  if (entry.timer !== undefined) return
  entry.timer = setTimeout(() => {
    const current = entries.get(runId)
    if (!current) return
    current.timer = undefined
    void performFetch(runId)
  }, debounceMs)
}

// ---------------------------------------------------------------------------
// Test hooks — module singletons otherwise leak across tests and HMR reloads
// ---------------------------------------------------------------------------

export function __configureRunReplayCoordinatorForTests(hooks: {
  fetchReplay?: (runId: string) => Promise<RunEventReplay>
  debounceMs?: number
}): void {
  if (hooks.fetchReplay) fetchOverride = hooks.fetchReplay
  if (typeof hooks.debounceMs === 'number') debounceMs = hooks.debounceMs
}

export function __resetRunReplayCoordinatorForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
  }
  entries.clear()
  runEventListeners.clear()
  if (runEventUnsubscribe) {
    runEventUnsubscribe()
    runEventUnsubscribe = undefined
  }
  visibilityListeners.clear()
  if (visibilityUnsubscribe) {
    visibilityUnsubscribe()
    visibilityUnsubscribe = undefined
  }
  fetchOverride = undefined
  debounceMs = DEFAULT_DEBOUNCE_MS
}

export function __runReplayPendingRunIdsForTests(): string[] {
  return [...entries.keys()]
}
