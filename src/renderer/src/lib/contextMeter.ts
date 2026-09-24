// Honest "current context" model for the composer context donut + its popover.
//
// The donut historically showed CUMULATIVE tokens (Σ of every run's total) ÷
// window. Because each turn re-sends the whole accumulated conversation, that sum
// re-adds the growing prompt every turn, so it over-counts real occupancy and
// pegs the donut near 100% long before the window is actually full (a chat that
// compacts at 850k/1.05M would already read ~100%).
//
// This module computes the HONEST proxy instead: the LATEST run's provider
// total (falling back to input+output). Each turn's `input_tokens` already
// includes the full re-sent conversation, so the most recent run ≈ what was
// actually in the window that turn. It's an estimate (slightly under-counts by
// whatever was added since that run ended, usually small), so callers should
// label it as such — but it's far truer than the cumulative sum. Computed per
// chat, and per participant for ensembles (each participant runs its own
// window).
//
// Label formatting (provider name + model) is deliberately left to the UI so this
// stays a pure, dependency-light, testable module.
import type {
  ChatMessage,
  ChatRun,
  EnsembleParticipant,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import { isContextWindowProviderId, resolveContextWindow } from './contextWindows'
import { extractUsageLimits } from './usageStats'
import {
  buildContextCompactionUsageEvidenceIndex,
  contextUsageAfterCompaction,
  contextUsageFromStats,
  type ContextCompactionUsageEvidence,
  type ContextUsageSnapshot
} from '../../../shared/contextUsage'
import { estimateTokensFromChars, visiblePayloadChars } from '../../../shared/tokenEstimate'
import { isMcpTransportWrapperActivity } from '../../../shared/toolInvocationPresentation'
import { isReasoningToolName } from './ToolParser'

export interface ContextToolActivityEntry {
  name: string
  label: string
  category: ToolActivity['category']
  count: number
}

export interface ContextActivitySummary {
  messageCount: number
  messageTokens: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  toolInputTokens: number
  toolResultCount: number
  toolResultTokens: number
  reasoningSegmentCount: number
  reasoningTextTokens: number
  readCalls: number
  writeCalls: number
  searchCalls: number
  shellCalls: number
  otherCalls: number
  filesRead: number
  filesWritten: number
  tools: ContextToolActivityEntry[]
}

export interface ContextMeterRow {
  /** Stable key: 'solo', or the ensemble participant id. */
  id: string
  provider: ProviderId
  /** Resolved model id used for the window lookup (may be undefined). */
  modelId?: string
  /** Ensemble participant role, when this row is a participant. */
  role?: string
  /** Honest current-context proxy: the latest run's provider total. */
  usedTokens: number
  windowTokens: number
  /** 0..100, clamped. 0 when the window is unknown. */
  percent: number
  /** Provider-normalized token makeup for the latest invocation/estimate. */
  usage?: ContextUsageSnapshot
  /** Host-observed transcript/tool directions. Token counts here are estimates
   * and are never added on top of provider usage. */
  activity?: ContextActivitySummary
}

export interface ContextMeterModel {
  solo: ContextMeterRow
  /** Ensemble only: one row per participant (un-run participants read 0%). */
  participants?: ContextMeterRow[]
  /** The focused participant id (the roster chip the composer footer is editing).
   * The donut follows this row; the popover highlights it. */
  focusedId?: string
}

/** Provider usage for the currently-streaming run. `totalTokens` is used when
 * a provider omits the individual input/output fields (which is valid for
 * several native transports). */
export interface LiveContextTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextUsage?: ContextUsageSnapshot
  estimated?: boolean
}

export function contextPercent(used: number, window: number): number {
  if (!(window > 0)) return 0
  return Math.min(100, Math.max(0, (used / window) * 100))
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0
}

function estimatedUsageFromCounts(usage: LiveContextTokenUsage): ContextUsageSnapshot | null {
  if (usage.contextUsage) return usage.contextUsage
  return contextUsageFromStats({
    input_tokens: nonNegativeInteger(usage.inputTokens),
    output_tokens: nonNegativeInteger(usage.outputTokens),
    total_tokens: nonNegativeInteger(usage.totalTokens),
    ...(usage.estimated ? { _taskwraith_token_count_confidence: 'estimated' } : {})
  })
}

