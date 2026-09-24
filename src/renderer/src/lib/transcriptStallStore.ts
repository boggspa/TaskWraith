import {
  TRANSCRIPT_STALL_ALERT_MS,
  TRANSCRIPT_STALL_WARN_MS,
  type TranscriptStallLevel
} from './transcriptStallWatchdog'

/**
 * Publishes "the transcript is behind" to whatever is on screen.
 *
 * A module-level store rather than React state, for the same reason
 * `bindChatTranscriptStore` is one: the producer is the chat-update runtime and
 * the consumer is a leaf beside the transcript, and threading this through the
 * component tree would put a re-render of the whole app in the path of a
 * notice whose entire job is to appear while the app is already struggling.
 *
 * The clock matters here in a way it does not for most state. Lag GROWS while
 * nothing happens — that is the definition of a stall — so a store that only
 * notified on events would go quiet at exactly the moment it has something to
 * say. Hence the tick, which runs only while some chat is actually behind.
 */

export interface TranscriptStallState {
  announcedSequence: number
  settledSequence: number
  /** When the oldest still-unsettled announcement arrived. */
  oldestUnsettledAtMs: number
}

export interface TranscriptStallSnapshot {
  level: TranscriptStallLevel
  lagMs: number
}

export const TRANSCRIPT_STALL_TICK_MS = 1_000

export const CURRENT_TRANSCRIPT_STALL: TranscriptStallSnapshot = { level: 'current', lagMs: 0 }

type Listener = () => void

const states = new Map<string, TranscriptStallState>()
const listenersByChatId = new Map<string, Set<Listener>>()
let tickHandle: ReturnType<typeof setInterval> | null = null
let nowMs: () => number = () => Date.now()

function anyChatBehind(): boolean {
  for (const state of states.values()) {
    if (state.settledSequence < state.announcedSequence) return true
  }
  return false
}

function notify(chatId: string): void {
  const listeners = listenersByChatId.get(chatId)
  if (!listeners) return
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A subscriber that throws must not stop the others from being told.
    }
  }
}

function notifyAll(): void {
  for (const chatId of [...listenersByChatId.keys()]) notify(chatId)
}

function syncTicker(): void {
  const needed = anyChatBehind() && listenersByChatId.size > 0
  if (needed && tickHandle === null) {
    tickHandle = setInterval(notifyAll, TRANSCRIPT_STALL_TICK_MS)
    // Never hold the process open for a progress indicator.
    ;(tickHandle as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
    return
  }
  if (!needed && tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}

export function publishTranscriptStallState(chatId: string, state: TranscriptStallState): void {
  if (!chatId) return
  const previous = states.get(chatId)
  if (
    previous &&
    previous.announcedSequence === state.announcedSequence &&
    previous.settledSequence === state.settledSequence &&
    previous.oldestUnsettledAtMs === state.oldestUnsettledAtMs
  ) {
    return
  }
  states.set(chatId, state)
  syncTicker()
  notify(chatId)
}

export function clearTranscriptStallState(chatId: string): void {
  snapshotCache.delete(chatId)
  if (!states.delete(chatId)) return
  syncTicker()
  notify(chatId)
}

/**
 * Cached per chat so repeated reads return the SAME object.
 *
 * `useSyncExternalStore` calls `getSnapshot` twice around a render and compares
 * with `Object.is`. A snapshot derived fresh from `Date.now()` differs between
 * those two reads whenever a millisecond boundary falls between them, which
 * React treats as a store that keeps changing — forcing re-render after
 * re-render, precisely while the app is already struggling. Lag is therefore
 * quantised to whole seconds (all the notice renders anyway) and the object is
 * reused until that quantised value actually moves.
 */
const snapshotCache = new Map<string, TranscriptStallSnapshot>()

export function getTranscriptStallSnapshot(
  chatId: string | null | undefined
): TranscriptStallSnapshot {
  if (!chatId) return CURRENT_TRANSCRIPT_STALL
  const state = states.get(chatId)
  if (!state || state.settledSequence >= state.announcedSequence) {
    snapshotCache.delete(chatId)
    return CURRENT_TRANSCRIPT_STALL
  }
  const rawLagMs = Math.max(0, nowMs() - state.oldestUnsettledAtMs)
  if (rawLagMs < TRANSCRIPT_STALL_WARN_MS) {
    snapshotCache.delete(chatId)
    return CURRENT_TRANSCRIPT_STALL
  }
  const lagMs = Math.floor(rawLagMs / 1_000) * 1_000
  const level: TranscriptStallLevel =
    rawLagMs >= TRANSCRIPT_STALL_ALERT_MS ? 'stalled' : 'catching-up'
  const cached = snapshotCache.get(chatId)
  if (cached && cached.level === level && cached.lagMs === lagMs) return cached
  const snapshot: TranscriptStallSnapshot = { level, lagMs }
  snapshotCache.set(chatId, snapshot)
  return snapshot
}

export function subscribeTranscriptStall(
  chatId: string | null | undefined,
  listener: Listener
): () => void {
  if (!chatId) return () => {}
  const listeners = listenersByChatId.get(chatId) ?? new Set<Listener>()
  listenersByChatId.set(chatId, listeners)
  listeners.add(listener)
  syncTicker()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByChatId.delete(chatId)
    syncTicker()
  }
}

/** Test seam only. Production always reads the wall clock. */
export function resetTranscriptStallStoreForTests(clock?: () => number): void {
  states.clear()
  snapshotCache.clear()
  listenersByChatId.clear()
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }
  nowMs = clock ?? (() => Date.now())
}
