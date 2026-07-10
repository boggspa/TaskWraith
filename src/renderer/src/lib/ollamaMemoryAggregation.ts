/**
 * ollamaMemoryAggregation — per-window AVERAGE llama-server RAM for the
 * Model Usage card (View B) and Settings → Model usage table.
 *
 * Ollama is local/free, so its cost sections show memory semantics instead of
 * token/cost roll-ups: for each rolling window we average per-run peak RSS and
 * periodic sample counts (not cumulative token totals).
 */

import type { UsageRecord } from '../../../main/store/types'
import {
  extractOllamaPeakRssGb,
  extractOllamaSampleCount,
  formatOllamaSummaryMemoryGb,
  ollamaMemoryUsageFields
} from './ollamaMemoryDisplay'
import {
  API_SPEND_WINDOW_MS,
  type ApiSpendWindowKey
} from './apiSpendAggregation'
import {
  MODEL_USAGE_WINDOW_MS,
  MODEL_USAGE_WINDOW_ORDER,
  type ModelUsageWindowKey
} from './modelUsageTable'
import { canonicalModelIdForProvider } from './modelDisplayName'

/** Structural chat/run shapes so BOTH full ChatRecords (getChats) and lean
 * ChatListItems (getChatList, runs stripped but runsSummary carried) satisfy
 * the aggregation without adapters. */
export interface OllamaMemoryRunSource {
  runId: string
  provider?: string
  startedAt?: string
  endedAt?: string
  requestedModel?: string
  actualModel?: string
  stats?: unknown
}

export interface OllamaMemoryChatSource {
  workspaceId?: string
  appChatId: string
  runs?: OllamaMemoryRunSource[] | null
  /** ChatListItem's lean projection — preferred over runs when present
   * (list items hard-code runs: []). */
  runsSummary?: OllamaMemoryRunSource[] | null
}

interface MemoryAccumulator {
  peakSumGb: number
  sampleSum: number
  runs: number
}

export interface OllamaMemoryWindowTotals {
  /** Mean per-run peak RSS (GB) across runs in this window. */
  avgPeakRssGb: number
  /** Mean periodic sample count across runs in this window. */
  avgSampleCount: number
  runs: number
}

export interface OllamaMemorySpendTotals {
  provider: 'ollama'
  day: OllamaMemoryWindowTotals
  week: OllamaMemoryWindowTotals
  month: OllamaMemoryWindowTotals
}

export interface OllamaMemoryModelRow {
  model: string
  windows: Record<ModelUsageWindowKey, OllamaMemoryWindowTotals>
}

export interface OllamaMemoryProviderGroup {
  provider: 'ollama'
  models: OllamaMemoryModelRow[]
  totals: Record<ModelUsageWindowKey, OllamaMemoryWindowTotals>
}

const emptyAccumulator = (): MemoryAccumulator => ({
  peakSumGb: 0,
  sampleSum: 0,
  runs: 0
})

const emptySpendWindowSet = (): Record<ApiSpendWindowKey, MemoryAccumulator> => ({
  day: emptyAccumulator(),
  week: emptyAccumulator(),
  month: emptyAccumulator()
})

const emptyTableWindowSet = (): Record<ModelUsageWindowKey, MemoryAccumulator> => ({
  h1: emptyAccumulator(),
  h24: emptyAccumulator(),
  d7: emptyAccumulator(),
  d30: emptyAccumulator(),
  d90: emptyAccumulator()
})

const applyRecord = (acc: MemoryAccumulator, record: UsageRecord): void => {
  const peakGb = extractOllamaPeakRssGb(record)
  if (peakGb <= 0) return
  acc.peakSumGb += peakGb
  acc.sampleSum += extractOllamaSampleCount(record)
  acc.runs += 1
}

const finalizeWindow = (acc: MemoryAccumulator): OllamaMemoryWindowTotals => {
  if (acc.runs <= 0) {
    return { avgPeakRssGb: 0, avgSampleCount: 0, runs: 0 }
  }
  return {
    avgPeakRssGb: acc.peakSumGb / acc.runs,
    avgSampleCount: acc.sampleSum / acc.runs,
    runs: acc.runs
  }
}

const finalizeSpendWindowSet = (
  set: Record<ApiSpendWindowKey, MemoryAccumulator>
): Record<ApiSpendWindowKey, OllamaMemoryWindowTotals> => ({
  day: finalizeWindow(set.day),
  week: finalizeWindow(set.week),
  month: finalizeWindow(set.month)
})