/**
 * Context occupancy is normally input + output for the latest request. Prefer
 * a provider's explicit total when it includes tokens not broken out into
 * those fields (for example, thinking tokens), and do not discard a valid
 * total-only snapshot.
 */
export function contextTokensFromUsage(usage: LiveContextTokenUsage): number {
  return estimatedUsageFromCounts(usage)?.contextTokens || 0
}

function withLiveOutput(
  usage: ContextUsageSnapshot | null | undefined,
  liveOutputTokens: number
): ContextUsageSnapshot | undefined {
  const live = Math.max(0, Math.trunc(liveOutputTokens))
  if (live <= 0) return usage || undefined
  if (!usage) {
    return (
      contextUsageFromStats({
        output_tokens: live,
        total_tokens: live,
        _taskwraith_token_count_confidence: 'estimated'
      }) || undefined
    )
  }
  return {
    ...usage,
    contextTokens: usage.contextTokens + live,
    totalTokens: usage.totalTokens + live,
    outputTokens: usage.outputTokens + live,
    visibleOutputTokens: usage.visibleOutputTokens + live,
    precision: usage.precision === 'exact' ? 'derived' : usage.precision
  }
}

function normalizeSeatModel(model?: string | null): string {
  return typeof model === 'string' ? model.trim() : ''
}

function runModelCandidatesForSeatMatch(run: ChatRun): string[] {
  // A run carries up to three model identities: the id the provider actually
  // dispatched (`actualModel` — often REWRITTEN by the launch path: the AGY
  // gemini-api lane strips its `gemini-api:` prefix, the Ollama launch plan
  // resolves catalog ids to installed tags like `rnj-1` → `rnj-1:8b`, Claude
  // `-1m` and Cursor `grok-fast` suffixes are stripped), plus the id the seat
  // asked for (`requestedModel`) and the seat snapshot captured at dispatch.
  // The latter two are exact copies of the seat string as it was when the run
  // started, so they are the honest identities for seat matching.
  const candidates = [run.actualModel, run.requestedModel, run.ensembleSeatSnapshot?.model]
    .map(normalizeSeatModel)
    .filter((model) => model.length > 0)
  return [...new Set(candidates)]
}

function runProviderForSeatMatch(run: ChatRun): ProviderId | undefined {
  return run.provider || run.ensembleSeatSnapshot?.provider
}

/**
 * Whether a sealed run still describes the participant's current seat.
 * Ensemble seat changes reuse `participantId`, so prior runs remain on the
 * chat but belong to a different model/provider window. A run missing
 * model/provider cannot be proven stale and still counts.
 *
 * A run matches when ANY of its recorded identities equals the seat model —
 * a provider-side dispatch rewrite (prefix strip, tag resolution) must not
 * zero the seat's meter, while a genuine seat swap (e.g. Codex → Spark under
 * a reused participantId) still mismatches because every identity on the old
 * run names the old model.
 */
export function runMatchesParticipantSeat(
  run: ChatRun,
  participant: Pick<EnsembleParticipant, 'provider' | 'model'>
): boolean {
  const runProvider = runProviderForSeatMatch(run)
  if (runProvider && runProvider !== participant.provider) return false
  const runModels = runModelCandidatesForSeatMatch(run)
  const seatModel = normalizeSeatModel(participant.model)
  if (runModels.length > 0 && seatModel && !runModels.includes(seatModel)) return false
  return true
}

/**
 * The latest run (by startedAt) that carries real usage stats, optionally scoped
 * to one ensemble participant. Returns its context token total, or zero.
 * When `participant` is supplied, only runs that still match that seat's
 * provider/model count — so a Codex→Spark swap under the same participantId
 * does not inherit the prior fill.
 */
