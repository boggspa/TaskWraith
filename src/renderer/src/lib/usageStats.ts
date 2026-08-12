import type { NormalizedEvent } from './GeminiAdapter'
import { isReasoningToolName, isToolResultEvent, isToolUseEvent } from './ToolParser'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../../../shared/usageAccounting'

export type UsageModelEntry = {
  model: string
  costRateModel?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  totalTokenLimit?: number
  resetAt?: string
  resetText?: string
  durationMs?: number
}

export const normalizeModelName = (model: string): string => {
  const lowered = (model || 'unknown').trim().toLowerCase()
  const compacted = lowered.replace(/[\s_-]+/g, '')
  if (compacted.includes('flashlite')) return 'Flash Lite'
  if (lowered.includes('flash')) return 'Flash'
  if (lowered.includes('pro')) return 'Pro'
  if (lowered.includes('2.0')) return model.trim() || 'unknown'
  return model.trim() || 'unknown'
}

const NON_EXECUTION_TOOL_EVENT_NAMES = new Set([
  'provider_warning',
  'update_topic',
  'summary',
  'intent',
  'progress',
  'tool_progress',
  'codex_reasoning',
  'codex_plan'
])

export const isProviderExecutionToolEvent = (event: NormalizedEvent): boolean => {
  if (event.type !== 'tool_event') return false
  const name = String(
    event.name || event.data?.tool_name || event.data?.toolName || event.data?.type || ''
  ).toLowerCase()
  if (isReasoningToolName(name)) return false
  if (NON_EXECUTION_TOOL_EVENT_NAMES.has(name)) return false
  return (
    event.isUse || event.isResult || isToolUseEvent(event.data) || isToolResultEvent(event.data)
  )
}

const extractNumeric = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.trunc(parsed)
}

const extractNestedNumber = (obj: any, paths: Array<string | string[]>): number | undefined => {
  for (const path of paths) {
    const keys = Array.isArray(path) ? path : [path]
    let cursor: any = obj
    let found = true
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
        found = false
        break
      }
      cursor = cursor[key]
    }
    if (found) {
      const parsed = extractNumeric(cursor)
      if (parsed !== undefined && parsed > 0) {
        return parsed
      }
    }
  }

  return undefined
}

const extractNestedValue = (obj: any, paths: Array<string | string[]>): unknown => {
  for (const path of paths) {
    const keys = Array.isArray(path) ? path : [path]
    let cursor: any = obj
    let found = true
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
        found = false
        break
      }
      cursor = cursor[key]
    }
    if (found && cursor !== undefined && cursor !== null && cursor !== '') {
      return cursor
    }
  }

  return undefined
}

const normalizeResetValue = (value: unknown): { resetAt?: string; resetText?: string } => {
  if (value === undefined || value === null || value === '') {
    return {}
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestampMs = value > 1_000_000_000_000 ? value : value * 1000
    return { resetAt: new Date(timestampMs).toISOString() }
  }

  const text = String(value).trim()
  if (!text) {
    return {}
  }

  const timeOnlyMatch = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i)
  if (timeOnlyMatch) {
    let hours = Number(timeOnlyMatch[1])
    const minutes = Number(timeOnlyMatch[2])
    const meridiem = timeOnlyMatch[3]?.toLowerCase()
    if (meridiem === 'pm' && hours < 12) hours += 12
    if (meridiem === 'am' && hours === 12) hours = 0

    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      const parsed = new Date()
      parsed.setHours(hours, minutes, 0, 0)
      if (parsed.getTime() < Date.now() - 60_000) {
        parsed.setDate(parsed.getDate() + 1)
      }
      return { resetAt: parsed.toISOString(), resetText: text }
    }
  }

  const monthNames: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  }
  const dayMonthMatch = text.match(/^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/i)
  if (dayMonthMatch) {
    const day = Number(dayMonthMatch[1])
    const month = monthNames[dayMonthMatch[2].toLowerCase()]
    const explicitYear = dayMonthMatch[3] ? Number(dayMonthMatch[3]) : undefined
    if (day >= 1 && day <= 31 && month !== undefined) {
      const now = new Date()
      let year = explicitYear || now.getFullYear()
      let parsed = new Date(year, month, day, 0, 0, 0, 0)
      if (
        !explicitYear &&
        parsed.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      ) {
        year += 1
        parsed = new Date(year, month, day, 0, 0, 0, 0)
      }
      return { resetAt: parsed.toISOString(), resetText: text }
    }
  }

  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) {
    return { resetAt: new Date(parsed).toISOString(), resetText: text }
  }

  return { resetText: text }
}

const extractUsageReset = (stats: any): { resetAt?: string; resetText?: string } => {
  if (!stats || typeof stats !== 'object') {
    return {}
  }

  return normalizeResetValue(
    extractNestedValue(stats, [
      ['reset_at'],
      ['resetAt'],
      ['resets_at'],
      ['resetsAt'],
      ['reset_time'],
      ['resetTime'],
      ['next_reset'],
      ['nextReset'],
      ['next_reset_at'],
      ['nextResetAt'],
      ['quota', 'reset_at'],
      ['quota', 'resetAt'],
      ['quota', 'next_reset'],
      ['usage', 'reset_at'],
      ['usage', 'resetAt'],
      ['limits', 'reset_at'],
      ['limits', 'resetAt'],
      ['usageLimits', 'reset_at'],
      ['usageLimits', 'resetAt']
    ])
  )
}

