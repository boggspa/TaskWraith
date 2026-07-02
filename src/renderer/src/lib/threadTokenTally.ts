import { formatCost, formatCostAlwaysOn, type DisplayCurrency } from './formatCost'
import { formatContextTokens } from './contextWindows'
import { extractOllamaPeakRssGb, formatOllamaComposerPeakGb } from './ollamaMemoryDisplay'
import {
  extractUsageCostUsd,
  extractUsageCount,
  extractUsageCountsFromCandidate
} from './usageStats'
import { estimateRunCostUsd, type RendererProviderRates } from './providerRateEstimate'
import type { ChatRun, EnsembleParticipant, ProviderId } from '../../../main/store/types'

type ChatTokenTally = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  explicitCostUsd: number
  /** API-equivalent estimate for completed runs that reported tokens but no provider cost. */
  estimatedCostUsd?: number
  /** Latest non-zero llama-server peak RSS (GB) from completed Ollama runs. */
  peakMemoryRssGb: number
}

type ChatTokenTallyOptions = {
  providerRates?: RendererProviderRates
}

const sumUsageCounts = (stats: any, keys: Array<string | string[]>): number =>
  keys.reduce((total, key) => total + extractUsageCount(stats, [key]), 0)

const estimateCompletedRunCostUsd = (
  run: ChatRun | undefined,
  counts: { inputTokens: number; outputTokens: number },
  explicitCostUsd: number,
  providerRates: RendererProviderRates | undefined
): number => {
  if (explicitCostUsd > 0 || !run?.stats || !providerRates) return 0
  const stats = run.stats
  const inputIncludesCache = stats?._taskwraith_input_includes_cache === true
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
  const cacheReadInputTokens = sumUsageCounts(stats, [
    ['cacheReadInputTokens'],
    ['cache_read_input_tokens'],
    ['input_cache_read'],
    ['cacheReadTokens'],
    ['cachedInputTokens'],
    ['cached_input_tokens']
  ])
  const cacheCreationInputTokens = extractUsageCount(stats, [
    ['cacheCreationInputTokens'],
    ['cache_creation_input_tokens'],
    ['input_cache_creation']
  ])
  const inputAudioTokens = inputIncludesCache
    ? 0
    : extractUsageCount(stats, [['input_audio_tokens'], ['inputAudioTokens']])
  const billableInputTokens = inputIncludesCache
    ? counts.inputTokens
    : inputBaseTokens + inputAudioTokens

  return estimateRunCostUsd(
    providerRates,
    run.provider,
    run.actualModel || run.requestedModel,
    billableInputTokens,
    counts.outputTokens,
    {
      cacheReadInputTokens,
      cacheCreationInputTokens,
      inputIncludesCache
    }
  )
}

const tallyCostUsd = (tally: ChatTokenTally): number =>
  tally.explicitCostUsd + (tally.estimatedCostUsd || 0)

const buildChatTokenTally = (
  runs: ChatRun[] = [],
  options: ChatTokenTallyOptions = {}
): ChatTokenTally => {
  let peakMemoryRssGb = 0
  const tally = runs.reduce<ChatTokenTally>(
    (total, run) => {
      const peakGb = extractOllamaPeakRssGb(run?.stats)
      if (peakGb > 0) peakMemoryRssGb = peakGb
      const counts = extractUsageCountsFromCandidate(run?.stats)
      const explicitCostUsd = extractUsageCostUsd(run?.stats)
      const estimatedCostUsd = estimateCompletedRunCostUsd(
        run,
        counts,
        explicitCostUsd,
        options.providerRates
      )
      return {
        inputTokens: total.inputTokens + counts.inputTokens,
        outputTokens: total.outputTokens + counts.outputTokens,
        totalTokens: total.totalTokens + counts.totalTokens,
        explicitCostUsd: total.explicitCostUsd + explicitCostUsd,
        estimatedCostUsd: (total.estimatedCostUsd || 0) + estimatedCostUsd,
        peakMemoryRssGb
      }
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      explicitCostUsd: 0,
      estimatedCostUsd: 0,
      peakMemoryRssGb: 0
    }
  )
  return { ...tally, peakMemoryRssGb }
}

const formatTallySuffix = (
  provider: ProviderId,
  tally: ChatTokenTally,
  currency: DisplayCurrency,
  overestimatePercent: number,
  options?: { dualCostAndRam?: boolean; projectedCost?: boolean }
): string => {
  const ram =
    tally.peakMemoryRssGb > 0 ? formatOllamaComposerPeakGb(tally.peakMemoryRssGb) : ''
  const totalCostUsd = tallyCostUsd(tally)
  const hasEstimatedCost = (tally.estimatedCostUsd || 0) > 0 || options?.projectedCost === true
  const cost = formatExplicitCostUsd(totalCostUsd, currency, overestimatePercent)

  if (options?.dualCostAndRam) {
    const parts: string[] = []
    if (totalCostUsd > 0) {
      const costLabel = formatCostAlwaysOn(totalCostUsd, currency, undefined, overestimatePercent)
      parts.push(hasEstimatedCost ? `~${costLabel}` : costLabel)
    }
    if (ram) parts.push(ram)
    return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  }

  if (provider === 'ollama' && ram) {
    return ` · ${ram}`
  }
  return cost ? ` · ${hasEstimatedCost ? '~' : ''}${cost}` : ''
}