function latestRunContext(
  runs: ReadonlyArray<ChatRun>,
  participantId?: string,
  participant?: Pick<EnsembleParticipant, 'provider' | 'model'>
): {
  tokens: number
  usage?: ContextUsageSnapshot
  totalTokenLimit?: number
  observedAt: number
} {
  let bestTime = Number.NEGATIVE_INFINITY
  let best: {
    tokens: number
    usage?: ContextUsageSnapshot
    totalTokenLimit?: number
    observedAt: number
  } | null = null
  for (const run of runs) {
    if (participantId && run.ensembleParticipantId !== participantId) continue
    if (participant && !runMatchesParticipantSeat(run, participant)) continue
    const usage = contextUsageFromStats(run?.stats)
    if (!usage) continue
    const tokens = usage.contextTokens
    const parsed = Date.parse(run.startedAt || '')
    const time = usage?.observedAt ?? (Number.isFinite(parsed) ? parsed : 0)
    if (time >= bestTime) {
      bestTime = time
      best = {
        tokens,
        ...(usage ? { usage } : {}),
        ...extractUsageLimits(run?.stats),
        observedAt: time
      }
    }
  }
  return best ?? { tokens: 0, observedAt: Number.NEGATIVE_INFINITY }
}

function latestContext(
  runs: ReadonlyArray<ChatRun>,
  compaction: ContextCompactionUsageEvidence | null | undefined,
  participantId?: string,
  participant?: Pick<EnsembleParticipant, 'provider' | 'model'>
): ReturnType<typeof latestRunContext> {
  const latest = latestRunContext(runs, participantId, participant)
  if (!compaction || compaction.observedAt < latest.observedAt) return latest
  // Compaction without a matching current-seat sealed baseline is prior-seat
  // evidence — do not resurrect it as current occupancy after a seat change.
  if (latest.observedAt === Number.NEGATIVE_INFINITY) return latest
  const usage = contextUsageAfterCompaction(latest.usage, compaction)
  return {
    ...latest,
    tokens: usage?.contextTokens ?? latest.tokens,
    ...(usage ? { usage } : {}),
    observedAt: compaction.observedAt
  }
}

/**
 * Honest current-context proxy for the active model: the latest run's
 * provider total, plus the in-flight output estimate while a run is streaming.
 */
export function currentContextTokens(
  runs: ReadonlyArray<ChatRun>,
  opts: {
    liveOutputTokens?: number
    isRunning?: boolean
    messages?: ReadonlyArray<ChatMessage>
  } = {}
): number {
  return currentContextUsage(runs, opts)?.contextTokens || 0
}

export function currentContextUsage(
  runs: ReadonlyArray<ChatRun>,
  opts: {
    liveOutputTokens?: number
    isRunning?: boolean
    messages?: ReadonlyArray<ChatMessage>
  } = {}
): ContextUsageSnapshot | undefined {
  const compaction = opts.messages
    ? buildContextCompactionUsageEvidenceIndex(opts.messages).unscoped
    : undefined
  const latest = latestContext(runs, compaction)
  const live = opts.isRunning ? Math.max(0, opts.liveOutputTokens ?? 0) : 0
  return withLiveOutput(latest.usage, live)
}

/** Provider-reported context limit carried by the same latest run selected for
 * current-window usage. Keeps main and multiview meters on the same denominator. */
export function currentContextTokenLimit(runs: ReadonlyArray<ChatRun>): number | undefined {
  return latestRunContext(runs).totalTokenLimit
}

/**
 * Overlay an authoritative live provider snapshot onto the meter. The
 * snapshot replaces the active run's context rather than adding to the last
 * turn: the provider input already includes the current prompt and transcript.
 * Ensemble snapshots are scoped to their active participant; solo snapshots
 * update the solo row.
 */
