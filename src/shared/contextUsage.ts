import { statsAreEstimated } from './tokenEstimate'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from './usageAccounting'

/**
 * Atomic context-window usage captured from the provider's latest model
 * invocation. It deliberately lives beside aggregate run billing stats: one
 * agent turn can make several model requests, so summing or taking maxima is
 * useful for spend but is not an honest measure of the tokens resident in the
 * model's current window.
 */
export const TASKWRAITH_CONTEXT_USAGE_KEY = '_taskwraith_context_usage'

export type ContextUsagePrecision = 'exact' | 'derived' | 'estimated'
export type ContextUsageSource =
  | 'provider-last-invocation'
  | 'provider-compaction'
  | 'provider-turn-aggregate'
  | 'post-compaction-unknown'
  | 'host-estimate'

export interface ContextUsageSnapshot {
  /** Host receipt time for this atomic provider snapshot. Used only to order it
   * against durable compaction evidence from the same seat. */
  observedAt?: number
  /** Tokens resident in the window after the sampled invocation. */
  contextTokens: number
  /** Provider total for the sampled invocation. Normally equals contextTokens. */
  totalTokens: number
  /** Cache-inclusive prompt/input tokens. */
  inputTokens: number
  /** Prompt tokens which were neither cache reads nor cache writes. */
  freshInputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Provider output, including reasoning when the provider reports it as a subset. */
  outputTokens: number
  /** User-visible output after a reported reasoning subset is removed. */
  visibleOutputTokens: number
  /** Reasoning/thinking tokens when the provider exposes them. */
  reasoningTokens: number
  /** Tool-definition/tool-use prompt tokens when the provider exposes them.
   * This is a subset of inputTokens and must not be added to the total. */
  toolUsePromptTokens: number
  /** Tokens present in the provider total but not classified by available fields. */
  unclassifiedTokens: number
  source: ContextUsageSource
  precision: ContextUsagePrecision
}

type UsageRecord = Record<string, unknown>

function record(value: unknown): UsageRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UsageRecord) : null
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined
}

function nestedValue(source: UsageRecord, path: readonly string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    const next = record(current)
    if (!next || !(key in next)) return undefined
    current = next[key]
  }
  return current
}

function maxAlias(source: UsageRecord, paths: ReadonlyArray<readonly string[]>): number {
  let largest = 0
  for (const path of paths) {
    largest = Math.max(largest, nonNegativeInteger(nestedValue(source, path)))
  }
  return largest
}

function hasPositiveAlias(source: UsageRecord, paths: ReadonlyArray<readonly string[]>): boolean {
  return maxAlias(source, paths) > 0
}

const INPUT_PATHS = [
  ['input_tokens'],
  ['inputTokens'],
  ['prompt_tokens'],
  ['promptTokens'],
  ['promptTokenCount'],
  ['input'],
  ['input_other'],
  ['counts', 'input'],
  ['counts', 'prompt'],
  ['tokenCounts', 'input'],
  ['token_counts', 'input']
] as const

const OUTPUT_PATHS = [
  ['output_tokens'],
  ['outputTokens'],
  ['completion_tokens'],
  ['completionTokens'],
  ['candidatesTokenCount'],
  ['output'],
  ['counts', 'output'],
  ['counts', 'completion'],
  ['tokenCounts', 'output'],
  ['token_counts', 'output']
] as const

const TOTAL_PATHS = [
  ['total_tokens'],
  ['totalTokens'],
  ['all_tokens'],
  ['totalTokenCount'],
  ['total'],
  ['tokens', 'total'],
  ['tokenCounts', 'total'],
  ['token_counts', 'total']
] as const

const REASONING_SUBSET_PATHS = [
  ['reasoningOutputTokens'],
  ['reasoning_output_tokens'],
  ['reasoning_tokens'],
  ['output_tokens_details', 'reasoning_tokens'],
  ['outputTokensDetails', 'reasoningTokens'],
  ['completion_tokens_details', 'reasoning_tokens'],
  ['completionTokensDetails', 'reasoningTokens']
] as const

