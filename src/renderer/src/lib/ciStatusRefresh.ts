// Policy for the composer's GitHub CI background poll. Pulled out of App.tsx so
// the "should we poll right now?" decision is unit-testable without timers.
//
// CI state changes on GitHub's servers (pending → passing/failing) WITHOUT any
// local commit, so the existing PR-status dedup key (repoRoot/branch/commit/…)
// can't detect it — the satellite row would freeze mid-run. This bounded poll
// fills that gap: it only ticks while someone is watching a still-running CI.

export interface CiPollDecisionInput {
  /** Wall-clock ms since the last poll kicked off; null/undefined when no prior run. */
  msSinceLastPoll: number | null | undefined
  /** Poll cadence in ms (e.g. 75_000). */
  intervalMs: number
  /** A previous poll is still in flight. */
  inFlight: boolean
  /** The Electron window is currently focused. */
  windowFocused: boolean
  /** `navigator.onLine` value. */
  online: boolean
  /** There is an open pull request worth watching. */
  hasOpenPr: boolean
  /** CI has reached a settled state (passed/failed) — nothing left to watch. */
  ciTerminal: boolean
}

/**
 * Decide whether the CI poll should fire right now. Pure so the policy can be
 * tested without setting up timers.
 *
 * Skips when: a poll is in flight; the window is blurred (no one is watching);
 * offline (data would be stale); there's no open PR; CI has already settled; or
 * too little wall-clock time has elapsed since the last attempt (guards the
 * focus-resume ⨯ heartbeat race, mirroring the usage-refresh loop).
 */
export function shouldRunCiPoll(input: CiPollDecisionInput): boolean {
  if (input.inFlight) return false
  if (!input.windowFocused) return false
  if (!input.online) return false
  if (!input.hasOpenPr) return false
  if (input.ciTerminal) return false
  if (input.msSinceLastPoll !== null && input.msSinceLastPoll !== undefined) {
    if (input.msSinceLastPoll < Math.min(intervalFloor(input.intervalMs), 5_000)) {
      return false
    }
  }
  return true
}

function intervalFloor(intervalMs: number): number {
  return Math.max(1_000, Math.floor(intervalMs / 3))
}

/** A CI status kind is terminal when it won't change without a new commit/push. */
export function isCiStatusTerminal(status: string | null | undefined): boolean {
  return status === 'passed' || status === 'failed'
}