export function applyLiveContextTokenUsage(
  meter: ContextMeterModel | null | undefined,
  usage: LiveContextTokenUsage | null | undefined,
  participantId?: string
): ContextMeterModel | null | undefined {
  if (!meter || !usage) return meter
  const snapshot = estimatedUsageFromCounts(usage)
  if (!snapshot) return meter
  const usedTokens = snapshot.contextTokens

  const withUsage = (row: ContextMeterRow): ContextMeterRow => {
    const persistedObservedAt = row.usage?.observedAt
    const liveObservedAt = snapshot.observedAt
    // A compaction card can land while the run remains active. Its durable
    // post-window state must not be overwritten by the last pre-compaction
    // working snapshot; a genuinely later provider invocation carries a newer
    // receipt time and resumes the live overlay naturally.
    if (
      persistedObservedAt !== undefined &&
      (liveObservedAt === undefined || liveObservedAt <= persistedObservedAt)
    ) {
      return row
    }
    return {
      ...row,
      usedTokens,
      percent: contextPercent(usedTokens, row.windowTokens),
      usage: snapshot
    }
  }

  if (meter.participants?.length) {
    if (!participantId) return meter
    let matched = false
    const participants = meter.participants.map((row) => {
      if (row.id !== participantId) return row
      matched = true
      return withUsage(row)
    })
    return matched ? { ...meter, participants } : meter
  }

  return { ...meter, solo: withUsage(meter.solo) }
}

/**
 * Live output-token estimate for ONE participant's in-flight (unsealed) run — the
 * per-participant analogue of the chat-wide live estimate. Counts ONLY assistant
 * message chars whose runId belongs to that participant's own unsealed run(s), so
 * it does NOT blend in other participants' output the way a chat-wide
 * "messages after the round started" sum does (which would dump every earlier
 * participant's output onto the one active row). Returns 0 when the participant
 * isn't actively streaming. `estimateFromChars` is injected to keep this module
 * dependency-light (App passes the same char→token estimator the solo donut uses).
 */
export function liveOutputTokensForParticipant(
  runs: ReadonlyArray<ChatRun>,
  messages: ReadonlyArray<{ role: string; runId?: string; content?: string }>,
  participantId: string | undefined,
  estimateFromChars: (chars: number) => number
): number {
  if (!participantId) return 0
  const activeRunIds = new Set(
    runs
      .filter(
        (run) =>
          run.ensembleParticipantId === participantId &&
          (!run.endedAt || run.status === 'running' || run.status === 'queued')
      )
      .map((run) => run.runId)
      .filter((id): id is string => Boolean(id))
  )
  if (activeRunIds.size === 0) return 0
  let liveChars = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (message.runId && activeRunIds.has(message.runId)) {
      liveChars += message.content?.length || 0
    }
  }
  return estimateFromChars(liveChars)
}

