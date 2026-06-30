// Pure helpers for the per-Agent STATS ledger (Agent Pool, Phase 2). Mirrors
// WorkflowRunStore: node-free pure logic here; the disk I/O lives in
// store/index.ts. One append-only `.jsonl` file per pooled Agent
// (`agent-stats/<pooledAgentId>.jsonl`), one delta record per FINALIZED run
// attributed to that Agent, folded on read.
//
// WHY THIS SHAPE
// --------------
// Attribution accrues from first pool-use forward (no backfill), so the ledger
// is written incrementally as runs finalize — never a cold full-corpus sweep
// (the documented run-events GIGABYTE main-thread beachball). Each delta carries
// its `runId`; the fold + the in-memory seen-set dedupe on it, so re-harvesting
// the same chat (saveChat fires on every chat mutation) can never double-count.
// A heavily-used Agent's file is compacted into one rollup record once the raw
// count crosses AGENT_STATS_FILE_CAP — the rollup keeps `runIds` so dedup
// survives compaction.

import type { ChatRun, PooledAgentStatsSummary } from './store/types'

export const AGENT_STATS_SCHEMA_VERSION = 1
/** Raw per-run records tolerated before a file is compacted into one rollup. */
export const AGENT_STATS_FILE_CAP = 2000

const POOLED_AGENT_ID_PREFIX = 'pooled-agent-'

/** True for a pooled-Agent id. Guards the harvest so a per-chat participant id
 *  can never be conflated with a pool identity. (Twin of the renderer guard.) */
export function isPooledAgentId(id: string | null | undefined): boolean {
  return (
    typeof id === 'string' &&
    id.startsWith(POOLED_AGENT_ID_PREFIX) &&
    id.length > POOLED_AGENT_ID_PREFIX.length
  )
}

export type AgentRunStatusBucket = 'success' | 'failed' | 'cancelled' | 'other'

/** One finalized run's contribution to an Agent's profile. */
export interface AgentStatDelta {
  runId: string
  chatId: string
  status: AgentRunStatusBucket
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  costUsd: number
  durationMs: number
  linesAdded: number
  linesRemoved: number
  filesTouched: number
  /** False when the run carried no run-diff, so ±lines is undercounted. */
  diffAvailable: boolean
  /** Finalize time (ms epoch). */
  at: number
}

/** Compaction record: the summed contribution of many runs + the runIds they
 *  covered (so dedup survives) + distinct chats. Always at most one per file. */
export interface AgentStatRollup {
  rollup: true
  runs: number
  success: number
  failed: number
  cancelled: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  costUsd: number
  durationMs: number
  linesAdded: number
  linesRemoved: number
  filesTouched: number
  runsWithDiffUnavailable: number
  chats: string[]
  runIds: string[]
  lastRunAt: number
}

export type AgentStatRecord = AgentStatDelta | AgentStatRollup

function isRollup(record: AgentStatRecord): record is AgentStatRollup {
  return (record as AgentStatRollup).rollup === true
}

// ── pure extraction (self-contained; no provider-coupled deps) ───────────────

