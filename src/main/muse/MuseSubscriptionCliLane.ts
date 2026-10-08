/**
 * Muse Code subscription meters from the local CLI — the lane that keeps the
 * `/usage` PTY probe (MuseSubscriptionUsage.ts) off the hot path.
 *
 * The quota-snapshot hook is read on every renderer refresh (bursts of a few
 * seconds apart), while a probe spawns a real `muse` TUI for ~3-12 s. This
 * module owns the cadence so the hook never does: `read()` is synchronous and
 * answers from the last observed reading, and `maybeRefresh()` re-probes only
 * when that reading is older than the fresh TTL, never concurrently, and
 * backs off after a probe that produced no meters. Limit Counter's Meta card
 * runs the same CLI probe on a ten-minute cadence; this mirrors it.
 *
 * Why probing is now acceptable on the automatic path: the probe passes
 * `--no-session-log`, so the TUI it spawns persists no session.jsonl and the
 * token meter in MuseUsage.ts (which reads those logs) never sees it. The
 * earlier "never probe automatically" rule guarded exactly that perturbation.
 *
 * Only a reading that carries at least one subscription meter is retained.
 * A meter-less reading (signed out, free tier, timeout) is a failure for
 * backoff purposes and leaves the previous observed reading in place; the hook
 * re-derives staleness from `refreshedAt`, so an old reading is flagged, not
 * hidden. The last observed reading is persisted (JSON, no secret material)
 * so a restart does not blank the lane until the first probe completes.
 */
import type { MuseSubscriptionUsageReading } from './MuseSubscriptionUsage'

export const MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS = 10 * 60_000
export const MUSE_SUBSCRIPTION_CLI_FAILURE_BACKOFF_MS = 5 * 60_000
/** Persisted beside the Grok snapshot; display-only fields, never credentials. */
export const MUSE_SUBSCRIPTION_CLI_SNAPSHOT_FILENAME = 'muse-subscription-usage-snapshot.json'

