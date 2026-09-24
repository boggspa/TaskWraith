/**
 * Coalesces the concurrent boot-time `getSettings()` calls into one IPC round
 * trip.
 *
 * `useAppearance` and `loadInitialData` both fetch settings from their own mount
 * effect, so on every launch the renderer asked main for the same document
 * twice, in the same effect flush, before either resolved.
 *
 * This deliberately only shares an **in-flight** request. It never serves a
 * settled result, so there is no staleness window and no cache to invalidate
 * when settings change — a later `getSettings()` is a fresh read exactly as
 * before.
 */
export interface CoalescedRequest<T> {
  request: () => Promise<T>
  /** Test-only: drops any in-flight sharing without cancelling the request. */
  reset: () => void
  /** Test-only: how many callers were served by a shared request. */
  sharedCount: () => number
}

export function createCoalescedRequest<T>(fetch: () => Promise<T>): CoalescedRequest<T> {
  let inFlight: Promise<T> | null = null
  let shared = 0
  return {
    request: () => {
      if (inFlight) {
        shared += 1
        return inFlight
      }
      const pending = fetch().finally(() => {
        // Clear on settle in both directions: a rejected boot fetch must be
        // retryable, and a resolved one must never be replayed as fresh.
        if (inFlight === pending) inFlight = null
      })
      inFlight = pending
      return pending
    },
    reset: () => {
      inFlight = null
      shared = 0
    },
    sharedCount: () => shared
  }
}

/**
 * The one boot-time settings read shared by `useAppearance` and
 * `loadInitialData`. Both mount effects run in the same flush, so both callers
 * are in flight together and are served by a single IPC round trip.
 */
export const startupSettingsRequest = createCoalescedRequest(() => window.api.getSettings())
