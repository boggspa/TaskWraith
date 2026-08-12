import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { cursorGrokBaseModelId, cursorGrokFastFromModelId } from '../../shared/grok45Models'
import { cursorStateDbCandidates } from './CursorUsage'
import {
  CURSOR_TRANSCRIPT_CHUNK_SIZE,
  cursorModelHintsNeedRefresh,
  cursorSqliteNeedsRescan,
  cursorTranscriptNeedsParsing,
  emptyCursorExternalActivityDiskCache,
  mergeCursorDiskCacheEvents,
  pruneCursorTranscriptCache,
  readCursorExternalActivityDiskCache,
  writeCursorExternalActivityDiskCache,
  type CursorExternalActivityDiskCache
} from './CursorExternalActivityCache'

export interface CursorExternalUsageEvent {
  provider: 'cursor'
  timestamp: number
  model: string
  /** Rate-table identity when display normalization intentionally collapses
   * several concrete Cursor wire ids into one catalogue model. */
  costRateModel?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  sourceKey: string
}

export interface CursorExternalActivityOptions {
  homeDir: string
  sinceMs: number
  /** Persisted incremental cache path (userData). */
  cachePath?: string
  /** Bypass cached transcript/sqlite snapshots and rebuild metadata. */
  force?: boolean
  /** Max transcript files to parse on this pass (chunked catch-up). */
  transcriptParseBudget?: number
  /** Injectable for tests. */
  readTextFile?: (path: string) => Promise<string>
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number }>
  listTranscriptFileStats?: (homeDir: string, sinceMs: number) => Promise<TranscriptFileStat[]>
  querySqlite?: (dbPath: string, query: string) => Promise<string[]>
  now?: number
}

export interface TranscriptFileStat {
  path: string
  mtimeMs: number
  size: number
}

const MAX_TRANSCRIPT_FILES = 400
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024
const BACKGROUND_CHUNK_DELAY_MS = 75
const TOKENS_PER_CHAR = 0.25
/** Rough tokens-per-line fallback when only dailyStats line counts exist. */
const TOKENS_PER_COMPOSER_LINE = 40

const CURSOR_SANDBOX_PROJECT_PREFIXES = ['tmp-', 'private-tmp-', 'var-folders-']

export function normalizeCursorExternalModelId(raw: string | undefined | null): string {
  const trimmed = String(raw || '').trim()
  const key = trimmed.toLowerCase()
  if (!key || key === 'cursor' || key === 'composer') return 'composer-2.5-fast'
  const cursorGrokBase = cursorGrokBaseModelId(key)
  if (cursorGrokBase) return cursorGrokBase
  const cursorGrokLabel = key.match(
    /^(?:cursor[ -])?grok[ -]4\.(5|6)(?:[ -](?:low|medium|high|xhigh|extra[ -]high))?(?:[ -]fast)?$/
  )
  if (cursorGrokLabel) return `grok-4.${cursorGrokLabel[1]}`
  if (
    key === 'cursor grok 4.5' ||
    key === 'cursor-grok-4.5' ||
    key === 'grok 4.5' ||
    key === 'grok-4.5' ||
    key.startsWith('grok-4.5-')
  ) {
    return 'grok-4.5'
  }
  if (key === 'composer 2.5 fast' || key === 'composer-2.5-fast') return 'composer-2.5-fast'
  if (key === 'composer 2.5' || key === 'composer-2.5') return 'composer-2.5'
  if (key.startsWith('composer-')) return key
  if (key.includes('fast')) return 'composer-2.5-fast'
  if (key.includes('composer')) return 'composer-2.5'
  return 'composer-2.5-fast'
}

/** Keep Cursor's concrete billing tier separate from its catalogue display
 * model. Grok 4.6 wire ids all display under `grok-4.6`, while `-fast` ids
 * must continue to resolve against the higher `grok-4.6-fast` rate row. */
