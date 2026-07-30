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

/**
 * Seed the in-memory slot from the PERSISTED model cache when discovery has not
 * run in this session.
 *
 * The slot above is process-local and starts at `none`, and the only writer is
 * `discoverAuthenticatedAgyModels`. A quota refresh does not run discovery, so
 * on a freshly started app the gate reported "no authenticated agy connection
 * was detected" no matter how many times the user signed in with the CLI and
 * hit refresh — the message named the one action that could not clear it.
 *
 * This module already treats a cached catalogue as evidence: the cache exists
 * only because an authenticated `agy models` once succeeded, which is why
 * AGY_CACHED_AUTH_EVIDENCE_TTL_MS exists to expire it. The gap was purely that
 * nothing consulted the on-disk copy. Reading it is not a backend round-trip,
 * so it does not grow request cadence against AntiGravity — the constraint the
 * discovery module is explicit about protecting.
 *
 * Fail-closed throughout: an unreadable cache, an unparseable timestamp, or an
 * empty catalogue all leave `none` in place. A LIVE provenance is never
 * downgraded — only `none` is seeded.
 */
export async function seedAgyDiscoveryProvenanceFromCache(
  readCachedRecord: () => Promise<{ models: unknown[]; updatedAtMs: number | null } | null>
): Promise<AgyDiscoveryProvenance> {
  if (current.source !== 'none') return current
  let record: { models: unknown[]; updatedAtMs: number | null } | null = null
  try {
    record = await readCachedRecord()
  } catch {
    return current
  }
  if (!record || !Array.isArray(record.models) || record.models.length === 0) return current
  const updatedAtMs = record.updatedAtMs
  if (updatedAtMs === null || !Number.isFinite(updatedAtMs)) return current
  // Re-check: an await boundary means a real discovery may have landed while
  // the file read was in flight, and live proof must win over cached proof.
  if (current.source !== 'none') return current
  recordAgyDiscoveryProvenance({ source: 'cached', cachedAtMs: updatedAtMs })
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
