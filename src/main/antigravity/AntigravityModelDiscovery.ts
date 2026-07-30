// Authenticated model discovery for the user-installed official `agy` CLI.
//
// This stays separate from runtime launches: it performs the documented
// `agy models` command only after recorded opt-in, forwards only the S2
// credential-sanitized environment, and never reads OAuth/keyring material.

import { spawn } from 'child_process'
import type { AppSettings } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  probeAgyModels,
  resolveAgyCliBinary,
  type AgyModel,
  type AgyModelProbeDependencies,
  type AgyProcessCaptureResult
} from './AntigravityCli'
import { antigravityAgyStaticModels, offerableAgyModels } from './AntigravityAgyStaticModels'
import {
  readCachedAgyModelRecord,
  writeCachedAgyModels,
  type AgyModelCacheDependencies,
  type CachedAgyModelRecord
} from './AntigravityAgyModelCache'
import {
  recordAgyDiscoveryProvenance,
  type AgyDiscoveryProvenance
} from './AntigravityAgyDiscoveryProvenance'

const MAX_CAPTURED_OUTPUT = 80_000

export interface AuthenticatedAgyModelDiscoveryDependencies {
  resolveBinary?: AgyModelProbeDependencies['resolveBinary']
  capture?: AgyModelProbeDependencies['capture']
  inheritedEnv?: AgyModelProbeDependencies['env']
  timeoutMs?: number
  /**
   * Last-known-good cache location. Omitting `userDataPath` disables the cache
   * entirely and falls straight through to the hardcoded floor, which is what
   * callers with no app context (and most tests) want.
   */
  cache?: AgyModelCacheDependencies
  /** Test seams. */
  readCachedModels?: (cache?: AgyModelCacheDependencies) => Promise<AgyModel[]>
  readCachedModelRecord?: (cache?: AgyModelCacheDependencies) => Promise<CachedAgyModelRecord>
  writeCachedModels?: (
    models: readonly AgyModel[],
    cache?: AgyModelCacheDependencies
  ) => Promise<void>
  /**
   * Records where the rows came from, so the quota gate can stop inferring
   * authentication from row shape. Defaults to the main-process single slot.
   */
  recordProvenance?: (provenance: AgyDiscoveryProvenance) => void
}

/**
 * Captures only a resolved official `agy` process with the environment already
 * constructed by `probeAgyModels`. Do not replace this with the generic CLI
 * capture helper: that helper creates its own provider environment and would
 * defeat the AntiGravity credential-selector stripping boundary.
 */
export function captureAgyModelDiscoveryOutput(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number }
): Promise<AgyProcessCaptureResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, [...args], { env: options.env, shell: false })
    const finish = (result: AgyProcessCaptureResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish({ stdout, stderr, code: null, timedOut: true, error: 'agy models timed out.' })
    }, options.timeoutMs)
    timeout.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > MAX_CAPTURED_OUTPUT) stdout = stdout.slice(-MAX_CAPTURED_OUTPUT)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_CAPTURED_OUTPUT) stderr = stderr.slice(-MAX_CAPTURED_OUTPUT)
    })
    child.on('error', (error) =>
      finish({ stdout, stderr, code: null, timedOut: false, error: error.message })
    )
    child.on('close', (code) => finish({ stdout, stderr, code, timedOut: false }))
  })
}

/**
 * The configured-provider cache may expose AntiGravity only after explicit risk
 * consent AND a resolved user-installed binary. Those two are hard gates: with
 * either missing this returns nothing, so the ban-risk lane stays invisible.
 *
 * Beyond that pair, a live authenticated `agy models` is preferred but no longer
 * REQUIRED. It used to be, and the consequence was that any probe failure — not
 * logged in, non-zero exit, timeout, or a parse yielding nothing — returned `[]`
 * with the error swallowed, which tripped the `models.length > 0` admission in
 * `isAuthenticatedAntigravityConfiguredProvider` and made the whole provider
 * vanish from every surface with no message anywhere.
 *
 * Preference order is live > cached > hardcoded, but the CACHE IS CONSULTED
 * FIRST, and that ordering is the whole point:
 *
 * `agy models` is an authenticated CLI round-trip costing roughly 2.4s on the
 * current official binary, while this function runs inside the configured-
 * provider probe's 900ms bounded lane (itself inside a 1000ms total deadline).
 * When the cache read sat AFTER the probe, control never reached it — the lane
 * timed out mid-probe every single time, so the cache was written on every pass
 * and read on none, and `antigravityAgyStaticModels()` was not a last-resort
 * floor but the only outcome the picker ever saw. Reading the cache first is a
 * local file read that finishes comfortably inside the budget.
 *
 * The probe still runs exactly once per settings generation, as before: when
 * cached rows already exist it refreshes them for the NEXT generation rather
 * than being awaited (stale-while-revalidate). That changes the picker's
 * freshness, not the number of authenticated round-trips — deliberately, since
 * request cadence against the AntiGravity backend is the thing that must not
 * grow.
 *
 * The cache exists because the hardcoded list is a mirror of agy's output, not a
 * curated catalogue — see AntigravityAgyModelCache for why that distinction makes
 * it the one model list worth self-refreshing.
 */
