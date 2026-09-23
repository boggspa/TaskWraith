/**
 * Durable memory of the Ollama daemon's own account state.
 *
 * Every other provider card answers "am I signed in?" from something that
 * survives a quit — a stored credential, a private-home auth probe, a resolved
 * binary. Ollama's answer lived only in a live `POST /api/me` round trip made
 * during a provider-status probe, so closing TaskWraith forgot a completed
 * `ollama signin` until something re-probed a warm daemon.
 *
 * This module owns the remembering rule and is deliberately store-free: the
 * record travels in `AppSettings`, so the read side is a pure function of the
 * settings already passed to a status probe, and the write side belongs to the
 * one IPC surface that holds `updateSettings`.
 */

export interface OllamaCliSignInRecord {
  /** Last DEFINITIVE daemon answer. Never written from an unknown probe. */
  readonly signedIn: boolean
  /** Account plan as the daemon reported it, when it reported one. */
  readonly plan?: string
  readonly updatedAt: string
}

/**
 * How one bounded daemon request ended. `timed-out` is OUR deadline firing —
 * a stalled event loop or a slow daemon, never proof that the daemon is absent
 * — whereas `refused` is the transport rejecting the connection outright.
 */
export type OllamaProbeOutcome = 'answered' | 'refused' | 'timed-out' | 'aborted'

/**
 * Deadline for one Cloud account probe, shared by main and the Host so the
 * same slow `POST /api/me` cannot read as signed in on the desktop and as
 * unknown in the Host. `/api/status` and the recommendations request share
 * it, and a caller's own shorter deadline still wins. `/api/me` is a round
 * trip the daemon relays to ollama.com: 110-200 ms warm and 445 ms at the
 * slowest relaunch seen. Main arms it on an event loop a large chat parse can
 * stall at relaunch, which is what the headroom is for; a hung daemon still
 * cannot pin a status card for long.
 */
export const OLLAMA_CLOUD_PROBE_TIMEOUT_MS = 4_000

/** The subset of a cloud-discovery snapshot this memory reads and repairs. */
export interface OllamaCliSignInObservation {
  readonly supported: boolean
  readonly authenticated: boolean | null
  readonly plan?: string
  /** True when a stored API key, not the CLI sign-in, produced `authenticated`. */
  readonly apiKeyConfigured?: boolean
  /** How the daemon account probe (`POST /api/me`) ended, when it ran. */
  readonly accountProbe?: OllamaProbeOutcome
  /** The local daemon served `/api/tags` during this same probe. */
  readonly localReachable?: boolean
  /** OUR deadline cut the probe off before the daemon could answer. */
  readonly timedOut?: boolean
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Read a persisted record back, discarding anything that is not one. */
export function normalizeOllamaCliSignIn(value: unknown): OllamaCliSignInRecord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.signedIn !== 'boolean') return null
  const updatedAt = optionalString(candidate.updatedAt)
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null
  const plan = optionalString(candidate.plan)
  return Object.freeze({
    signedIn: candidate.signedIn,
    ...(candidate.signedIn && plan ? { plan } : {}),
    updatedAt
  })
}

/**
 * Fold one probe into the remembered record.
 *
 * The load-bearing rule is the `null` arm: an unreachable, timed-out, or
 * transport-refused `/api/me` is NOT evidence of a signed-out account, so it
 * must leave the memory exactly as it found it. Only the daemon's own yes
 * (`200`) or no (`401`) may write. Returning the previous object identity
 * unchanged lets callers skip a settings write for the common case.
 */
export function nextOllamaCliSignInRecord(
  previous: OllamaCliSignInRecord | null,
  observation: OllamaCliSignInObservation,
  nowIso: string
): OllamaCliSignInRecord | null {
  // A stored API key authenticates the direct Cloud API without the CLI ever
  // having signed in, so it must not be recorded as one.
  if (observation.apiKeyConfigured === true) return previous
  if (observation.authenticated === null) return previous
  if (observation.authenticated === true) {
    const plan = optionalString(observation.plan) ?? previous?.plan
    if (previous?.signedIn === true && previous.plan === plan) return previous
    return Object.freeze({ signedIn: true, ...(plan ? { plan } : {}), updatedAt: nowIso })
  }
  if (previous?.signedIn === false) return previous
  return Object.freeze({ signedIn: false, updatedAt: nowIso })
}

/**
 * A single `401` must not erase a remembered sign-in. The daemon relays
 * `/api/me` to ollama.com and can answer `401` transiently (a restart, a
 * refreshed token), and because the repair only ever stands in for a `true`
 * record, one such answer disarmed the whole memory until a `200` arrived. A
 * real `ollama signout` keeps answering `401`, so the confirming re-probe
 * records it within the same call.
 */
export function requiresOllamaSignOutConfirmation(
  previous: OllamaCliSignInRecord | null,
  observation: OllamaCliSignInObservation
): boolean {
  return (
    previous?.signedIn === true &&
    observation.authenticated === false &&
    observation.apiKeyConfigured !== true
  )
}

/**
 * Fold the confirming re-probe into the first answer. A second definitive
 * `401` confirms the sign-out and a `200` is the account still there (with its
 * plan); anything else — unknown, or a probe that threw — leaves the record
 * untouched, and the next probe asks again.
 */
export function confirmOllamaSignOut(
  first: OllamaCliSignInObservation,
  second: OllamaCliSignInObservation | null
): OllamaCliSignInObservation {
  if (second && (second.authenticated === false || second.authenticated === true)) return second
  return { ...first, authenticated: null }
}

/**
 * True when the memory should stand in for an unknown live answer.
 *
 * What keeps this honest is evidence that a daemon is PRESENT while only its
 * account answer is missing:
 *
 * - `supported`: another daemon cloud endpoint answered this probe.
 * - `localReachable`: the daemon served `/api/tags` in this same probe and the
 *   account probe went unanswered. A daemon that did answer `/api/me` with
 *   something other than a sign-in state (an older build's 404) is left alone.
 * - `timedOut` / a `timed-out` account probe: OUR deadline fired. That is a
 *   stalled main loop or a slow daemon — the relaunch window this memory exists
 *   for — not a transport refusal.
 *
 * A daemon that is simply not running refuses every request, matches none of
 * these, and the card keeps saying so rather than claiming a Cloud connection
 * nothing can serve.
 */
export function shouldApplyRememberedOllamaCliSignIn(
  observation: OllamaCliSignInObservation,
  remembered: OllamaCliSignInRecord | null
): boolean {
  if (remembered?.signedIn !== true || observation.authenticated !== null) return false
  if (observation.supported === true) return true
  if (observation.timedOut === true || observation.accountProbe === 'timed-out') return true
  return observation.localReachable === true && observation.accountProbe !== 'answered'
}

/**
 * Repair an unknown cloud snapshot from the remembered account. `context`
 * carries what the snapshot itself cannot see — the local model list's outcome
 * — and never leaks into the returned snapshot.
 */
export function applyRememberedOllamaCliSignIn<T extends OllamaCliSignInObservation>(
  cloud: T,
  remembered: OllamaCliSignInRecord | null,
  context: Pick<OllamaCliSignInObservation, 'localReachable' | 'timedOut'> = {}
): T & { authenticatedFromMemory?: true } {
  if (!shouldApplyRememberedOllamaCliSignIn({ ...cloud, ...context }, remembered)) return cloud
  return {
    ...cloud,
    authenticated: true,
    ...(cloud.plan || !remembered?.plan ? {} : { plan: remembered.plan }),
    authenticatedFromMemory: true as const
  }
}
