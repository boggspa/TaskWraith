import type { AgentRunRoute } from './run/AgentRunTypes'
import type { ProviderId } from './store/types'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../shared/usageAccounting'
import { withContextUsageSnapshot } from '../shared/contextUsage'
import {
  GROK_46_MODEL_ID,
  cursorGrokBaseModelId,
  cursorGrokFastFromModelId
} from '../shared/grok45Models'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const codexUsageObservedAtByProviderSnapshot = new WeakMap<object, number>()

function codexUsageObservedAt(tokenUsage: unknown, receivedAt: number): number {
  if (!isRecord(tokenUsage)) return receivedAt
  const previous = codexUsageObservedAtByProviderSnapshot.get(tokenUsage)
  if (previous !== undefined) return previous
  codexUsageObservedAtByProviderSnapshot.set(tokenUsage, receivedAt)
  return receivedAt
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
  const normalized = normalizeProviderUsage(provider, usage)
  // Claude's assistant envelope is one atomic model invocation. A single
  // agent turn can emit several of these around tool calls, while the terminal
  // result carries an aggregate. Keep the latest atomic window beside the
  // aggregate spend counters so the context meter never combines maxima from
  // different invocations.
  return provider === 'claude' && event.type === 'assistant' && usage === message.usage
    ? withContextUsageSnapshot(normalized, {
        source: 'provider-last-invocation',
        precision: 'exact'
      })
    : normalized
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
  fallbackDurationMs = 0,
  receivedAt = Date.now()
): Record<string, unknown> {
  const last = tokenUsage?.last || tokenUsage?.total || {}
  const modelContextWindow = tokenUsage?.modelContextWindow
  const normalized = normalizeProviderUsage('codex', {
    ...last,
    totalTokenLimit: typeof modelContextWindow === 'number' ? modelContextWindow : undefined,
    duration_ms: fallbackDurationMs
  })
  return tokenUsage?.last
    ? withContextUsageSnapshot(normalized, {
        source: 'provider-last-invocation',
        precision: 'exact',
        // App-server terminal projection reuses the same provider snapshot
        // received by thread/tokenUsage/updated. Keep that receipt time stable
        // so a later terminal frame cannot make pre-compaction usage appear
        // newer than durable compaction evidence.
        observedAt: codexUsageObservedAt(tokenUsage, receivedAt)
      })
    : normalized
}

export function cursorUsageToStats(
  tokenUsage: unknown,
  fallbackDurationMs = 0,
  costRateModel?: string
): Record<string, unknown> {
  const raw = isRecord(tokenUsage) ? tokenUsage : {}
  return {
    ...normalizeProviderUsage('cursor', {
      input_tokens: canonicalUsageCount(raw, 'inputTokens'),
      output_tokens: canonicalUsageCount(raw, 'outputTokens'),
      cache_read_input_tokens: canonicalUsageCount(raw, 'cacheReadTokens'),
      cache_creation_input_tokens: canonicalUsageCount(raw, 'cacheWriteTokens'),
      duration_ms: fallbackDurationMs
    }),
    ...(costRateModel ? { _taskwraith_cost_rate_model: costRateModel } : {})
  }
}

/**
 * Cursor reports the selected Grok family as its base catalogue id even when
 * Fast is a separate launch control. Preserve the equivalent published rate
 * row without changing the model shown in the transcript or picker.
 */
export function cursorCostRateModel(
  model: string | null | undefined,
  fastMode = false
): string | undefined {
  if (cursorGrokBaseModelId(model) !== GROK_46_MODEL_ID) return undefined
  return fastMode || cursorGrokFastFromModelId(model)
    ? `${GROK_46_MODEL_ID}-fast`
    : GROK_46_MODEL_ID
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
  const explicitTotalTokenCount = Number(raw.totalTokenCount)
  const hasExplicitTotalTokenCount =
    raw.totalTokenCount !== undefined &&
    Number.isFinite(explicitTotalTokenCount) &&
    explicitTotalTokenCount >= 0
  const normalized = normalizeProviderUsage('gemini', {
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
  return withContextUsageSnapshot(normalized, {
    source: 'provider-last-invocation',
    // A provider total is the coverage proof for Gemini: without it, omitted
    // thoughts/candidates fields are indistinguishable from genuine zeroes.
    precision: hasExplicitTotalTokenCount ? 'exact' : 'derived'
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