export function cursorExternalCostRateModelId(raw: string | undefined | null): string | undefined {
  if (cursorGrokBaseModelId(raw) !== 'grok-4.6') return undefined
  return cursorGrokFastFromModelId(raw) ? 'grok-4.6-fast' : 'grok-4.6'
}

function inferCursorExternalCostRateModelFromText(text: string): string | undefined {
  const wireId = text
    .toLowerCase()
    .match(
      /(?:^|[^a-z0-9-])(cursor-grok-4\.6-(?:low|medium|high|xhigh)(?:-fast)?)(?=$|[^a-z0-9-])/
    )?.[1]
  return cursorExternalCostRateModelId(wireId)
}

export function isCursorSandboxProjectDir(projectDirName: string): boolean {
  const name = projectDirName.replace(/\\/g, '/').split('/').pop() || projectDirName
  return CURSOR_SANDBOX_PROJECT_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function estimateTokensFromText(text: string): number {
  const len = text.length
  if (len <= 0) return 0
  return Math.max(1, Math.round(len * TOKENS_PER_CHAR))
}

export function extractTranscriptMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text)
    }
  }
  return parts.join('\n')
}

export function inferCursorModelFromText(text: string): string {
  const haystack = text.toLowerCase()
  if (
    haystack.includes('cursor grok 4.6') ||
    haystack.includes('cursor-grok-4.6') ||
    haystack.includes('grok 4.6') ||
    haystack.includes('grok-4.6')
  ) {
    return 'grok-4.6'
  }
  if (
    haystack.includes('cursor grok 4.5') ||
    haystack.includes('cursor-grok-4.5') ||
    haystack.includes('grok 4.5') ||
    haystack.includes('grok-4.5')
  ) {
    return 'grok-4.5'
  }
  if (haystack.includes('composer-2.5-fast') || haystack.includes('composer 2.5 fast')) {
    return 'composer-2.5-fast'
  }
  if (haystack.includes('composer-2.5') || haystack.includes('composer 2.5')) {
    return 'composer-2.5'
  }
  return 'composer-2.5-fast'
}

export interface ParsedCursorAgentTranscript {
  composerId: string
  inputTokens: number
  outputTokens: number
  model: string
  costRateModel?: string
  timestamp: number
  sourceKey: string
}

/** Parse one Cursor IDE agent-transcript JSONL file into a single usage event. */
export function parseCursorAgentTranscript(
  filePath: string,
  text: string,
  mtimeMs: number,
  modelHint?: string
): ParsedCursorAgentTranscript | null {
  const normalizedPath = filePath.replace(/\\/g, '/')
  if (normalizedPath.includes('/subagents/')) return null

  const projectDir = normalizedPath.split('/projects/')[1]?.split('/')[0] || ''
  if (projectDir && isCursorSandboxProjectDir(projectDir)) return null

  const composerId =
    normalizedPath.match(/agent-transcripts\/([^/]+)\/[^/]+\.jsonl$/)?.[1] ||
    normalizedPath.match(/agent-transcripts\/([^/]+)\.jsonl$/)?.[1] ||
    'unknown'

  let inputTokens = 0
  let outputTokens = 0
  let model = modelHint ? normalizeCursorExternalModelId(modelHint) : ''
  let costRateModel = cursorExternalCostRateModelId(modelHint)
  let lastTimestamp = 0

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    const role = typeof parsed.role === 'string' ? parsed.role : ''
    if (role !== 'user' && role !== 'assistant') continue

    const message =
      parsed.message && typeof parsed.message === 'object'
        ? (parsed.message as Record<string, unknown>)
        : null
    const contentText = extractTranscriptMessageText(message?.content)
    if (!contentText) continue

    const tokens = estimateTokensFromText(contentText)
    if (role === 'user') inputTokens += tokens
    else outputTokens += tokens

    if (!model) model = inferCursorModelFromText(contentText)
    if (!costRateModel) {
      const inferredCostRateModel = inferCursorExternalCostRateModelFromText(contentText)
      if (inferredCostRateModel) {
        model = 'grok-4.6'
        costRateModel = inferredCostRateModel
      }
    }
    const createdAt = parseTimestamp(message?.createdAt ?? parsed.timestamp)
    if (createdAt && createdAt > lastTimestamp) lastTimestamp = createdAt
  }

  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return null

  return {
    composerId,
    inputTokens,
    outputTokens,
    model: normalizeCursorExternalModelId(model),
    ...(costRateModel ? { costRateModel } : {}),
    timestamp: lastTimestamp > 0 ? lastTimestamp : mtimeMs,
    sourceKey: `cursor-ide-transcript:${composerId}:${normalizedPath}`
  }
}

