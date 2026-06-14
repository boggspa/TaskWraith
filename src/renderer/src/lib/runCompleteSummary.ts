import type {
  ChatRecord,
  ChatRun,
  ComplexityEscalationAction,
  ComplexityEscalationKind,
  ComplexityEscalationSignal,
  EnsembleRoundParticipantState
} from '../../../main/store/types'
import { formatContextTokens } from './contextWindows'
import { formatCostAlwaysOn, type DisplayCurrency } from './formatCost'
import { humaniseModelId } from './modelDisplayName'
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

export type RunCompleteSummaryRow = {
  label: string
  value: string
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
 *     reported (per-token API seats: Claude / Gemini / Kimi).
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
      run.stats?._taskwraith_input_includes_cache === true ||
      cacheCounts.cacheReadInputTokens > 0 ||
      cacheCounts.cacheCreationInputTokens > 0
    const model = run.actualModel || run.requestedModel
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

const formatApprovalModeLabel = (mode?: string): string => {
  if (!mode) return 'Unknown'
  if (mode === 'plan') return 'Read-only'
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

const readPositiveNumberPair = (
  obj: any,
  primaryPaths: Array<string | string[]>,
  secondaryPaths: Array<string | string[]> = []
): number => readPositiveNumber(obj, primaryPaths) + readPositiveNumber(obj, secondaryPaths)

const extractCacheUsageCounts = (
  stats: any
): { cacheReadInputTokens: number; cacheCreationInputTokens: number } => {
  return {
    cacheReadInputTokens: readPositiveNumberPair(
      stats,
      [
        ['cacheReadInputTokens'],
        ['cache_read_input_tokens'],
        ['input_cache_read'],
        ['cacheReadTokens']
      ],
      [['cached_input_tokens'], ['cachedInputTokens']]
    ),
    cacheCreationInputTokens: readPositiveNumber(stats, [
      ['cacheCreationInputTokens'],
      ['cache_creation_input_tokens'],
      ['input_cache_creation']
    ])
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

/** Guest-child Ollama peak RAM for a standard chat's run-complete summary. */
export const buildGuestCompanionRamRow = (
  companionRuns: ChatRun[] = []
): RunCompleteSummaryRow | null => {
  const { peakGb, samples } = findPeakOllamaRamFromRuns(companionRuns)
  return buildOllamaRamRowFromPeak(peakGb, samples)
}

export const resolveGuestCompanionRuns = (
  chat: ChatRecord | null | undefined,
  chats: ChatRecord[]
): ChatRun[] => {
  const childId = chat?.guestParticipant?.childChatId
  if (!childId) return []
  return chats.find((entry) => entry.appChatId === childId)?.runs || []
}

export const buildRunCompleteSummaryRows = (run?: ChatRun | null): RunCompleteSummaryRow[] => {
  if (!run) return []

  const rows: RunCompleteSummaryRow[] = []
  const model = run.actualModel || run.requestedModel
  if (model) rows.push({ label: 'Model', value: humaniseModelId(run.provider, model) || model })
  rows.push({ label: 'Mode', value: formatApprovalModeLabel(run.approvalMode) })
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
  const firstApprovalMode = roundRuns.find((run) => run.approvalMode)?.approvalMode
  if (firstApprovalMode) {
    rows.push({ label: 'Mode', value: formatApprovalModeLabel(firstApprovalMode) })
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

/**
 * 1.0.7 (M5 surfacing) — presentation model for one complexity-escalation
 * signal. The orchestrator already computes + persists these every round
 * (`chat.ensemble.escalationSignals`); they were dark-shipped and rendered
 * nowhere. This is a PURE mapping from the stored signal to the copy an
 * advisory chip renders — short label + a one-line recommended next step.
 *
 * FRAMING (the maintainer's explicit constraint): these are advisory only —
 * the orchestrator never auto-acts. The copy makes a tradeoff VISIBLE so the
 * user decides; it must never frame a multi-seat panel as waste. Note the
 * recommended action for `disagreement-unresolved` is to ADD a synthesizer to
 * reconcile — i.e. lean INTO the panel, not shrink it.
 */
export type EscalationChipModel = {
  id: string
  /** Short human label for the signal kind. */
  label: string
  /** One-line recommended next step (advisory). */
  action: string
  /** Coarse tone for styling — failures read warmer than advisories. */
  tone: 'attention' | 'info'
}

const ESCALATION_KIND_LABEL: Record<ComplexityEscalationKind, string> = {
  stuck: 'Round stalled',
  looping: 'Handoffs exhausted',
  'disagreement-unresolved': 'Unreconciled answers',
  'tool-error-cluster': 'Tool errors clustered'
}

const ESCALATION_KIND_TONE: Record<ComplexityEscalationKind, EscalationChipModel['tone']> = {
  stuck: 'attention',
  looping: 'info',
  'disagreement-unresolved': 'info',
  'tool-error-cluster': 'attention'
}

const ESCALATION_ACTION_COPY: Record<ComplexityEscalationAction, string> = {
  // Lean into the panel — never frame more seats as waste.
  'extend-rounds': 'Consider another round to converge.',
  'call-synthesizer': 'Add a synthesizer to reconcile the answers.',
  'pause-for-user': 'Your input would help unblock this.'
}

/**
 * Map the signals persisted on a chat's ensemble state to chip view-models
 * for the CURRENT round only (signals carry their originating `roundId`).
 * De-duplicates by signal kind (the orchestrator already uses deterministic
 * `${roundId}-esc-${kind}` ids, but a defensive de-dup keeps the chip strip
 * tidy). Returns [] when there's no active round or no signals — the caller
 * renders nothing.
 *
 * Pure + side-effect-free so the kind/action copy + filtering are unit-tested
 * without a render harness.
 */
export const buildEscalationChips = (chat: ChatRecord | null): EscalationChipModel[] => {
  const round = chat?.ensemble?.activeRound
  const signals = chat?.ensemble?.escalationSignals
  if (!round || !signals || signals.length === 0) return []
  const seenKinds = new Set<ComplexityEscalationKind>()
  const chips: EscalationChipModel[] = []
  for (const signal of signals as ComplexityEscalationSignal[]) {
    if (signal.roundId !== round.roundId) continue
    if (seenKinds.has(signal.kind)) continue
    seenKinds.add(signal.kind)
    chips.push({
      id: signal.id,
      label: ESCALATION_KIND_LABEL[signal.kind] || signal.kind,
      action: ESCALATION_ACTION_COPY[signal.recommendedAction] || '',
      tone: ESCALATION_KIND_TONE[signal.kind] || 'info'
    })
  }
  return chips
}