export const mergeUsageReset = (
  current: { resetAt?: string; resetText?: string },
  incoming: { resetAt?: string; resetText?: string }
): { resetAt?: string; resetText?: string } => {
  if (!incoming.resetAt && !incoming.resetText) {
    return current
  }
  if (!current.resetAt && !current.resetText) {
    return incoming
  }
  if (incoming.resetAt && current.resetAt) {
    return new Date(incoming.resetAt).getTime() >= new Date(current.resetAt).getTime()
      ? incoming
      : current
  }
  return incoming.resetAt ? incoming : current
}

export const extractResetHintsFromText = (
  text: string
): Array<{ model: string; resetAt?: string; resetText?: string }> => {
  const hints: Array<{ model: string; resetAt?: string; resetText?: string }> = []
  const lines = text.replace(/\r/g, '').split('\n')
  const modelPattern =
    /(flash[-\s]?lite|flash|pro|gemini[-\w.]*flash[-\w.]*lite|gemini[-\w.]*flash|gemini[-\w.]*pro)/i

  for (const line of lines) {
    if (!/reset|resets|refresh|renews|available/i.test(line)) {
      continue
    }
    const modelMatch = line.match(modelPattern)
    if (!modelMatch) {
      continue
    }
    const resetMatch = line.match(
      /(?:reset|resets|refresh(?:es)?|renews|available again)\s*(?:at|on|in|:)?\s*([^|,;]+)/i
    )
    const reset = normalizeResetValue(resetMatch?.[1] || line.trim())
    hints.push({
      model: normalizeModelName(modelMatch[1]),
      ...reset
    })
  }

  return hints
}

export const extractUsageLimits = (
  stats: any
): { inputTokenLimit?: number; outputTokenLimit?: number; totalTokenLimit?: number } => {
  if (!stats || typeof stats !== 'object') {
    return {}
  }

  const inputTokenLimit = extractNestedNumber(stats, [
    ['inputTokensLimit'],
    ['input_tokens_limit'],
    ['input_limit_tokens'],
    ['tokenLimits', 'input'],
    ['token_limits', 'input'],
    ['usageLimits', 'input_tokens'],
    ['limits', 'input_tokens'],
    'inputTokenLimit',
    'inputLimit',
    'input_limit'
  ])

  const outputTokenLimit = extractNestedNumber(stats, [
    ['outputTokensLimit'],
    ['output_tokens_limit'],
    ['output_limit_tokens'],
    ['tokenLimits', 'output'],
    ['token_limits', 'output'],
    ['usageLimits', 'output_tokens'],
    ['limits', 'output_tokens'],
    'outputTokenLimit',
    'outputLimit',
    'output_limit'
  ])

  const totalTokenLimit = extractNestedNumber(stats, [
    ['totalTokensLimit'],
    ['total_tokens_limit'],
    ['total_limit_tokens'],
    ['tokenLimits', 'total'],
    ['token_limits', 'total'],
    ['usageLimits', 'total_tokens'],
    ['limits', 'total_tokens'],
    ['limits', 'total'],
    'totalTokenLimit',
    'totalLimit',
    'total_limit'
  ])

  return {
    inputTokenLimit,
    outputTokenLimit,
    totalTokenLimit
  }
}

export const extractUsageCount = (stats: any, keys: Array<string | string[]>): number => {
  return extractNestedNumber(stats, keys) || 0
}

const sumUsageCounts = (stats: any, keys: Array<string | string[]>): number => {
  return keys.reduce((total, key) => total + extractUsageCount(stats, [key]), 0)
}

