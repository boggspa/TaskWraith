// Honest "current context" model for the composer context donut + its popover.
//
// The donut historically showed CUMULATIVE tokens (Σ of every run's total) ÷
// window. Because each turn re-sends the whole accumulated conversation, that sum
// re-adds the growing prompt every turn, so it over-counts real occupancy and
// pegs the donut near 100% long before the window is actually full (a chat that
// compacts at 850k/1.05M would already read ~100%).
//
// This module computes the HONEST proxy instead: the LATEST run's input+output
// tokens. Each turn's `input_tokens` already includes the full re-sent
// conversation, so the most recent run ≈ what was actually in the window that
// turn. It's an estimate (slightly under-counts by whatever was added since that
// run ended, usually small), so callers should label it as such — but it's far
// truer than the cumulative sum. Computed per chat, and per participant for
// ensembles (each participant runs its own model, so its own window).
//
// Label formatting (provider name + model) is deliberately left to the UI so this
// stays a pure, dependency-light, testable module.
import type { ChatRun, EnsembleParticipant, ProviderId } from '../../../main/store/types'
import { resolveContextWindow } from './contextWindows'
import { extractUsageCountsFromCandidate } from './usageStats'

export interface ContextMeterRow {
  /** Stable key: 'solo', or the ensemble participant id. */
  id: string
  provider: ProviderId
  /** Resolved model id used for the window lookup (may be undefined). */
  modelId?: string
  /** Ensemble participant role, when this row is a participant. */
  role?: string
  /** Honest current-context proxy: the latest run's input+output tokens. */
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

export function contextPercent(used: number, window: number): number {
  if (!(window > 0)) return 0
  return Math.min(100, Math.max(0, (used / window) * 100))
}

/**
 * The latest run (by startedAt) that carries real usage stats, optionally scoped
 * to one ensemble participant. Returns its input+output token counts, or zeros.
 */
function latestRunContext(
  runs: ReadonlyArray<ChatRun>,
  participantId?: string
): { input: number; output: number } {
  let bestTime = Number.NEGATIVE_INFINITY
  let best: { input: number; output: number } | null = null
  for (const run of runs) {
    if (participantId && run.ensembleParticipantId !== participantId) continue
    const counts = extractUsageCountsFromCandidate(run?.stats)
    if (counts.totalTokens <= 0 && counts.inputTokens <= 0) continue
    const parsed = Date.parse(run.startedAt || '')
    const time = Number.isFinite(parsed) ? parsed : 0
    if (time >= bestTime) {
      bestTime = time
      best = { input: counts.inputTokens, output: counts.outputTokens }
    }
  }
  return best ?? { input: 0, output: 0 }
}

/**
 * Honest current-context proxy for the active model: the latest run's
 * input+output, plus the in-flight output estimate while a run is streaming.
 */
export function currentContextTokens(
  runs: ReadonlyArray<ChatRun>,
  opts: { liveOutputTokens?: number; isRunning?: boolean } = {}
): number {
  const latest = latestRunContext(runs)
  const base = latest.input + latest.output
  const live = opts.isRunning ? Math.max(0, opts.liveOutputTokens ?? 0) : 0
  return base + live
}

/** Per-participant context rows for an ensemble chat (honest current-context). */
export function buildParticipantContextRows(
  runs: ReadonlyArray<ChatRun>,
  participants: ReadonlyArray<EnsembleParticipant>
): ContextMeterRow[] {
  return participants.map((participant) => {
    const latest = latestRunContext(runs, participant.id)
    const usedTokens = latest.input + latest.output
    const windowTokens = resolveContextWindow(participant.provider, participant.model)
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