const SEPARATE_REASONING_PATHS = [['thoughtsTokenCount'], ['thought_tokens']] as const

const TOOL_PROMPT_PATHS = [
  ['toolUsePromptTokenCount'],
  ['tool_use_prompt_token_count'],
  ['toolPromptTokens'],
  ['tool_prompt_tokens']
] as const

function cacheReadTokens(source: UsageRecord): number {
  return Math.max(
    usageCacheReadInputTokens(source),
    nonNegativeInteger(source.cachedContentTokenCount),
    nonNegativeInteger(nestedValue(source, ['input_tokens_details', 'cached_tokens'])),
    nonNegativeInteger(nestedValue(source, ['inputTokensDetails', 'cachedTokens'])),
    nonNegativeInteger(nestedValue(source, ['prompt_tokens_details', 'cached_tokens'])),
    nonNegativeInteger(nestedValue(source, ['promptTokensDetails', 'cachedTokens']))
  )
}

function inputIncludesCache(source: UsageRecord): boolean {
  return (
    usageInputIncludesCache(source) ||
    nonNegativeInteger(source.cachedContentTokenCount) > 0 ||
    hasPositiveAlias(source, [
      ['input_tokens_details', 'cached_tokens'],
      ['inputTokensDetails', 'cachedTokens'],
      ['prompt_tokens_details', 'cached_tokens'],
      ['promptTokensDetails', 'cachedTokens']
    ])
  )
}

function validSource(value: unknown): ContextUsageSource {
  return value === 'provider-last-invocation' ||
    value === 'provider-compaction' ||
    value === 'provider-turn-aggregate' ||
    value === 'post-compaction-unknown' ||
    value === 'host-estimate'
    ? value
    : 'provider-turn-aggregate'
}

function validPrecision(value: unknown): ContextUsagePrecision {
  return value === 'exact' || value === 'derived' || value === 'estimated' ? value : 'derived'
}

export function normalizeContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  const source = record(value)
  if (!source) return null
  const contextTokens = optionalNonNegativeInteger(source.contextTokens)
  if (contextTokens === undefined) return null
  const inputTokens = nonNegativeInteger(source.inputTokens)
  const outputTokens = nonNegativeInteger(source.outputTokens)
  const reasoningTokens = nonNegativeInteger(source.reasoningTokens)
  const observedAt = optionalNonNegativeInteger(source.observedAt)
  return {
    ...(observedAt !== undefined ? { observedAt } : {}),
    contextTokens,
    totalTokens: Math.max(contextTokens, nonNegativeInteger(source.totalTokens)),
    inputTokens,
    freshInputTokens: Math.min(inputTokens, nonNegativeInteger(source.freshInputTokens)),
    cacheReadInputTokens: Math.min(inputTokens, nonNegativeInteger(source.cacheReadInputTokens)),
    cacheCreationInputTokens: Math.min(
      inputTokens,
      nonNegativeInteger(source.cacheCreationInputTokens)
    ),
    outputTokens,
    visibleOutputTokens: Math.min(outputTokens, nonNegativeInteger(source.visibleOutputTokens)),
    reasoningTokens,
    toolUsePromptTokens: Math.min(inputTokens, nonNegativeInteger(source.toolUsePromptTokens)),
    unclassifiedTokens: Math.min(contextTokens, nonNegativeInteger(source.unclassifiedTokens)),
    source: validSource(source.source),
    precision: validPrecision(source.precision)
  }
}

