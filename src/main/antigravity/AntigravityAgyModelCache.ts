// Last-known-good `agy models` catalogue.
//
// WHY: the hardcoded floor in AntigravityAgyStaticModels exists so the provider
// never silently vanishes when discovery fails, but a hardcoded snapshot goes
// stale every time Google ships or retires a family, and nothing about that list
// is a product decision — agy prints bare ids that are handed straight to
// `--model`, with no display name, context window, pricing or reasoning ladder to
// curate. Unlike the real catalogues in StaticProviderModels, it is a mirror, not
// an offer surface. So it should keep itself current rather than wait for someone
// to re-run `agy models` by hand.
//
// Mirrors the provider-usage-snapshot pattern (cacheProviderUsageSnapshot /
// usageSnapshotWithPersistedFallback): persist on success, serve on failure.
// Resolution order becomes live > cached > hardcoded, so the hardcoded list only
// matters on a machine that has never once discovered successfully.
//
// Deliberately a plain userData JSON file rather than a settings field: settings
// carry a sanitizer whitelist that silently drops unknown keys, and this is
// non-secret, machine-local, self-healing data that no other surface reads.
// Writes are async — an unbounded synchronous writeJson on the main thread is a
// known freeze class here.
//
// NOT account-scoped: identifying the signed-in account would mean reading agy's
// credentials, which this lane never does. So after switching Google accounts the
// cache describes the previous one until the next successful discovery. That
// self-heals, and a stale id fails loudly at dispatch with agy's own model error
// rather than silently doing the wrong thing.

import { promises as fsPromises } from 'fs'
import { join } from 'path'
import type { AgyModel } from './AntigravityCli'
import { isAntigravityGeminiApiModelCandidate } from './AntigravityCombinedModeDispatch'

export const AGY_MODEL_CACHE_FILENAME = 'antigravity-agy-models.json'
const AGY_MODEL_CACHE_VERSION = 1
const MAX_CACHED_MODELS = 128
const MAX_ID_LENGTH = 512

/**
 * Conservative id shape. The value reaches `--model` as its own argv member with
 * `shell: false`, so a leading dash cannot become a flag, but this is now data
 * read back from disk — validate rather than trust the file.
 */
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export interface AgyModelCacheDependencies {
  readonly userDataPath?: string
  readonly readFile?: (path: string) => Promise<string>
  readonly writeFile?: (path: string, contents: string) => Promise<void>
  /** Stamped into the record; injected because Date is unavailable in some contexts. */
  readonly now?: () => string
}

export function agyModelCachePath(userDataPath: string): string {
  return join(userDataPath, AGY_MODEL_CACHE_FILENAME)
}

function sanitizeCachedModel(value: unknown): AgyModel | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { id?: unknown; label?: unknown }
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id || id.length > MAX_ID_LENGTH || !SAFE_MODEL_ID.test(id)) return null
  // A cached row carrying the gemini-api prefix would be routed by
  // dispatchAntigravityCombinedMode to the separately billed SDK key lane. An
  // agy-lane cache must never be able to redirect a run onto the paid lane.
  if (isAntigravityGeminiApiModelCandidate(id)) return null
  const rawLabel = typeof record.label === 'string' ? record.label.trim() : ''
  return { id, label: rawLabel && rawLabel.length <= MAX_ID_LENGTH ? rawLabel : id }
}

/** Pure half: validate a parsed cache record into offerable rows. */
export function sanitizeCachedAgyModels(parsed: unknown): AgyModel[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as { version?: unknown; models?: unknown }
  if (record.version !== AGY_MODEL_CACHE_VERSION) return []
  if (!Array.isArray(record.models)) return []
  const models: AgyModel[] = []
  const seen = new Set<string>()
  for (const entry of record.models) {
    if (models.length >= MAX_CACHED_MODELS) break
    const model = sanitizeCachedModel(entry)
    if (!model) continue
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  return models
}

export interface CachedAgyModelRecord {
  readonly models: AgyModel[]
  /**
   * Epoch ms of the cache write, or null when absent/unparseable.
   *
   * `updatedAt` has always been WRITTEN below and never read back. It matters
   * now because a cache is the only durable evidence that an authenticated
   * `agy models` once succeeded on this machine, and that evidence is used to
   * decide whether a quota probe may run — evidence which should not be
   * treated as good forever.
   */
  readonly updatedAtMs: number | null
}

/** Pure half: recover the write time from a parsed cache record. */
export function cachedAgyModelUpdatedAtMs(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = (parsed as { updatedAt?: unknown }).updatedAt
  if (typeof raw !== 'string') return null
  const parsedMs = Date.parse(raw)
  return Number.isFinite(parsedMs) ? parsedMs : null
}

/** Best-effort: any failure yields an empty record so the caller falls through. */
export async function readCachedAgyModelRecord(
  deps: AgyModelCacheDependencies = {}
): Promise<CachedAgyModelRecord> {
  const userDataPath = deps.userDataPath
  if (!userDataPath) return { models: [], updatedAtMs: null }
  const readFile = deps.readFile ?? ((path: string) => fsPromises.readFile(path, 'utf8'))
  try {
    const parsed: unknown = JSON.parse(await readFile(agyModelCachePath(userDataPath)))
    const models = sanitizeCachedAgyModels(parsed)
    // Only report an age for a record that actually yielded rows: an age
    // without models is not evidence of anything.
    return {
      models,
      updatedAtMs: models.length > 0 ? cachedAgyModelUpdatedAtMs(parsed) : null
    }
  } catch {
    return { models: [], updatedAtMs: null }
  }
}

/** Best-effort: any failure yields [] so the caller falls through to the floor. */
export async function readCachedAgyModels(
  deps: AgyModelCacheDependencies = {}
): Promise<AgyModel[]> {
  return (await readCachedAgyModelRecord(deps)).models
}

/**
 * Best-effort write; never throws into a discovery pass. Refuses to persist an
 * empty list, which would otherwise let one odd successful-but-empty probe erase
 * a good cache and drop the user back to the hardcoded floor.
 */
export async function writeCachedAgyModels(
  models: readonly AgyModel[],
  deps: AgyModelCacheDependencies = {}
): Promise<void> {
  const userDataPath = deps.userDataPath
  if (!userDataPath || models.length === 0) return
  const sanitized = sanitizeCachedAgyModels({
    version: AGY_MODEL_CACHE_VERSION,
    models
  })
  if (sanitized.length === 0) return
  const writeFile =
    deps.writeFile ??
    ((path: string, contents: string) => fsPromises.writeFile(path, contents, 'utf8'))
  try {
    await writeFile(
      agyModelCachePath(userDataPath),
      JSON.stringify(
        {
          version: AGY_MODEL_CACHE_VERSION,
          updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
          models: sanitized
        },
        null,
        2
      )
    )
  } catch {
    // A cache that cannot be written just means the next failure serves the floor.
  }
}
