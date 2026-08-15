import type { ChatMessage, ChatRun, ProviderId, ToolActivity } from '../../../main/store/types'
import { contextUsageFromStats, type ContextUsageSnapshot } from '../../../shared/contextUsage'
import { estimateTokensFromChars, visiblePayloadChars } from '../../../shared/tokenEstimate'
import { runMatchesParticipantSeat } from './contextMeter'
import { isReasoningToolName } from './ToolParser'

export type WorkingIndicatorTokenInput = {
  runId: string | null
  participantId: string | null
  provider: ProviderId | null
  modelId: string | null
}

export type WorkingIndicatorTokenTarget = {
  runId: string | null
  /** Latest sealed context for this provider/model seat before the active run. */
  contextBaselineTokens: number
  contextBaselineAvailable: boolean
  /** Best current-context snapshot or renderer-side live estimate. */
  targetTokens: number
  /** Visible assistant text plus tool inputs/results observed for this run. */
  estimatedCurrentTurnTokens: number
  /** Tool-result subset that may arrive after the latest provider snapshot. */
  estimatedToolResultTokens: number
}

function nonNegativeInteger(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

function runBelongsToWorkingSeat(run: ChatRun, input: WorkingIndicatorTokenInput): boolean {
  if (input.participantId) {
    if (run.ensembleParticipantId !== input.participantId) return false
  } else if (run.ensembleParticipantId) {
    return false
  }
  if (!input.provider) return true
  return runMatchesParticipantSeat(run, {
    provider: input.provider,
    model: input.modelId || undefined
  })
}

function usageObservedAt(usage: ContextUsageSnapshot, run: ChatRun): number {
  if (usage.observedAt !== undefined) return usage.observedAt
  const startedAt = Date.parse(run.startedAt || '')
  return Number.isFinite(startedAt) ? startedAt : 0
}

function latestContextUsage(
  runs: readonly ChatRun[],
  input: WorkingIndicatorTokenInput,
  excludeRunId?: string | null
): ContextUsageSnapshot | null {
  let latest: ContextUsageSnapshot | null = null
  let latestObservedAt = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    if (excludeRunId && run.runId === excludeRunId) continue
    if (!runBelongsToWorkingSeat(run, input)) continue
    const usage = contextUsageFromStats(run.stats)
    if (!usage) continue
    const observedAt = usageObservedAt(usage, run)
    if (observedAt >= latestObservedAt) {
      latest = usage
      latestObservedAt = observedAt
    }
  }
  return latest
}

function toolActivityPayloadChars(activity: ToolActivity): {
  total: number
  result: number
} {
  const resultPayload =
    activity.rawResultEvent ??
    activity.outputPreview ??
    activity.resultSummary ??
    activity.outputSummary ??
    ''
  const result = visiblePayloadChars(resultPayload)
  return {
    total:
      (activity.toolName?.length || 0) +
      visiblePayloadChars(activity.parameters ?? activity.rawUseEvent) +
      result,
    // A real tool result becomes input to the next model invocation. Reasoning
    // activities are provider output, so an authoritative usage snapshot can
    // already include them and they must not ride the additive bridge.
    result: isReasoningToolName(activity.toolName || '') ? 0 : result
  }
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

  const messageCharsByRunId = new Map<string, number>()
  const activityCharsByRunId = new Map<string, Map<string, { total: number; result: number }>>()
  for (const message of messages) {
    if (!message.runId || !inputsByRunId.has(message.runId)) continue
    if (message.role === 'assistant') {
      messageCharsByRunId.set(
        message.runId,
        (messageCharsByRunId.get(message.runId) || 0) + (message.content?.length || 0)
      )
    }
    if (!message.toolActivities?.length) continue
    const activities = activityCharsByRunId.get(message.runId) || new Map()
    for (const activity of message.toolActivities) {
      const payload = toolActivityPayloadChars(activity)
      const previous = activities.get(activity.id)
      activities.set(activity.id, {
        total: Math.max(previous?.total || 0, payload.total),
        result: Math.max(previous?.result || 0, payload.result)
      })
    }
    activityCharsByRunId.set(message.runId, activities)
  }

  const runsById = new Map(runs.map((run) => [run.runId, run]))
  const targets = new Map<string | null, WorkingIndicatorTokenTarget>()
  for (const input of inputs) {
    const run = input.runId ? runsById.get(input.runId) : undefined
    const baselineUsage = latestContextUsage(runs, input, input.runId)
    const base = nonNegativeInteger(baselineUsage?.contextTokens)
    const currentRunUsage =
      run && runBelongsToWorkingSeat(run, input) ? contextUsageFromStats(run.stats) : null
    const reportedCurrentContext = nonNegativeInteger(currentRunUsage?.contextTokens)
    const activities = input.runId ? activityCharsByRunId.get(input.runId) : undefined
    let activityChars = 0
    let toolResultChars = 0
    for (const payload of activities?.values() || []) {
      activityChars += payload.total
      toolResultChars += payload.result
    }
    const estimatedCurrentTurnTokens = input.runId
      ? estimateTokensFromChars((messageCharsByRunId.get(input.runId) || 0) + activityChars)
      : 0
    const estimatedToolResultTokens = estimateTokensFromChars(toolResultChars)
    targets.set(input.runId, {
      runId: input.runId,
      contextBaselineTokens: base,
      contextBaselineAvailable: Boolean(baselineUsage),
      targetTokens: Math.max(reportedCurrentContext, base + estimatedCurrentTurnTokens),
      estimatedCurrentTurnTokens,
      estimatedToolResultTokens
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
