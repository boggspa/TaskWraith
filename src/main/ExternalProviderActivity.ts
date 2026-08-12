import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import os from 'os'
import { createInterface } from 'readline'
import { app } from 'electron'
import type { ProviderId, UsageRecord } from './store/types'
import {
  externalActivityRecordTokens,
  externalActivityWindowBounds
} from '../shared/usageAccounting'
import {
  ExternalUsageBucketAccumulator,
  aggregateExternalUsageRecords
} from '../shared/externalUsageBuckets'
import {
  loadCursorIdeUsageEvents,
  setCursorExternalActivityUpdateListener
} from './cursor/CursorExternalActivity'
import { CURSOR_TRANSCRIPT_CHUNK_SIZE } from './cursor/CursorExternalActivityCache'
import {
  type ExternalActivityFileCacheEvent,
  ensureExternalActivityFileCacheLoaded,
  getCachedExternalFileEvents,
  persistExternalActivityFileCacheIfDirty,
  pruneExternalActivityFileCache,
  setCachedExternalFileEvents
} from './ExternalActivityFileCache'
import { isTaskWraithCodexRolloutOriginator } from './codex/CodexHome'
import { loadExternalUsageSnapshot, persistExternalUsageSnapshot } from './ExternalUsageSnapshot'

type ExternalActivityProvider = Extract<
  ProviderId,
  'codex' | 'claude' | 'gemini' | 'kimi' | 'cursor' | 'grok'
>

export interface ExternalProviderActivityOptions {
  homeDir?: string
  now?: Date
  lookbackDays?: number
  /** Bypass the in-memory result cache. Per-file caches still apply — an
   * unchanged file (same mtime+size) is never re-parsed, even when forced. */
  force?: boolean
  /** Override persisted Cursor incremental cache path (tests). */
  cursorCachePath?: string
  /** Override persisted per-file event cache path (tests). */
  externalFileCachePath?: string
}

interface ExternalUsageEvent extends ExternalActivityFileCacheEvent {
  provider: ExternalActivityProvider
  /** Rate-table identity when it intentionally differs from the normalized
   * display model (for example Cursor Grok 4.6 Fast). */
  costRateModel?: string
  /** Cross-file dedupe key (claude/gemini). Stored with cached per-file
   * events so assembly-time dedupe survives the incremental cache. */
  dedupeKey?: string
}

interface CollectedSessionFile {
  path: string
  mtimeMs: number
  size: number
}

const DEFAULT_LOOKBACK_DAYS = 90
const MAX_FILES_PER_PROVIDER = 260
const MAX_GEMINI_SESSION_FILES = 1_200
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_EXPANDED_SESSION_TEXT_BYTES = 128 * 1024 * 1024
const MAX_CODEX_SQLITE_MARKERS_PER_BUCKET = 8

// ── Cached front door ───────────────────────────────────────────────────────
// A full load walks up to ~5k provider session files. The per-file
// ExternalActivityFileCache makes that walk incremental (stat sweep + parse
// of changed files only, persisted across launches), and this in-memory
// layer serves repeat callers for 6h without re-walking at all.
// Serve-stale-while-revalidate; a bounded non-forced 2h interval in
// usageRatesHandlers keeps remote rollups fresh; index.ts prewarms at
// startup so the FIRST open is hydrated too.

const EXTERNAL_USAGE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000
const EXTERNAL_FILE_CACHE_FILENAME = 'external-activity-file-cache.jsonl'
const EXTERNAL_USAGE_SNAPSHOT_FILENAME = 'external-activity-snapshot.json'

// ── Main-thread duty cycle ──────────────────────────────────────────────────
// Streaming keeps any single read short, but the scan AS A WHOLE is the
// problem: a cold cache re-parses every in-window session file, which on a
// busy machine is tens of GB (measured 2026-07-19: 74.9GB across 3.8k Codex
// rollouts, ~216s at 0.35GB/s). Nothing here blocks in the `readFileSync`
// sense, yet the main process stays pegged for minutes, IPC replies queue
// behind it, and the window reads as frozen at launch.
//
// So bound the SHARE of the main thread the scan may take: run for at most
// SCAN_SLICE_MS, then hand the loop back for SCAN_YIELD_MS so paint, IPC and
// timers drain. This trades ~25% more wall-clock on a background task for a
// responsive app, which is the right side of that trade. A `setImmediate`
// yield is NOT enough — under sustained CPU it resolves straight back into
// the scan and the loop re-saturates; only a real timer gap lets work land.
// Prefer responsiveness over raw scan throughput: a cold 90-day walk can
// otherwise peg main for minutes and freeze IPC/paint. Shorter slices + longer
// yields keep the window usable while the background hydrate finishes.
const SCAN_SLICE_MS = 25
const SCAN_YIELD_MS = 40

/** 'duty-cycle' bounds the scan's share of its process and therefore its
 * system-wide CPU/disk contention. 'immediate' is retained for isolated tests
 * and diagnostics only; production workers must remain duty-cycled. */
let scanYieldMode: 'duty-cycle' | 'immediate' = 'duty-cycle'

export function setExternalScanYieldMode(mode: 'duty-cycle' | 'immediate'): void {
  scanYieldMode = mode
}
// Checking the clock per line would itself cost real time on a 400M-line
// corpus, so amortize it over a batch.
const SCAN_CLOCK_CHECK_LINES = 256
// Between-file duty cycle for collect/stat/cache assembly work that never
// enters the line reader (and therefore never hits SCAN_CLOCK_CHECK_LINES).
const SCAN_CLOCK_CHECK_FILES = 8
// Cold IPC returns a short-window partial first so welcome heatmaps paint
// without waiting for the full 90-day reparse of multi-GB provider corpora.
const COLD_PARTIAL_LOOKBACK_DAYS = 14

let scanSliceDeadlineMs = 0

/** Hand the event loop back once the current slice is spent. Shared across
 * every reader: the providers scan concurrently under one `Promise.all`, so
 * the budget has to be global or each reader would claim a full slice. */
