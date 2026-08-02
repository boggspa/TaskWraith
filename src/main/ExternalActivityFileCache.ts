import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { createInterface } from 'readline'
import type { UsageRecord } from './store/types'
import { ExternalUsageBucketAccumulator } from '../shared/externalUsageBuckets'

/**
 * Per-file incremental cache for the External Activity scan.
 *
 * The original format persisted every parsed provider turn as a verbose JSON
 * object. On a busy install that grew to 524 MB / 1.4M events. Every new
 * utility process then parsed the entire file into a Map before it could
 * discover that the underlying session files were unchanged, consuming a CPU
 * core and more than 600 MB of resident memory during startup.
 *
 * v6 keeps the same exact mtime+size invalidation contract while making the
 * payload compact:
 * - providers that do not need cross-file dedupe are pre-aggregated into the
 *   same minute/hour buckets used by the renderer;
 * - Claude/Gemini calls retain one compact tuple per dedupe identity, with a
 *   fixed-size digest instead of repeated request/message ids;
 * - models are interned once per source file and source paths are never
 *   repeated inside event rows.
 *
 * v5 is migrated in place, one JSONL row at a time. That one-time read remains
 * background work, but raw event arrays are released after each row instead
 * of being retained for the whole scan.
 */

// v6: compact packed rows + per-file time buckets. v5 verbose rows are the
// only legacy shape worth migrating: older versions have parser semantics
// that cannot safely be reused.
export const EXTERNAL_ACTIVITY_FILE_CACHE_VERSION = 6
const MIGRATABLE_CACHE_VERSION = 5

// Cache loading runs inside the utility process in production, but it still
// competes for system CPU, disk and page cache. Check after every JSONL row:
// live caches contain multi-megabyte lines, so a line-count batch lets one
// slice run for seconds before yielding.
const CACHE_LOAD_SLICE_MS = 25
const CACHE_LOAD_YIELD_MS = 40
let cacheLoadDeadlineMs = 0

async function yieldCacheLoadSlice(): Promise<void> {
  const now = Date.now()
  if (now < cacheLoadDeadlineMs) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, CACHE_LOAD_YIELD_MS)
  })
  cacheLoadDeadlineMs = Date.now() + CACHE_LOAD_SLICE_MS
}

export interface ExternalActivityFileCacheEvent {
  provider: string
  timestamp: number
  model: string
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  sourceKey: string
  dedupeKey?: string
  runCount?: number
}

type PackedExternalActivityEvent = [
  timestamp: number,
  modelIndex: number,
  totalTokens: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  runCount: number,
  dedupeKey: string
]

interface PackedExternalActivityFileCacheEntry {
  provider: string
  path: string
  mtimeMs: number
  size: number
  models: string[]
  events: PackedExternalActivityEvent[]
}

interface ExternalActivityFileCacheEntryRef {
  provider: string
  path: string
  mtimeMs: number
  size: number
  /** Keep compact rows serialized between lookups. Hundreds of thousands of
   * tiny JS tuple arrays cost far more heap than their 16 MB JSON encoding. */
  serializedLine: string
}

interface LegacyExternalActivityFileCacheEntry {
  provider: string
  path: string
  mtimeMs: number
  size: number
  events: unknown[]
}

interface CacheHeaderLine {
  version: number
}

let entriesByKey: Map<string, ExternalActivityFileCacheEntryRef> | null = null
let loadedPath: string | null = null
let dirty = false

function entryKey(provider: string, path: string): string {
  return `${provider}\u0000${path}`
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

function normalizeCacheEvent(
  value: unknown,
  provider: string,
  index: number
): ExternalActivityFileCacheEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Partial<ExternalActivityFileCacheEvent>
  const timestamp = Number(event.timestamp)
  const totalTokens = Number(event.totalTokens)
  if (!Number.isFinite(timestamp) || !Number.isFinite(totalTokens)) return null
  const model = typeof event.model === 'string' ? event.model : ''
  if (!model || model.length > 512) return null
  const dedupeKey = typeof event.dedupeKey === 'string' ? event.dedupeKey : ''
  return {
    provider,
    timestamp,
    model,
    inputTokens: finiteNonNegative(event.inputTokens),
    outputTokens: finiteNonNegative(event.outputTokens),
    totalTokens: Math.max(0, totalTokens),
    cacheReadInputTokens: finiteNonNegative(event.cacheReadInputTokens),
    cacheCreationInputTokens: finiteNonNegative(event.cacheCreationInputTokens),
    sourceKey:
      typeof event.sourceKey === 'string' && event.sourceKey
        ? event.sourceKey
        : `legacy-cache:${provider}:${index}`,
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(finiteNonNegative(event.runCount) > 1
      ? { runCount: Math.trunc(finiteNonNegative(event.runCount)) }
      : {})
  }
}

function compactDedupeKey(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22)
}