const finalizeTableWindowSet = (
  set: Record<ModelUsageWindowKey, MemoryAccumulator>
): Record<ModelUsageWindowKey, OllamaMemoryWindowTotals> => ({
  h1: finalizeWindow(set.h1),
  h24: finalizeWindow(set.h24),
  d7: finalizeWindow(set.d7),
  d30: finalizeWindow(set.d30),
  d90: finalizeWindow(set.d90)
})

const modelKeyFor = (record: UsageRecord): string => {
  const raw = (record.model || '').trim()
  return canonicalModelIdForProvider('ollama', raw || 'ollama') || 'ollama'
}

const isOllamaMemoryRecord = (record: UsageRecord): boolean =>
  record.provider === 'ollama' && extractOllamaPeakRssGb(record) > 0

const chatRunTimestampMs = (endedAt?: string, startedAt?: string): number | null => {
  const ended = endedAt ? Date.parse(endedAt) : Number.NaN
  if (Number.isFinite(ended)) return ended
  const started = startedAt ? Date.parse(startedAt) : Number.NaN
  return Number.isFinite(started) ? started : null
}

/**
 * Reconstruct memory-bearing usage rows from persisted chat transcripts.
 * Completed Ollama runs store peak RSS + sample counts on `ChatRun.stats`
 * long before `usage.json` learned those fields — this lets the RAM views
 * populate from existing threads without waiting for new runs.
 */
export function deriveOllamaMemoryUsageFromChats(chats: OllamaMemoryChatSource[]): UsageRecord[] {
  const derived: UsageRecord[] = []
  if (!Array.isArray(chats)) return derived

  for (const chat of chats) {
    // ChatListItems always carry runsSummary (and hard-code runs: []);
    // full ChatRecords carry runs. Prefer the summary when present.
    const runs = chat?.runsSummary ?? chat?.runs
    if (!Array.isArray(runs) || runs.length === 0) continue
    const workspaceId = chat.workspaceId || 'global'
    const chatId = chat.appChatId

    for (const run of runs) {
      if (run?.provider !== 'ollama') continue
      const memory = ollamaMemoryUsageFields(run.stats)
      if (!memory.ollamaMemoryPeakRssGb) continue
      const timestamp = chatRunTimestampMs(run.endedAt, run.startedAt)
      if (timestamp == null) continue

      derived.push({
        id: `chat-run-${run.runId}`,
        provider: 'ollama',
        timestamp,
        workspaceId,
        chatId,
        runId: run.runId,
        usageKind: 'run',
        model: (run.actualModel || run.requestedModel || 'ollama').trim() || 'ollama',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0,
        ...memory
      })
    }
  }
  return derived
}

/**
 * Merge `usage.json` rows with chat-derived Ollama memory rows. Patches
 * historical usage records that lack memory fields and appends chat-only
 * runs that never reached usage.json.
 */
export function mergeOllamaMemoryUsageRecords(
  usageRecords: UsageRecord[],
  chats: OllamaMemoryChatSource[]
): UsageRecord[] {
  const merged = [...usageRecords]
  const indexByRunId = new Map<string, number>()
  for (let index = 0; index < merged.length; index += 1) {
    const record = merged[index]
    if (record?.provider === 'ollama' && record.runId) {
      indexByRunId.set(record.runId, index)
    }
  }

  for (const derived of deriveOllamaMemoryUsageFromChats(chats)) {
    const existingIndex = derived.runId ? indexByRunId.get(derived.runId) : undefined
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]
      if (!extractOllamaPeakRssGb(existing)) {
        merged[existingIndex] = {
          ...existing,
          ollamaMemoryPeakRssGb: derived.ollamaMemoryPeakRssGb,
          ollamaMemorySampleCount: derived.ollamaMemorySampleCount
        }
      }
      continue
    }
    merged.push(derived)
    if (derived.runId) indexByRunId.set(derived.runId, merged.length - 1)
  }

  return merged
}

/** Compact RAM label for table/card cells (e.g. `12 GB avg`, or `12GB` in table compact mode). */
export function formatOllamaMemoryAvgCell(avgPeakRssGb: number, compact = false): string {
  if (!Number.isFinite(avgPeakRssGb) || avgPeakRssGb <= 0) return '—'
  if (compact) {
    if (avgPeakRssGb >= 10) return `${Math.round(avgPeakRssGb)}GB`
    const fixed = avgPeakRssGb >= 1 ? avgPeakRssGb.toFixed(1) : avgPeakRssGb.toFixed(2)
    return `${fixed.replace(/\.0+$/, '')}GB`
  }
  const label = formatOllamaSummaryMemoryGb(avgPeakRssGb)
  return label ? `${label} avg` : '—'
}