async function yieldScanSlice(): Promise<void> {
  if (scanYieldMode === 'immediate') {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    return
  }
  const now = Date.now()
  if (now < scanSliceDeadlineMs) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SCAN_YIELD_MS)
  })
  scanSliceDeadlineMs = Date.now() + SCAN_SLICE_MS
}

export interface ExternalUsageRollup {
  providers: Array<{ provider: string; h24: number; d7: number; d90: number }>
  totals: { h24: number; d7: number; d90: number }
}

/** Token totals per provider for the 24h/7d/90d chips — computed off the
 * cached usage records so paired devices get the same numbers the desktop
 * External Activity header shows.
 *
 * The `d90` window is 90 LOCAL CALENDAR days ending at the last millisecond of
 * today, matching `buildHeatmapGrid`'s window rather than a rolling 90x24h
 * cutoff, and tokens come from the shared accounting helper rather than a
 * second formula. Both used to differ here, so this rollup and the desktop
 * header disagreed by construction — see the parity test in
 * ExternalProviderActivity.test.ts. */
export function buildExternalUsageRollup(
  records: UsageRecord[],
  now: number = Date.now()
): ExternalUsageRollup {
  const h24 = now - 24 * 60 * 60 * 1000
  const d7 = now - 7 * 24 * 60 * 60 * 1000
  const { startMs, endMs } = externalActivityWindowBounds(new Date(now), DEFAULT_LOOKBACK_DAYS)
  const byProvider = new Map<string, { h24: number; d7: number; d90: number }>()
  const totals = { h24: 0, d7: 0, d90: 0 }
  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    if (!Number.isFinite(record.timestamp)) continue
    if (record.timestamp < startMs || record.timestamp > endMs) continue
    const tokens = externalActivityRecordTokens(record)
    if (!tokens) continue
    const key = record.provider ?? 'unknown'
    const bucket = byProvider.get(key) ?? { h24: 0, d7: 0, d90: 0 }
    bucket.d90 += tokens
    totals.d90 += tokens
    if (record.timestamp >= d7) {
      bucket.d7 += tokens
      totals.d7 += tokens
      if (record.timestamp >= h24) {
        bucket.h24 += tokens
        totals.h24 += tokens
      }
    }
    byProvider.set(key, bucket)
  }
  return {
    providers: [...byProvider.entries()]
      .map(([provider, buckets]) => ({ provider, ...buckets }))
      .sort((a, b) => b.d90 - a.d90),
    totals
  }
}

let externalUsageCache: { records: UsageRecord[]; scannedAt: number } | null = null
let cursorCacheListenerInstalled = false
let automaticScanAdmissionOpen = true
let externalUsageSnapshotPath: string | null = null
let snapshotHydrated = false
let snapshotHydrationInFlight: Promise<void> | null = null

/** How a 90-day scan is executed. Production installs a utility-process
 * driver at startup; this front door deliberately has no main-process
 * fallback. A cold history scan can read tens of GB, so serving empty/stale
 * stats is always preferable to letting it contend with Electron's main
 * event loop. `onPartial` delivers the short-window cold partial (and any
 * other intermediate result) before the full window resolves. */
export interface ExternalScanRequest {
  options: ExternalProviderActivityOptions
  /** When set, deliver a short-window partial via onPartial before resolving
   * the full window. Null when a cached result is already on screen — a
   * partial would transiently shrink it. */
  partialLookbackDays: number | null
}

export type ExternalScanDriver = (
  request: ExternalScanRequest,
  onPartial: (records: UsageRecord[]) => void
) => Promise<UsageRecord[]>

let externalScanDriver: ExternalScanDriver | null = null

export function setExternalScanDriver(driver: ExternalScanDriver | null): void {
  externalScanDriver = driver
}

/** Fired every time the cached record set is replaced with fresher/fuller
 * data (cold partial, full-window completion, Cursor chunk upgrades,
 * background revalidation). index.ts uses it to ping renderers so the welcome
 * heatmap upgrades from the 14-day partial to the full 90-day window without
 * waiting for an unrelated re-render. */
type ExternalUsageUpdateListener = (records: UsageRecord[]) => void

let externalUsageUpdateListener: ExternalUsageUpdateListener | null = null

export function setExternalUsageUpdateListener(listener: ExternalUsageUpdateListener | null): void {
  externalUsageUpdateListener = listener
}

function commitExternalUsageRecords(records: UsageRecord[], scannedAt: number = Date.now()): void {
  externalUsageCache = { records, scannedAt }
  try {
    externalUsageUpdateListener?.(records)
  } catch {
    // Listener failures must never poison the scan pipeline.
  }
}

async function hydrateConfiguredExternalUsageSnapshot(): Promise<void> {
  if (snapshotHydrated) return
  if (snapshotHydrationInFlight) return snapshotHydrationInFlight
  const snapshotPath = externalUsageSnapshotPath
  if (!snapshotPath) {
    snapshotHydrated = true
    return
  }
  snapshotHydrationInFlight = (async () => {
    const snapshot = await loadExternalUsageSnapshot(snapshotPath)
    if (snapshot && (!externalUsageCache || snapshot.scannedAt > externalUsageCache.scannedAt)) {
      commitExternalUsageRecords(snapshot.records, snapshot.scannedAt)
    }
    snapshotHydrated = true
  })().finally(() => {
    snapshotHydrationInFlight = null
  })
  return snapshotHydrationInFlight
}

/**
 * Startup admission fence. Renderer reads may ask for external usage on their
 * first animation frame; those reads serve the compact last-good snapshot but
 * cannot launch the heavyweight refresh before the main process explicitly
 * calls {@link prewarmExternalUsageCache} after the interactive settle gap.
 */
export function initializeExternalUsageCacheForStartup(
  snapshotPath: string = resolveExternalUsageSnapshotPath()
): Promise<void> {
  automaticScanAdmissionOpen = false
  if (externalUsageSnapshotPath !== snapshotPath) {
    externalUsageSnapshotPath = snapshotPath
    snapshotHydrated = false
    snapshotHydrationInFlight = null
  }
  return hydrateConfiguredExternalUsageSnapshot()
}

function resolveCursorExternalCachePath(override?: string): string {
  if (override) return override
  return join(app.getPath('userData'), 'cursor-external-activity-cache.json')
}

