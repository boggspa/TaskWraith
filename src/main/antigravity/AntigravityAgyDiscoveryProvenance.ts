/**
 * Where the offered agy model rows last came from, and therefore whether this
 * machine has real evidence of an authenticated agy connection.
 *
 * WHY THIS EXISTS. `hasAuthenticatedAgyCatalogRow` inferred authentication from
 * row SHAPE — any catalogue row without the `gemini-api:` prefix was taken as
 * proof of a live agy session. But `antigravityAgyStaticModels()` rows are bare
 * ids too, so the hardcoded floor satisfied that test. Combined with the cache
 * never being read in time, EVERY row was a floor row, so the proof was always
 * fabricated: a machine that had never once authenticated could still open the
 * gate that permits a `/usage` probe — and each probe is a real authenticated
 * agy session. Provenance is the honest signal: it records what the last
 * discovery actually managed, rather than guessing from what it returned.
 *
 * Deliberately a main-process single slot rather than a field on the catalogue
 * rows. Threading a new field would have to survive the configured-provider
 * snapshot and its sanitizers, whose whitelists silently drop unknown keys —
 * the failure mode would be a quietly re-forged signal. This mirrors
 * `AntigravityGeminiApiDiscoveryOutcome`, the established pattern here.
 *
 * Tightening only: this can refuse a probe that previously would have run, and
 * can never permit one that previously would not. That direction is the point —
 * fewer authenticated sessions opened against the backend, never more.
 */

/** `none` = discovery has not run, or ran without consent/binary. */
export type AgyCatalogSource = 'live' | 'cached' | 'floor' | 'none'

/**
 * How long a cached model list stays acceptable as evidence of an authenticated
 * connection. A cache exists only because an authenticated `agy models` once
 * succeeded, so it IS evidence — but of a past sign-in, so it expires.
 */
export const AGY_CACHED_AUTH_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface AgyDiscoveryProvenance {
  readonly source: AgyCatalogSource
  /** Epoch ms the serving cache was written; null unless `source` is 'cached'. */
  readonly cachedAtMs: number | null
}

const UNKNOWN_PROVENANCE: AgyDiscoveryProvenance = { source: 'none', cachedAtMs: null }

let current: AgyDiscoveryProvenance = UNKNOWN_PROVENANCE

export function recordAgyDiscoveryProvenance(next: AgyDiscoveryProvenance): void {
  current = {
    source: next.source,
    cachedAtMs: next.source === 'cached' && Number.isFinite(next.cachedAtMs ?? NaN)
      ? (next.cachedAtMs as number)
      : null
  }
}

export function readAgyDiscoveryProvenance(): AgyDiscoveryProvenance {
  return current
}

/** Test-only: restore the fail-closed default. */
export function resetAgyDiscoveryProvenanceForTests(): void {
  current = UNKNOWN_PROVENANCE
}

/**
 * Pure predicate. `live` is current proof. `cached` is proof of a past sign-in
 * and holds for `AGY_CACHED_AUTH_EVIDENCE_TTL_MS`. `floor` and `none` are not
 * evidence of anything and must never open the gate.
 *
 * A cached record with no readable timestamp fails closed: an unknown age
 * cannot be shown to be inside the window.
 */
export function agyProvenanceProvesAuthenticatedConnection(
  provenance: AgyDiscoveryProvenance | null | undefined,
  nowMs: number
): boolean {
  if (!provenance) return false
  if (provenance.source === 'live') return true
  if (provenance.source !== 'cached') return false
  const cachedAtMs = provenance.cachedAtMs
  if (cachedAtMs === null || !Number.isFinite(cachedAtMs)) return false
  const age = nowMs - cachedAtMs
  // A future-dated cache (clock change, edited file) is not usable evidence.
  if (age < 0) return false
  return age < AGY_CACHED_AUTH_EVIDENCE_TTL_MS
}