/** Compact periodic-sample label (e.g. `8 samples avg`, or `8 avg` in table compact mode). */
export function formatOllamaSampleAvgCell(
  avgSampleCount: number,
  runs: number,
  compact = false
): string {
  if (runs <= 0) return '—'
  if (avgSampleCount > 0) {
    const rounded =
      avgSampleCount >= 10 ? Math.round(avgSampleCount) : Number(avgSampleCount.toFixed(1))
    if (compact) return `${rounded} avg`
    return `${rounded} samples avg`
  }
  if (compact) return runs === 1 ? '1 avg' : `${runs} avg`
  return runs === 1 ? '1 run' : `${runs} runs`
}

/**
 * Sidebar View B: Day / 7d / 30d average peak RAM for Ollama runs.
 * Returns `null` when there is no memory-bearing activity in the 30-day window.
 */
export function buildOllamaMemorySpend(
  records: UsageRecord[],
  now: number = Date.now()
): OllamaMemorySpendTotals | null {
  const cutoffs = {
    day: now - API_SPEND_WINDOW_MS.day,
    week: now - API_SPEND_WINDOW_MS.week,
    month: now - API_SPEND_WINDOW_MS.month
  }
  const totals = emptySpendWindowSet()

  for (const record of records) {
    if (!record || record.usageKind === 'reset_hint') continue
    if (!isOllamaMemoryRecord(record)) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp)) continue
    if (timestamp > now || timestamp < cutoffs.month) continue

    applyRecord(totals.month, record)
    if (timestamp >= cutoffs.week) applyRecord(totals.week, record)
    if (timestamp >= cutoffs.day) applyRecord(totals.day, record)
  }

  if (totals.month.runs <= 0) return null

  return {
    provider: 'ollama',
    ...finalizeSpendWindowSet(totals)
  }
}

/**
 * Settings table: per-model average peak RAM across the five rolling windows.
 * Ollama is local-only — always reads TaskWraith's own usage records.
 */
export function buildOllamaMemoryModelTable(
  records: UsageRecord[],
  now: number = Date.now()
): OllamaMemoryProviderGroup | null {
  const cutoffs = {
    h1: now - MODEL_USAGE_WINDOW_MS.h1,
    h24: now - MODEL_USAGE_WINDOW_MS.h24,
    d7: now - MODEL_USAGE_WINDOW_MS.d7,
    d30: now - MODEL_USAGE_WINDOW_MS.d30,
    d90: now - MODEL_USAGE_WINDOW_MS.d90
  }

  const buckets = new Map<string, Record<ModelUsageWindowKey, MemoryAccumulator>>()

  for (const record of records) {
    if (!record || record.usageKind === 'reset_hint') continue
    if (!isOllamaMemoryRecord(record)) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp)) continue
    if (timestamp > now || timestamp < cutoffs.d90) continue

    const modelKey = modelKeyFor(record)
    let windowSet = buckets.get(modelKey)
    if (!windowSet) {
      windowSet = emptyTableWindowSet()
      buckets.set(modelKey, windowSet)
    }

    applyRecord(windowSet.d90, record)
    if (timestamp >= cutoffs.d30) applyRecord(windowSet.d30, record)
    if (timestamp >= cutoffs.d7) applyRecord(windowSet.d7, record)
    if (timestamp >= cutoffs.h24) applyRecord(windowSet.h24, record)
    if (timestamp >= cutoffs.h1) applyRecord(windowSet.h1, record)
  }

  if (buckets.size === 0) return null

  const providerTotals = emptyTableWindowSet()
  const models: OllamaMemoryModelRow[] = []

  for (const [model, windowSet] of buckets.entries()) {
    models.push({
      model,
      windows: finalizeTableWindowSet(windowSet)
    })
    for (const key of MODEL_USAGE_WINDOW_ORDER) {
      const acc = windowSet[key]
      providerTotals[key].peakSumGb += acc.peakSumGb
      providerTotals[key].sampleSum += acc.sampleSum
      providerTotals[key].runs += acc.runs
    }
  }

  models.sort(
    (a, b) =>
      b.windows.d90.avgPeakRssGb - a.windows.d90.avgPeakRssGb || a.model.localeCompare(b.model)
  )

  return {
    provider: 'ollama',
    models,
    totals: finalizeTableWindowSet(providerTotals)
  }
}