function ensureCursorCacheListener(): void {
  if (cursorCacheListenerInstalled) return
  cursorCacheListenerInstalled = true
  setCursorExternalActivityUpdateListener((events) => {
    replaceCachedCursorExternalRecords(events)
  })
}

/** Worker seam: inside the utility process there is no renderer to notify, so
 * converted Cursor chunk records are forwarded to the parent, which merges
 * them via {@link applyCursorUsageRecords}. */
let cursorRecordsForwarder: ((records: UsageRecord[]) => void) | null = null

export function setCursorRecordsForwarder(fn: ((records: UsageRecord[]) => void) | null): void {
  cursorRecordsForwarder = fn
}

/** Merge freshly-converted Cursor records into the cached set (all other
 * providers untouched) and notify listeners. Runs in main for both the local
 * chunk listener and records forwarded from the worker process. */
export function applyCursorUsageRecords(cursorRecords: UsageRecord[]): void {
  if (cursorRecords.length === 0) return
  // Cursor chunk sets bypass loadExternalProviderUsageRecords, so bucket them
  // here — each update carries the COMPLETE cursor set (the merge below
  // replaces the provider subset wholesale), and aggregation is idempotent,
  // so worker-forwarded sets that were already bucketed re-group unchanged.
  const bucketed = aggregateExternalUsageRecords(cursorRecords, Date.now())
  if (!externalUsageCache) {
    commitExternalUsageRecords(bucketed)
    return
  }
  const other = externalUsageCache.records.filter((record) => record.provider !== 'cursor')
  commitExternalUsageRecords([...other, ...bucketed].sort((a, b) => b.timestamp - a.timestamp))
}

function replaceCachedCursorExternalRecords(
  cursorEvents: Array<{
    provider: 'cursor'
    timestamp: number
    model: string
    costRateModel?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens: number
    sourceKey: string
  }>
): void {
  const cursorRecords = cursorEvents
    .map((event) => eventToUsageRecord(event))
    .filter((record): record is UsageRecord => Boolean(record))
  if (cursorRecords.length === 0) return
  applyCursorUsageRecords(cursorRecords)
  cursorRecordsForwarder?.(cursorRecords)
}

interface ExternalScanInFlight {
  /** Resolves at the first committed result (cold partial or full window).
   * This is retained for test teardown; renderers never wait for it. */
  firstData: Promise<UsageRecord[]>
  /** Resolves with the full-window result. */
  complete: Promise<UsageRecord[]>
}

let externalScanInFlight: ExternalScanInFlight | null = null

function startExternalScan(
  options: ExternalProviderActivityOptions,
  force: boolean
): ExternalScanInFlight {
  if (externalScanInFlight) return externalScanInFlight

  let resolveFirst!: (records: UsageRecord[]) => void
  let firstSettled = false
  const firstData = new Promise<UsageRecord[]>((resolve) => {
    resolveFirst = resolve
  })
  const settleFirst = (records: UsageRecord[]): void => {
    if (firstSettled) return
    firstSettled = true
    resolveFirst(records)
  }
  const commit = (records: UsageRecord[]): void => {
    commitExternalUsageRecords(records)
    settleFirst(records)
  }

  const request: ExternalScanRequest = {
    options: { ...options, force },
    partialLookbackDays:
      !externalUsageCache && !force && !options.lookbackDays ? COLD_PARTIAL_LOOKBACK_DAYS : null
  }

  const runWith = async (driver: ExternalScanDriver): Promise<UsageRecord[]> => {
    const full = await driver(request, commit)
    const scannedAt = Date.now()
    commitExternalUsageRecords(full, scannedAt)
    settleFirst(full)
    if (externalUsageSnapshotPath) {
      await persistExternalUsageSnapshot(externalUsageSnapshotPath, { records: full, scannedAt })
    }
    return full
  }

  const complete = (async () => {
    const driver = externalScanDriver
    if (!driver) {
      // Startup wiring has not installed the utility-process driver yet. Do
      // not quietly perform the same expensive walk on Electron main; the
      // scheduled prewarm will retry after the pipeline is installed.
      const fallback = externalUsageCache?.records ?? []
      settleFirst(fallback)
      return fallback
    }
    try {
      return await runWith(driver)
    } catch (error) {
      // A worker failure is an empty/stale-data condition, not permission to
      // move a multi-GB scan onto main. The next caller/prewarm can retry.
      console.warn('[external-usage] background worker scan failed:', error)
      const fallback = externalUsageCache?.records ?? []
      settleFirst(fallback)
      return fallback
    } finally {
      externalScanInFlight = null
    }
  })()

  externalScanInFlight = { firstData, complete }
  return externalScanInFlight
}

/** Test seam: resolve once no external scan is in flight. Callers of
 * getExternalUsageCached unblock at the FIRST committed result while the
 * full-window walk keeps writing caches in the background — teardown that
 * removes a scan fixture must wait here first, or those writers race the rm
 * (ENOTEMPTY). Production never calls this. */
export async function settleExternalScansForTests(): Promise<void> {
  while (externalScanInFlight) {
    await externalScanInFlight.complete.catch(() => {})
  }
}

/** Test seam: clear the in-memory front-door state (result cache, in-flight
 * scan, injected driver/listeners). Production never calls this. */
export function resetExternalUsageFrontDoorForTests(): void {
  externalUsageCache = null
  externalScanInFlight = null
  externalScanDriver = null
  externalUsageUpdateListener = null
  cursorRecordsForwarder = null
  automaticScanAdmissionOpen = true
  externalUsageSnapshotPath = null
  snapshotHydrated = false
  snapshotHydrationInFlight = null
}

export async function getExternalUsageCached(
  options: ExternalProviderActivityOptions & { maxAgeMs?: number } = {}
): Promise<UsageRecord[]> {
  const maxAgeMs = options.maxAgeMs ?? EXTERNAL_USAGE_CACHE_MAX_AGE_MS
  const now = Date.now()
  const cached = externalUsageCache
  if (cached && now - cached.scannedAt < maxAgeMs && options.force !== true) {
    return cached.records
  }

  const force = options.force === true || options.maxAgeMs === 0
  if (!force && !automaticScanAdmissionOpen) return cached?.records ?? []
  // Stale-while-revalidate with a deliberately non-blocking cold path. A
  // renderer must never wait for disk-history hydration: kick the worker and
  // show empty stats until its pushed cache upgrade arrives.
  startExternalScan(options, force)
  return cached?.records ?? []
}