function deriveSnapshot(
  value: unknown,
  overrides: Partial<Pick<ContextUsageSnapshot, 'source' | 'precision' | 'observedAt'>> = {}
): ContextUsageSnapshot | null {
  const source = record(value)
  if (!source) return null

  const reportedInputTokens = maxAlias(source, INPUT_PATHS)
  const cacheReadInputTokens = cacheReadTokens(source)
  const cacheCreationInputTokens = usageCacheCreationInputTokens(source)
  const includesCache = inputIncludesCache(source)
  const inputTokens =
    reportedInputTokens + (includesCache ? 0 : cacheReadInputTokens + cacheCreationInputTokens)
  const freshInputTokens = Math.max(
    0,
    inputTokens - cacheReadInputTokens - cacheCreationInputTokens
  )

  const outputTokens = maxAlias(source, OUTPUT_PATHS)
  const reasoningSubsetTokens = Math.min(outputTokens, maxAlias(source, REASONING_SUBSET_PATHS))
  const separateReasoningTokens = maxAlias(source, SEPARATE_REASONING_PATHS)
  const reasoningTokens = Math.max(reasoningSubsetTokens, separateReasoningTokens)
  const visibleOutputTokens =
    separateReasoningTokens > 0 ? outputTokens : Math.max(0, outputTokens - reasoningSubsetTokens)

  const knownTokens = inputTokens + visibleOutputTokens + reasoningTokens
  const reportedTotalTokens = maxAlias(source, TOTAL_PATHS)
  const contextTokens = Math.max(reportedTotalTokens, knownTokens)
  if (contextTokens <= 0) return null

  const estimated = statsAreEstimated(source)
  const precision = overrides.precision || (estimated ? 'estimated' : 'derived')
  const snapshotSource =
    overrides.source || (estimated ? 'host-estimate' : 'provider-turn-aggregate')

  return {
    ...(overrides.observedAt !== undefined ? { observedAt: overrides.observedAt } : {}),
    contextTokens,
    totalTokens: contextTokens,
    inputTokens,
    freshInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    visibleOutputTokens,
    reasoningTokens,
    toolUsePromptTokens: Math.min(inputTokens, maxAlias(source, TOOL_PROMPT_PATHS)),
    unclassifiedTokens: Math.max(0, contextTokens - knownTokens),
    source: snapshotSource,
    precision
  }
}

/** Read a persisted atomic snapshot when present; otherwise derive the best
 * honest breakdown available from legacy run stats. */
export function contextUsageFromStats(value: unknown): ContextUsageSnapshot | null {
  const source = record(value)
  if (!source) return null
  return (
    normalizeContextUsageSnapshot(source[TASKWRAITH_CONTEXT_USAGE_KEY]) || deriveSnapshot(source)
  )
}

/** Attach an atomic provider invocation (or an explicitly identified estimate)
 * without disturbing the aggregate billing counters around it. */
export function withContextUsageSnapshot(
  value: UsageRecord,
  options: {
    source: ContextUsageSource
    precision: ContextUsagePrecision
    observedAt?: number
  }
): UsageRecord {
  const snapshot = deriveSnapshot(value, {
    ...options,
    observedAt: options.observedAt ?? Date.now()
  })
  return snapshot ? { ...value, [TASKWRAITH_CONTEXT_USAGE_KEY]: snapshot } : value
}

export function contextTokensFromStats(value: unknown): number {
  return contextUsageFromStats(value)?.contextTokens || 0
}

export interface ContextCompactionUsageEvidence {
  observedAt: number
  /** Missing when a provider/host reported completion but no trustworthy
   * post-compaction occupancy. Zero is a valid, exact value. */
  postTokens?: number
}

export interface ContextCompactionUsageEvidenceIndex {
  /** Latest completed compaction that is not scoped to an Ensemble seat. */
  unscoped: ContextCompactionUsageEvidence | null
  /** Latest completed compaction for each explicitly scoped Ensemble seat. */
  byParticipantId: ReadonlyMap<string, ContextCompactionUsageEvidence>
}

type IndexedContextCompactionUsageEvidence = ContextCompactionUsageEvidence & { index: number }

function newerContextCompactionEvidence(
  current: IndexedContextCompactionUsageEvidence | undefined,
  candidate: IndexedContextCompactionUsageEvidence
): IndexedContextCompactionUsageEvidence {
  return !current ||
    candidate.observedAt > current.observedAt ||
    (candidate.observedAt === current.observedAt && candidate.index > current.index)
    ? candidate
    : current
}

function withoutContextCompactionIndex(
  evidence: IndexedContextCompactionUsageEvidence | undefined
): ContextCompactionUsageEvidence | null {
  if (!evidence) return null
  const { index: _index, ...result } = evidence
  return result
}