function nestedNumber(stats: unknown, paths: string[][]): number {
  if (!stats || typeof stats !== 'object') return 0
  for (const pathKeys of paths) {
    let cursor: unknown = stats
    let ok = true
    for (const key of pathKeys) {
      if (cursor && typeof cursor === 'object' && key in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[key]
      } else {
        ok = false
        break
      }
    }
    if (!ok) continue
    // No truncation here — costs are fractional. Token call sites trunc.
    const value = typeof cursor === 'string' ? Number(cursor.trim()) : Number(cursor)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function sumNumbers(stats: unknown, paths: string[][]): number {
  let total = 0
  for (const pathKeys of paths) total += nestedNumber(stats, [pathKeys])
  return total
}

/** Token counts from a run's provider-raw `stats` blob (mirrors the spellings
 *  usageStats.extractUsageCountsFromCandidate probes). */
export function extractRunTokens(stats: unknown): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} {
  const includesCache = Boolean((stats as Record<string, unknown>)?._taskwraith_input_includes_cache)
  const inputBase = nestedNumber(stats, [
    ['input_tokens'],
    ['inputTokens'],
    ['prompt_tokens'],
    ['promptTokens'],
    ['input'],
    ['prompt'],
    ['counts', 'input'],
    ['counts', 'prompt'],
    ['tokenCounts', 'input'],
    ['token_counts', 'input']
  ])
  const cacheInput = includesCache
    ? 0
    : sumNumbers(stats, [
        ['cache_creation_input_tokens'],
        ['cache_read_input_tokens'],
        ['cached_input_tokens'],
        ['input_cache_creation'],
        ['input_cache_read']
      ])
  const inputAudio = includesCache ? 0 : sumNumbers(stats, [['input_audio_tokens']])
  const inputTokens = inputBase + cacheInput + inputAudio

  const outputBase = nestedNumber(stats, [
    ['output_tokens'],
    ['outputTokens'],
    ['completion_tokens'],
    ['completionTokens'],
    ['output'],
    ['counts', 'output'],
    ['counts', 'completion'],
    ['tokenCounts', 'output'],
    ['token_counts', 'output']
  ])
  const outputTokens = outputBase + sumNumbers(stats, [['output_audio_tokens']])

  const explicitTotal = nestedNumber(stats, [
    ['total_tokens'],
    ['totalTokens'],
    ['all_tokens'],
    ['total'],
    ['tokens', 'total'],
    ['tokenCounts', 'total'],
    ['token_counts', 'total']
  ])
  const totalTokens = explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens
  return {
    inputTokens: Math.trunc(Math.max(0, inputTokens)),
    outputTokens: Math.trunc(Math.max(0, outputTokens)),
    totalTokens: Math.trunc(Math.max(0, totalTokens))
  }
}

export function extractRunCostUsd(stats: unknown): number {
  const raw = nestedNumber(stats, [
    ['cost_usd'],
    ['costUsd'],
    ['total_cost_usd'],
    ['totalCostUsd'],
    ['usage', 'cost_usd'],
    ['usage', 'costUsd'],
    ['billing', 'cost_usd'],
    ['billing', 'costUsd']
  ])
  return raw > 0 ? raw : 0
}

/** Wall-clock run duration: `stats.duration_ms` else endedAt−startedAt. */
export function runDurationMs(run: Pick<ChatRun, 'stats' | 'startedAt' | 'endedAt'>): number {
  const fromStats = nestedNumber(run.stats, [['duration_ms'], ['durationMs']])
  if (fromStats > 0) return fromStats
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN
  const end = run.endedAt ? Date.parse(run.endedAt) : NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start
  return 0
}

function sumDiffLines(files: { additions?: number; deletions?: number }[] | undefined): {
  added: number
  removed: number
  files: number
} {
  if (!Array.isArray(files)) return { added: 0, removed: 0, files: 0 }
  let added = 0
  let removed = 0
  for (const file of files) {
    added += Math.max(0, file.additions ?? 0)
    removed += Math.max(0, file.deletions ?? 0)
  }
  return { added, removed, files: files.length }
}

/** Run-LEVEL ± lines + files-touched from `run.runDiff`. `available` is false
 *  when no diff was captured (so callers can qualify the figure). */
export function diffLineStats(run: Pick<ChatRun, 'runDiff'>): {
  linesAdded: number
  linesRemoved: number
  filesTouched: number
  available: boolean
} {
  const diff = run.runDiff
  if (!diff) return { linesAdded: 0, linesRemoved: 0, filesTouched: 0, available: false }
  const created = sumDiffLines(diff.createdFiles)
  const modified = sumDiffLines(diff.modifiedFiles)
  const deleted = sumDiffLines(diff.deletedFiles)
  return {
    linesAdded: created.added + modified.added + deleted.added,
    linesRemoved: created.removed + modified.removed + deleted.removed,
    filesTouched: created.files + modified.files + deleted.files,
    available: true
  }
}

export function statusBucket(run: Pick<ChatRun, 'status' | 'cancelled'>): AgentRunStatusBucket {
  if (run.cancelled === true || run.status === 'cancelled') return 'cancelled'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'success' || run.status === 'success_with_warnings') return 'success'
  return 'other'
}

/** A run is countable once it has ended and is not actively running/sleeping. */
export function isTerminalRun(run: Pick<ChatRun, 'status' | 'cancelled' | 'endedAt'>): boolean {
  if (run.cancelled === true) return true
  if (run.status === 'running' || run.status === 'sleeping') return false
  return Boolean(run.endedAt) || run.status === 'success' || run.status === 'success_with_warnings' || run.status === 'failed' || run.status === 'cancelled'
}

/** Build a finalized run's delta. Returns null for a non-terminal run. */
export function buildAgentStatDelta(
  chatId: string,
  run: ChatRun,
  now: number
): AgentStatDelta | null {
  if (!isTerminalRun(run)) return null
  const tokens = extractRunTokens(run.stats)
  const diff = diffLineStats(run)
  const endedMs = run.endedAt ? Date.parse(run.endedAt) : NaN
  return {
    runId: run.runId,
    chatId,
    status: statusBucket(run),
    tokensIn: tokens.inputTokens,
    tokensOut: tokens.outputTokens,
    tokensTotal: tokens.totalTokens,
    costUsd: extractRunCostUsd(run.stats),
    durationMs: runDurationMs(run),
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    filesTouched: diff.filesTouched,
    diffAvailable: diff.available,
    at: Number.isFinite(endedMs) ? endedMs : now
  }
}

// ── fold + compaction ────────────────────────────────────────────────────────

