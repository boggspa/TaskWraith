import type { ChatMessage, ChatRun, ProviderId, ToolActivity } from '../../../main/store/types'
import {
  buildContextCompactionUsageEvidenceIndex,
  contextUsageFromStats,
  type ContextCompactionUsageEvidence,
  type ContextUsageSnapshot
} from '../../../shared/contextUsage'
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
  /** Provider/model identity plus the latest successful compaction. */
  tokenEpochKey: string
  /** Successful compaction boundary used to reject older live snapshots. */
  tokenEpochObservedAt: number | null
  /** Latest sealed context for this provider/model seat before the active run. */
  contextBaselineTokens: number
  contextBaselineAvailable: boolean
  contextState: WorkingIndicatorContextState
  /** Best current-context snapshot or renderer-side live estimate. */
  targetTokens: number
  /** Visible assistant text plus tool inputs/results observed for this run. */
  estimatedCurrentTurnTokens: number
  /** Tool-result subset that may arrive after the latest provider snapshot. */
  estimatedToolResultTokens: number
}

export type WorkingIndicatorContextState =
  | 'available'
  | 'estimated'
  | 'unavailable'
  | 'post-compaction-unknown'

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

function runBelongsToWorkingScope(run: ChatRun, input: WorkingIndicatorTokenInput): boolean {
  return input.participantId
    ? run.ensembleParticipantId === input.participantId
    : !run.ensembleParticipantId
}

function usageObservedAt(usage: ContextUsageSnapshot, run: ChatRun): number {
  if (usage.observedAt !== undefined) return usage.observedAt
  const startedAt = Date.parse(run.startedAt || '')
  return Number.isFinite(startedAt) ? startedAt : 0
}

type ObservedContextUsage = {
  usage: ContextUsageSnapshot
  observedAt: number
}

function latestContextUsage(
  runs: readonly ChatRun[],
  input: WorkingIndicatorTokenInput,
  excludeRunId?: string | null
): ObservedContextUsage | null {
  let latest: ObservedContextUsage | null = null
  let latestObservedAt = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    if (excludeRunId && run.runId === excludeRunId) continue
    if (!runBelongsToWorkingSeat(run, input)) continue
    const usage = contextUsageFromStats(run.stats)
    if (!usage) continue
    const observedAt = usageObservedAt(usage, run)
    if (observedAt >= latestObservedAt) {
      latest = { usage, observedAt }
      latestObservedAt = observedAt
    }
  }
  return latest
}

function compactionBelongsToWorkingSeat(
  evidence: ContextCompactionUsageEvidence,
  runs: readonly ChatRun[],
  input: WorkingIndicatorTokenInput
): boolean {
  if (evidence.provider && input.provider && evidence.provider !== input.provider) return false

  let latestScopedRun: ChatRun | null = null
  let latestStartedAt = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    if (!runBelongsToWorkingScope(run, input)) continue
    const startedAt = Date.parse(run.startedAt || '')
    const observedAt = Number.isFinite(startedAt) ? startedAt : 0
    if (evidence.observedAt > 0 && observedAt > evidence.observedAt) continue
    if (observedAt >= latestStartedAt) {
      latestScopedRun = run
      latestStartedAt = observedAt
    }
  }
  return Boolean(latestScopedRun && runBelongsToWorkingSeat(latestScopedRun, input))
}

function workingSeatEpochKey(input: WorkingIndicatorTokenInput): string {
  return JSON.stringify([
    input.participantId || 'solo',
    input.provider || 'unknown-provider',
    input.modelId || 'unknown-model'
  ])
}

function contextStateForUsage(usage: ContextUsageSnapshot): WorkingIndicatorContextState {
  return usage.precision === 'estimated' ? 'estimated' : 'available'
}

