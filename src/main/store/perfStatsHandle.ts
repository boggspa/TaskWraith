/**
 * T9a — the harness-gated read-only handle the perf runner samples.
 *
 * WHY THIS EXISTS:
 * The T4b reporting seam built real counters (`SaveCoalescerStats`,
 * `ChatJournalStats`, persistence-probe bytes) but nothing outside a unit test
 * ever read them: `runT2Baseline` built its metrics from
 * `applyUnsupportedAnnotations(createEmptyPerfMetrics())`, so every
 * `main.saveChat` number in the T2 report was a ZERO DEFAULT SEED, never a
 * measurement. That is why T2 could only ever report
 * `metricsCollected: false`. This handle is the missing producer.
 *
 * WHY A GLOBAL, AND WHY THIS IS NOT AN EXFILTRATION SURFACE:
 * The runner attaches the Node inspector to the main process and can evaluate
 * expressions in its context, but only against what that context exposes. The
 * alternative route — having the child stream probe JSONL to disk during the
 * replay — would add write+fsync traffic to the exact I/O path under
 * measurement and corrupt the result it is meant to report. Sampling a
 * pre-aggregated in-memory object once, after the replay, perturbs nothing.
 *
 * CONTAINMENT (all four hold, by construction):
 *  1. Installation is gated on `PERF_PRELOAD_PROBE=1`. With the flag unset —
 *     every production build and every normal launch — this module assigns
 *     nothing and the global does not exist.
 *  2. The payload is COUNTERS ONLY: integers and a fixed vocabulary of target
 *     class names. No chat ids, no paths, no titles, no message content. It
 *     cannot be used to read user data even when it is installed.
 *  3. It is read-only. The handle exposes no setter and no way to mutate
 *     store state; calling it cannot change what is persisted.
 *  4. It is a plain function returning a fresh snapshot, so a sampler cannot
 *     retain a live reference into store internals.
 */

/** Global name the harness evaluates. Must stay in lockstep with the collector. */
export const PERF_STATS_GLOBAL = '__TASKWRAITH_PERF_STATS__'

const PROBE_ENV_FLAG = 'PERF_PRELOAD_PROBE'

/** Shape returned to the sampler. Counters only — see containment note above. */
export interface PerfStatsHandlePayload {
  /** Milliseconds since epoch when the sample was taken, for run correlation. */
  sampledAt: number
  coalescing: unknown
  probes: unknown
}

export function isPerfStatsHandleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROBE_ENV_FLAG]
  return raw === '1' || raw === 'true'
}

/**
 * Install the handle when the harness flag is set. Returns true when a handle
 * was installed, so callers and tests can assert the gate rather than guess.
 *
 * Idempotent: re-installing replaces the previous function rather than
 * stacking, so a hot-reloaded store module cannot leave a stale closure
 * pointing at a dead coalescer.
 */
export function installPerfStatsHandle(
  read: () => PerfStatsHandlePayload,
  options: { env?: NodeJS.ProcessEnv; target?: Record<string, unknown> } = {}
): boolean {
  const env = options.env ?? process.env
  if (!isPerfStatsHandleEnabled(env)) return false
  const target = options.target ?? (globalThis as unknown as Record<string, unknown>)
  target[PERF_STATS_GLOBAL] = () => read()
  return true
}

/** Remove the handle. Used by tests; also lets a caller revoke it explicitly. */
export function uninstallPerfStatsHandle(options: { target?: Record<string, unknown> } = {}): void {
  const target = options.target ?? (globalThis as unknown as Record<string, unknown>)
  delete target[PERF_STATS_GLOBAL]
}