export function parseCursorDailyStatsValue(
  parsed: Record<string, unknown>,
  sourceKey: string
): CursorExternalUsageEvent | null {
  const timestamp = parseCursorDailyStatTimestamp(parsed)
  if (!timestamp) return null
  const suggested = numberValue(parsed.composerSuggestedLines)
  const accepted = numberValue(parsed.composerAcceptedLines)
  const lines = suggested + accepted
  if (lines <= 0) return null
  const totalTokens = Math.max(1, Math.round(lines * TOKENS_PER_COMPOSER_LINE))
  return {
    provider: 'cursor',
    timestamp,
    model: 'composer-2.5-fast',
    inputTokens: Math.round(totalTokens * 0.35),
    outputTokens: Math.round(totalTokens * 0.65),
    totalTokens,
    sourceKey
  }
}

export function parseCursorBubbleValue(
  parsed: Record<string, unknown>,
  sourceKey: string
): CursorExternalUsageEvent | null {
  const tokenCount =
    parsed.tokenCount && typeof parsed.tokenCount === 'object'
      ? (parsed.tokenCount as Record<string, unknown>)
      : null
  const inputTokens = numberValue(tokenCount?.inputTokens)
  const outputTokens = numberValue(tokenCount?.outputTokens)
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return null

  const timestamp =
    parseTimestamp(parsed.createdAt) ||
    parseTimestamp(parsed.timingInfo && typeof parsed.timingInfo === 'object'
      ? (parsed.timingInfo as Record<string, unknown>).startTime
      : undefined)
  if (!timestamp) return null

  const modelInfo =
    parsed.modelInfo && typeof parsed.modelInfo === 'object'
      ? (parsed.modelInfo as Record<string, unknown>)
      : null
  const rawModel = typeof modelInfo?.modelName === 'string' ? modelInfo.modelName : undefined
  const model = normalizeCursorExternalModelId(rawModel)
  const costRateModel = cursorExternalCostRateModelId(rawModel)

  return {
    provider: 'cursor',
    timestamp,
    model,
    ...(costRateModel ? { costRateModel } : {}),
    inputTokens,
    outputTokens,
    totalTokens,
    sourceKey
  }
}

let memoryDiskCache: CursorExternalActivityDiskCache | null = null
let memoryDiskCachePath: string | null = null
let catchUpTimer: ReturnType<typeof setTimeout> | null = null
let catchUpOptions: CursorExternalActivityOptions | null = null
let catchUpInFlight = false
let onCursorCacheUpdated: ((events: CursorExternalUsageEvent[]) => void) | null = null

export function setCursorExternalActivityUpdateListener(
  listener: ((events: CursorExternalUsageEvent[]) => void) | null
): void {
  onCursorCacheUpdated = listener
}

export function getCursorIdeUsageSnapshot(sinceMs: number): CursorExternalUsageEvent[] {
  if (!memoryDiskCache) return []
  return mergeCursorDiskCacheEvents(memoryDiskCache, sinceMs)
}

export function prewarmCursorIdeUsageCache(options: CursorExternalActivityOptions): void {
  void loadCursorIdeUsageEvents({
    ...options,
    transcriptParseBudget: options.transcriptParseBudget ?? CURSOR_TRANSCRIPT_CHUNK_SIZE * 2
  }).catch(() => {})
  scheduleCursorIdeUsageCatchUp(options)
}

