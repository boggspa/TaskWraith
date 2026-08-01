import type {
  ChatRecord,
  ChatRun,
  ComplexityEscalationKind,
  ComplexityEscalationSignal,
  EnsembleRoundParticipantState,
  ProviderId
} from '../../../main/store/types'
import { formatContextTokens } from './contextWindows'
import { formatCostAlwaysOn, type DisplayCurrency } from './formatCost'
import { humaniseModelId } from './modelDisplayName'
import { resolveProviderBrandLabel, resolveProviderHueClass } from './ollamaDisplayBrand'
import { getProviderLabel } from './providerLabels'
import { estimateRunCostUsd, type RendererProviderRates } from './providerRateEstimate'
import {
  extractOllamaPeakRssGb,
  formatOllamaSummaryMemoryGb
} from './ollamaMemoryDisplay'
import {
  extractUsageCount,
  extractUsageCostUsd,
  extractUsageCountsFromCandidate
} from './usageStats'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../../../shared/usageAccounting'

export type RunCompleteSummaryRow = {
  label: string
  value: string
}

export type RunCompleteTokenParticipant = {
  id: string
  provider?: ProviderId
  providerClass: string
  label: string
  isBossman: boolean
  isCaptain: boolean
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokensLabel: string
  title: string
}

export type RunCompleteTokenDetails = {
  participants: RunCompleteTokenParticipant[]
  inputTokens: number
  outputTokens: number
  totalTokens: number
  totalLabel: string
  totalTitle: string
}

/**
 * 1.0.7 — Cost-display inputs threaded into the (otherwise pure) ensemble
 * round summary builder so it can render a currency-aware Cost row + a
 * projected token->USD estimate for subscription/credit seats. All optional:
 * omitting them reproduces the pre-1.0.7 behaviour (no Cost row).
 *
 * - `currency` / `overestimatePercent`: the user's Settings → General
 *   preferences, already plumbed to the transcript.
 * - `providerRates`: the per-provider rate table from the `providerRates:get`
 *   IPC (USD per 1M tokens). Used ONLY to estimate seats that emit no
 *   `cost_usd`. Absent/empty → no estimate, just real cost (which may be
 *   blank for subscription seats).
 */
export type EnsembleRoundSummaryCostOptions = {
  currency?: DisplayCurrency
  overestimatePercent?: number
  providerRates?: RendererProviderRates
}

/**
 * 1.0.7 — Build the Cost row for a finished ensemble round, kept PURE so the
 * estimator math + honesty badging are exhaustively testable.
 *
 * Two USD figures are accumulated separately across the round's runs:
 *   - `realUsd`: the sum of explicit `cost_usd` the provider actually
 *     reported (provider/API paths that expose billing usage).
 *   - `estUsd`: a PROJECTED API-equivalent for runs that reported NO
 *     `cost_usd` (subscription / credit seats: Codex / Grok / Cursor),
 *     derived from summed tokens × the provider rate table.
 *
 * HONESTY GUARDRAILS (the maintainer's explicit constraint —
 * ProviderRateService self-documents its rates as projected, not billed):
 *   (a) a run is only estimated when it has no explicit cost_usd, and
 *   (b) any estimated component is badged "est. API-equiv" (with a leading
 *       "~" on a fully-estimated row), NEVER rendered as a bare currency
 *       string that implies money was spent.
 *
 * Returns `null` when there's nothing to show (no real cost AND no estimate)
 * so the caller omits the row entirely rather than printing a misleading
 * `$0.00`. When only real cost exists it's a plain currency string; when only
 * an estimate exists it's `~<amount> est. API-equiv`; a mix shows both.
 */
