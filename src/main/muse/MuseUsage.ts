/**
 * Muse seat usage metering from durable `session.jsonl` events.
 *
 * Authority:
 *   - Tokens: `goal_usage_attribution` where usage_family === "provider" and
 *     quantity.reported === true
 *   - Model / duration / cache split: sibling `model_completed` on the same
 *     Muse run_id (do not double-count tokens)
 *   - Cost: model-catalog rates (USD per million tokens) — not present in jsonl
 *
 * `--no-session-log` and reported metering are mutually exclusive. This module
 * never invents reported usage when session logging is off; callers must pass
 * `sessionLogEnabled: false` (or omit metering) rather than falling back to
 * `muse export` or char estimates as the primary path.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseMuseEnvelope, type MuseEnvelope } from './MuseExecJson'

export const MUSE_USAGE_SOURCE = 'muse-session-jsonl'
export const MUSE_TOKEN_COUNT_CONFIDENCE_KEY = '_taskwraith_token_count_confidence'
export const MUSE_TOKEN_COUNT_REPORTED = 'reported'
export const MUSE_TOKEN_COUNT_UNAVAILABLE = 'unavailable'

export type MuseTokenCountConfidence = 'reported' | 'estimated' | 'unavailable'

export interface MuseModelRate {
  readonly inputUsdPerMillion: number
  readonly outputUsdPerMillion: number
  readonly cachedUsdPerMillion: number
  readonly currency: 'USD' | string
}

export interface MuseMeterSnapshot {
  museSessionId: string
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Informational annotation; never added into totalTokens. */
  reasoningTokens: number
  totalTokens: number
  durationMs: number
  estimatedCostUsd: number | null
  tokenCountConfidence: MuseTokenCountConfidence
  source: typeof MUSE_USAGE_SOURCE
  usageIds: string[]
  /** True when metering was refused because session logging is off. */
  meteringDisabled?: boolean
}

export interface MuseProviderStats {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  reasoning_tokens: number
  duration_ms: number
  model?: string
  total_cost_usd?: number
  _taskwraith_usage_source: typeof MUSE_USAGE_SOURCE
  [MUSE_TOKEN_COUNT_CONFIDENCE_KEY]: MuseTokenCountConfidence
}

interface PartialRunAccum {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  durationMs: number
  model: string | null
  usageIds: string[]
  hasCompletedCache: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asFiniteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Hard policy: reported metering requires a durable session log. */
export function museMeteringAllowed(sessionLogEnabled: boolean): boolean {
  return sessionLogEnabled === true
}

/**
 * Parse a Muse model-catalog cost row (`rows[].cost`) into USD/MTok rates.
 * Returns null when the row is missing or unparseable (tokens-only fallback).
 */
export function parseMuseModelCatalogRate(cost: unknown): MuseModelRate | null {
  const rec = asRecord(cost)
  if (!rec) return null
  const input = Number(rec.input)
  const output = Number(rec.output)
  const cached = Number(rec.cached)
  if (![input, output, cached].every((n) => Number.isFinite(n) && n >= 0)) return null
  const currency = asString(rec.currency) || 'USD'
  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    cachedUsdPerMillion: cached,
    currency
  }
}

/**
 * Read rates for `modelId` from `$dataHome/muse/model-catalog/*.json` (or
 * `$dataHome/model-catalog` when dataHome already ends with `/muse`).
 */
export async function loadMuseModelCatalogRate(
  dataHome: string,
  modelId: string | null | undefined
): Promise<MuseModelRate | null> {
  const id = typeof modelId === 'string' ? modelId.trim() : ''
  if (!id) return null
  const trimmed = dataHome.replace(/\/+$/, '')
  const root = trimmed.endsWith('/muse') ? trimmed : join(trimmed, 'muse')
  const catalogDir = join(root, 'model-catalog')
  let entries: string[]
  try {
    entries = await fs.readdir(catalogDir)
  } catch {
    return null
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(catalogDir, name), 'utf8')
      const doc = JSON.parse(raw) as { rows?: unknown }
      const rows = Array.isArray(doc.rows) ? doc.rows : []
      for (const row of rows) {
        const rec = asRecord(row)
        if (!rec) continue
        const mid = asString(rec.model_id) || asString(rec.id) || asString(rec.model)
        if (mid !== id) continue
        const rate = parseMuseModelCatalogRate(rec.cost)
        if (rate) return rate
      }
    } catch {
      continue
    }
  }
  return null
}

