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
import type { ChatRun, EnsembleParticipant, ProviderId } from '../../../main/store/types'
import { isContextWindowProviderId, resolveContextWindow } from './contextWindows'
import { extractUsageCountsFromCandidate, extractUsageLimits } from './usageStats'

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
}

export function contextPercent(used: number, window: number): number {
  if (!(window > 0)) return 0
  return Math.min(100, Math.max(0, (used / window) * 100))
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0
}

/**
 * Context occupancy is normally input + output for the latest request. Prefer
 * a provider's explicit total when it includes tokens not broken out into
 * those fields (for example, thinking tokens), and do not discard a valid
 * total-only snapshot.
 */
export function contextTokensFromUsage(usage: LiveContextTokenUsage): number {
  const input = nonNegativeInteger(usage.inputTokens)
  const output = nonNegativeInteger(usage.outputTokens)
  const total = nonNegativeInteger(usage.totalTokens)
  return Math.max(total, input + output)
}

/**
 * The latest run (by startedAt) that carries real usage stats, optionally scoped
 * to one ensemble participant. Returns its context token total, or zero.
 */
function latestRunContext(
  runs: ReadonlyArray<ChatRun>,
  participantId?: string
): { tokens: number; totalTokenLimit?: number } {
  let bestTime = Number.NEGATIVE_INFINITY
  let best: { tokens: number; totalTokenLimit?: number } | null = null
  for (const run of runs) {
    if (participantId && run.ensembleParticipantId !== participantId) continue
    const counts = extractUsageCountsFromCandidate(run?.stats)
    const tokens = contextTokensFromUsage(counts)
    if (tokens <= 0) continue
    const parsed = Date.parse(run.startedAt || '')
    const time = Number.isFinite(parsed) ? parsed : 0
    if (time >= bestTime) {
      bestTime = time
      best = {
        tokens,
        ...extractUsageLimits(run?.stats)
      }
    }
  }
  return best ?? { tokens: 0 }
}

/**
 * Honest current-context proxy for the active model: the latest run's
 * provider total, plus the in-flight output estimate while a run is streaming.
 */
export function currentContextTokens(
  runs: ReadonlyArray<ChatRun>,
  opts: { liveOutputTokens?: number; isRunning?: boolean } = {}
): number {
  const latest = latestRunContext(runs)
  const base = latest.tokens
  const live = opts.isRunning ? Math.max(0, opts.liveOutputTokens ?? 0) : 0
  return base + live
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
  const usedTokens = contextTokensFromUsage(usage)
  if (usedTokens <= 0) return meter

  const withUsage = (row: ContextMeterRow): ContextMeterRow => ({
    ...row,
    usedTokens,
    percent: contextPercent(usedTokens, row.windowTokens)
  })

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
  }
): ContextMeterRow[] {
  return participants.map((participant) => {
    const latest = latestRunContext(runs, participant.id)
    let usedTokens = latest.tokens
    if (live?.participantId && participant.id === live.participantId) {
      usedTokens += Math.max(0, live.outputTokens ?? 0)
    }
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
      percent: contextPercent(usedTokens, windowTokens)
    }
  })
}