export const buildEnsembleRoundCostRow = (
  roundRuns: ChatRun[],
  options: EnsembleRoundSummaryCostOptions
): RunCompleteSummaryRow | null => {
  const currency: DisplayCurrency = options.currency || 'USD'
  const overestimate = options.overestimatePercent ?? 0
  const rates = options.providerRates || {}

  let realUsd = 0
  let estUsd = 0
  for (const run of roundRuns) {
    const explicit = extractUsageCostUsd(run.stats)
    if (explicit > 0) {
      // Per-token seat reported real spend — never override with an estimate.
      realUsd += explicit
      continue
    }
    // No explicit cost (subscription / credit seat) — project from tokens.
    const counts = extractUsageCountsFromCandidate(run.stats)
    const cacheCounts = extractCacheUsageCounts(run.stats)
    const inputIncludesCache =
      usageInputIncludesCache(run.stats) ||
      cacheCounts.cacheReadInputTokens > 0 ||
      cacheCounts.cacheCreationInputTokens > 0
    const statsRateModel =
      typeof run.stats?._taskwraith_cost_rate_model === 'string'
        ? run.stats._taskwraith_cost_rate_model.trim()
        : ''
    const model = statsRateModel || run.actualModel || run.requestedModel
    estUsd += estimateRunCostUsd(
      rates,
      run.provider,
      model,
      counts.inputTokens,
      counts.outputTokens,
      {
        ...cacheCounts,
        inputIncludesCache
      }
    )
  }

  if (realUsd <= 0 && estUsd <= 0) return null

  if (estUsd <= 0) {
    // Pure real cost — plain currency string.
    return { label: 'Cost', value: formatCostAlwaysOn(realUsd, currency, undefined, overestimate) }
  }

  const estText = `~${formatCostAlwaysOn(estUsd, currency, undefined, overestimate)} est. API-equiv`
  if (realUsd <= 0) {
    // Pure estimate — badge it unmistakably as projected, not billed.
    return { label: 'Cost', value: estText }
  }
  // Mix of real + estimated seats — show both, keep the estimate badged.
  return {
    label: 'Cost',
    value: `${formatCostAlwaysOn(realUsd, currency, undefined, overestimate)} + ${estText}`
  }
}