export interface MuseSubscriptionCliPersistence {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

export interface MuseSubscriptionCliLaneDeps {
  /** Runs one `/usage` capture (MuseSubscriptionUsage.probeMuseSubscriptionUsage). */
  probe: () => Promise<MuseSubscriptionUsageReading>
  /**
   * True when a probe may spawn: the muse binary resolves AND a Meta credential
   * is present. A signed-out TUI must never be launched by a background lane.
   */
  isEligible: () => boolean | Promise<boolean>
  persistence?: MuseSubscriptionCliPersistence
  now?: () => number
  freshTtlMs?: number
  failureBackoffMs?: number
  log?: (line: string) => void
}

export interface MuseSubscriptionCliLane {
  /** Last observed reading, or null. Synchronous; never spawns. Kicks a
   *  TTL-gated background refresh so the next read is fresher. */
  read(): MuseSubscriptionUsageReading | null
  /** Probe when stale (or `force`), single-flight. Resolves to the reading
   *  now held — the new one when the probe observed meters, else the old. */
  maybeRefresh(options?: { force?: boolean }): Promise<MuseSubscriptionUsageReading | null>
  /** Load the persisted reading. Idempotent; safe to call before `read()`. */
  hydrate(): Promise<void>
}

interface PersistedSnapshot {
  schemaVersion: 1
  reading: MuseSubscriptionUsageReading
}

/** True when a reading carries at least one subscription meter. */
export function museSubscriptionReadingHasMeters(
  reading: MuseSubscriptionUsageReading | null | undefined
): reading is MuseSubscriptionUsageReading {
  return (
    !!reading &&
    reading.hasSubscription === true &&
    (reading.current.usedPercent != null || reading.weekly.usedPercent != null)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function percentOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function isoOrNull(value: unknown): string | null {
  const text = stringOrNull(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Re-validate a persisted reading field by field so a hand-edited or
 * truncated file can only yield a well-formed reading or nothing.
 */
export function parsePersistedMuseSubscriptionReading(
  text: string | null | undefined
): MuseSubscriptionUsageReading | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.reading)) return null
  const raw = parsed.reading
  const meter = (value: unknown, weekly: boolean) => {
    const record = isRecord(value) ? value : {}
    const resetAt = isoOrNull(record.resetAt)
    const seconds = record.limitWindowSeconds
    return {
      usedPercent: percentOrNull(record.usedPercent),
      resetAtText: stringOrNull(record.resetAtText),
      resetAt,
      limitWindowSeconds:
        weekly && resetAt && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
          ? seconds
          : null
    }
  }
  const session = isRecord(raw.session) ? raw.session : {}
  const refreshedAt = isoOrNull(raw.refreshedAt)
  if (!refreshedAt) return null
  const reading: MuseSubscriptionUsageReading = {
    planName: stringOrNull(raw.planName),
    hasSubscription: raw.hasSubscription === true,
    current: meter(raw.current, false),
    weekly: meter(raw.weekly, true),
    session: {
      inputTokens: countOrNull(session.inputTokens),
      cachedTokens: countOrNull(session.cachedTokens),
      outputTokens: countOrNull(session.outputTokens),
      totalTokens: countOrNull(session.totalTokens),
      turns: countOrNull(session.turns),
      subagents: countOrNull(session.subagents)
    },
    refreshedAt
  }
  return museSubscriptionReadingHasMeters(reading) ? reading : null
}

export function createMuseSubscriptionCliLane(
  deps: MuseSubscriptionCliLaneDeps
): MuseSubscriptionCliLane {
  const now = deps.now ?? (() => Date.now())
  const freshTtlMs = deps.freshTtlMs ?? MUSE_SUBSCRIPTION_CLI_FRESH_TTL_MS
  const failureBackoffMs = deps.failureBackoffMs ?? MUSE_SUBSCRIPTION_CLI_FAILURE_BACKOFF_MS
  const log = deps.log ?? (() => {})

  let reading: MuseSubscriptionUsageReading | null = null
  let observedAt = Number.NEGATIVE_INFINITY
  let lastFailureAt = Number.NEGATIVE_INFINITY
  let inFlight: Promise<MuseSubscriptionUsageReading | null> | null = null
  let hydration: Promise<void> | null = null

  const hydrate = (): Promise<void> => {
    if (hydration) return hydration
    hydration = (async () => {
      if (!deps.persistence) return
      try {
        const restored = parsePersistedMuseSubscriptionReading(await deps.persistence.read())
        // A probe that completed while hydrating wins; the file is older.
        if (restored && reading === null) {
          reading = restored
          observedAt = Date.parse(restored.refreshedAt)
        }
      } catch {
        // A missing or unreadable file simply means no restored reading.
      }
    })()
    return hydration
  }

  const isFresh = (at: number): boolean => at - observedAt < freshTtlMs
  const inBackoff = (at: number): boolean => at - lastFailureAt < failureBackoffMs

  const persist = async (next: MuseSubscriptionUsageReading): Promise<void> => {
    if (!deps.persistence) return
    const snapshot: PersistedSnapshot = { schemaVersion: 1, reading: next }
    try {
      await deps.persistence.write(JSON.stringify(snapshot, null, 2))
    } catch {
      // Persistence is a convenience across restarts, never load-bearing.
    }
  }

  const maybeRefresh = (
    options: { force?: boolean } = {}
  ): Promise<MuseSubscriptionUsageReading | null> => {
    if (inFlight) return inFlight
    const at = now()
    if (!options.force && (isFresh(at) || inBackoff(at))) return Promise.resolve(reading)
    inFlight = (async () => {
      try {
        await hydrate()
        if (!(await Promise.resolve(deps.isEligible()).catch(() => false))) return reading
        const next = await deps.probe()
        if (museSubscriptionReadingHasMeters(next)) {
          reading = next
          const refreshed = Date.parse(next.refreshedAt)
          observedAt = Number.isFinite(refreshed) ? refreshed : now()
          await persist(next)
        } else {
          lastFailureAt = now()
          log('[muse-subscription] /usage probe reported no subscription meters')
        }
      } catch (error) {
        lastFailureAt = now()
        log(
          `[muse-subscription] /usage probe failed: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        inFlight = null
      }
      return reading
    })()
    return inFlight
  }

  return {
    hydrate,
    maybeRefresh,
    read: () => {
      void hydrate()
      void maybeRefresh()
      return reading
    }
  }
}
