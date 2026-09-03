/**
 * Cached Devin plan state for the hot paths.
 *
 * The free-plan flag comes from the Devin desktop client's local SQLite state
 * DB (see DevinUsage). That file is ~18MB on a working install, so the picker
 * catalogue and the dispatch clamp must not re-read it per call. This module
 * owns one short-lived cache shared by both.
 *
 * Fail-open, matching devinPlanAccess: a read failure, a missing DB, or a
 * non-Devin plan row all resolve to `undefined`, which every consumer treats
 * as "ungated". The cache stores that outcome too, so a broken read does not
 * turn into a per-call DB hit.
 */

import { loadDevinUsageSnapshot } from './DevinUsage'

export interface DevinPlanStateDeps {
  readPlanInfoRows: () => Promise<string[]>
  now?: () => number
  platform?: NodeJS.Platform
  /** How long a resolved answer is reused. Default 60s. */
  ttlMs?: number
}

export interface DevinPlanStateResolver {
  /** Resolve the free-plan flag, reusing a cached answer inside the TTL. */
  resolve: () => Promise<boolean | undefined>
  /** Drop the cached answer (a plan change or a sign-out invalidates it). */
  invalidate: () => void
}

const DEFAULT_TTL_MS = 60_000

export function createDevinPlanStateResolver(deps: DevinPlanStateDeps): DevinPlanStateResolver {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  let cachedAt: number | null = null
  let cached: boolean | undefined
  let inFlight: Promise<boolean | undefined> | null = null

  const fresh = (): boolean => cachedAt !== null && now() - cachedAt < ttlMs

  return {
    resolve: async () => {
      if (fresh()) return cached
      // Collapse concurrent callers onto one read: the picker and a dispatch
      // can land together, and two SQLite opens would be pure waste.
      if (inFlight) return inFlight
      inFlight = loadDevinUsageSnapshot({
        readPlanInfoRows: deps.readPlanInfoRows,
        now,
        platform: deps.platform
      })
        .then((snapshot) => snapshot.freePlan)
        .catch(() => undefined)
        .then((value) => {
          cached = value
          cachedAt = now()
          inFlight = null
          return value
        })
      return inFlight
    },
    invalidate: () => {
      cachedAt = null
      cached = undefined
    }
  }
}