function messageFallsInsideTokenEpoch(
  message: ChatMessage,
  messageIndex: number,
  compaction: ContextCompactionUsageEvidence | null,
  messageIndexById: ReadonlyMap<string, number>
): boolean {
  if (!compaction) return true
  const compactionIndex = compaction.messageId
    ? messageIndexById.get(compaction.messageId)
    : undefined
  if (compactionIndex !== undefined) return messageIndex > compactionIndex
  const timestamp = Date.parse(message.timestamp || '')
  return Number.isFinite(timestamp) && timestamp > compaction.observedAt
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
 * Build all active working-row targets through shared transcript scans. The
 * compaction index is built once, and fan-out lanes stay isolated by run id;
 * a Claude text burst can never add tokens to a simultaneously-running row.
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

  const compactionIndex = buildContextCompactionUsageEvidenceIndex(messages)
  const compactionByInput = new Map<
    WorkingIndicatorTokenInput,
    ContextCompactionUsageEvidence | null
  >()
  for (const input of inputs) {
    const candidate = input.participantId
      ? compactionIndex.byParticipantId.get(input.participantId) || null
      : compactionIndex.unscoped
    compactionByInput.set(
      input,
      candidate && compactionBelongsToWorkingSeat(candidate, runs, input) ? candidate : null
    )
  }

  const messageIndexById = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const messageId = messages[index]?.id
    if (messageId) messageIndexById.set(messageId, index)
  }

  const messageCharsByRunId = new Map<string, number>()
  const activityCharsByRunId = new Map<string, Map<string, { total: number; result: number }>>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message.runId) continue
    const input = inputsByRunId.get(message.runId)
    if (!input) continue
    if (
      !messageFallsInsideTokenEpoch(
        message,
        index,
        compactionByInput.get(input) || null,
        messageIndexById
      )
    ) {
      continue
    }
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
    const currentRunContext =
      run && runBelongsToWorkingSeat(run, input)
        ? (() => {
            const usage = contextUsageFromStats(run.stats)
            return usage ? { usage, observedAt: usageObservedAt(usage, run) } : null
          })()
        : null
    const compaction = compactionByInput.get(input) || null
    const epochObservedAt = compaction?.observedAt ?? null
    const baselineIsFresh =
      Boolean(baselineUsage) &&
      (epochObservedAt === null || baselineUsage!.observedAt > epochObservedAt)
    const currentRunIsFresh =
      Boolean(currentRunContext) &&
      (epochObservedAt === null || currentRunContext!.observedAt > epochObservedAt)

    let base = baselineIsFresh ? nonNegativeInteger(baselineUsage?.usage.contextTokens) : 0
    let contextBaselineAvailable = baselineIsFresh
    let contextState: WorkingIndicatorContextState = baselineIsFresh
      ? contextStateForUsage(baselineUsage!.usage)
      : 'unavailable'
    if (compaction && !baselineIsFresh) {
      if (compaction.postTokens !== undefined) {
        base = nonNegativeInteger(compaction.postTokens)
        contextBaselineAvailable = true
        contextState = 'available'
      } else {
        contextState = 'post-compaction-unknown'
      }
    }
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
    const reportedCurrentContext = currentRunIsFresh
      ? nonNegativeInteger(currentRunContext?.usage.contextTokens)
      : 0
    let targetTokens = 0
    if (currentRunIsFresh) {
      contextState = contextStateForUsage(currentRunContext!.usage)
      targetTokens = Math.max(reportedCurrentContext, base + estimatedCurrentTurnTokens)
    } else if (contextState !== 'post-compaction-unknown') {
      targetTokens = Math.max(reportedCurrentContext, base + estimatedCurrentTurnTokens)
      if (contextState === 'unavailable' && estimatedCurrentTurnTokens > 0) {
        contextState = 'estimated'
        targetTokens = estimatedCurrentTurnTokens
      }
    }
    const seatEpochKey = workingSeatEpochKey(input)
    const compactionEpochKey = compaction
      ? compaction.epochKey || `${compaction.observedAt}:${compaction.postTokens ?? 'unknown'}`
      : null
    targets.set(input.runId, {
      runId: input.runId,
      tokenEpochKey: compactionEpochKey
        ? `${seatEpochKey}:compaction:${compactionEpochKey}`
        : seatEpochKey,
      tokenEpochObservedAt: epochObservedAt,
      contextBaselineTokens: base,
      contextBaselineAvailable,
      contextState,
      targetTokens,
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
