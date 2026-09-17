/**
 * Re-check the Host when the machine comes back.
 *
 * Until now `powerMonitor.on('resume')` did exactly one thing: renew a power
 * assertion. Nothing re-probed the Host. That matters because the Desktop
 * broker reconnects only LAZILY — `withClient` evicts a dead lease and the
 * *next* request builds a fresh one — so after a lock or a sleep the first
 * thing to discover the socket died is whatever the user clicks next, and it
 * discovers it by failing.
 *
 * Two things are therefore done here, and deliberately nothing else:
 *
 *  1. **Probe, and on failure drop the connection.** Dropping makes the next
 *     request reconnect instead of inheriting a corpse. It is done ONLY on a
 *     failed probe: closing a healthy socket is the connection churn
 *     `HostProjectionBroker.withClient` explicitly refuses to cause.
 *
 *  2. **Nudge catalogue recovery.** A recovery hold is committed on the
 *     begin-recovery REQUEST, so a reply lost across a suspend strands the
 *     admission, the fsynced hold file and the `pending` entry together. One
 *     thread then silently stops accepting writes — picker selections revert,
 *     transcript edits do not land, nothing logs — until a 10-minute TTL
 *     reclaims it. The controller already reclaims such a strand the moment the
 *     SAME writer asks to begin again, so re-enqueueing is enough to trigger
 *     the existing, ownership-scoped reclaim. We do not reclaim anything here.
 *
 * What this must never do, and does not:
 *   - Call `HostLifecycleController.start()` or `HostExternalSupervisor
 *     .ensureAvailable()`. The controller's contract is explicit — "It never
 *     retries in the background: only app startup or an explicit user action
 *     can call start()" — and a system event is not a user action. Respawning
 *     a Host from a timer is the undeclared background service that contract
 *     forbids.
 *   - Release, expire or force any write-gate hold. The gate's release closure
 *     is identity-fenced precisely so a stale releaser cannot free a NEWER
 *     hold; a force-release here would let a local write interleave with an
 *     in-flight adoption. Reclaim stays with the owner that can prove identity.
 */

export interface ResumeHostProbeResult {
  ok: boolean
  error?: string
}

export interface ResumeHostHealthCheckDeps {
  /** Bounded, side-effect-free Host round-trip. Must not throw; the broker's
   *  snapshot() already answers `{ ok, error }` rather than rejecting. */
  probeHost: () => Promise<ResumeHostProbeResult>
  /** Drop the broker's socket so the NEXT request reconnects eagerly. */
  dropHostConnection: () => void
  /** Re-enqueue catalogue recovery for every projected thread. */
  nudgeCatalogueRecovery: () => void
  probeTimeoutMs?: number
  log?: (line: string) => void
}

export interface ResumeHostHealthCheckOutcome {
  reason: string
  probe: 'ok' | 'failed' | 'timeout' | 'threw'
  /** True when the socket was dropped so the next request rebuilds it. */
  droppedConnection: boolean
  nudgedRecovery: boolean
  detail?: string
}

/**
 * The broker inherits a 30s request budget from `HostProjectionClient`, which
 * is far too long to leave a wake-up check hanging. A resume probe that has not
 * answered in five seconds has told us what we need to know.
 */
export const RESUME_HOST_PROBE_TIMEOUT_MS = 5_000

const MAX_DETAIL = 200

function detail(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '')
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL)
}

/**
 * Returns a fire-and-forget check. It never rejects: a `powerMonitor` handler
 * has nowhere to put an error, and an unhandled rejection at wake is worse than
 * the stale socket it was trying to report.
 *
 * Overlapping calls coalesce onto the in-flight check. macOS can deliver
 * `resume` and `unlock-screen` within a few milliseconds of each other, and two
 * concurrent probes would race to drop the same connection.
 */
export function createResumeHostHealthCheck(
  deps: ResumeHostHealthCheckDeps
): (reason: string) => Promise<ResumeHostHealthCheckOutcome> {
  const log = deps.log ?? ((): void => {})
  const timeoutMs = deps.probeTimeoutMs ?? RESUME_HOST_PROBE_TIMEOUT_MS
  let inFlight: Promise<ResumeHostHealthCheckOutcome> | null = null

  const runOnce = async (reason: string): Promise<ResumeHostHealthCheckOutcome> => {
    let probe: ResumeHostHealthCheckOutcome['probe'] = 'ok'
    let because: string | undefined

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      })
      const raced = await Promise.race([deps.probeHost(), timeout])
      if (raced === 'timeout') {
        probe = 'timeout'
        because = `no answer in ${timeoutMs}ms`
      } else if (!raced.ok) {
        probe = 'failed'
        because = detail(raced.error)
      }
    } catch (error) {
      // A port that rejects rather than answering `{ ok: false }` is still a
      // dead Host, not a reason to skip the repair.
      probe = 'threw'
      because = detail(error)
    } finally {
      if (timer) clearTimeout(timer)
    }

    let droppedConnection = false
    if (probe !== 'ok') {
      try {
        deps.dropHostConnection()
        droppedConnection = true
      } catch (error) {
        log(`[resume-health] could not drop the Host connection: ${detail(error)}`)
      }
    }

    // Unconditional: a socket that answers fine can still be sitting behind a
    // hold stranded before the machine went away, and that is the failure with
    // no other escape inside ten minutes. `enqueue` applies its own liveness
    // and cooldown guards, so this cannot stampede.
    let nudgedRecovery = false
    try {
      deps.nudgeCatalogueRecovery()
      nudgedRecovery = true
    } catch (error) {
      log(`[resume-health] could not re-enqueue catalogue recovery: ${detail(error)}`)
    }

    const outcome: ResumeHostHealthCheckOutcome = {
      reason,
      probe,
      droppedConnection,
      nudgedRecovery,
      ...(because ? { detail: because } : {})
    }
    log(
      probe === 'ok'
        ? `[resume-health] Host reachable after ${reason}`
        : `[resume-health] Host ${probe} after ${reason} (${because}); ` +
            `connection dropped for reconnect${nudgedRecovery ? ', recovery re-enqueued' : ''}`
    )
    return outcome
  }

  return (reason: string): Promise<ResumeHostHealthCheckOutcome> => {
    if (inFlight) return inFlight
    const run = runOnce(reason).finally(() => {
      inFlight = null
    })
    inFlight = run
    return run
  }
}