const EMPTY_SUMMARY = (agentId: string): PooledAgentStatsSummary => ({
  agentId,
  runs: 0,
  success: 0,
  failed: 0,
  cancelled: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensTotal: 0,
  costUsd: 0,
  durationMs: 0,
  linesAdded: 0,
  linesRemoved: 0,
  filesTouched: 0,
  distinctChats: 0,
  runsWithDiffUnavailable: 0,
  lastRunAt: 0
})

/** Fold a file's records (≤1 rollup + raw deltas) into a summary. */
export function foldAgentStats(
  agentId: string,
  records: AgentStatRecord[]
): PooledAgentStatsSummary {
  const summary = EMPTY_SUMMARY(agentId)
  const chats = new Set<string>()
  const seenRuns = new Set<string>()
  for (const record of records) {
    if (isRollup(record)) {
      summary.runs += record.runs
      summary.success += record.success
      summary.failed += record.failed
      summary.cancelled += record.cancelled
      summary.tokensIn += record.tokensIn
      summary.tokensOut += record.tokensOut
      summary.tokensTotal += record.tokensTotal
      summary.costUsd += record.costUsd
      summary.durationMs += record.durationMs
      summary.linesAdded += record.linesAdded
      summary.linesRemoved += record.linesRemoved
      summary.filesTouched += record.filesTouched
      summary.runsWithDiffUnavailable += record.runsWithDiffUnavailable
      summary.lastRunAt = Math.max(summary.lastRunAt, record.lastRunAt)
      for (const chatId of record.chats) chats.add(chatId)
      for (const runId of record.runIds) seenRuns.add(runId)
    } else {
      // Raw delta — skip a runId already counted (in a rollup or earlier line).
      if (seenRuns.has(record.runId)) continue
      seenRuns.add(record.runId)
      summary.runs += 1
      if (record.status === 'success') summary.success += 1
      else if (record.status === 'failed') summary.failed += 1
      else if (record.status === 'cancelled') summary.cancelled += 1
      summary.tokensIn += record.tokensIn
      summary.tokensOut += record.tokensOut
      summary.tokensTotal += record.tokensTotal
      summary.costUsd += record.costUsd
      summary.durationMs += record.durationMs
      summary.linesAdded += record.linesAdded
      summary.linesRemoved += record.linesRemoved
      summary.filesTouched += record.filesTouched
      if (!record.diffAvailable) summary.runsWithDiffUnavailable += 1
      summary.lastRunAt = Math.max(summary.lastRunAt, record.at)
      chats.add(record.chatId)
    }
  }
  summary.distinctChats = chats.size
  return summary
}

/** The set of runIds a file already covers (for dedup; spans the rollup). */
export function seenRunIds(records: AgentStatRecord[]): Set<string> {
  const seen = new Set<string>()
  for (const record of records) {
    if (isRollup(record)) for (const runId of record.runIds) seen.add(runId)
    else seen.add(record.runId)
  }
  return seen
}

export function countRawDeltas(records: AgentStatRecord[]): number {
  return records.reduce((n, record) => (isRollup(record) ? n : n + 1), 0)
}

/**
 * Collapse all records (existing rollup + raw deltas) into a SINGLE rollup,
 * preserving every sum, distinct chat, and runId. Folding the result equals
 * folding the input — the compaction-identity invariant.
 */
export function compactToRollup(agentId: string, records: AgentStatRecord[]): AgentStatRollup {
  const folded = foldAgentStats(agentId, records)
  const chats = new Set<string>()
  const runIds = new Set<string>()
  for (const record of records) {
    if (isRollup(record)) {
      for (const chatId of record.chats) chats.add(chatId)
      for (const runId of record.runIds) runIds.add(runId)
    } else {
      chats.add(record.chatId)
      runIds.add(record.runId)
    }
  }
  return {
    rollup: true,
    runs: folded.runs,
    success: folded.success,
    failed: folded.failed,
    cancelled: folded.cancelled,
    tokensIn: folded.tokensIn,
    tokensOut: folded.tokensOut,
    tokensTotal: folded.tokensTotal,
    costUsd: folded.costUsd,
    durationMs: folded.durationMs,
    linesAdded: folded.linesAdded,
    linesRemoved: folded.linesRemoved,
    filesTouched: folded.filesTouched,
    runsWithDiffUnavailable: folded.runsWithDiffUnavailable,
    chats: [...chats],
    runIds: [...runIds],
    lastRunAt: folded.lastRunAt
  }
}

// ── (de)serialization ────────────────────────────────────────────────────────

/** Per-Agent file name; sanitizes the id (path-injection safe). */
export function safeAgentStatsFileName(agentId: string): string {
  const normalized = String(agentId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${normalized || 'unknown-agent'}.jsonl`
}

export function serializeAgentStatRecord(record: AgentStatRecord): string {
  return `${JSON.stringify(record)}\n`
}

export function parseAgentStatRecordLine(line: string): AgentStatRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as AgentStatRecord
    if (isRollup(parsed)) return parsed
    if (parsed && typeof (parsed as AgentStatDelta).runId === 'string') return parsed
    return null
  } catch {
    return null
  }
}