/** Kick off a background external-usage hydrate at app launch. The worker
 * owns every provider scan, including Cursor's incremental cache work. */
export function prewarmExternalUsageCache(): void {
  void hydrateConfiguredExternalUsageSnapshot().finally(() => {
    automaticScanAdmissionOpen = true
    // The snapshot makes first paint immediate, but launch should still
    // revalidate provider files incrementally. A 1ms age bound requests that
    // refresh without the stronger `force` semantics (which reset Cursor's
    // own incremental path when maxAgeMs is exactly zero).
    void getExternalUsageCached({ maxAgeMs: 1 })
  })
}

function resolveExternalFileCachePath(override?: string): string {
  if (override) return override
  return join(app.getPath('userData'), EXTERNAL_FILE_CACHE_FILENAME)
}

function resolveExternalUsageSnapshotPath(): string {
  return join(app.getPath('userData'), EXTERNAL_USAGE_SNAPSHOT_FILENAME)
}

/** Default persisted-cache locations. Resolved in MAIN (the utility process
 * has no `app`); the worker driver stamps these into every scan request so
 * the worker never touches electron APIs. */
export function defaultExternalActivityCachePaths(): {
  externalFileCachePath: string
  cursorCachePath: string
  externalUsageSnapshotPath: string
} {
  return {
    externalFileCachePath: resolveExternalFileCachePath(),
    cursorCachePath: resolveCursorExternalCachePath(),
    externalUsageSnapshotPath: resolveExternalUsageSnapshotPath()
  }
}

/** Serve a file's parsed events from the per-file cache when its mtime+size
 * are unchanged; otherwise parse and cache. Parse failures are not cached so
 * a transient error retries on the next scan.
 *
 * SCHEMA LANDMINE: cached events are keyed only by (provider, path, mtime,
 * size). If you change what any parse*File fn emits (new fields, changed
 * semantics), bump EXTERNAL_ACTIVITY_FILE_CACHE_VERSION or existing installs
 * will serve old-shape events until files churn. */
async function readFileEventsThroughCache(
  provider: ExternalActivityProvider,
  file: CollectedSessionFile,
  parse: () => Promise<ExternalUsageEvent[]>
): Promise<ExternalUsageEvent[]> {
  await yieldScanSlice()
  const cached = getCachedExternalFileEvents(provider, file.path, file.mtimeMs, file.size)
  if (cached) return cached as ExternalUsageEvent[]
  let events: ExternalUsageEvent[]
  try {
    events = await parse()
  } catch {
    return []
  }
  setCachedExternalFileEvents(provider, file.path, file.mtimeMs, file.size, events)
  return events
}

export async function loadExternalProviderUsageRecords(
  options: ExternalProviderActivityOptions = {}
): Promise<UsageRecord[]> {
  const homeDir = options.homeDir || os.homedir()
  const now = options.now || new Date()
  const lookbackDays = options.lookbackDays || DEFAULT_LOOKBACK_DAYS
  const sinceMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000

  const fileCachePath = resolveExternalFileCachePath(options.externalFileCachePath)
  await ensureExternalActivityFileCacheLoaded(fileCachePath)

  const readers: Array<
    (homeDir: string, sinceMs: number, nowMs: number) => Promise<UsageRecord[]>
  > = [
    readCodexActivity,
    readClaudeActivity,
    readGeminiActivity,
    readKimiActivity,
    readGrokActivity,
    (homeDir: string, sinceMs: number, nowMs: number) =>
      readCursorActivity(homeDir, sinceMs, nowMs, options)
  ]
  // Persist as each provider lands, not only once all of them have.
  //
  // A cold-cache scan runs for minutes; persisting only at the end meant
  // quitting mid-scan threw away every file parsed so far, so the next launch
  // redid the whole walk — and a user who quits during launch never escapes
  // that loop. Checkpointing per provider makes progress durable.
  //
  // CRITICAL: providers MUST run serially for checkpoint persists. The file
  // cache module clears `dirty` at the end of every persist. Under Promise.all,
  // one provider's setCached(dirty=true) can race another provider's in-flight
  // persist which then sets dirty=false — the waiting provider's checkpoint
  // no-ops and its entries never reach disk. Linux CI then fails "persists
  // across process restarts" (codex totalTokens undefined) after
  // resetExternalActivityFileCacheForTests(). Serial read+checkpoint avoids
  // that wipe race without changing ExternalActivityFileCache.
  const nested: UsageRecord[][] = []
  for (const reader of readers) {
    nested.push(await safeRead(reader, homeDir, sinceMs, now.getTime()))
    await persistExternalActivityFileCacheIfDirty(fileCachePath)
  }
  // Collapse per-turn records into wall-clock buckets BEFORE they leave the
  // scan. Each provider already feeds a streaming accumulator so `nested`
  // contains only compact buckets; this final idempotent fold merges buckets
  // that happen to meet across reader seams.
  return aggregateExternalUsageRecords(nested.flat(), now.getTime())
}

async function safeRead(
  reader: (homeDir: string, sinceMs: number, nowMs: number) => Promise<UsageRecord[]>,
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  try {
    return await reader(homeDir, sinceMs, nowMs)
  } catch {
    return []
  }
}

function addExternalUsageEvent(
  accumulator: ExternalUsageBucketAccumulator,
  event: ExternalUsageEvent
): void {
  const record = eventToUsageRecord(event)
  if (record) accumulator.add(record)
}

