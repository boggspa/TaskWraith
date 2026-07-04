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

import type {
  ChatMessage,
  ChatRun,
  PooledAgentStatsBreakdown,
  PooledAgentStatsSummary
} from './store/types'

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
  providerThreadId?: string
  ensembleRoundId?: string
  ensembleRole?: string
  ensembleStageRole?: string
  ensembleLaneIntent?: string
  status: AgentRunStatusBucket
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  costUsd: number
  durationMs: number
  linesAdded: number
  linesRemoved: number
  filesTouched: number
  toolCalls: number
  writeToolCalls: number
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
  toolCalls: number
  writeToolCalls: number
  runsWithDiffUnavailable: number
  chats: string[]
  providerThreads: string[]
  ensembleRounds: string[]
  ensembleRoles: PooledAgentStatsBreakdown[]
  ensembleStageRoles: PooledAgentStatsBreakdown[]
  ensembleLaneIntents: PooledAgentStatsBreakdown[]
  runIds: string[]
  lastRunAt: number
}

export type AgentStatRecord = AgentStatDelta | AgentStatRollup

function isRollup(record: AgentStatRecord): record is AgentStatRollup {
  return (record as AgentStatRollup).rollup === true
}

export interface AgentRunToolActivityStats {
  toolCalls: number
  writeToolCalls: number
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

export function toolActivityStatsForRun(
  runId: string,
  messages: readonly Pick<ChatMessage, 'runId' | 'toolActivities'>[] | undefined
): AgentRunToolActivityStats {
  if (!runId || !Array.isArray(messages)) return { toolCalls: 0, writeToolCalls: 0 }
  let toolCalls = 0
  let writeToolCalls = 0
  for (const message of messages) {
    if (message.runId !== runId || !Array.isArray(message.toolActivities)) continue
    for (const activity of message.toolActivities) {
      toolCalls += 1
      if (activity.category === 'write') writeToolCalls += 1
    }
  }
  return { toolCalls, writeToolCalls }
}

function compactString(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
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
  now: number,
  toolStats: AgentRunToolActivityStats = { toolCalls: 0, writeToolCalls: 0 }
): AgentStatDelta | null {
  if (!isTerminalRun(run)) return null
  const tokens = extractRunTokens(run.stats)
  const diff = diffLineStats(run)
  const endedMs = run.endedAt ? Date.parse(run.endedAt) : NaN
  const providerThreadId = compactString(run.providerThreadId, 240)
  const ensembleRoundId = compactString(run.ensembleRoundId, 160)
  const ensembleRole = compactString(run.ensembleRole, 120)
  const ensembleStageRole = compactString(run.ensembleStageRole, 40)
  const ensembleLaneIntent = compactString(run.ensembleLaneIntent, 40)
  return {
    runId: run.runId,
    chatId,
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(ensembleRoundId ? { ensembleRoundId } : {}),
    ...(ensembleRole ? { ensembleRole } : {}),
    ...(ensembleStageRole ? { ensembleStageRole } : {}),
    ...(ensembleLaneIntent ? { ensembleLaneIntent } : {}),
    status: statusBucket(run),
    tokensIn: tokens.inputTokens,
    tokensOut: tokens.outputTokens,
    tokensTotal: tokens.totalTokens,
    costUsd: extractRunCostUsd(run.stats),
    durationMs: runDurationMs(run),
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    filesTouched: diff.filesTouched,
    toolCalls: Math.max(0, Math.trunc(toolStats.toolCalls || 0)),
    writeToolCalls: Math.max(0, Math.trunc(toolStats.writeToolCalls || 0)),
    diffAvailable: diff.available,
    at: Number.isFinite(endedMs) ? endedMs : now
  }
}

// ── fold + compaction ────────────────────────────────────────────────────────

function positiveInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function addString(set: Set<string>, value: unknown): void {
  const compact = compactString(value)
  if (compact) set.add(compact)
}

function addBreakdown(map: Map<string, number>, key: unknown, count = 1): void {
  const compact = compactString(key)
  if (!compact || count <= 0) return
  map.set(compact, (map.get(compact) ?? 0) + count)
}

function mergeBreakdown(map: Map<string, number>, records: PooledAgentStatsBreakdown[] | undefined): void {
  if (!Array.isArray(records)) return
  for (const record of records) addBreakdown(map, record.key, positiveInt(record.count))
}

function breakdownFromMap(map: Map<string, number>): PooledAgentStatsBreakdown[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

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
  toolCalls: 0,
  writeToolCalls: 0,
  distinctChats: 0,
  distinctSessions: 0,
  distinctEnsembleRounds: 0,
  ensembleRoles: [],
  ensembleStageRoles: [],
  ensembleLaneIntents: [],
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
  const sessions = new Set<string>()
  const rounds = new Set<string>()
  const roleCounts = new Map<string, number>()
  const stageRoleCounts = new Map<string, number>()
  const laneIntentCounts = new Map<string, number>()
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
      summary.toolCalls += positiveInt(record.toolCalls)
      summary.writeToolCalls += positiveInt(record.writeToolCalls)
      summary.runsWithDiffUnavailable += record.runsWithDiffUnavailable
      summary.lastRunAt = Math.max(summary.lastRunAt, record.lastRunAt)
      for (const chatId of record.chats) chats.add(chatId)
      for (const providerThreadId of record.providerThreads ?? []) sessions.add(providerThreadId)
      for (const roundId of record.ensembleRounds ?? []) rounds.add(roundId)
      mergeBreakdown(roleCounts, record.ensembleRoles)
      mergeBreakdown(stageRoleCounts, record.ensembleStageRoles)
      mergeBreakdown(laneIntentCounts, record.ensembleLaneIntents)
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
      summary.toolCalls += positiveInt(record.toolCalls)
      summary.writeToolCalls += positiveInt(record.writeToolCalls)
      if (!record.diffAvailable) summary.runsWithDiffUnavailable += 1
      summary.lastRunAt = Math.max(summary.lastRunAt, record.at)
      chats.add(record.chatId)
      addString(sessions, record.providerThreadId)
      addString(rounds, record.ensembleRoundId)
      addBreakdown(roleCounts, record.ensembleRole)
      addBreakdown(stageRoleCounts, record.ensembleStageRole)
      addBreakdown(laneIntentCounts, record.ensembleLaneIntent)
    }
  }
  summary.distinctChats = chats.size
  summary.distinctSessions = sessions.size
  summary.distinctEnsembleRounds = rounds.size
  summary.ensembleRoles = breakdownFromMap(roleCounts)
  summary.ensembleStageRoles = breakdownFromMap(stageRoleCounts)
  summary.ensembleLaneIntents = breakdownFromMap(laneIntentCounts)
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
  const providerThreads = new Set<string>()
  const ensembleRounds = new Set<string>()
  const runIds = new Set<string>()
  for (const record of records) {
    if (isRollup(record)) {
      for (const chatId of record.chats) chats.add(chatId)
      for (const providerThreadId of record.providerThreads ?? []) providerThreads.add(providerThreadId)
      for (const roundId of record.ensembleRounds ?? []) ensembleRounds.add(roundId)
      for (const runId of record.runIds) runIds.add(runId)
    } else {
      if (runIds.has(record.runId)) continue
      chats.add(record.chatId)
      addString(providerThreads, record.providerThreadId)
      addString(ensembleRounds, record.ensembleRoundId)
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
    toolCalls: folded.toolCalls,
    writeToolCalls: folded.writeToolCalls,
    runsWithDiffUnavailable: folded.runsWithDiffUnavailable,
    chats: [...chats],
    providerThreads: [...providerThreads],
    ensembleRounds: [...ensembleRounds],
    ensembleRoles: folded.ensembleRoles,
    ensembleStageRoles: folded.ensembleStageRoles,
    ensembleLaneIntents: folded.ensembleLaneIntents,
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