function usageRecordForCacheEvent(event: ExternalActivityFileCacheEvent): UsageRecord {
  return {
    id: event.sourceKey,
    provider: event.provider as UsageRecord['provider'],
    workspaceId: 'external',
    chatId: `external-${event.provider}`,
    runId: `external-${event.provider}`,
    usageKind: 'run',
    model: event.model,
    inputTokens: finiteNonNegative(event.inputTokens),
    outputTokens: finiteNonNegative(event.outputTokens),
    totalTokens: finiteNonNegative(event.totalTokens),
    ...(finiteNonNegative(event.cacheReadInputTokens) > 0
      ? { cacheReadInputTokens: finiteNonNegative(event.cacheReadInputTokens) }
      : {}),
    ...(finiteNonNegative(event.cacheCreationInputTokens) > 0
      ? { cacheCreationInputTokens: finiteNonNegative(event.cacheCreationInputTokens) }
      : {}),
    durationMs: 0,
    timestamp: event.timestamp,
    ...(finiteNonNegative(event.runCount) > 1
      ? { runCount: Math.trunc(finiteNonNegative(event.runCount)) }
      : {})
  }
}

function packEvents(
  provider: string,
  values: unknown[],
  nowMs: number
): Pick<PackedExternalActivityFileCacheEntry, 'models' | 'events'> {
  const dedupedEvents: Array<ExternalActivityFileCacheEvent & { dedupeKey: string }> = []
  const seenDedupeKeys = new Set<string>()
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)

  for (let index = 0; index < values.length; index += 1) {
    const event = normalizeCacheEvent(values[index], provider, index)
    if (!event) continue
    if (event.dedupeKey) {
      if (seenDedupeKeys.has(event.dedupeKey)) continue
      seenDedupeKeys.add(event.dedupeKey)
      dedupedEvents.push({ ...event, dedupeKey: compactDedupeKey(event.dedupeKey) })
      continue
    }
    accumulator.add(usageRecordForCacheEvent(event))
  }

  const compactedEvents: ExternalActivityFileCacheEvent[] = [
    ...dedupedEvents,
    ...accumulator.finish().map((record) => ({
      provider,
      timestamp: record.timestamp,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      sourceKey: record.id,
      runCount: record.runCount
    }))
  ]

  const models: string[] = []
  const modelIndexes = new Map<string, number>()
  const packed: PackedExternalActivityEvent[] = []
  for (const event of compactedEvents) {
    let modelIndex = modelIndexes.get(event.model)
    if (modelIndex === undefined) {
      modelIndex = models.length
      models.push(event.model)
      modelIndexes.set(event.model, modelIndex)
    }
    packed.push([
      event.timestamp,
      modelIndex,
      finiteNonNegative(event.totalTokens),
      finiteNonNegative(event.inputTokens),
      finiteNonNegative(event.outputTokens),
      finiteNonNegative(event.cacheReadInputTokens),
      finiteNonNegative(event.cacheCreationInputTokens),
      Math.max(1, Math.trunc(finiteNonNegative(event.runCount) || 1)),
      event.dedupeKey || ''
    ])
  }

  return { models, events: packed }
}

function isPackedEvent(value: unknown, modelCount: number): value is PackedExternalActivityEvent {
  if (!Array.isArray(value) || value.length !== 9) return false
  const [timestamp, modelIndex, total, input, output, cacheRead, cacheCreation, runCount, dedupe] =
    value
  return (
    Number.isFinite(timestamp) &&
    Number.isInteger(modelIndex) &&
    modelIndex >= 0 &&
    modelIndex < modelCount &&
    [total, input, output, cacheRead, cacheCreation].every(
      (entry) => Number.isFinite(entry) && entry >= 0
    ) &&
    Number.isInteger(runCount) &&
    runCount >= 1 &&
    typeof dedupe === 'string' &&
    dedupe.length <= 128
  )
}

function normalizePackedEntry(value: unknown): PackedExternalActivityFileCacheEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<PackedExternalActivityFileCacheEntry>
  if (
    typeof entry.provider !== 'string' ||
    !entry.provider ||
    typeof entry.path !== 'string' ||
    !entry.path ||
    !Number.isFinite(entry.mtimeMs) ||
    !Number.isFinite(entry.size) ||
    !Array.isArray(entry.models) ||
    entry.models.length > 2_048 ||
    !entry.models.every(
      (model) => typeof model === 'string' && model.length > 0 && model.length <= 512
    ) ||
    !Array.isArray(entry.events) ||
    entry.events.length > 1_000_000 ||
    !entry.events.every((event) => isPackedEvent(event, entry.models!.length))
  ) {
    return null
  }
  return entry as PackedExternalActivityFileCacheEntry
}

function migrateLegacyEntry(value: unknown): PackedExternalActivityFileCacheEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<LegacyExternalActivityFileCacheEntry>
  if (
    typeof entry.provider !== 'string' ||
    !entry.provider ||
    typeof entry.path !== 'string' ||
    !entry.path ||
    !Number.isFinite(entry.mtimeMs) ||
    !Number.isFinite(entry.size) ||
    !Array.isArray(entry.events)
  ) {
    return null
  }
  return {
    provider: entry.provider,
    path: entry.path,
    mtimeMs: entry.mtimeMs as number,
    size: entry.size as number,
    ...packEvents(entry.provider, entry.events, Date.now())
  }
}