function eventToUsageRecord(event: ExternalUsageEvent): UsageRecord | null {
  if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) return null
  const totalTokens = Math.max(0, Math.round(event.totalTokens || 0))
  const inputTokens = Math.max(0, Math.round(event.inputTokens || 0))
  const cacheReadInputTokens = Math.max(0, Math.round(event.cacheReadInputTokens || 0))
  const cacheCreationInputTokens = Math.max(0, Math.round(event.cacheCreationInputTokens || 0))
  const outputTokens = Math.max(
    0,
    Math.round(
      event.outputTokens ??
        totalTokens - inputTokens - cacheReadInputTokens - cacheCreationInputTokens
    )
  )
  const costRateModel = String(event.costRateModel || '').trim()
  const id = `external-${event.provider}-${stableHash(
    `${event.timestamp}|${event.model}|${totalTokens}|${event.sourceKey}`
  )}`
  return {
    id,
    provider: event.provider,
    timestamp: event.timestamp,
    workspaceId: 'external',
    chatId: `external-${event.provider}`,
    runId: `external-${event.provider}`,
    usageKind: 'run',
    model: event.model || event.provider,
    ...(costRateModel ? { costRateModel } : {}),
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    durationMs: 0,
    ...(Number.isFinite(event.runCount) && Number(event.runCount) > 1
      ? { runCount: Math.trunc(Number(event.runCount)) }
      : {})
  }
}

function extractCodexSessionModel(json: Record<string, unknown>): string | null {
  const topType = typeof json.type === 'string' ? json.type : ''
  const payload = json.payload
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (topType !== 'turn_context' && record.type !== 'turn_context') return null

  const direct = typeof record.model === 'string' ? record.model.trim() : ''
  if (direct) return direct

  const collaboration = record.collaboration_mode
  if (collaboration && typeof collaboration === 'object') {
    const settings = (collaboration as Record<string, unknown>).settings
    if (settings && typeof settings === 'object') {
      const settingsRecord = settings as Record<string, unknown>
      const settingsModel = settingsRecord.model
      const nested = typeof settingsModel === 'string' ? settingsModel.trim() : ''
      if (nested) return nested
    }
  }
  return null
}

async function readCodexActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  const codexRoot = join(homeDir, '.codex')
  // A newest-file cap silently drops still-in-window sessions once enough
  // newer ones exist, which makes long-window totals move backwards: a 90-day
  // window spans ~3.8k rollouts here, so a 2.4k cap discarded the oldest ~1.4k
  // outright. Keep the time window and let the per-file cache absorb the walk,
  // exactly as Claude does below.
  const files = [
    ...(await collectFiles(
      join(codexRoot, 'sessions'),
      (path) => path.endsWith('.jsonl'),
      sinceMs,
      null
    )),
    ...(await collectFiles(
      join(codexRoot, 'archived_sessions'),
      (path) => path.endsWith('.jsonl'),
      sinceMs,
      null
    ))
  ]
  pruneExternalActivityFileCache('codex', new Set(files.map((file) => file.path)))
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('codex', file, () =>
      parseCodexSessionFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp >= sinceMs) addExternalUsageEvent(accumulator, event)
    }
  }
  for (const event of await readCodexSessionIndexActivity(codexRoot, sinceMs)) {
    addExternalUsageEvent(accumulator, event)
  }
  for (const event of await readCodexSqliteActivity(codexRoot, sinceMs)) {
    addExternalUsageEvent(accumulator, event)
  }
  return accumulator.finish()
}

/** Parse one Codex session file into events. No window filtering here — the
 * result is cached per file and filtered by the caller's sinceMs. */
async function parseCodexSessionFile(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  let sessionModel = ''
  // Codex reports `total_token_usage` as a CUMULATIVE session running total and
  // `last_token_usage` as that turn's delta. Two traps follow. ~16% of
  // token_count events re-emit an unchanged cumulative total, so summing the
  // deltas blind double-counts those turns; and a forked session inherits its
  // parent's cumulative baseline, so the first event's cumulative is NOT its
  // own spend. Tracking the cumulative advance between consecutive events
  // corrects both: it identifies repeats (no advance) while leaving the first
  // event of a fork to be measured by its own delta.
  let previousCumulative: number | null = null
  for await (const { json, lineIndex } of parseJsonLineFile(filePath, isCodexActivityLine)) {
    const payload =
      json?.payload && typeof json.payload === 'object'
        ? (json.payload as Record<string, unknown>)
        : {}
    if (
      (json?.type === 'session_meta' || payload.type === 'session_meta') &&
      isTaskWraithCodexRolloutOriginator(payload.originator)
    ) {
      // Shared-home TaskWraith rollouts are legacy copies after the private
      // CODEX_HOME cutover. Settings adds TaskWraith's durable usage journal
      // explicitly, so treating these as external would double-count them.
      return []
    }
    const turnModel = extractCodexSessionModel(json)
    if (turnModel) sessionModel = turnModel
    if (json?.payload?.type !== 'token_count') continue
    const timestamp = parseTimestamp(json.timestamp)
    if (!timestamp) continue

    const info = json.payload?.info
    const cumulative = numberValue(info?.total_token_usage?.total_tokens)
    const advance = previousCumulative === null ? null : cumulative - previousCumulative
    if (cumulative > 0) previousCumulative = cumulative
    // No advance means this event restates a turn already counted.
    if (advance !== null && advance <= 0 && cumulative > 0) continue

    const usage = info?.last_token_usage
    if (!usage || typeof usage !== 'object') {
      // No per-turn breakdown on this event. Fall back to the cumulative
      // ADVANCE, never the cumulative total itself — the old fallback summed a
      // whole-session running total as though it were a single turn.
      if (advance !== null && advance > 0) {
        events.push({
          provider: 'codex',
          timestamp,
          model: sessionModel || 'codex',
          totalTokens: advance,
          sourceKey: `${filePath}:${lineIndex}`
        })
      }
      continue
    }
    const reportedInputTokens = numberValue(usage?.input_tokens)
    // Codex/OpenAI reports cached tokens as a subset of input_tokens. The two
    // cache-read keys are aliases seen across CLI versions, not additive
    // counters, so take the larger rather than double-counting both.
    const reportedCacheReadInputTokens = Math.max(
      numberValue(usage?.cache_read_input_tokens),
      numberValue(usage?.cached_input_tokens)
    )
    const cacheReadInputTokens = Math.min(reportedInputTokens, reportedCacheReadInputTokens)
    const cacheCreationInputTokens = Math.min(
      Math.max(0, reportedInputTokens - cacheReadInputTokens),
      numberValue(usage?.cache_creation_input_tokens)
    )
    const inputTokens = Math.max(
      0,
      reportedInputTokens - cacheReadInputTokens - cacheCreationInputTokens
    )
    // reasoning_output_tokens is a subset of output_tokens in Codex rollout
    // records, so output_tokens is already the inclusive output count.
    const outputTokens = numberValue(usage?.output_tokens)
    const totalTokens = tokenTotal(usage, reportedInputTokens, outputTokens)
    if (totalTokens <= 0) continue
    events.push({
      provider: 'codex',
      timestamp,
      model: sessionModel || 'codex',
      totalTokens,
      inputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      sourceKey: `${filePath}:${lineIndex}`
    })
  }
  return events
}