export const formatWorkDuration = (startedAt?: string, completedAt?: string): string | null => {
  if (!startedAt || !completedAt) {
    return null
  }

  const started = new Date(startedAt).getTime()
  const completed = new Date(completedAt).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return null
  }

  let remainingSeconds = Math.max(1, Math.round((completed - started) / 1000))
  const hours = Math.floor(remainingSeconds / 3600)
  remainingSeconds -= hours * 3600
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds - minutes * 60
  const parts: string[] = []

  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`)

  return `Worked for ${parts.slice(0, 2).join(' ')}`
}

const formatCompactDurationMs = (durationMs: number): string => {
  const ms = Math.max(0, Math.round(durationMs))
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

const formatRunStatusLabel = (status?: string): string => {
  if (!status) return 'Unknown'
  if (status === 'success' || status === 'completed') return 'Complete'
  if (status === 'success_with_warnings') return 'Warnings'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const formatApprovalModeLabel = (
  run?: Pick<ChatRun, 'approvalMode' | 'workflowMode'> | null
): string => {
  const mode = run?.approvalMode
  if (!mode) return 'Unknown'
  if (mode === 'plan') return run?.workflowMode === 'plan' ? 'Plan' : 'Read-Only/Recon'
  if (mode === 'auto_edit') return 'Auto edit'
  return formatRunStatusLabel(mode)
}

const getRunDurationMs = (run: ChatRun): number => {
  const statsDuration = extractUsageCount(run.stats, [['duration_ms'], ['durationMs']])
  if (statsDuration > 0) return statsDuration

  const started = run.startedAt ? Date.parse(run.startedAt) : NaN
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    return ended - started
  }
  return 0
}

const readPositiveNumber = (obj: any, paths: Array<string | string[]>): number => {
  for (const path of paths) {
    const keys = Array.isArray(path) ? path : [path]
    let cursor = obj
    let found = true
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
        found = false
        break
      }
      cursor = cursor[key]
    }
    if (!found) continue
    const value = typeof cursor === 'string' ? Number(cursor.trim()) : Number(cursor)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

const extractCacheUsageCounts = (
  stats: any
): { cacheReadInputTokens: number; cacheCreationInputTokens: number } => {
  return {
    cacheReadInputTokens: usageCacheReadInputTokens(stats),
    cacheCreationInputTokens: usageCacheCreationInputTokens(stats)
  }
}

const OLLAMA_RAM_SAMPLE_PATHS: Array<string | string[]> = [
  ['ollamaMemorySampleCount'],
  ['hardware', 'ram', 'sampleCount']
]

const buildOllamaRamRowFromPeak = (
  peakGb: number,
  samples: number
): RunCompleteSummaryRow | null => {
  if (peakGb <= 0) return null
  const suffix = samples > 1 ? ` peak, ${Math.round(samples)} samples` : ' RSS'
  return {
    label: 'RAM',
    value: `${formatOllamaSummaryMemoryGb(peakGb)} llama-server${suffix}`
  }
}

const findPeakOllamaRamFromRuns = (
  runs: ChatRun[]
): { peakGb: number; samples: number } => {
  let peakGb = 0
  let samples = 0
  for (const run of runs) {
    const peak = extractOllamaPeakRssGb(run.stats)
    if (peak <= peakGb) continue
    peakGb = peak
    samples = readPositiveNumber(run.stats, OLLAMA_RAM_SAMPLE_PATHS)
  }
  return { peakGb, samples }
}

const buildOllamaRamRow = (run: ChatRun): RunCompleteSummaryRow | null => {
  if (run.provider !== 'ollama') return null
  const peakGb = extractOllamaPeakRssGb(run.stats)
  if (peakGb <= 0) return null
  const samples = readPositiveNumber(run.stats, OLLAMA_RAM_SAMPLE_PATHS)
  return buildOllamaRamRowFromPeak(peakGb, samples)
}

/** Peak llama-server RSS across Ollama participant runs in an ensemble round. */
export const buildEnsembleRoundOllamaRamRow = (
  roundRuns: ChatRun[]
): RunCompleteSummaryRow | null => {
  const ollamaRuns = roundRuns.filter((run) => run.provider === 'ollama')
  const { peakGb, samples } = findPeakOllamaRamFromRuns(ollamaRuns)
  return buildOllamaRamRowFromPeak(peakGb, samples)
}

export const buildRunCompleteSummaryRows = (run?: ChatRun | null): RunCompleteSummaryRow[] => {
  if (!run) return []

  const rows: RunCompleteSummaryRow[] = []
  const model = run.actualModel || run.requestedModel
  if (model) rows.push({ label: 'Model', value: humaniseModelId(run.provider, model) || model })
  rows.push({ label: 'Mode', value: formatApprovalModeLabel(run) })
  rows.push({ label: 'Status', value: formatRunStatusLabel(run.status) })

  const durationMs = getRunDurationMs(run)
  if (durationMs > 0) rows.push({ label: 'Duration', value: formatCompactDurationMs(durationMs) })

  const counts = extractUsageCountsFromCandidate(run.stats)
  if (counts.totalTokens > 0) {
    rows.push({
      label: 'Tokens',
      value: `${formatContextTokens(counts.inputTokens)} in / ${formatContextTokens(counts.outputTokens)} out`
    })
    rows.push({ label: 'Total', value: `${formatContextTokens(counts.totalTokens)} tokens` })
  }
  const ramRow = buildOllamaRamRow(run)
  if (ramRow) rows.push(ramRow)

  return rows
}

const compactTokenLabel = (count: number): string => (count > 0 ? formatContextTokens(count) : '-')

const tokenTitle = (label: string, inputTokens: number, outputTokens: number, totalTokens: number): string =>
  `${label}: ${formatContextTokens(inputTokens)} in / ${formatContextTokens(outputTokens)} out / ${formatContextTokens(totalTokens)} total`

const participantDisplayLabel = (
  provider: ProviderId | undefined,
  role: string | undefined,
  model: string | undefined
): string => {
  const trimmedRole = role?.trim()
  if (trimmedRole) return trimmedRole
  return (
    resolveProviderBrandLabel(provider, model, model ? humaniseModelId(provider, model) : undefined) ||
    (provider ? getProviderLabel(provider) : 'Run')
  )
}

const modelFromRuns = (runs: ChatRun[], fallback?: string): string | undefined => {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const model = runs[index].actualModel || runs[index].requestedModel
    if (model) return model
  }
  return fallback
}

const sumRunTokens = (runs: ChatRun[]): { inputTokens: number; outputTokens: number; totalTokens: number } =>
  runs.reduce(
    (total, run) => {
      const counts = extractUsageCountsFromCandidate(run.stats)
      total.inputTokens += counts.inputTokens
      total.outputTokens += counts.outputTokens
      total.totalTokens += counts.totalTokens
      return total
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  )

export const buildRunCompleteTokenDetails = (
  run?: ChatRun | null
): RunCompleteTokenDetails | null => {
  if (!run) return null
  const counts = extractUsageCountsFromCandidate(run.stats)
  if (counts.totalTokens <= 0) return null

  const model = run.actualModel || run.requestedModel
  const label = participantDisplayLabel(run.provider, run.ensembleRole, model)
  const providerClass = resolveProviderHueClass(
    run.provider,
    model,
    model ? humaniseModelId(run.provider, model) : undefined
  )
  const participant: RunCompleteTokenParticipant = {
    id: run.ensembleParticipantId || run.runId,
    provider: run.provider,
    providerClass,
    label,
    isBossman: false,
    isCaptain: false,
    ...counts,
    tokensLabel: compactTokenLabel(counts.totalTokens),
    title: tokenTitle(label, counts.inputTokens, counts.outputTokens, counts.totalTokens)
  }

  return {
    participants: [participant],
    ...counts,
    totalLabel: compactTokenLabel(counts.totalTokens),
    totalTitle: tokenTitle('Round total', counts.inputTokens, counts.outputTokens, counts.totalTokens)
  }
}

export const buildEnsembleRoundTokenDetails = (
  chat: ChatRecord | null
): RunCompleteTokenDetails | null => {
  const round = chat?.ensemble?.activeRound
  if (!round) return null
  const roundRuns = (chat?.runs || []).filter((run) => run.ensembleRoundId === round.roundId)
  const configuredParticipants = chat?.ensemble?.participants || []
  const configuredById = new Map(configuredParticipants.map((participant) => [participant.id, participant]))
  const bossmanParticipantId = chat?.ensemble?.bossmanParticipantId
  const secondInCommandParticipantId = chat?.ensemble?.secondInCommandParticipantId
  const consumedRunIds = new Set<string>()
  const sortedParticipants = [...(round.participants || [])].sort((a, b) => a.order - b.order)

  const sourceParticipants =
    sortedParticipants.length > 0
      ? sortedParticipants
      : roundRuns.map((run, index) => ({
          participantId: run.ensembleParticipantId || run.runId,
          provider: run.provider || 'gemini',
          role: run.ensembleRole || '',
          order: typeof run.ensembleOrder === 'number' ? run.ensembleOrder : index,
          status: 'answered' as const
        }))

  const participants = sourceParticipants.map((participant) => {
    let participantRuns = roundRuns.filter(
      (run) => run.ensembleParticipantId === participant.participantId
    )
    if (participantRuns.length === 0) {
      participantRuns = roundRuns.filter(
        (run) =>
          !consumedRunIds.has(run.runId) &&
          run.provider === participant.provider &&
          (run.ensembleOrder === participant.order || run.ensembleRole === participant.role)
      )
    }
    participantRuns.forEach((run) => consumedRunIds.add(run.runId))

    const configured = configuredById.get(participant.participantId)
    const model = modelFromRuns(participantRuns, configured?.model)
    const counts = sumRunTokens(participantRuns)
    const label = participantDisplayLabel(participant.provider, participant.role, model)
    const providerClass = resolveProviderHueClass(
      participant.provider,
      model,
      model ? humaniseModelId(participant.provider, model) : undefined
    )
    return {
      id: participant.participantId,
      provider: participant.provider,
      providerClass,
      label,
      isBossman: participant.participantId === bossmanParticipantId,
      isCaptain:
        participant.participantId === secondInCommandParticipantId &&
        participant.participantId !== bossmanParticipantId,
      ...counts,
      tokensLabel: compactTokenLabel(counts.totalTokens),
      title: tokenTitle(label, counts.inputTokens, counts.outputTokens, counts.totalTokens)
    }
  })

  const totals = participants.reduce(
    (total, participant) => {
      total.inputTokens += participant.inputTokens
      total.outputTokens += participant.outputTokens
      total.totalTokens += participant.totalTokens
      return total
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  )

  if (participants.length === 0 || totals.totalTokens <= 0) return null

  return {
    participants,
    ...totals,
    totalLabel: compactTokenLabel(totals.totalTokens),
    totalTitle: tokenTitle('Round total', totals.inputTokens, totals.outputTokens, totals.totalTokens)
  }
}

/**
 * Per-participant outcome rollup for a finished ensemble round — the panel's
 * round-close "who passed, who skipped, who failed" ask. Reads the terminal
 * status on each `activeRound.participants[]` entry (finishRound resolves every
 * participant to a terminal status by round close):
 *
 *   - Contributed: answered | yielded   (mirrors ComplexityEscalation's
 *   - Failed:      failed | unreachable   ANSWER_STATUSES / FAILURE_STATUSES)
 *   - Skipped:     anything else (user-skipped, produced-no-content,
 *                  cancelled, or paused/sleeping)
 *
 * Returned as label/value rows so they slot straight into the existing
 * run-complete summary grid. Empty buckets are omitted; participant labels
 * prefer the role, falling back to the provider id.
 */
export const buildRoundOutcomeRows = (chat: ChatRecord | null): RunCompleteSummaryRow[] => {
  const participants = chat?.ensemble?.activeRound?.participants || []
  if (participants.length === 0) return []
  const label = (p: EnsembleRoundParticipantState): string => p.role?.trim() || p.provider
  const contributed = participants.filter((p) => p.status === 'answered' || p.status === 'yielded')
  const failed = participants.filter((p) => p.status === 'failed' || p.status === 'unreachable')
  const skipped = participants.filter(
    (p) => !['answered', 'yielded', 'failed', 'unreachable'].includes(p.status)
  )
  const rows: RunCompleteSummaryRow[] = []
  if (contributed.length > 0) {
    rows.push({ label: 'Contributed', value: contributed.map(label).join(', ') })
  }
  if (skipped.length > 0) {
    rows.push({ label: 'Skipped', value: skipped.map(label).join(', ') })
  }
  if (failed.length > 0) {
    rows.push({ label: 'Failed', value: failed.map(label).join(', ') })
  }
  return rows
}

/**
 * Ensemble variant of {@link buildRunCompleteSummaryRows}. Aggregates
 * across every participant run that belongs to the round so the user
 * sees ALL models that contributed, not just the last speaker's.
 *
 * Model list: each participant's model joined by `·` for compact
 * single-line display. Status: 'Complete' if every run reports
 * success (and the round itself completed), else the worst-case
 * status. Tokens sum across all runs. Duration uses the round's
 * `startedAt` → `endedAt` envelope rather than any individual run's
 * timing.
 */
export const buildEnsembleRoundSummaryRows = (
  chat: ChatRecord | null,
  cancelled: boolean,
  costOptions: EnsembleRoundSummaryCostOptions = {}
): RunCompleteSummaryRow[] => {
  const round = chat?.ensemble?.activeRound
  if (!round) return []
  const roundRuns = (chat?.runs || []).filter((run) => run.ensembleRoundId === round.roundId)
  const rows: RunCompleteSummaryRow[] = []

  // Collect each participant's actual (or requested) model, dedup +
  // preserve insertion order so the display follows speaker order.
  const seenModels = new Set<string>()
  const models: string[] = []
  for (const run of roundRuns) {
    const model = run.actualModel || run.requestedModel
    if (model && !seenModels.has(model)) {
      seenModels.add(model)
      models.push(model)
    }
  }
  if (models.length > 0) {
    rows.push({
      label: models.length === 1 ? 'Model' : 'Models',
      value: models.join(' · ')
    })
  }

  // Mode: take from the first run with an approval mode — every
  // participant in a round currently shares the chat-level preset, so
  // varying values would indicate per-participant overrides worth
  // surfacing too. Keep it simple for now and show the first.
  const firstModeRun = roundRuns.find((run) => run.approvalMode)
  if (firstModeRun) {
    rows.push({ label: 'Mode', value: formatApprovalModeLabel(firstModeRun) })
  }

  rows.push({
    label: 'Status',
    value: cancelled ? 'Cancelled' : 'Complete'
  })

  // Per-participant outcome rollup (who contributed / skipped / failed) — the
  // panel's round-close "who passed / skipped / failed" ask.
  rows.push(...buildRoundOutcomeRows(chat))

  // Round-envelope wall-clock — the time the user actually waited for the
  // round to close. Labelled "Latency" (its own distinct row) so it reads
  // clearly alongside the Cost row below; this is end-to-end round latency,
  // not summed per-participant compute time.
  const startedAtMs = round.startedAt ? new Date(round.startedAt).getTime() : NaN
  const endedAtMs = round.endedAt ? new Date(round.endedAt).getTime() : Date.now()
  if (Number.isFinite(startedAtMs) && endedAtMs > startedAtMs) {
    rows.push({
      label: 'Latency',
      value: formatCompactDurationMs(endedAtMs - startedAtMs)
    })
  }

  // Token totals — sum across all participant runs.
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const run of roundRuns) {
    const counts = extractUsageCountsFromCandidate(run.stats)
    inputTokens += counts.inputTokens
    outputTokens += counts.outputTokens
    totalTokens += counts.totalTokens
  }
  if (totalTokens > 0) {
    rows.push({
      label: 'Tokens',
      value: `${formatContextTokens(inputTokens)} in / ${formatContextTokens(outputTokens)} out`
    })
    rows.push({ label: 'Total', value: `${formatContextTokens(totalTokens)} tokens` })
  }

  // Cost — real provider-reported spend plus a clearly-badged projected
  // API-equivalent for subscription/credit seats that emit no cost_usd.
  const costRow = buildEnsembleRoundCostRow(roundRuns, costOptions)
  if (costRow) rows.push(costRow)

  // RAM — peak llama-server RSS from any Ollama lane (shown alongside Cost).
  const ramRow = buildEnsembleRoundOllamaRamRow(roundRuns)
  if (ramRow) rows.push(ramRow)

  return rows
}

/* ============================================================
 * Run-complete status vocabulary
 * ------------------------------------------------------------
 * The card that closes every run used to be titled with a fixed
 * "Task complete" and then contradict itself underneath with an
 * advisory banner strip ("Round stalled — your input would help
 * unblock this"). Those banners were inactionable and read as
 * anxiety, so two of the four signal kinds were hidden outright
 * and the rest still shouted from a box below a title claiming
 * success.
 *
 * The banners are gone. The signal itself was the useful part,
 * so it now REPLACES the card's title: the string that heads the
 * card is a dynamic status, and the useful warnings live in this
 * vocabulary rather than in their own boxes.
 *
 * Deliberately NOT ensemble-specific — `complete`, `cancelled`,
 * `awaiting-answer` and `exit-failure` all resolve for a solo
 * run; the surfaced escalation kinds are the ensemble-only
 * additions. `disagreement-unresolved` remains an advisory signal
 * but is deliberately excluded here: multiple answers without a
 * synthesizer is not evidence that the task failed.
 * ============================================================ */

/**
 * Accent applied to the status string. Nothing else about the card changes —
 * no pill, no container, no icon.
 *  - `neutral` : work finished, or the pause was intentional (unchanged white)
 *  - `warning` : a blocker fired BUT the run still produced work
 *  - `danger`  : a blocker fired and nothing was produced at all
 */
export type RunCompleteStatusTone = 'neutral' | 'warning' | 'danger'

export type RunCompleteBlockerKind = Exclude<
  ComplexityEscalationKind,
  'disagreement-unresolved'
>

export type RunCompleteStatusKind =
  /** Exit 0, nothing flagged. */
  | 'complete'
  /** Exit 130 — the user stopped it. Intentional, so never alarmed. */
  | 'cancelled'
  /** Ended on an unanswered agent question / plan choice. Intentional pause. */
  | 'awaiting-answer'
  /** Any other non-zero exit. */
  | 'exit-failure'
  /** Ensemble round blockers (see ComplexityEscalation.ts). */
  | RunCompleteBlockerKind

export type RunCompleteStatus = {
  kind: RunCompleteStatusKind
  /** The card title — replaces the old hard-coded "Task complete". */
  label: string
  /** Screen-reader phrasing (spelled out where the label is terse). */
  srLabel: string
  tone: RunCompleteStatusTone
  /**
   * The blocker's own evidence line, surfaced as the title's `title`
   * attribute so the detail the banner used to carry is still reachable
   * without occupying layout. Empty when there's nothing to add.
   */
  detail: string
}

/** One blocker flagged against the run/round, with its evidence line. */
export type RunCompleteBlocker = {
  kind: RunCompleteBlockerKind
  detail: string
}

const STATUS_LABEL: Record<RunCompleteStatusKind, string> = {
  complete: 'Task complete',
  cancelled: 'Run cancelled',
  'awaiting-answer': 'Awaiting your answer',
  // Carries the exit code, so it is filled in by the resolver.
  'exit-failure': 'Task ended',
  stuck: 'Round stalled',
  // Sentence case: this string now sits in the card's title slot alongside
  // "Task complete", where Title Case read as a different typographic voice.
  looping: 'Handoff/turns exhausted',
  'tool-error-cluster': 'Tool errors clustered'
}

/** The stripped global-chat card keeps its own terser wording. */
const GLOBAL_STATUS_LABEL: Partial<Record<RunCompleteStatusKind, string>> = {
  complete: 'Done',
  cancelled: 'Stopped',
  'exit-failure': "Couldn't finish"
}

/**
 * Which blocker wins the title when several fire for one round. They are
 * independent lenses on the same round (an all-failed round trips both
 * `tool-error-cluster` and `stuck`), so the title shows the most severe and
 * the rest stay in the evidence tooltip.
 */
const BLOCKER_SEVERITY: Record<RunCompleteBlockerKind, number> = {
  stuck: 4,
  'tool-error-cluster': 3,
  looping: 2
}

function loopingLimitCopy(round: NonNullable<ChatRecord['ensemble']>['activeRound']): string {
  const max =
    typeof round?.maxContinuationHops === 'number' && Number.isFinite(round.maxContinuationHops)
      ? Math.max(0, round.maxContinuationHops)
      : null
  const used =
    typeof round?.continuationHops === 'number' && Number.isFinite(round.continuationHops)
      ? Math.max(0, round.continuationHops)
      : max
  if (used !== null && max !== null) {
    return `Handoff/Turns reached their limit (${used}/${max}).`
  }
  return 'Handoff/Turns reached their limit.'
}

/**
 * Blockers flagged against the CURRENT round only (signals carry their
 * originating `roundId`), severity-ordered worst-first and de-duplicated by
 * kind. Returns [] when there's no active round or no signals.
 *
 * `disagreement-unresolved` is intentionally filtered from this presentation:
 * multiple answers without a synthesizer can be useful parallel work and is
 * not reliable evidence that the task failed. The signal remains persisted for
 * advisory/telemetry consumers. Other kinds remain eligible to title the card.
 *
 * Pure + side-effect-free so the mapping is unit-tested without a render
 * harness.
 */
export const buildRunCompleteBlockers = (chat: ChatRecord | null): RunCompleteBlocker[] => {
  const round = chat?.ensemble?.activeRound
  const signals = chat?.ensemble?.escalationSignals
  if (!round || !signals || signals.length === 0) return []
  const seenKinds = new Set<RunCompleteBlockerKind>()
  const blockers: RunCompleteBlocker[] = []
  for (const signal of signals as ComplexityEscalationSignal[]) {
    if (signal.roundId !== round.roundId) continue
    if (signal.kind === 'disagreement-unresolved') continue
    if (seenKinds.has(signal.kind)) continue
    seenKinds.add(signal.kind)
    blockers.push({
      kind: signal.kind,
      // Live counters beat the stored evidence line for `looping`.
      detail: signal.kind === 'looping' ? loopingLimitCopy(round) : signal.evidence || ''
    })
  }
  return blockers.sort((a, b) => (BLOCKER_SEVERITY[b.kind] || 0) - (BLOCKER_SEVERITY[a.kind] || 0))
}

/**
 * Did the round/run actually produce something? This is the ONLY input that
 * separates the yellow accent from the red one: a blocker on top of real edits
 * or a real answer is a partial result, a blocker on top of nothing is a dead
 * round.
 *
 * `answered`/`yielded` mirrors ComplexityEscalation's ANSWER_STATUSES; solo
 * runs have no participants, so they lean on `hadAssistantOutput`.
 */
export const runCompleteProducedWork = (input: {
  chat: ChatRecord | null
  fileChangeCount: number
  hadAssistantOutput?: boolean
}): boolean => {
  if (input.fileChangeCount > 0) return true
  if (input.hadAssistantOutput) return true
  const participants = input.chat?.ensemble?.activeRound?.participants || []
  return participants.some((p) => p.status === 'answered' || p.status === 'yielded')
}

export interface ResolveRunCompleteStatusInput {
  exitCode: number
  /** The stripped global-chat card, which uses terser wording. */
  isGlobal?: boolean
  /** Severity-ordered blockers — see {@link buildRunCompleteBlockers}. */
  blockers?: readonly RunCompleteBlocker[]
  /** See {@link runCompleteProducedWork}. */
  producedWork: boolean
  /** An agent question / plan choice was still unanswered when the run ended. */
  awaitingAnswer?: boolean
}

/**
 * Resolve the card's title + accent. Precedence, worst-understood-cause first:
 *
 *  1. `cancelled` — the user's own stop outranks anything the round inferred
 *     about itself; an ensemble round cancelled mid-flight trips `stuck`, and
 *     titling that "Round stalled" in red would blame the harness for a
 *     deliberate act.
 *  2. `exit-failure` — the process itself broke; the most concrete fact.
 *  3. the worst blocker.
 *  4. `awaiting-answer` — intentional pause.
 *  5. `complete`.
 */
export const resolveRunCompleteStatus = (
  input: ResolveRunCompleteStatusInput
): RunCompleteStatus => {
  const label = (kind: RunCompleteStatusKind): string =>
    (input.isGlobal ? GLOBAL_STATUS_LABEL[kind] : undefined) || STATUS_LABEL[kind]
  // A blocker over real output is a partial result; over nothing it's a dead run.
  const blockedTone: RunCompleteStatusTone = input.producedWork ? 'warning' : 'danger'

  if (input.exitCode === 130) {
    return {
      kind: 'cancelled',
      label: label('cancelled'),
      srLabel: label('cancelled'),
      tone: 'neutral',
      detail: ''
    }
  }
  if (input.exitCode !== 0) {
    return {
      kind: 'exit-failure',
      label: input.isGlobal ? label('exit-failure') : `Task ended (code ${input.exitCode})`,
      srLabel: input.isGlobal ? label('exit-failure') : `Task ended with code ${input.exitCode}`,
      tone: blockedTone,
      detail: ''
    }
  }
  const blocker = input.blockers?.[0]
  if (blocker) {
    return {
      kind: blocker.kind,
      label: label(blocker.kind),
      srLabel: label(blocker.kind),
      tone: blockedTone,
      // Every blocker's evidence, worst first — the detail the banner carried.
      detail: (input.blockers || [])
        .map((entry) => entry.detail)
        .filter(Boolean)
        .join(' ')
    }
  }
  if (input.awaitingAnswer) {
    return {
      kind: 'awaiting-answer',
      label: label('awaiting-answer'),
      srLabel: label('awaiting-answer'),
      tone: 'neutral',
      detail: ''
    }
  }
  return {
    kind: 'complete',
    label: label('complete'),
    srLabel: label('complete'),
    tone: 'neutral',
    detail: ''
  }
}