export function estimateMuseCostUsd(args: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  rate: MuseModelRate | null | undefined
}): number | null {
  if (!args.rate) return null
  const input = nonNeg(args.inputTokens)
  const output = nonNeg(args.outputTokens)
  const cacheRead = nonNeg(args.cacheReadTokens ?? 0)
  // Billable input excludes cache-read tokens when the catalog has a cached rate
  // and cache-read is known; otherwise price the full input at the input rate.
  const billableInput =
    cacheRead > 0 && args.rate.cachedUsdPerMillion >= 0
      ? Math.max(0, input - cacheRead)
      : input
  const usd =
    (billableInput / 1_000_000) * args.rate.inputUsdPerMillion +
    (cacheRead / 1_000_000) * args.rate.cachedUsdPerMillion +
    (output / 1_000_000) * args.rate.outputUsdPerMillion
  return Number.isFinite(usd) ? usd : null
}

export interface MuseUsageReducer {
  readonly museSessionId: string
  readonly logPath: string
  ingestEnvelope(envelope: MuseEnvelope): void
  /** Ingest a complete session.jsonl line (parse + reduce). */
  ingestLine(line: string): void
  snapshot(rate?: MuseModelRate | null): MuseMeterSnapshot
}

function emptyRun(): PartialRunAccum {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    model: null,
    usageIds: [],
    hasCompletedCache: false
  }
}

function nestedEvent(envelope: MuseEnvelope): Record<string, unknown> | null {
  if (envelope.payload_type !== 'runtime.session') return null
  const event = asRecord(envelope.payload.event)
  return event ?? null
}

/**
 * Create a path-scoped usage reducer. Dedupe by envelope `id`, else
 * `(stream.id, sequence)`, and scope `usage_id` to the log path (subagent
 * synthetic ids are not globally unique).
 */
export function createMuseUsageReducer(args: {
  museSessionId: string
  logPath: string
}): MuseUsageReducer {
  const seenEnvelopeKeys = new Set<string>()
  const seenUsageKeys = new Set<string>()
  const byRunId = new Map<string, PartialRunAccum>()

  const ensureRun = (runId: string): PartialRunAccum => {
    let row = byRunId.get(runId)
    if (!row) {
      row = emptyRun()
      byRunId.set(runId, row)
    }
    return row
  }

  const ingestEnvelope = (envelope: MuseEnvelope): void => {
    const dedupeKey = envelope.id || `${envelope.stream.id}:${envelope.sequence}`
    if (seenEnvelopeKeys.has(dedupeKey)) return
    seenEnvelopeKeys.add(dedupeKey)

    const event = nestedEvent(envelope)
    if (!event) return
    const kind = asString(event.kind)
    const runId = asString(envelope.payload.run_id) || 'unknown'

    if (kind === 'goal_usage_attribution') {
      const record = asRecord(event.record)
      if (!record) return
      const family = asString(record.usage_family)
      const quantity = asRecord(record.quantity)
      if (!quantity) return
      if (family !== 'provider') return
      if (quantity.reported !== true) return
      const usageId = asString(record.usage_id) || dedupeKey
      const usageKey = `${args.logPath}::${usageId}`
      if (seenUsageKeys.has(usageKey)) return
      seenUsageKeys.add(usageKey)

      const row = ensureRun(runId)
      row.inputTokens += nonNeg(asFiniteNumber(quantity.input_tokens))
      row.outputTokens += nonNeg(asFiniteNumber(quantity.output_tokens))
      row.cachedTokens += nonNeg(asFiniteNumber(quantity.cached_tokens))
      row.reasoningTokens += nonNeg(asFiniteNumber(quantity.reasoning_tokens))
      row.usageIds.push(usageId)
      return
    }

    if (kind === 'model_completed') {
      const usage = asRecord(event.usage)
      const row = ensureRun(runId)
      if (usage) {
        // Enrich only — tokens already counted from goal_usage_attribution.
        row.cacheReadTokens += nonNeg(asFiniteNumber(usage.cache_read_tokens))
        row.cacheWriteTokens += nonNeg(asFiniteNumber(usage.cache_write_tokens))
        row.hasCompletedCache = true
        if (!row.reasoningTokens) {
          row.reasoningTokens = nonNeg(asFiniteNumber(usage.reasoning_tokens))
        }
      }
      row.durationMs += nonNeg(asFiniteNumber(event.duration_ms))
      const model = asString(event.model)
      if (model) row.model = model
    }
  }

  const snapshot = (rate?: MuseModelRate | null): MuseMeterSnapshot => {
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadInputTokens = 0
    let cacheCreationInputTokens = 0
    let reasoningTokens = 0
    let durationMs = 0
    let model: string | null = null
    const usageIds: string[] = []
    let anyCompletedCache = false
    let cachedTokensFallback = 0

    for (const row of byRunId.values()) {
      inputTokens += row.inputTokens
      outputTokens += row.outputTokens
      reasoningTokens += row.reasoningTokens
      durationMs += row.durationMs
      usageIds.push(...row.usageIds)
      if (row.model) model = row.model
      if (row.hasCompletedCache) {
        anyCompletedCache = true
        cacheReadInputTokens += row.cacheReadTokens
        cacheCreationInputTokens += row.cacheWriteTokens
      } else {
        cachedTokensFallback += row.cachedTokens
      }
    }
    if (!anyCompletedCache && cachedTokensFallback > 0) {
      cacheReadInputTokens = cachedTokensFallback
    }

    const hasReported = usageIds.length > 0
    const estimatedCostUsd = hasReported
      ? estimateMuseCostUsd({
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadInputTokens,
          rate
        })
      : null

    return {
      museSessionId: args.museSessionId,
      model,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs,
      estimatedCostUsd,
      tokenCountConfidence: hasReported ? 'reported' : 'unavailable',
      source: MUSE_USAGE_SOURCE,
      usageIds
    }
  }

  return {
    museSessionId: args.museSessionId,
    logPath: args.logPath,
    ingestEnvelope,
    ingestLine(line: string) {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const envelope = parseMuseEnvelope(JSON.parse(trimmed) as unknown)
        if (envelope) ingestEnvelope(envelope)
      } catch {
        /* skip malformed complete lines */
      }
    },
    snapshot
  }
}