async function readClaudeActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  const root = join(homeDir, '.claude', 'projects')
  const files = await collectFiles(
    root,
    (path) => path.endsWith('.jsonl'),
    sinceMs,
    // Claude keeps one JSONL per session. A newest-file cap silently drops
    // still-in-window high-token sessions once enough newer chats exist, which
    // makes 90-day totals move backwards. Keep the time window, but do not
    // pre-truncate source files for Claude.
    null
  )
  pruneExternalActivityFileCache('claude', new Set(files.map((file) => file.path)))
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  const seen = new Set<string>()
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('claude', file, () =>
      parseClaudeSessionFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp < sinceMs) continue
      if (event.dedupeKey) {
        if (seen.has(event.dedupeKey)) continue
        seen.add(event.dedupeKey)
      }
      addExternalUsageEvent(accumulator, event)
    }
  }
  return accumulator.finish()
}

/** Parse one Claude session file into events. No window filtering or
 * cross-file dedupe here — events carry their dedupeKey and are cached per
 * file; the caller filters and dedupes at assembly time. */
async function parseClaudeSessionFile(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  for await (const { json, lineIndex } of parseJsonLineFile(filePath)) {
    const timestamp = parseTimestamp(json?.timestamp)
    if (!timestamp) continue
    const usage = json?.usage || json?.message?.usage
    if (!usage || typeof usage !== 'object') continue
    const inputTokens = numberValue(usage.input_tokens) + numberValue(usage.input_audio_tokens)
    const cacheReadInputTokens = numberValue(usage.cache_read_input_tokens)
    const cacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens)
    const outputTokens = numberValue(usage.output_tokens) + numberValue(usage.output_audio_tokens)
    const totalTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens
    if (totalTokens <= 0) continue
    const messageId = String(json?.message?.id || '')
    const requestId = String(json?.requestId || json?.request_id || '')
    // One assistant message spanning several content blocks is written as one
    // row per block, and every row repeats the SAME usage object — 12 rows for
    // a 12-tool-call turn, each restating the whole turn's tokens. requestId +
    // messageId identifies the single API call behind them; timestamp must
    // stay OUT of the key, because those rows differ by sub-second write time
    // and including it defeated the dedupe entirely (~2.2x over-count).
    // Rows carrying neither id fall back to the line itself, which dedupes
    // only across the resume/fork copies of one transcript.
    const callIdentity = requestId || messageId ? `${requestId}|${messageId}` : `line:${lineIndex}`
    events.push({
      provider: 'claude',
      timestamp,
      model: String(json?.message?.model || json?.model || 'Claude'),
      inputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens,
      sourceKey: `${filePath}:${lineIndex}`,
      dedupeKey: `${callIdentity}|${totalTokens}`
    })
  }
  return events
}

async function readGeminiActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  const root = join(homeDir, '.gemini', 'tmp')
  const files = await collectFiles(
    root,
    (path) => isGeminiSessionActivityPath(path),
    sinceMs,
    MAX_GEMINI_SESSION_FILES
  )
  pruneExternalActivityFileCache('gemini', new Set(files.map((file) => file.path)))
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  const seen = new Set<string>()
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('gemini', file, () =>
      parseGeminiSessionFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp < sinceMs) continue
      if (event.dedupeKey) {
        if (seen.has(event.dedupeKey)) continue
        seen.add(event.dedupeKey)
      }
      addExternalUsageEvent(accumulator, event)
    }
  }
  return accumulator.finish()
}

/** Parse one Gemini session file into events. Keeps the 128MB tail cap —
 * legacy Gemini sessions are single big JSON documents, so a smaller cap
 * would head-truncate and silently drop the whole file's usage. */
async function parseGeminiSessionFile(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  const text = await readTextTail(filePath, MAX_EXPANDED_SESSION_TEXT_BYTES)
  const entries = parseGeminiSessionEntries(text)
  for (const { json, sourceIndex } of entries) {
    const timestamp = parseTimestamp(json?.timestamp)
    if (!timestamp) continue
    const tokens = json?.tokens
    if (!tokens || typeof tokens !== 'object') continue
    const inputTokens = numberValue(tokens.input)
    const outputTokens = numberValue(tokens.output)
    const totalTokens = inputTokens + outputTokens || numberValue(tokens.total)
    if (totalTokens <= 0) continue
    events.push({
      provider: 'gemini',
      timestamp,
      model: String(json?.model || 'Gemini'),
      inputTokens,
      outputTokens: outputTokens || Math.max(0, totalTokens - inputTokens),
      totalTokens,
      sourceKey: `${filePath}:${sourceIndex}`,
      dedupeKey: `${json?.id || ''}|${timestamp}|${totalTokens}`
    })
  }
  return events
}

async function readCodexSessionIndexActivity(
  codexRoot: string,
  sinceMs: number
): Promise<ExternalUsageEvent[]> {
  const indexPath = join(codexRoot, 'session_index.jsonl')
  try {
    await fs.access(indexPath)
  } catch {
    return []
  }

  const events: ExternalUsageEvent[] = []
  const text = await readTextTail(indexPath)
  let lineIndex = 0
  for (const json of parseJsonLines(text)) {
    lineIndex += 1
    const timestamp =
      parseTimestamp(json?.updated_at) ||
      parseTimestamp(json?.updatedAt) ||
      parseTimestamp(json?.timestamp) ||
      parseTimestamp(json?.created_at) ||
      parseTimestamp(json?.createdAt)
    if (!timestamp || timestamp < sinceMs) continue
    events.push({
      provider: 'codex',
      timestamp,
      model: 'Codex',
      totalTokens: 0,
      sourceKey: `${indexPath}:${lineIndex}`
    })
  }
  return events
}