export const extractUsageCountsFromCandidate = (
  stats: any
): { inputTokens: number; outputTokens: number; totalTokens: number } => {
  const inputBaseTokens = extractUsageCount(stats, [
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
  const inputIncludesCache = usageInputIncludesCache(stats)
  const cacheInputTokens = inputIncludesCache
    ? 0
    : usageCacheReadInputTokens(stats) + usageCacheCreationInputTokens(stats)
  const inputAudioTokens = inputIncludesCache
    ? 0
    : extractUsageCount(stats, [['input_audio_tokens'], ['inputAudioTokens']])
  const inputTokens = inputBaseTokens + cacheInputTokens + inputAudioTokens

  const outputBaseTokens = extractUsageCount(stats, [
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
  const outputTokens = outputBaseTokens + sumUsageCounts(stats, [['output_audio_tokens']])

  const explicitTotalTokens = extractUsageCount(stats, [
    ['total_tokens'],
    ['totalTokens'],
    ['all_tokens'],
    ['total'],
    ['tokens', 'total'],
    ['tokenCounts', 'total'],
    ['token_counts', 'total']
  ])
  const totalTokens = explicitTotalTokens > 0 ? explicitTotalTokens : inputTokens + outputTokens

  return {
    inputTokens: Math.trunc(Math.max(0, inputTokens)),
    outputTokens: Math.trunc(Math.max(0, outputTokens)),
    totalTokens: Math.trunc(Math.max(0, totalTokens))
  }
}

export const extractUsageCostUsd = (stats: any): number => {
  const raw = extractNestedValue(stats, [
    ['cost_usd'],
    ['costUsd'],
    ['total_cost_usd'],
    ['totalCostUsd'],
    ['usage', 'cost_usd'],
    ['usage', 'costUsd'],
    ['billing', 'cost_usd'],
    ['billing', 'costUsd']
  ])
  if (raw === undefined || raw === null || raw === '') return 0
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const isNonEmptyObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const extractCacheUsageCounts = (
  stats: any
): { cacheReadInputTokens: number; cacheCreationInputTokens: number } => ({
  cacheReadInputTokens: usageCacheReadInputTokens(stats),
  cacheCreationInputTokens: usageCacheCreationInputTokens(stats)
})

const persistedNonCacheInputTokens = (
  stats: any,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number
): number => {
  const reportedInputTokens = extractUsageCount(stats, [
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
  const inputIncludesCache = usageInputIncludesCache(stats)
  const inputAudioTokens = inputIncludesCache
    ? 0
    : extractUsageCount(stats, [['input_audio_tokens'], ['inputAudioTokens']])

  return Math.max(
    0,
    reportedInputTokens -
      (inputIncludesCache ? cacheReadInputTokens + cacheCreationInputTokens : 0) +
      inputAudioTokens
  )
}

const buildUsageModelEntry = (
  modelName: string,
  candidate: any,
  fallbackModel: string
): UsageModelEntry | null => {
  if (!isNonEmptyObject(candidate)) {
    return null
  }

  const resolvedModel = modelName?.trim() || fallbackModel || 'unknown'
  const counts = extractUsageCountsFromCandidate(candidate)
  const cacheCounts = extractCacheUsageCounts(candidate)
  const inputTokens = persistedNonCacheInputTokens(
    candidate,
    cacheCounts.cacheReadInputTokens,
    cacheCounts.cacheCreationInputTokens
  )
  const limits = extractUsageLimits(candidate)
  const reset = extractUsageReset(candidate)
  const durationMs = extractUsageCount(candidate, [['duration_ms'], ['durationMs']])
  const costRateModel =
    typeof candidate._taskwraith_cost_rate_model === 'string'
      ? candidate._taskwraith_cost_rate_model.trim()
      : ''

  const hasAnyCount = counts.inputTokens > 0 || counts.outputTokens > 0 || counts.totalTokens > 0
  const hasAnyLimit = Boolean(
    limits.inputTokenLimit || limits.outputTokenLimit || limits.totalTokenLimit
  )
  const hasAnyReset = Boolean(reset.resetAt || reset.resetText)
  const hasAnyDuration = durationMs > 0

  if (!hasAnyCount && !hasAnyLimit && !hasAnyReset && !hasAnyDuration) {
    return null
  }

  return {
    model: resolvedModel,
    ...(costRateModel ? { costRateModel } : {}),
    ...counts,
    inputTokens,
    ...(cacheCounts.cacheReadInputTokens > 0
      ? { cacheReadInputTokens: cacheCounts.cacheReadInputTokens }
      : {}),
    ...(cacheCounts.cacheCreationInputTokens > 0
      ? { cacheCreationInputTokens: cacheCounts.cacheCreationInputTokens }
      : {}),
    ...limits,
    ...reset,
    ...(hasAnyDuration ? { durationMs } : {})
  }
}

export const extractModelUsageEntriesFromStats = (
  stats: any,
  fallbackModel: string
): UsageModelEntry[] => {
  if (!isNonEmptyObject(stats)) {
    return [
      {
        model: fallbackModel || 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0
      }
    ]
  }

  const entries: UsageModelEntry[] = []
  const modelStats = stats.models

  if (Array.isArray(modelStats) && modelStats.length > 0) {
    for (const item of modelStats) {
      if (isNonEmptyObject(item)) {
        const next = buildUsageModelEntry(
          (item.model || item.name || item.id || '').toString(),
          item,
          fallbackModel
        )
        if (next) entries.push(next)
      } else if (typeof item === 'string' && item.trim()) {
        entries.push({
          model: item.trim(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          durationMs: 0
        })
      }
    }
  } else if (isNonEmptyObject(modelStats)) {
    for (const [modelName, item] of Object.entries(modelStats)) {
      const next = buildUsageModelEntry(modelName, item, fallbackModel)
      if (next) {
        entries.push(next)
      }
    }
  }

  if (entries.length > 0) {
    return entries
  }

  const fallback = buildUsageModelEntry(fallbackModel, stats, fallbackModel)
  if (fallback) {
    return [fallback]
  }

  return [
    {
      model: fallbackModel || 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0
    }
  ]
}