export function scheduleCursorIdeUsageCatchUp(options: CursorExternalActivityOptions): void {
  catchUpOptions = { ...options }
  if (catchUpTimer) return
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null
    void runCursorIdeUsageCatchUpChunk()
  }, BACKGROUND_CHUNK_DELAY_MS)
}

async function runCursorIdeUsageCatchUpChunk(): Promise<void> {
  if (catchUpInFlight || !catchUpOptions) return
  const pending = memoryDiskCache?.pendingTranscriptPaths.length || 0
  if (pending <= 0) return

  catchUpInFlight = true
  try {
    const events = await loadCursorIdeUsageEvents({
      ...catchUpOptions,
      transcriptParseBudget: CURSOR_TRANSCRIPT_CHUNK_SIZE
    })
    onCursorCacheUpdated?.(events)
    if ((memoryDiskCache?.pendingTranscriptPaths.length || 0) > 0) {
      scheduleCursorIdeUsageCatchUp(catchUpOptions)
    }
  } catch {
    scheduleCursorIdeUsageCatchUp(catchUpOptions)
  } finally {
    catchUpInFlight = false
  }
}

async function ensureDiskCache(
  options: CursorExternalActivityOptions
): Promise<CursorExternalActivityDiskCache> {
  const cachePath = options.cachePath
  // Reuse whenever the cache COVERS the requested window (cache.sinceMs <=
  // requested sinceMs). Production sinceMs is a rolling now-90d recomputed
  // per scan, so the old exact-equality key discarded this cache on every
  // scan — silently defeating the incremental path. Transcript entries and
  // merged events are pruned/filtered by the caller's sinceMs on each pass,
  // so advancing the window is always safe; only a WIDENED window (requested
  // sinceMs earlier than coverage) requires a rebuild from empty.
  if (memoryDiskCache && memoryDiskCachePath === (cachePath || '')) {
    if (memoryDiskCache.sinceMs <= options.sinceMs) {
      memoryDiskCache.sinceMs = options.sinceMs
      return memoryDiskCache
    }
  }

  let cache = cachePath ? await readCursorExternalActivityDiskCache(cachePath) : null
  if (!cache || cache.sinceMs > options.sinceMs) {
    cache = emptyCursorExternalActivityDiskCache(options.sinceMs)
  }
  cache.sinceMs = options.sinceMs

  memoryDiskCache = cache
  memoryDiskCachePath = cachePath || ''
  return cache
}

