import type { ChatMessage, ChatRun } from '../../../main/store/types'
import { extractUsageCountsFromCandidate } from './usageStats'
import { estimateLiveOutputTokensFromChars } from './liveOutputTokens'

export type WorkingIndicatorTokenInput = {
  runId: string | null
  tokenAccumulatorBase: number
}

export type WorkingIndicatorTokenTarget = {
  runId: string | null
  /** Completed participant turns plus the best live current-turn snapshot. */
  targetTokens: number
  /** Stream-text estimate used only when an authoritative snapshot is absent. */
  estimatedCurrentTurnTokens: number
}

function nonNegativeInteger(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

/**
 * Build all active working-row targets in one pass over streamed messages.
 * Fan-out lanes stay isolated by run id; a Claude text burst can never add
 * tokens to a simultaneously-running Cursor row.
 */
export function buildWorkingIndicatorTokenTargets(
  runs: readonly ChatRun[],
  messages: readonly ChatMessage[],
  inputs: readonly WorkingIndicatorTokenInput[]
): Map<string | null, WorkingIndicatorTokenTarget> {
  const inputsByRunId = new Map<string, WorkingIndicatorTokenInput>()
  for (const input of inputs) {
    if (input.runId) inputsByRunId.set(input.runId, input)
  }

  const charsByRunId = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.runId || !inputsByRunId.has(message.runId)) {
      continue
    }
    charsByRunId.set(
      message.runId,
      (charsByRunId.get(message.runId) || 0) + (message.content?.length || 0)
    )
  }

  const runsById = new Map(runs.map((run) => [run.runId, run]))
  const targets = new Map<string | null, WorkingIndicatorTokenTarget>()
  for (const input of inputs) {
    const base = nonNegativeInteger(input.tokenAccumulatorBase)
    const run = input.runId ? runsById.get(input.runId) : undefined
    const reportedCurrentTurn = run
      ? nonNegativeInteger(extractUsageCountsFromCandidate(run.stats).totalTokens)
      : 0
    const estimatedCurrentTurnTokens = input.runId
      ? estimateLiveOutputTokensFromChars(charsByRunId.get(input.runId) || 0)
      : 0
    targets.set(input.runId, {
      runId: input.runId,
      targetTokens: base + Math.max(reportedCurrentTurn, estimatedCurrentTurnTokens),
      estimatedCurrentTurnTokens
    })
  }
  return targets
}

/**
 * Reduces prop churn from raw streamed characters. The local leaf still draws
 * at 500ms, but small provider deltas wait for a meaningful snapshot boundary
 * instead of repeatedly restarting a 430ms digit roll.
 */
export function workingIndicatorTokenSnapshotBucket(tokens: number): number {
  const value = nonNegativeInteger(tokens)
  const increment = value >= 100_000 ? 1_000 : value >= 10_000 ? 100 : 10
  return Math.floor(value / increment) * increment
}
