import { isDeepStrictEqual } from 'node:util'
import { TOKEN_COUNT_CONFIDENCE_KEY, TOKEN_COUNT_ESTIMATED } from '../shared/tokenEstimate'
import type { ChatRecord, EnsembleParticipant, ProviderId } from './store/types'

export interface EnsembleWorkingUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimated: boolean
}

export interface ReconcileEnsembleTerminalUsageInput {
  chat: ChatRecord
  runId: string
  participantId: string
  provider: ProviderId
  terminalStats: Record<string, unknown>
  previousTotalsApplied: boolean
  nowMs: number
}

export interface ReconciledEnsembleTerminalUsage {
  chat: ChatRecord
  stats: Record<string, unknown>
}

const TOKEN_TOTAL_FIELDS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['total_tokens', 'totalTokens'],
  ['duration_ms', 'durationMs']
] as const

function positiveCount(stats: unknown, snake: string, camel: string): number {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return 0
  const record = stats as Record<string, unknown>
  const value = Number(record[snake] ?? record[camel])
  return Number.isFinite(value) && value > 0 ? value : 0
}

function hasTokenCounts(stats: Record<string, unknown>): boolean {
  return TOKEN_TOTAL_FIELDS.slice(0, 3).some(
    ([snake, camel]) => positiveCount(stats, snake, camel) > 0
  )
}

/**
 * Convert the last live Working snapshot into provisional durable run stats.
 * This makes replacing the ephemeral snapshot with a sealed ChatRun lossless
 * while the provider's richer terminal result is still in flight.
 */
export function statsFromEnsembleWorkingUsage(
  snapshot: EnsembleWorkingUsageSnapshot | undefined
): Record<string, unknown> | undefined {
  if (!snapshot) return undefined
  const inputTokens = Math.max(0, Math.trunc(snapshot.inputTokens || 0))
  const outputTokens = Math.max(0, Math.trunc(snapshot.outputTokens || 0))
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    Math.max(0, Math.trunc(snapshot.totalTokens || 0))
  )
  if (totalTokens <= 0) return undefined
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(snapshot.estimated ? { [TOKEN_COUNT_CONFIDENCE_KEY]: TOKEN_COUNT_ESTIMATED } : {})
  }
}

/**
 * A terminal frame with token counts supersedes the provisional snapshot.
 * Duration/cost-only frames enrich it instead, preserving the token estimate
 * until a provider-reported count is available.
 */
export function mergeEnsembleTerminalStats(
  previousStats: unknown,
  terminalStats: Record<string, unknown>
): Record<string, unknown> {
  const previous =
    previousStats && typeof previousStats === 'object' && !Array.isArray(previousStats)
      ? (previousStats as Record<string, unknown>)
      : undefined
  if (!previous || hasTokenCounts(terminalStats)) return { ...terminalStats }
  return { ...previous, ...terminalStats }
}

function adjustParticipantTokenTotals(
  existing: EnsembleParticipant['tokenTotals'],
  previousStats: unknown,
  nextStats: Record<string, unknown>,
  previousTotalsApplied: boolean
): EnsembleParticipant['tokenTotals'] {
  const next = { ...(existing || {}) }
  for (const [snake, camel] of TOKEN_TOTAL_FIELDS) {
    const prior = previousTotalsApplied ? positiveCount(previousStats, snake, camel) : 0
    const incoming = positiveCount(nextStats, snake, camel)
    const adjusted = Math.max(0, (next[snake] || 0) + incoming - prior)
    if (adjusted > 0) next[snake] = adjusted
    else delete next[snake]
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * Replace one exact, already-sealed ensemble run's provisional stats with its
 * late provider terminal stats. Participant lifetime totals are corrected by
 * delta, so duplicate terminal frames cannot double-count the run.
 */
export function reconcileEnsembleTerminalUsage(
  input: ReconcileEnsembleTerminalUsageInput
): ReconciledEnsembleTerminalUsage | null {
  const runIndex = input.chat.runs.findIndex((run) => run.runId === input.runId)
  if (runIndex < 0) return null
  const run = input.chat.runs[runIndex]
  if (
    run.provider !== input.provider ||
    run.ensembleParticipantId !== input.participantId ||
    !input.chat.ensemble
  ) {
    return null
  }

  const stats = mergeEnsembleTerminalStats(run.stats, input.terminalStats)
  const participantIndex = input.chat.ensemble.participants.findIndex(
    (participant) => participant.id === input.participantId
  )
  if (participantIndex < 0) return null
  const participant = input.chat.ensemble.participants[participantIndex]
  const tokenTotals = adjustParticipantTokenTotals(
    participant.tokenTotals,
    run.stats,
    stats,
    input.previousTotalsApplied
  )
  const statsChanged = !isDeepStrictEqual(run.stats, stats)
  const totalsChanged = !isDeepStrictEqual(participant.tokenTotals, tokenTotals)
  if (!statsChanged && !totalsChanged) return null

  const runs = [...input.chat.runs]
  if (statsChanged) runs[runIndex] = { ...run, stats }
  const participants = [...input.chat.ensemble.participants]
  if (totalsChanged) {
    const updatedParticipant = { ...participant }
    if (tokenTotals) updatedParticipant.tokenTotals = tokenTotals
    else delete updatedParticipant.tokenTotals
    participants[participantIndex] = updatedParticipant
  }

  return {
    stats,
    chat: {
      ...input.chat,
      runs,
      ensemble: { ...input.chat.ensemble, participants },
      updatedAt: input.nowMs
    }
  }
}
