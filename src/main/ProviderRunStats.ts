import type { AgentRunRoute } from './run/AgentRunTypes'
import type { ProviderId } from './store/types'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../shared/usageAccounting'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function providerUsageNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function firstProviderUsageNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = providerUsageNumber(source, key)
    if (value > 0) return value
  }
  return 0
}

function sumProviderUsageNumbers(source: Record<string, unknown>, keys: string[]): number {
  return keys.reduce((total, key) => total + providerUsageNumber(source, key), 0)
}

function positiveMax(...values: Array<unknown>): number | undefined {
  const numbers = values
    .map((value) => (typeof value === 'string' ? Number(value.trim()) : Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (numbers.length === 0) return undefined
  return Math.trunc(Math.max(...numbers))
}

export function normalizeProviderUsage(
  provider: ProviderId,
  usage: Record<string, unknown>
): Record<string, unknown> {
  if (!isRecord(usage)) return usage

  const inputAlreadyIncludesCache = usageInputIncludesCache(usage)
  const inputBase =
    provider === 'kimi' && !inputAlreadyIncludesCache
      ? firstProviderUsageNumber(usage, [
          'input_other',
          'input_tokens',
          'inputTokens',
          'prompt_tokens',
          'promptTokens',
          'input'
        ])
      : firstProviderUsageNumber(usage, [
          'input_tokens',
          'inputTokens',
          'prompt_tokens',
          'promptTokens',
          'input',
          'input_other'
        ])
  const cacheReadInput = usageCacheReadInputTokens(usage)
  const cacheCreationInput = usageCacheCreationInputTokens(usage)
  const cacheInput = cacheReadInput + cacheCreationInput
  const audioInput = sumProviderUsageNumbers(usage, ['input_audio_tokens'])
  const outputBase = firstProviderUsageNumber(usage, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'output',
    'candidatesTokenCount'
  ])
  const outputAudio = sumProviderUsageNumbers(usage, ['output_audio_tokens'])
  const inputTokens = Math.trunc(
    inputBase + (inputAlreadyIncludesCache ? 0 : cacheInput + audioInput)
  )
  const outputTokens = Math.trunc(outputBase + outputAudio)
  const explicitTotal = firstProviderUsageNumber(usage, [
    'total_tokens',
    'totalTokens',
    'all_tokens',
    'total',
    'totalTokenCount'
  ])
  const computedTotal = inputTokens + outputTokens
  const totalTokens = Math.trunc(explicitTotal > 0 ? explicitTotal : computedTotal)

  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return usage

  const limits = {
    inputTokenLimit: positiveMax(
      usage.inputTokenLimit,
      usage.input_tokens_limit,
      usage.inputTokensLimit
    ),
    outputTokenLimit: positiveMax(
      usage.outputTokenLimit,
      usage.output_tokens_limit,
      usage.outputTokensLimit
    ),
    totalTokenLimit: positiveMax(
      usage.totalTokenLimit,
      usage.total_tokens_limit,
      usage.totalTokensLimit,
      usage.modelContextWindow
    )
  }

  return {
    ...usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(cacheReadInput > 0 ? { cache_read_input_tokens: cacheReadInput } : {}),
    ...(cacheCreationInput > 0 ? { cache_creation_input_tokens: cacheCreationInput } : {}),
    ...(limits.inputTokenLimit ? { inputTokenLimit: limits.inputTokenLimit } : {}),
    ...(limits.outputTokenLimit ? { outputTokenLimit: limits.outputTokenLimit } : {}),
    ...(limits.totalTokenLimit ? { totalTokenLimit: limits.totalTokenLimit } : {}),
    _taskwraith_input_includes_cache:
      inputAlreadyIncludesCache || cacheInput > 0 || audioInput > 0 || provider === 'kimi'
  }
}

function nestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return isRecord(value) ? value : {}
}

export function extractProviderUsage(
  provider: ProviderId,
  event: unknown
): Record<string, unknown> | null {
  if (!isRecord(event)) return null
  const message = nestedRecord(event, 'message')
  const params = nestedRecord(event, 'params')
  const payload = nestedRecord(params, 'payload')
  const usage = [
    event.usage,
    message.usage,
    event.stats,
    payload.token_usage,
    params.token_usage
  ].find(isRecord)
  if (!usage) return null
  return normalizeProviderUsage(provider, usage)
}