function stringField(source: Record<string, unknown> | undefined, keys: string[]): string {
  if (!source) return ''
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function activityFilePath(activity: ToolActivity): string {
  return (
    activity.filePath ||
    activity.affectedFilePath ||
    stringField(activity.parameters, [
      'file_path',
      'filePath',
      'path',
      'absolute_path',
      'target_path'
    ])
  )
}

function activityBelongsToParticipant(
  message: ChatMessage,
  activity: ToolActivity,
  participantId?: string
): boolean {
  if (!participantId) return true
  const activityParticipantId = activity.metadata?.ensembleParticipantId
  if (activityParticipantId) return activityParticipantId === participantId
  const messageParticipantId =
    typeof message.metadata?.ensembleParticipantId === 'string'
      ? message.metadata.ensembleParticipantId
      : ''
  return messageParticipantId === participantId
}

/**
 * Host-observed directions which explain what generated token traffic without
 * pretending TaskWraith can recover provider-owned system prompts or exact
 * tokenizer boundaries. Counts are exact; the token figures use the shared
 * chars÷4 estimate and stay visually marked as estimates.
 */
export function buildContextActivitySummary(
  messages: ReadonlyArray<ChatMessage>,
  participantId?: string
): ContextActivitySummary {
  let messageChars = 0
  let messageCount = 0
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0
  let toolInputChars = 0
  let toolResultCount = 0
  let toolResultChars = 0
  let reasoningSegmentCount = 0
  let reasoningTextChars = 0
  let readCalls = 0
  let writeCalls = 0
  let searchCalls = 0
  let shellCalls = 0
  let otherCalls = 0
  const filesRead = new Set<string>()
  const filesWritten = new Set<string>()
  const tools = new Map<string, ContextToolActivityEntry>()

  for (const message of messages) {
    if (message.content && message.role !== 'tool') {
      messageCount += 1
      messageChars += message.content.length
      if (message.role === 'user') userMessageCount += 1
      if (message.role === 'assistant') assistantMessageCount += 1
    }

    for (const activity of message.toolActivities || []) {
      if (!activityBelongsToParticipant(message, activity, participantId)) continue
      if (isMcpTransportWrapperActivity(activity)) continue
      const reasoning = isReasoningToolName(activity.toolName || '')
      const resultPayload =
        activity.rawResultEvent ??
        activity.outputPreview ??
        activity.resultSummary ??
        activity.outputSummary ??
        ''
      const hasResult =
        activity.rawResultEvent !== undefined ||
        Boolean(activity.outputPreview || activity.resultSummary || activity.outputSummary)
      if (reasoning) {
        reasoningSegmentCount += 1
        reasoningTextChars += visiblePayloadChars(resultPayload)
        continue
      }

      toolCallCount += 1
      toolInputChars += visiblePayloadChars(activity.parameters ?? activity.rawUseEvent)
      if (hasResult) toolResultCount += 1
      toolResultChars += visiblePayloadChars(resultPayload)
      const path = activityFilePath(activity)
      switch (activity.category) {
        case 'read':
          readCalls += 1
          if (path) filesRead.add(path)
          break
        case 'write':
          writeCalls += 1
          if (path) filesWritten.add(path)
          break
        case 'search':
          searchCalls += 1
          break
        case 'shell':
          shellCalls += 1
          break
        default:
          otherCalls += 1
          break
      }

      const name = activity.toolName || 'unknown'
      const existing = tools.get(name)
      if (existing) {
        existing.count += 1
      } else {
        tools.set(name, {
          name,
          label: activity.displayName || name,
          category: activity.category,
          count: 1
        })
      }
    }
  }

  return {
    messageCount,
    messageTokens: estimateTokensFromChars(messageChars),
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    toolInputTokens: estimateTokensFromChars(toolInputChars),
    toolResultCount,
    toolResultTokens: estimateTokensFromChars(toolResultChars),
    reasoningSegmentCount,
    reasoningTextTokens: estimateTokensFromChars(reasoningTextChars),
    readCalls,
    writeCalls,
    searchCalls,
    shellCalls,
    otherCalls,
    filesRead: filesRead.size,
    filesWritten: filesWritten.size,
    tools: [...tools.values()].sort(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name)
    )
  }
}

/**
 * Per-participant context rows for an ensemble chat (honest current-context).
 * `live` lets the ACTIVELY-RUNNING participant's row tick up with the in-flight
 * output estimate mid-stream (the in-flight run has no sealed stats yet, so its
 * row would otherwise freeze at the last turn) — the per-participant analogue of
 * the solo donut's live add. Only the `live.participantId` row gets it.
 */
export function buildParticipantContextRows(
  runs: ReadonlyArray<ChatRun>,
  participants: ReadonlyArray<EnsembleParticipant>,
  live?: {
    participantId?: string
    outputTokens?: number
    resolveWindowTokens?: (participant: EnsembleParticipant) => number | undefined
    messages?: ReadonlyArray<ChatMessage>
  }
): ContextMeterRow[] {
  const compactions = live?.messages
    ? buildContextCompactionUsageEvidenceIndex(live.messages)
    : undefined
  return participants.map((participant) => {
    const latest = latestContext(
      runs,
      compactions?.byParticipantId.get(participant.id),
      participant.id,
      participant
    )
    let usage = latest.usage
    if (live?.participantId && participant.id === live.participantId) {
      usage = withLiveOutput(usage, Math.max(0, live.outputTokens ?? 0))
    }
    const usedTokens = usage ? usage.contextTokens : latest.tokens
    const liveWindowTokens = live?.resolveWindowTokens?.(participant)
    const windowTokens = resolveContextWindow(
      isContextWindowProviderId(participant.provider) ? participant.provider : undefined,
      participant.model,
      latest.totalTokenLimit,
      liveWindowTokens
    )
    return {
      id: participant.id,
      provider: participant.provider,
      modelId: participant.model,
      role: participant.role,
      usedTokens,
      windowTokens,
      percent: contextPercent(usedTokens, windowTokens),
      ...(usage ? { usage } : {})
    }
  })
}
