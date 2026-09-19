/**
 * Whether a thread's durable run-event history should still be fetched.
 *
 * The guard used to be "does this chat have a raw-log buffer yet", which
 * conflated two very different things. `appendThreadRawLog` creates a buffer
 * for the FIRST renderer-authored line, so one locally-emitted log permanently
 * suppressed hydration for that thread and the run-event history never loaded
 * again for that chat. The send path already emits such a line, so this fired
 * in ordinary use.
 *
 * Hydration state is therefore tracked on its own. Buffer presence still
 * matters, but only in one direction: raw-log buffers are evicted under
 * retention pressure, and an evicted thread must be allowed to hydrate again.
 */
export interface ThreadRawLogHydrationState {
  /** This chat has already been hydrated from run events in this session. */
  hydrated: boolean
  /** A hydration request for this chat is already in flight. */
  inFlight: boolean
  /** A raw-log buffer currently exists for this chat (renderer-authored or hydrated). */
  hasBuffer: boolean
  /** The run-events bridge is available. */
  hasRunEventsApi: boolean
}

export function shouldHydrateThreadRawLogs(state: ThreadRawLogHydrationState): boolean {
  if (!state.hasRunEventsApi) return false
  if (state.inFlight) return false
  // Hydrated AND still held: nothing to do. Hydrated but evicted: fetch again.
  if (state.hydrated && state.hasBuffer) return false
  return true
}

/**
 * Combine fetched history with whatever the renderer has already written.
 *
 * Hydration used to `replace` the buffer wholesale, which would discard any
 * renderer-authored lines that arrived first -- the very lines whose presence
 * is what allowed hydration to run at all. Historical events are older than
 * anything emitted live in this session, so they lead; the newest entries win
 * the capacity limit, matching how the ring buffer would have filled naturally.
 */
export function mergeHydratedRawLogs<T>(
  historical: readonly T[],
  existing: readonly T[],
  limit: number
): T[] {
  if (limit <= 0) return []
  if (existing.length === 0) return historical.slice(-limit)
  if (historical.length === 0) return existing.slice(-limit)
  return [...historical, ...existing].slice(-limit)
}