async function readCodexSqliteActivity(
  codexRoot: string,
  sinceMs: number
): Promise<ExternalUsageEvent[]> {
  const dbPath = join(codexRoot, 'logs_2.sqlite')
  try {
    await fs.access(dbPath)
  } catch {
    return []
  }

  const cutoffSeconds = Math.floor(sinceMs / 1000)
  const query = [
    'SELECT (ts / 7200) * 7200 AS bucket_ts, COUNT(*) AS event_count FROM logs',
    `WHERE ts >= ${cutoffSeconds}`,
    'GROUP BY bucket_ts ORDER BY bucket_ts ASC;'
  ].join(' ')
  const rows = await runSqliteQuery(dbPath, query)
  const events: ExternalUsageEvent[] = []
  for (const row of rows) {
    const [bucketRaw, countRaw] = row.split('|')
    const bucketSeconds = Number(bucketRaw)
    const eventCount = Number(countRaw)
    if (!Number.isFinite(bucketSeconds) || !Number.isFinite(eventCount)) continue
    const markerCount = Math.min(
      MAX_CODEX_SQLITE_MARKERS_PER_BUCKET,
      Math.max(1, Math.ceil(Math.log2(Math.max(1, eventCount) + 1)))
    )
    const spacingSeconds = 7200 / (markerCount + 1)
    for (let index = 0; index < markerCount; index += 1) {
      const timestamp = (bucketSeconds + spacingSeconds * (index + 1)) * 1000
      if (timestamp < sinceMs) continue
      events.push({
        provider: 'codex',
        timestamp,
        model: 'Codex',
        totalTokens: 0,
        sourceKey: `codex-sqlite:${bucketSeconds}:${index}`
      })
    }
  }
  return events
}

// The kimi-cli → Kimi Code migration (2026-07) moved sessions to
// ~/.kimi-code/sessions/wd_*/ses_*/agents/main/wire.jsonl AND dropped the
// per-turn `StatusUpdate.payload.token_usage` records the legacy parser keys
// off — a scan of the migrated tree confirms kimi-code writes NO structured
// token usage to disk. So the new root would yield zero usage events and is not
// scanned here; the AUTHORITATIVE Kimi usage source is the live
// api.kimi.com/coding/v1/usages endpoint (fetchKimiUsageSnapshot), which the
// credential-path fix in ProviderAuthUsage now reaches. This reader stays on
// the legacy ~/.kimi/sessions root purely to surface any pre-migration
// StatusUpdate history that still parses; it is not the live meter.
async function readKimiActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  const root = join(homeDir, '.kimi', 'sessions')
  const files = await collectFiles(root, isKimiWireActivityPath, sinceMs)
  pruneExternalActivityFileCache('kimi', new Set(files.map((file) => file.path)))
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('kimi', file, () =>
      parseKimiWireFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp >= sinceMs) addExternalUsageEvent(accumulator, event)
    }
  }
  return accumulator.finish()
}

/** Parse one Kimi wire file into events. No window filtering here — cached
 * per file and filtered by the caller's sinceMs. */
async function parseKimiWireFile(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  const text = await readTextTail(filePath)
  let lineIndex = 0
  for (const json of parseJsonLines(text)) {
    lineIndex += 1
    const timestamp = parseTimestamp(json?.timestamp)
    if (!timestamp) continue
    const message = json?.message
    if (message?.type !== 'StatusUpdate') continue
    const usage = message?.payload?.token_usage
    const inputTokens = numberValue(usage?.input_other)
    const cacheReadInputTokens = numberValue(usage?.input_cache_read)
    const cacheCreationInputTokens = numberValue(usage?.input_cache_creation)
    const outputTokens = numberValue(usage?.output)
    const totalTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens
    if (totalTokens <= 0) continue
    events.push({
      provider: 'kimi',
      timestamp,
      model: 'Kimi',
      inputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      outputTokens,
      totalTokens,
      sourceKey: `${filePath}:${lineIndex}`
    })
  }
  return events
}

/** Grok CLI writes no per-session usage file. Its only on-disk record of token
 * spend is a single append-only log, `~/.grok/logs/unified.jsonl`, where each
 * completed turn emits a `shell.turn.inference_done` line carrying that turn's
 * counts. The chip existed here long before this reader did, so Grok read as a
 * flat zero rather than as "not measurable". */
async function readGrokActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number
): Promise<UsageRecord[]> {
  const logPath = join(homeDir, '.grok', 'logs', 'unified.jsonl')
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(logPath)
  } catch {
    return []
  }
  if (!stat.isFile()) return []

  pruneExternalActivityFileCache('grok', new Set([logPath]))
  const events = await readFileEventsThroughCache(
    'grok',
    { path: logPath, mtimeMs: stat.mtimeMs, size: stat.size },
    () => parseGrokUnifiedLog(logPath)
  )
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  for (const event of events) {
    if (event.timestamp >= sinceMs) addExternalUsageEvent(accumulator, event)
  }
  return accumulator.finish()
}

/** Lines that can carry Grok activity: the turn records themselves, plus the
 * model-catalog lines that name the model in play. The log is dominated by auth
 * and catalog chatter that can never contribute. */
function isGrokActivityLine(line: string): boolean {
  return line.includes('"prompt_tokens"') || line.includes('"current_model_id"')
}