export async function loadCursorIdeUsageEvents(
  options: CursorExternalActivityOptions
): Promise<CursorExternalUsageEvent[]> {
  const now = options.now ?? Date.now()
  const force = options.force === true
  const readTextFile = options.readTextFile ?? ((path: string) => fs.readFile(path, 'utf8'))
  const statFile =
    options.statFile ??
    (async (path: string) => {
      const stat = await fs.stat(path)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    })
  const listTranscriptFileStats =
    options.listTranscriptFileStats ??
    ((homeDir, sinceMs) => collectAgentTranscriptFileStats(homeDir, sinceMs, statFile))
  const querySqlite = options.querySqlite ?? runSqliteQuery
  const parseBudget = Math.max(0, options.transcriptParseBudget ?? MAX_TRANSCRIPT_FILES)

  const cache = await ensureDiskCache(options)
  if (force) {
    cache.pendingTranscriptPaths = []
    cache.sqliteSnapshot = null
    cache.modelHintsFetchedAt = 0
  }

  const modelHints = await loadCursorConversationModelHints(
    options.homeDir,
    querySqlite,
    cache,
    now,
    force
  )

  const transcriptStats = await listTranscriptFileStats(options.homeDir, options.sinceMs)
  const activePaths = new Set(transcriptStats.map((file) => file.path))
  pruneCursorTranscriptCache(cache, activePaths, options.sinceMs)

  const needsParse = transcriptStats.filter((file) =>
    cursorTranscriptNeedsParsing(cache, file.path, file.mtimeMs, file.size)
  )
  const queue =
    cache.pendingTranscriptPaths.length > 0
      ? cache.pendingTranscriptPaths
      : needsParse.map((file) => file.path)
  const toParse = queue.slice(0, parseBudget)
  cache.pendingTranscriptPaths = queue.slice(toParse.length)

  const statByPath = new Map(transcriptStats.map((file) => [file.path, file]))
  for (const filePath of toParse) {
    const fileStat = statByPath.get(filePath)
    if (!fileStat) continue
    try {
      const text = await readTextFile(filePath)
      if (text.length > MAX_TRANSCRIPT_BYTES) continue
      const composerId =
        filePath
          .replace(/\\/g, '/')
          .match(/agent-transcripts\/([^/]+)\//)?.[1] || ''
      const parsed = parseCursorAgentTranscript(
        filePath,
        text,
        fileStat.mtimeMs,
        composerId ? modelHints.get(composerId) : undefined
      )
      if (!parsed) continue
      cache.transcriptEntries[filePath] = {
        filePath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        event: {
          provider: 'cursor',
          timestamp: parsed.timestamp,
          model: parsed.model,
          ...(parsed.costRateModel ? { costRateModel: parsed.costRateModel } : {}),
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.inputTokens + parsed.outputTokens,
          sourceKey: parsed.sourceKey
        }
      }
    } catch {
      continue
    }
  }

  await refreshCursorSqliteSnapshot(options.homeDir, querySqlite, cache, now, force)

  cache.updatedAt = now
  if (options.cachePath) {
    await writeCursorExternalActivityDiskCache(options.cachePath, cache)
  }

  const events = mergeCursorDiskCacheEvents(cache, options.sinceMs)
  if (cache.pendingTranscriptPaths.length > 0 && catchUpOptions?.cachePath === options.cachePath) {
    scheduleCursorIdeUsageCatchUp(options)
  }
  return events
}

async function refreshCursorSqliteSnapshot(
  homeDir: string,
  querySqlite: (dbPath: string, query: string) => Promise<string[]>,
  cache: CursorExternalActivityDiskCache,
  now: number,
  force: boolean
): Promise<void> {
  const sinceDate = new Date(cache.sinceMs).toISOString().slice(0, 10)
  const dailyKeyPrefix = `aiCodeTracking.dailyStats.v1.5.${sinceDate}`

  for (const dbPath of cursorStateDbCandidates(homeDir)) {
    let dbMtimeMs = 0
    try {
      const stat = await fs.stat(dbPath)
      dbMtimeMs = stat.mtimeMs
    } catch {
      continue
    }

    if (!cursorSqliteNeedsRescan(cache, dbPath, dbMtimeMs, now, force)) break

    const events: CursorExternalUsageEvent[] = []
    const seen = new Set<string>()
    const push = (event: CursorExternalUsageEvent | null): void => {
      if (!event || event.timestamp < cache.sinceMs) return
      if (seen.has(event.sourceKey)) return
      seen.add(event.sourceKey)
      events.push(event)
    }

    const bubbleRows = await querySqlite(
      dbPath,
      `SELECT key, value FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%'
         AND (
           CAST(json_extract(value, '$.tokenCount.inputTokens') AS INTEGER) > 0
           OR CAST(json_extract(value, '$.tokenCount.outputTokens') AS INTEGER) > 0
         );`
    )
    for (const row of bubbleRows) {
      const tab = row.indexOf('|')
      const key = tab >= 0 ? row.slice(0, tab) : row
      const rawValue = tab >= 0 ? row.slice(tab + 1) : ''
      try {
        push(parseCursorBubbleValue(JSON.parse(rawValue), `cursor-ide-bubble:${key}`))
      } catch {
        continue
      }
    }

    const dailyRows = await querySqlite(
      dbPath,
      `SELECT key, value FROM ItemTable
       WHERE key LIKE 'aiCodeTracking.dailyStats.%'
         AND key >= '${dailyKeyPrefix}'
       ORDER BY key ASC;`
    )
    for (const row of dailyRows) {
      const tab = row.indexOf('|')
      const key = tab >= 0 ? row.slice(0, tab) : row
      const rawValue = tab >= 0 ? row.slice(tab + 1) : ''
      try {
        push(parseCursorDailyStatsValue(JSON.parse(rawValue), `cursor-ide-daily:${key}`))
      } catch {
        continue
      }
    }

    cache.sqliteSnapshot = {
      dbPath,
      dbMtimeMs,
      scannedAt: now,
      events
    }
    break
  }
}

async function loadCursorConversationModelHints(
  homeDir: string,
  querySqlite: (dbPath: string, query: string) => Promise<string[]>,
  cache: CursorExternalActivityDiskCache,
  now: number,
  force: boolean
): Promise<Map<string, string>> {
  const hints = new Map<string, string>()
  if (!cursorModelHintsNeedRefresh(cache, now, force)) {
    for (const [conversationId, model] of Object.entries(cache.modelHints)) {
      hints.set(conversationId, model)
    }
    return hints
  }

  const trackingDb = join(homeDir, '.cursor', 'ai-tracking', 'ai-code-tracking.db')
  try {
    await fs.access(trackingDb)
  } catch {
    return hints
  }

  const rows = await querySqlite(
    trackingDb,
    'SELECT conversationId, model FROM conversation_summaries WHERE model IS NOT NULL AND model != "";'
  )
  for (const row of rows) {
    const tab = row.indexOf('|')
    if (tab < 0) continue
    const conversationId = row.slice(0, tab).trim()
    const model = row.slice(tab + 1).trim()
    if (conversationId && model) hints.set(conversationId, model)
  }

  if (hints.size > 0) {
    cache.modelHints = Object.fromEntries(hints.entries())
    cache.modelHintsFetchedAt = now
    return hints
  }

  const hashRows = await querySqlite(
    trackingDb,
    `SELECT conversationId, model
     FROM (
       SELECT conversationId, model, MAX(createdAt) AS latest
       FROM ai_code_hashes
       WHERE source = 'composer' AND conversationId IS NOT NULL AND model IS NOT NULL
       GROUP BY conversationId
     )
     ORDER BY latest DESC
     LIMIT 500;`
  )
  for (const row of hashRows) {
    const tab = row.indexOf('|')
    if (tab < 0) continue
    const conversationId = row.slice(0, tab).trim()
    const model = row.slice(tab + 1).trim()
    if (conversationId && model && !hints.has(conversationId)) hints.set(conversationId, model)
  }

  cache.modelHints = Object.fromEntries(hints.entries())
  cache.modelHintsFetchedAt = now
  return hints
}

async function collectAgentTranscriptFileStats(
  homeDir: string,
  sinceMs: number,
  statFile: (path: string) => Promise<{ mtimeMs: number; size: number }> = async (path) => {
    const stat = await fs.stat(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  }
): Promise<TranscriptFileStat[]> {
  const root = join(homeDir, '.cursor', 'projects')
  const files: TranscriptFileStat[] = []
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
        if (entry.name === 'subagents') continue
        stack.push(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (!entryPath.replace(/\\/g, '/').includes('/agent-transcripts/')) continue
      try {
        const stat = await statFile(entryPath)
        if (stat.mtimeMs < sinceMs) continue
        files.push({ path: entryPath, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch {
        continue
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_TRANSCRIPT_FILES)
}

async function runSqliteQuery(dbPath: string, query: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/sqlite3',
      ['-readonly', '-separator', '|', dbPath, query],
      { timeout: 8_000, maxBuffer: 32 * 1024 * 1024 },
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

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCursorDailyStatTimestamp(value: Record<string, unknown>): number | null {
  if (typeof value.date !== 'string' || !value.date.trim()) return null
  const parsed = Date.parse(`${value.date.trim()}T12:00:00`)
  return Number.isFinite(parsed) ? parsed : null
}

function numberValue(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}