/** Index the latest durable context-compaction card for every scope in one
 * transcript walk. Renderer callers use this when drawing an Ensemble roster
 * so adding participants does not multiply full-message scans. */
export function buildContextCompactionUsageEvidenceIndex(
  messages: ReadonlyArray<unknown>
): ContextCompactionUsageEvidenceIndex {
  let unscoped: IndexedContextCompactionUsageEvidence | undefined
  const byParticipantId = new Map<string, IndexedContextCompactionUsageEvidence>()

  for (let index = 0; index < messages.length; index += 1) {
    const message = record(messages[index])
    const metadata = record(message?.metadata)
    const scopedParticipantId =
      typeof metadata?.ensembleParticipantId === 'string' &&
      metadata.ensembleParticipantId.length > 0
        ? metadata.ensembleParticipantId
        : undefined
    const signal = record(metadata?.contextCompaction)
    if (signal?.kind !== 'completed') continue
    const telemetry = record(signal.telemetry)
    const postTokens = optionalNonNegativeInteger(telemetry?.postTokens)
    const timestamp =
      typeof message?.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN
    const candidate: IndexedContextCompactionUsageEvidence = {
      observedAt: Number.isFinite(timestamp) ? timestamp : 0,
      index,
      ...(postTokens !== undefined ? { postTokens } : {})
    }

    if (scopedParticipantId) {
      byParticipantId.set(
        scopedParticipantId,
        newerContextCompactionEvidence(byParticipantId.get(scopedParticipantId), candidate)
      )
    } else {
      unscoped = newerContextCompactionEvidence(unscoped, candidate)
    }
  }

  return {
    unscoped: withoutContextCompactionIndex(unscoped),
    byParticipantId: new Map(
      [...byParticipantId].map(([participantId, evidence]) => [
        participantId,
        withoutContextCompactionIndex(evidence)!
      ])
    )
  }
}

/** Latest durable context-compaction card for one seat. The parser is kept
 * generic so main and renderer can share it without importing store types. */
export function latestContextCompactionUsageEvidence(
  messages: ReadonlyArray<unknown>,
  participantId?: string
): ContextCompactionUsageEvidence | null {
  const evidence = buildContextCompactionUsageEvidenceIndex(messages)
  return participantId ? evidence.byParticipantId.get(participantId) || null : evidence.unscoped
}

/** Convert a compaction completion into context-window state. When the
 * provider omits postTokens, retain only the prior count as an explicitly
 * stale upper bound rather than pretending the old breakdown is current. */
export function contextUsageAfterCompaction(
  previous: ContextUsageSnapshot | null | undefined,
  evidence: ContextCompactionUsageEvidence
): ContextUsageSnapshot | undefined {
  const tokens = evidence.postTokens ?? previous?.contextTokens
  if (tokens === undefined) return undefined
  const exact = evidence.postTokens !== undefined
  return {
    observedAt: evidence.observedAt,
    contextTokens: tokens,
    totalTokens: tokens,
    inputTokens: 0,
    freshInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    visibleOutputTokens: 0,
    reasoningTokens: 0,
    toolUsePromptTokens: 0,
    unclassifiedTokens: tokens,
    source: exact ? 'provider-compaction' : 'post-compaction-unknown',
    precision: exact ? 'exact' : 'estimated'
  }
}

export function contextUsageSnapshotsEqual(
  left: ContextUsageSnapshot | null | undefined,
  right: ContextUsageSnapshot | null | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.observedAt === right.observedAt &&
    left.contextTokens === right.contextTokens &&
    left.totalTokens === right.totalTokens &&
    left.inputTokens === right.inputTokens &&
    left.freshInputTokens === right.freshInputTokens &&
    left.cacheReadInputTokens === right.cacheReadInputTokens &&
    left.cacheCreationInputTokens === right.cacheCreationInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.visibleOutputTokens === right.visibleOutputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.toolUsePromptTokens === right.toolUsePromptTokens &&
    left.unclassifiedTokens === right.unclassifiedTokens &&
    left.source === right.source &&
    left.precision === right.precision
  )
}
