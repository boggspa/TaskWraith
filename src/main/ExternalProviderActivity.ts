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
  loadCursorIdeUsageEvents,
  prewarmCursorIdeUsageCache,
  setCursorExternalActivityUpdateListener
} from './cursor/CursorExternalActivity'
import { CURSOR_TRANSCRIPT_CHUNK_SIZE } from './cursor/CursorExternalActivityCache'
import {
  ensureExternalActivityFileCacheLoaded,
  getCachedExternalFileEvents,
  persistExternalActivityFileCacheIfDirty,
  pruneExternalActivityFileCache,
  setCachedExternalFileEvents
} from './ExternalActivityFileCache'

type ExternalActivityProvider = Extract<
  ProviderId,
  'codex' | 'claude' | 'gemini' | 'kimi' | 'cursor'
>

interface ExternalProviderActivityOptions {
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

interface ExternalUsageEvent {
  provider: ExternalActivityProvider
  timestamp: number
  model: string
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  sourceKey: string
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
const MAX_CODEX_SESSION_FILES = 2_400
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

export interface ExternalUsageRollup {
  providers: Array<{ provider: string; h24: number; d7: number; d90: number }>
  totals: { h24: number; d7: number; d90: number }
}

/** Token totals per provider for the 24h/7d/90d chips — computed off the
 * cached usage records so paired devices get the same numbers the desktop
 * External Activity header shows. */
export function buildExternalUsageRollup(
  records: UsageRecord[],
  now: number = Date.now()
): ExternalUsageRollup {
  const h24 = now - 24 * 60 * 60 * 1000
  const d7 = now - 7 * 24 * 60 * 60 * 1000
  const d90 = now - 90 * 24 * 60 * 60 * 1000
  const byProvider = new Map<string, { h24: number; d7: number; d90: number }>()
  const totals = { h24: 0, d7: 0, d90: 0 }
  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    const tokens =
      record.totalTokens ||
      record.inputTokens +
        (record.cacheReadInputTokens || 0) +
        (record.cacheCreationInputTokens || 0) +
        record.outputTokens ||
      0
    if (!tokens || !Number.isFinite(record.timestamp)) continue
    const key = record.provider ?? 'unknown'
    const bucket = byProvider.get(key) ?? { h24: 0, d7: 0, d90: 0 }
    if (record.timestamp >= d90) {
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
let externalUsageInFlight: Promise<UsageRecord[]> | null = null
let cursorCacheListenerInstalled = false

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

function replaceCachedCursorExternalRecords(
  cursorEvents: Array<{
    provider: 'cursor'
    timestamp: number
    model: string
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

  if (!externalUsageCache) {
    externalUsageCache = { records: cursorRecords, scannedAt: Date.now() }
    return
  }

  const other = externalUsageCache.records.filter((record) => record.provider !== 'cursor')
  externalUsageCache.records = [...other, ...cursorRecords].sort(
    (a, b) => b.timestamp - a.timestamp
  )
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
  const refresh = (externalUsageInFlight ??= loadExternalProviderUsageRecords({
    ...options,
    force: options.force === true || options.maxAgeMs === 0
  })
    .then((records) => {
      externalUsageCache = { records, scannedAt: Date.now() }
      return records
    })
    .finally(() => {
      externalUsageInFlight = null
    }))
  // Stale-while-revalidate: a stale cache answers instantly while the
  // rescan proceeds; only a COLD cache awaits the scan.
  if (cached && options.force !== true && options.maxAgeMs !== 0) return cached.records
  return refresh
}

/** Kick off a background external-usage hydrate at app launch. Cursor IDE
 * scans are incremental + chunked; other providers use the in-memory cache. */
export function prewarmExternalUsageCache(): void {
  ensureCursorCacheListener()
  const homeDir = os.homedir()
  const sinceMs = Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  prewarmCursorIdeUsageCache({
    homeDir,
    sinceMs,
    cachePath: resolveCursorExternalCachePath(),
    transcriptParseBudget: CURSOR_TRANSCRIPT_CHUNK_SIZE * 2
  })
  void getExternalUsageCached()
}

function resolveExternalFileCachePath(override?: string): string {
  if (override) return override
  return join(app.getPath('userData'), EXTERNAL_FILE_CACHE_FILENAME)
}

/** Serve a file's parsed events from the per-file cache when its mtime+size
 * are unchanged; otherwise parse and cache. Parse failures are not cached so
 * a transient error retries on the next scan.
 *
 * SCHEMA LANDMINE: cached events are opaque JSON keyed only by
 * (provider, path, mtime, size). If you change what any parse*File fn emits
 * (new fields, changed semantics), bump EXTERNAL_ACTIVITY_FILE_CACHE_VERSION
 * or existing installs will serve old-shape events until files churn. */
async function readFileEventsThroughCache(
  provider: ExternalActivityProvider,
  file: CollectedSessionFile,
  parse: () => Promise<ExternalUsageEvent[]>
): Promise<ExternalUsageEvent[]> {
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

  const readers = [
    readCodexActivity,
    readClaudeActivity,
    readGeminiActivity,
    readKimiActivity,
    (homeDir: string, sinceMs: number) => readCursorActivity(homeDir, sinceMs, options)
  ]
  const nested = await Promise.all(readers.map((reader) => safeRead(reader, homeDir, sinceMs)))
  await persistExternalActivityFileCacheIfDirty(fileCachePath)
  const byId = new Map<string, UsageRecord>()
  for (const event of nested.flat()) {
    const record = eventToUsageRecord(event)
    if (record) byId.set(record.id, record)
  }
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp)
}

async function safeRead(
  reader: (homeDir: string, sinceMs: number) => Promise<ExternalUsageEvent[]>,
  homeDir: string,
  sinceMs: number
): Promise<ExternalUsageEvent[]> {
  try {
    return await reader(homeDir, sinceMs)
  } catch {
    return []
  }
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
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    durationMs: 0
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

async function readCodexActivity(homeDir: string, sinceMs: number): Promise<ExternalUsageEvent[]> {
  const codexRoot = join(homeDir, '.codex')
  const files = [
    ...(await collectFiles(
      join(codexRoot, 'sessions'),
      (path) => path.endsWith('.jsonl'),
      sinceMs,
      MAX_CODEX_SESSION_FILES
    )),
    ...(await collectFiles(
      join(codexRoot, 'archived_sessions'),
      (path) => path.endsWith('.jsonl'),
      sinceMs,
      MAX_CODEX_SESSION_FILES
    ))
  ]
  pruneExternalActivityFileCache('codex', new Set(files.map((file) => file.path)))
  const events: ExternalUsageEvent[] = []
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('codex', file, () =>
      parseCodexSessionFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp >= sinceMs) events.push(event)
    }
  }
  events.push(...(await readCodexSessionIndexActivity(codexRoot, sinceMs)))
  events.push(...(await readCodexSqliteActivity(codexRoot, sinceMs)))
  return events
}

/** Parse one Codex session file into events. No window filtering here — the
 * result is cached per file and filtered by the caller's sinceMs. */
async function parseCodexSessionFile(filePath: string): Promise<ExternalUsageEvent[]> {
  const events: ExternalUsageEvent[] = []
  const text = await readTextTail(filePath)
  let lineIndex = 0
  let sessionModel = ''
  for (const json of parseJsonLines(text)) {
    lineIndex += 1
    const turnModel = extractCodexSessionModel(json)
    if (turnModel) sessionModel = turnModel
    if (json?.payload?.type !== 'token_count') continue
    const timestamp = parseTimestamp(json.timestamp)
    if (!timestamp) continue
    const usage = json.payload?.info?.last_token_usage || json.payload?.info?.total_token_usage
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

async function readClaudeActivity(homeDir: string, sinceMs: number): Promise<ExternalUsageEvent[]> {
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
  const events: ExternalUsageEvent[] = []
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
      events.push(event)
    }
  }
  return events
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
      dedupeKey: `${requestId}|${messageId}|${timestamp}|${totalTokens}`
    })
  }
  return events
}