/** Snapshot used when `--no-session-log` (or metering explicitly disabled). */
export function unavailableMuseMeterSnapshot(museSessionId: string): MuseMeterSnapshot {
  return {
    museSessionId,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    estimatedCostUsd: null,
    tokenCountConfidence: 'unavailable',
    source: MUSE_USAGE_SOURCE,
    usageIds: [],
    meteringDisabled: true
  }
}

/**
 * Project a meter snapshot into the snake_case stats object consumed by
 * `normalizeProviderUsage` / exit `recordUsage`.
 */
export function museMeterSnapshotToProviderStats(snapshot: MuseMeterSnapshot): MuseProviderStats {
  const stats: MuseProviderStats = {
    input_tokens: snapshot.inputTokens,
    output_tokens: snapshot.outputTokens,
    total_tokens: snapshot.totalTokens,
    cache_read_input_tokens: snapshot.cacheReadInputTokens,
    cache_creation_input_tokens: snapshot.cacheCreationInputTokens,
    reasoning_tokens: snapshot.reasoningTokens,
    duration_ms: snapshot.durationMs,
    _taskwraith_usage_source: MUSE_USAGE_SOURCE,
    [MUSE_TOKEN_COUNT_CONFIDENCE_KEY]: snapshot.tokenCountConfidence
  }
  if (snapshot.model) stats.model = snapshot.model
  if (snapshot.estimatedCostUsd != null) stats.total_cost_usd = snapshot.estimatedCostUsd
  return stats
}

/**
 * High-level entry: when session logging is disabled, return unavailable stats;
 * otherwise reduce the provided envelopes (or leave zeros/unavailable).
 */
export function meterMuseUsage(args: {
  museSessionId: string
  logPath: string
  sessionLogEnabled: boolean
  envelopes?: MuseEnvelope[]
  rate?: MuseModelRate | null
}): { snapshot: MuseMeterSnapshot; stats: MuseProviderStats } {
  if (!museMeteringAllowed(args.sessionLogEnabled)) {
    const snapshot = unavailableMuseMeterSnapshot(args.museSessionId)
    return { snapshot, stats: museMeterSnapshotToProviderStats(snapshot) }
  }
  const reducer = createMuseUsageReducer({
    museSessionId: args.museSessionId,
    logPath: args.logPath
  })
  for (const envelope of args.envelopes || []) reducer.ingestEnvelope(envelope)
  const snapshot = reducer.snapshot(args.rate)
  return { snapshot, stats: museMeterSnapshotToProviderStats(snapshot) }
}