function canonicalUsageCount(stats: Record<string, unknown>, key: string): number {
  const value = stats[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
  }
  return 0
}

export function mergeProviderUsage(
  provider: ProviderId,
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!next) return previous
  const normalized = normalizeProviderUsage(provider, next)
  if (!previous) return normalized
  const merged: Record<string, unknown> = { ...previous, ...normalized }
  for (const key of [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'inputTokenLimit',
    'outputTokenLimit',
    'totalTokenLimit'
  ]) {
    const value = positiveMax(previous[key], normalized[key])
    if (value !== undefined) merged[key] = value
  }
  const mergedInput = canonicalUsageCount(merged, 'input_tokens')
  const mergedOutput = canonicalUsageCount(merged, 'output_tokens')
  const coherentTotal = positiveMax(merged.total_tokens, mergedInput + mergedOutput)
  if (coherentTotal !== undefined) merged.total_tokens = coherentTotal
  return merged
}

export function codexUsageToStats(
  tokenUsage: any,
  fallbackDurationMs = 0
): Record<string, unknown> {
  const last = tokenUsage?.last || tokenUsage?.total || {}
  const modelContextWindow = tokenUsage?.modelContextWindow
  return normalizeProviderUsage('codex', {
    ...last,
    totalTokenLimit: typeof modelContextWindow === 'number' ? modelContextWindow : undefined,
    duration_ms: fallbackDurationMs
  })
}

export function cursorUsageToStats(
  tokenUsage: unknown,
  fallbackDurationMs = 0
): Record<string, unknown> {
  const raw = isRecord(tokenUsage) ? tokenUsage : {}
  return normalizeProviderUsage('cursor', {
    input_tokens: canonicalUsageCount(raw, 'inputTokens'),
    output_tokens: canonicalUsageCount(raw, 'outputTokens'),
    cache_read_input_tokens: canonicalUsageCount(raw, 'cacheReadTokens'),
    cache_creation_input_tokens: canonicalUsageCount(raw, 'cacheWriteTokens'),
    duration_ms: fallbackDurationMs
  })
}

export function geminiUsageMetadataToStats(
  usage: Record<string, unknown> | null | undefined,
  durationMs = 0,
  options: { alreadyRecorded?: boolean } = {}
): Record<string, unknown> {
  const raw = usage || {}
  const cachedContentTokenCount = canonicalUsageCount(raw, 'cachedContentTokenCount')
  const promptTokenCount = canonicalUsageCount(raw, 'promptTokenCount')
  const candidatesTokenCount = canonicalUsageCount(raw, 'candidatesTokenCount')
  const thoughtsTokenCount = canonicalUsageCount(raw, 'thoughtsTokenCount')
  return normalizeProviderUsage('gemini', {
    ...raw,
    input_tokens: promptTokenCount,
    output_tokens: candidatesTokenCount,
    ...(cachedContentTokenCount > 0
      ? {
          cache_read_input_tokens: cachedContentTokenCount,
          _taskwraith_input_includes_cache: true
        }
      : {}),
    total_tokens:
      canonicalUsageCount(raw, 'totalTokenCount') ||
      promptTokenCount + candidatesTokenCount + thoughtsTokenCount,
    duration_ms: durationMs,
    ...(options.alreadyRecorded ? { _taskwraith_usage_recorded: true } : {})
  })
}

export function buildAgentExitStats(
  provider: ProviderId,
  route?: AgentRunRoute | null
): Record<string, unknown> | undefined {
  if (!route || typeof route !== 'object') return undefined
  const tokenUsage = (route as { tokenUsage?: unknown }).tokenUsage
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined
  const startedAt = (route as { startedAt?: unknown }).startedAt
  const durationMs =
    typeof startedAt === 'number' && Number.isFinite(startedAt)
      ? Math.max(0, Date.now() - startedAt)
      : 0
  if (provider === 'codex') {
    return codexUsageToStats(tokenUsage, durationMs)
  }
  return {
    ...(tokenUsage as Record<string, unknown>),
    duration_ms: durationMs
  }
}