async function readGeminiActivity(homeDir: string, sinceMs: number): Promise<ExternalUsageEvent[]> {
  const root = join(homeDir, '.gemini', 'tmp')
  const files = await collectFiles(
    root,
    (path) => isGeminiSessionActivityPath(path),
    sinceMs,
    MAX_GEMINI_SESSION_FILES
  )
  pruneExternalActivityFileCache('gemini', new Set(files.map((file) => file.path)))
  const events: ExternalUsageEvent[] = []
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
      events.push(event)
    }
  }
  return events
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

async function readKimiActivity(homeDir: string, sinceMs: number): Promise<ExternalUsageEvent[]> {
  const root = join(homeDir, '.kimi', 'sessions')
  const files = await collectFiles(root, isKimiWireActivityPath, sinceMs)
  pruneExternalActivityFileCache('kimi', new Set(files.map((file) => file.path)))
  const events: ExternalUsageEvent[] = []
  for (const file of files) {
    const fileEvents = await readFileEventsThroughCache('kimi', file, () =>
      parseKimiWireFile(file.path)
    )
    for (const event of fileEvents) {
      if (event.timestamp >= sinceMs) events.push(event)
    }
  }
  return events
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
    const totalTokens =
      inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens
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

async function readCursorActivity(
  homeDir: string,
  sinceMs: number,
  options: ExternalProviderActivityOptions = {}
): Promise<ExternalUsageEvent[]> {
  ensureCursorCacheListener()
  const force = options.force === true
  return loadCursorIdeUsageEvents({
    homeDir,
    sinceMs,
    cachePath: resolveCursorExternalCachePath(options.cursorCachePath),
    force,
    transcriptParseBudget: force ? 400 : CURSOR_TRANSCRIPT_CHUNK_SIZE * 2
  })
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

async function* parseJsonLineFile(
  filePath: string
): AsyncGenerator<{ json: any; lineIndex: number }> {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineIndex = 0
  try {
    for await (const line of lines) {
      lineIndex += 1
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('{$set')) continue
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
