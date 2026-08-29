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

/** The subset of a cloud-discovery snapshot this memory reads and repairs. */
export interface OllamaCliSignInObservation {
  readonly supported: boolean
  readonly authenticated: boolean | null
  readonly plan?: string
  /** True when a stored API key, not the CLI sign-in, produced `authenticated`. */
  readonly apiKeyConfigured?: boolean
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
 * True when the memory should stand in for an unknown live answer.
 *
 * `supported` is the guard that keeps this honest. A daemon that answered
 * `/api/status` or the recommendations endpoint but could not complete
 * `/api/me` is transiently unsure about an account that really is signed in; a
 * daemon that is simply not running (or whose transport is paused) reports
 * `supported: false`, and there the card must keep saying so rather than
 * claiming a Cloud connection nothing can serve.
 */
export function shouldApplyRememberedOllamaCliSignIn(
  observation: OllamaCliSignInObservation,
  remembered: OllamaCliSignInRecord | null
): boolean {
  return (
    remembered?.signedIn === true &&
    observation.supported === true &&
    observation.authenticated === null
  )
}

/** Repair an unknown-but-supported cloud snapshot from the remembered account. */
export function applyRememberedOllamaCliSignIn<T extends OllamaCliSignInObservation>(
  cloud: T,
  remembered: OllamaCliSignInRecord | null
): T & { authenticatedFromMemory?: true } {
  if (!shouldApplyRememberedOllamaCliSignIn(cloud, remembered)) return cloud
  return {
    ...cloud,
    authenticated: true,
    ...(cloud.plan || !remembered?.plan ? {} : { plan: remembered.plan }),
    authenticatedFromMemory: true as const
  }
}