function entryRef(
  entry: PackedExternalActivityFileCacheEntry,
  serializedLine: string = JSON.stringify(entry)
): ExternalActivityFileCacheEntryRef {
  return {
    provider: entry.provider,
    path: entry.path,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    serializedLine
  }
}

/** Load the cache file into memory once per path; subsequent calls no-op.
 * Passing a different path (tests) reloads from that path. */
export async function ensureExternalActivityFileCacheLoaded(cachePath: string): Promise<void> {
  if (entriesByKey && loadedPath === cachePath) return
  const entries = new Map<string, ExternalActivityFileCacheEntryRef>()
  entriesByKey = entries
  loadedPath = cachePath
  dirty = false
  cacheLoadDeadlineMs = Date.now() + CACHE_LOAD_SLICE_MS
  let diskVersion: number | null = null
  try {
    const input = createReadStream(cachePath, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        await yieldCacheLoadSlice()
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (diskVersion === null) {
          const header = parsed as CacheHeaderLine
          if (
            header?.version !== EXTERNAL_ACTIVITY_FILE_CACHE_VERSION &&
            header?.version !== MIGRATABLE_CACHE_VERSION
          ) {
            return
          }
          diskVersion = header.version
          if (diskVersion === MIGRATABLE_CACHE_VERSION) dirty = true
          continue
        }
        const entry =
          diskVersion === MIGRATABLE_CACHE_VERSION
            ? migrateLegacyEntry(parsed)
            : normalizePackedEntry(parsed)
        if (!entry) continue
        entries.set(
          entryKey(entry.provider, entry.path),
          entryRef(entry, diskVersion === MIGRATABLE_CACHE_VERSION ? undefined : trimmed)
        )
      }
    } finally {
      lines.close()
      input.destroy()
    }
  } catch {
    // Missing or unreadable cache file — start empty.
  }
}

export function getCachedExternalFileEvents(
  provider: string,
  path: string,
  mtimeMs: number,
  size: number
): ExternalActivityFileCacheEvent[] | null {
  const entry = entriesByKey?.get(entryKey(provider, path))
  if (!entry) return null
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) return null
  let packed: PackedExternalActivityFileCacheEntry | null = null
  try {
    packed = normalizePackedEntry(JSON.parse(entry.serializedLine))
  } catch {
    return null
  }
  if (!packed) return null
  return packed.events.map((event, index) => {
    const [
      timestamp,
      modelIndex,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      runCount,
      dedupeKey
    ] = event
    return {
      provider,
      timestamp,
      model: packed.models[modelIndex],
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      sourceKey: `compact-cache:${provider}:${mtimeMs}:${index}`,
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(runCount > 1 ? { runCount } : {})
    }
  })
}

export function setCachedExternalFileEvents(
  provider: string,
  path: string,
  mtimeMs: number,
  size: number,
  events: ExternalActivityFileCacheEvent[]
): void {
  if (!entriesByKey) return
  const entry: PackedExternalActivityFileCacheEntry = {
    provider,
    path,
    mtimeMs,
    size,
    ...packEvents(provider, events, Date.now())
  }
  entriesByKey.set(entryKey(provider, path), entryRef(entry))
  dirty = true
}

/** Drop entries for files no longer in the provider's active (in-window) set
 * so the cache tracks the rolling window instead of growing forever. */
export function pruneExternalActivityFileCache(provider: string, activePaths: Set<string>): void {
  if (!entriesByKey) return
  for (const [key, entry] of entriesByKey) {
    if (entry.provider !== provider) continue
    if (!activePaths.has(entry.path)) {
      entriesByKey.delete(key)
      dirty = true
    }
  }
}

/** Persist to disk when anything changed this scan. Streams JSONL through a
 * write stream (awaiting drain) and swaps in atomically via tmp+rename. */
export async function persistExternalActivityFileCacheIfDirty(cachePath: string): Promise<void> {
  if (!dirty || !entriesByKey || loadedPath !== cachePath) return
  const tempPath = `${cachePath}.tmp-${process.pid}`
  try {
    await fs.mkdir(dirname(cachePath), { recursive: true })
    const stream = createWriteStream(tempPath, { encoding: 'utf8', mode: 0o600 })
    const writeLine = (line: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (stream.write(`${line}\n`)) {
          resolve()
          return
        }
        const onDrain = (): void => {
          stream.off('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          stream.off('drain', onDrain)
          reject(err)
        }
        stream.once('drain', onDrain)
        stream.once('error', onError)
      })
    try {
      await writeLine(JSON.stringify({ version: EXTERNAL_ACTIVITY_FILE_CACHE_VERSION }))
      for (const entry of entriesByKey.values()) {
        await writeLine(entry.serializedLine)
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      stream.destroy()
      throw err
    }
    await fs.rename(tempPath, cachePath)
    dirty = false
  } catch {
    // Best-effort persistence — a failed write must not break usage surfaces.
    try {
      await fs.rm(tempPath, { force: true })
    } catch {
      // ignore
    }
  }
}

/** Tests only: drop in-memory state so the next load re-reads from disk. */
export function resetExternalActivityFileCacheForTests(): void {
  entriesByKey = null
  loadedPath = null
  dirty = false
}