async function parseGrokUnifiedLog(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  // The turn record names no model; the catalog line preceding it does. Track
  // the last one seen, exactly as the Codex parser tracks `turn_context`.
  let sessionModel = ''
  for await (const { json, lineIndex } of parseJsonLineFile(filePath, isGrokActivityLine)) {
    const context = json?.ctx
    if (!context || typeof context !== 'object') continue

    const currentModel =
      typeof context.current_model_id === 'string' ? context.current_model_id.trim() : ''
    if (currentModel) sessionModel = currentModel
    if (context.prompt_tokens === undefined) continue

    const timestamp = parseTimestamp(json.ts)
    if (!timestamp) continue

    // `cached_prompt_tokens` is a SUBSET of `prompt_tokens`, and
    // `reasoning_tokens` a subset of `completion_tokens` — the same convention
    // Codex uses. Verified across this machine's log with zero violations.
    // Adding either on top of its parent would double-count.
    const promptTokens = numberValue(context.prompt_tokens)
    const cacheReadInputTokens = Math.min(promptTokens, numberValue(context.cached_prompt_tokens))
    const inputTokens = Math.max(0, promptTokens - cacheReadInputTokens)
    const outputTokens = numberValue(context.completion_tokens)
    const totalTokens = promptTokens + outputTokens
    if (totalTokens <= 0) continue

    events.push({
      provider: 'grok',
      timestamp,
      model: sessionModel || 'grok',
      totalTokens,
      inputTokens,
      cacheReadInputTokens,
      outputTokens,
      sourceKey: `${filePath}:${lineIndex}`
    })
  }
  return events
}

async function readCursorActivity(
  homeDir: string,
  sinceMs: number,
  nowMs: number,
  options: ExternalProviderActivityOptions = {}
): Promise<UsageRecord[]> {
  ensureCursorCacheListener()
  const force = options.force === true
  const cursorOptions = {
    homeDir,
    sinceMs,
    cachePath: resolveCursorExternalCachePath(options.cursorCachePath),
    force,
    // A utility process owns the external scan, so drain Cursor's bounded
    // transcript set there rather than scheduling a second catch-up on main.
    transcriptParseBudget: cursorRecordsForwarder
      ? 400
      : force
        ? 400
        : CURSOR_TRANSCRIPT_CHUNK_SIZE * 2
  }
  const events = await loadCursorIdeUsageEvents(cursorOptions)
  const accumulator = new ExternalUsageBucketAccumulator(nowMs)
  for (const event of events) addExternalUsageEvent(accumulator, event)
  return accumulator.finish()
}

async function runSqliteQuery(dbPath: string, query: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/sqlite3',
      ['-readonly', dbPath, query],
      { timeout: 8_000 },
      (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        resolve(
          String(stdout || '')
            .split(/\r?\n/)
            .filter(Boolean)
        )
      }
    )
  })
}

async function collectFiles(
  root: string,
  accepts: (path: string) => boolean,
  sinceMs: number,
  maxFiles: number | null = MAX_FILES_PER_PROVIDER
): Promise<CollectedSessionFile[]> {
  try {
    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const files: CollectedSessionFile[] = []
  const stack = [root]
  let visited = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile() || !accepts(entryPath)) continue
      try {
        const stat = await fs.stat(entryPath)
        if (stat.mtimeMs < sinceMs) continue
        files.push({ path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch {
        continue
      }
      visited += 1
      if (visited % SCAN_CLOCK_CHECK_FILES === 0) await yieldScanSlice()
    }
  }
  const sorted = files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return maxFiles === null ? sorted : sorted.slice(0, maxFiles)
}

async function readTextTail(filePath: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) text = text.slice(firstNewline + 1)
    }
    return text
  } finally {
    await handle.close()
  }
}

function parseJsonLines(text: string): any[] {
  const parsed: any[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('{$set')) continue
    try {
      parsed.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return parsed
}

/** Lines that can carry Codex activity: the token_count events themselves and
 * the turn_context records that name the model. Reasoning, tool calls and
 * message bodies are the overwhelming bulk of a rollout's bytes and can never
 * contribute, so this keeps a full-file scan affordable without truncating. */
function isCodexActivityLine(line: string): boolean {
  return (
    line.includes('"session_meta"') ||
    line.includes('"token_count"') ||
    line.includes('"turn_context"')
  )
}

async function* parseJsonLineFile(
  filePath: string,
  lineFilter?: (line: string) => boolean
): AsyncGenerator<{ json: any; lineIndex: number }> {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineIndex = 0
  try {
    for await (const line of lines) {
      lineIndex += 1
      // Every byte of the Codex + Claude corpus passes through here, so this
      // is the one place a duty-cycle check covers the whole scan. readline
      // hands back buffered lines as already-resolved promises, which only
      // drains microtasks — without this the loop can run for a whole chunk
      // without ever letting an IPC reply through.
      if (lineIndex % SCAN_CLOCK_CHECK_LINES === 0) await yieldScanSlice()
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('{$set')) continue
      if (lineFilter && !lineFilter(trimmed)) continue
      try {
        yield { json: JSON.parse(trimmed), lineIndex }
      } catch {
        continue
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function parseGeminiSessionEntries(text: string): Array<{ json: any; sourceIndex: number }> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed?.messages)) {
        return parsed.messages.map((json: any, index: number) => ({
          json,
          sourceIndex: index + 1
        }))
      }
      if (parsed?.tokens && typeof parsed.tokens === 'object') {
        return [{ json: parsed, sourceIndex: 1 }]
      }
    } catch {
      // Modern Gemini sessions are JSONL, so fall through to line parsing.
    }
  }

  const entries: Array<{ json: any; sourceIndex: number }> = []
  let lineIndex = 0
  for (const line of text.split(/\r?\n/)) {
    lineIndex += 1
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('{$set')) continue
    try {
      entries.push({ json: JSON.parse(trimmedLine), sourceIndex: lineIndex })
    } catch {
      continue
    }
  }
  return entries
}

function isGeminiSessionActivityPath(path: string): boolean {
  return /\/chats\/.+\.jsonl?$/.test(toPortablePath(path))
}

function isKimiWireActivityPath(path: string): boolean {
  return toPortablePath(path).endsWith('/wire.jsonl')
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function tokenTotal(usage: any, reportedInputTokens: number, outputTokens: number): number {
  if (!usage || typeof usage !== 'object') return 0
  const direct = numberValue(usage.total_tokens) || numberValue(usage.totalTokens)
  if (direct > 0) return direct
  return reportedInputTokens + outputTokens
}

function numberValue(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16)
}