export async function discoverAuthenticatedAgyModels(
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined,
  deps: AuthenticatedAgyModelDiscoveryDependencies = {}
): Promise<AgyModel[]> {
  const record = deps.recordProvenance ?? recordAgyDiscoveryProvenance
  if (!isAntigravityOptInEnabled(settings)) {
    record({ source: 'none', cachedAtMs: null })
    return []
  }

  // Resolved once and reused, so the probe cannot observe a different binary
  // than the presence gate did.
  let resolvedBinary: Awaited<ReturnType<typeof resolveAgyCliBinary>>
  try {
    resolvedBinary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  } catch {
    record({ source: 'none', cachedAtMs: null })
    return []
  }
  if (!resolvedBinary.binaryPath) {
    record({ source: 'none', cachedAtMs: null })
    return []
  }

  const runProbe = async (): Promise<AgyModel[]> => {
    const result = await probeAgyModels({
      resolveBinary: async () => resolvedBinary,
      capture: deps.capture ?? captureAgyModelDiscoveryOutput,
      env: deps.inheritedEnv,
      timeoutMs: deps.timeoutMs
    })
    if (result.error || result.models.length === 0) return []
    // Persisted, not awaited-for-correctness: a cache write failure must not
    // turn a good discovery into a failed one. The `.catch` is load-bearing —
    // `void` alone discards the promise WITHOUT a rejection handler, so a
    // writer that rejects becomes an unhandled rejection in the main process.
    // The cache stores the UNFILTERED catalogue (it mirrors agy's output);
    // the resold-model policy is applied on the way OUT of every source so
    // a policy change never requires a cache invalidation.
    void (deps.writeCachedModels ?? writeCachedAgyModels)(result.models, deps.cache).catch(() => {})
    const offerable = offerableAgyModels(result.models)
    // A successful probe is CURRENT proof of an authenticated connection, and
    // it is recorded even when it lands after the caller's bounded window gave
    // up on it: the round-trip really did succeed, which is exactly what the
    // quota gate needs to know. That is why a first-ever launch can still open
    // the gate a couple of seconds after showing the floor.
    if (offerable.length > 0) record({ source: 'live', cachedAtMs: null })
    return offerable
  }

  let cached: CachedAgyModelRecord = { models: [], updatedAtMs: null }
  try {
    if (deps.readCachedModelRecord) {
      cached = await deps.readCachedModelRecord(deps.cache)
    } else if (deps.readCachedModels) {
      // Legacy seam: rows without an age. Treated as an unknown-age cache,
      // which the provenance predicate fails closed on.
      cached = { models: await deps.readCachedModels(deps.cache), updatedAtMs: null }
    } else {
      cached = await readCachedAgyModelRecord(deps.cache)
    }
  } catch {
    // An unreadable cache is not a discovery failure; fall through to the probe.
    cached = { models: [], updatedAtMs: null }
  }

  const cachedOfferable = offerableAgyModels(cached.models)
  if (cachedOfferable.length > 0) {
    record({ source: 'cached', cachedAtMs: cached.updatedAtMs })
    // Refresh in the background for the next generation. Unawaited on purpose:
    // awaiting it is what previously guaranteed the lane timed out. If it
    // succeeds it upgrades the provenance to 'live'.
    void runProbe().catch(() => {})
    return cachedOfferable
  }

  // Nothing cached — this machine has never discovered successfully. Await the
  // probe: there is nothing better to return, and if it outruns the caller's
  // budget the lane falls through to the floor exactly as it did before.
  try {
    const live = await runProbe()
    if (live.length > 0) return live
  } catch {
    // Fall through to the floor rather than hiding the provider entirely.
  }
  // The floor is a hardcoded mirror, NOT evidence of anything. Recording it as
  // such is the whole point of this signal.
  record({ source: 'floor', cachedAtMs: null })
  return offerableAgyModels(antigravityAgyStaticModels())
}