/** Fold guest-child (or other companion) Ollama peak RAM into a thread tally. */
const mergeCompanionPeakMemoryRssGb = (
  tally: ChatTokenTally,
  companionRuns: ChatRun[] = []
): ChatTokenTally => {
  const companionPeak = buildChatTokenTally(companionRuns).peakMemoryRssGb
  if (companionPeak <= tally.peakMemoryRssGb) return tally
  return { ...tally, peakMemoryRssGb: companionPeak }
}
// 1.0.5-EW25 — Routes through `formatCost` so the user's selected
// display currency wins. Pre-EW25 this hard-coded the `$` symbol +
// `<$0.01` floor; the floor logic now lives in `formatCost.ts` and
// is per-currency aware. Callers that previously didn't pass a
// currency get USD by default — backward-compatible.
//
// 1.0.5-EW34 — Threads the user's conservative-overestimate bias
// percent (sub-slice e) into the same call. Default 0 keeps the
// behaviour identical for callers that don't pass a bias.
const formatExplicitCostUsd = (
  costUsd: number,
  currency: DisplayCurrency = 'USD',
  overestimatePercent: number = 0
): string => formatCost(costUsd, currency, undefined, overestimatePercent)
const formatThreadTokenTally = (
  provider: ProviderId,
  _providerLabel: string,
  tally: ChatTokenTally,
  currency: DisplayCurrency = 'USD',
  overestimatePercent: number = 0
): string | null => {
  if (tally.totalTokens <= 0) return null
  // Provider label dropped — the user already knows which provider
  // they're talking to (the provider chip is right next to this
  // tally), and the inline real-estate is tight. `_providerLabel`
  // kept as a positional arg so the call site doesn't change shape.
  return `${formatContextTokens(tally.inputTokens)} in / ${formatContextTokens(tally.outputTokens)} out${formatTallySuffix(provider, tally, currency, overestimatePercent)}`
}

/**
 * B1 (1.0.3) — per-participant breakdown for the ensemble tally
 * footer's hover tooltip. The footer chip itself keeps the compact
 * aggregate format (`Σin / Σout · $total`) so the visual budget
 * stays tight; the breakdown surfaces on hover via the `title`
 * attribute for users who want to see "where did the cost come
 * from?" without leaving the composer.
 *
 * Groups `runs` by `ensembleParticipantId` and matches each group
 * to the participant's role for the tooltip label. Participants
 * with no runs are omitted so the tooltip doesn't list zeros.
 */
const formatEnsembleTokenBreakdown = (
  runs: ChatRun[],
  participants: EnsembleParticipant[],
  currency: DisplayCurrency = 'USD',
  overestimatePercent: number = 0,
  providerRates?: RendererProviderRates
): string | null => {
  // Ollama RAM peaks are per-run hardware telemetry; ensemble breakdown
  // stays token/cost-only so the footer tooltip doesn't grow noisy.
  if (!runs.length || !participants.length) return null
  const byParticipant = new Map<string, ChatTokenTally>()
  for (const run of runs) {
    const pid = run.ensembleParticipantId
    if (!pid) continue
    const counts = extractUsageCountsFromCandidate(run.stats)
    const cost = extractUsageCostUsd(run.stats)
    const estimatedCostUsd = estimateCompletedRunCostUsd(run, counts, cost, providerRates)
    const existing = byParticipant.get(pid) || {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      explicitCostUsd: 0,
      estimatedCostUsd: 0,
      peakMemoryRssGb: 0
    }
    byParticipant.set(pid, {
      inputTokens: existing.inputTokens + counts.inputTokens,
      outputTokens: existing.outputTokens + counts.outputTokens,
      totalTokens: existing.totalTokens + counts.totalTokens,
      explicitCostUsd: existing.explicitCostUsd + cost,
      estimatedCostUsd: (existing.estimatedCostUsd || 0) + estimatedCostUsd,
      peakMemoryRssGb: 0
    })
  }
  if (byParticipant.size === 0) return null
  const lines: string[] = []
  for (const participant of participants) {
    const tally = byParticipant.get(participant.id)
    if (!tally || tally.totalTokens <= 0) continue
    const label = participant.role || participant.provider
    const costUsd = tallyCostUsd(tally)
    const cost = formatExplicitCostUsd(costUsd, currency, overestimatePercent)
    lines.push(
      `${label}: ${formatContextTokens(tally.inputTokens)} in / ${formatContextTokens(tally.outputTokens)} out${cost ? ` · ${(tally.estimatedCostUsd || 0) > 0 ? '~' : ''}${cost}` : ''}`
    )
  }
  return lines.length > 0 ? lines.join('\n') : null
}

export type { ChatTokenTally }
export {
  buildChatTokenTally,
  formatExplicitCostUsd,
  formatTallySuffix,
  formatThreadTokenTally,
  formatEnsembleTokenBreakdown,
  mergeCompanionPeakMemoryRssGb,
  tallyCostUsd
}
