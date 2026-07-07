import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileSummary,
  EnsembleRoundState
} from '../../../main/store/types'
import { computeGoalRuntimeTiming } from '../../../main/GoalState'
import {
  TASKWRAITH_CLOSEOUT_KIND,
  taskWraithRoundCloseoutId,
  taskWraithRunCloseoutId
} from '../../../shared/taskWraithCloseout'
import { formatContextTokens } from './contextWindows'
import { getProviderLabel } from './providerLabels'
import { extractUsageCountsFromCandidate } from './usageStats'

type CloseoutPlacement = {
  sourceRunId?: string
  promptMessageId?: string
  closeoutRoundId?: string
}

export function buildTaskWraithRunCloseoutMessage(input: {
  chat: ChatRecord
  run: ChatRun
  completedAt: string
  exitCode?: number
  fileSummaries?: DiffFileSummary[]
  now?: Date
}): ChatMessage {
  const { chat, run, completedAt, exitCode } = input
  const durationMs = durationBetween(run.startedAt, completedAt)
  const lines = [
    formatWorkedFor(durationMs),
    '',
    'Close-out:',
    `- Status: ${formatRunStatus(run.status, exitCode)}.`
  ]
  const summaryLine = latestAssistantSummary(chat.messages, run.runId)
  if (summaryLine) lines.push(`- Summary: ${summaryLine}`)
  const fileLine = fileSummaryLine(input.fileSummaries)
  if (fileLine) lines.push(`- Changed: ${fileLine}`)
  const tokenLine = tokenSummaryLine([run])
  if (tokenLine) lines.push(`- Tokens: ${tokenLine}.`)
  const goalLine = goalSummaryLine(
    resolveCloseoutGoal(chat.activeGoal, run.activeGoalId),
    input.now
  )
  if (goalLine) lines.push(`- Goal: ${goalLine}`)

  return {
    id: taskWraithRunCloseoutId(run.runId),
    role: 'system',
    content: lines.join('\n'),
    timestamp: completedAt,
    runId: run.runId,
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutSource: 'deterministicFallback',
      closeoutScope: 'run',
      sourceRunId: run.runId,
      closeoutStatus: run.status || (exitCode === 0 ? 'success' : 'failed'),
      ...(durationMs > 0 ? { closeoutDurationMs: durationMs } : {}),
      ...(run.activeGoalId ? { closeoutGoalId: run.activeGoalId } : {}),
      ...(chat.activeGoal?.status ? { closeoutGoalStatus: chat.activeGoal.status } : {})
    }
  }
}

export function buildTaskWraithRoundCloseoutMessage(input: {
  chat: ChatRecord
  round: EnsembleRoundState
  completedAt: string
  fileSummaries?: DiffFileSummary[]
  now?: Date
}): ChatMessage {
  const { chat, round, completedAt } = input
  const roundRuns = (chat.runs || []).filter((run) => run.ensembleRoundId === round.roundId)
  const durationMs = durationBetween(round.startedAt, completedAt)
  const lines = [
    formatWorkedFor(durationMs),
    '',
    'Close-out:',
    `- Status: ${formatRoundStatus(round.status)}.`
  ]
  const participantLine = participantSummaryLine(round)
  if (participantLine) lines.push(`- Participants: ${participantLine}.`)
  const summaryLine = roundSummaryLine(chat, round.roundId)
  if (summaryLine) lines.push(`- Summary: ${summaryLine}`)
  const fileLine = fileSummaryLine(input.fileSummaries)
  if (fileLine) lines.push(`- Changed: ${fileLine}`)
  const tokenLine = tokenSummaryLine(roundRuns)
  if (tokenLine) lines.push(`- Tokens: ${tokenLine}.`)
  const goalLine = goalSummaryLine(chat.activeGoal, input.now)
  if (goalLine) lines.push(`- Goal: ${goalLine}`)

  return {
    id: taskWraithRoundCloseoutId(round.roundId),
    role: 'system',
    content: lines.join('\n'),
    timestamp: completedAt,
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutSource: 'deterministicFallback',
      closeoutScope: 'ensembleRound',
      closeoutRoundId: round.roundId,
      closeoutStatus: round.status,
      ...(durationMs > 0 ? { closeoutDurationMs: durationMs } : {}),
      ...(chat.activeGoal?.id ? { closeoutGoalId: chat.activeGoal.id } : {}),
      ...(chat.activeGoal?.status ? { closeoutGoalStatus: chat.activeGoal.status } : {})
    }
  }
}

export function upsertTaskWraithCloseoutMessage(
  messages: ChatMessage[],
  closeout: ChatMessage,
  placement: CloseoutPlacement
): ChatMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === closeout.id)
  if (existingIndex >= 0) {
    const next = [...messages]
    next[existingIndex] = { ...next[existingIndex], ...closeout }
    return next
  }

  const insertAfter = findCloseoutInsertIndex(messages, placement)
  if (insertAfter < 0 || insertAfter >= messages.length - 1) {
    return [...messages, closeout]
  }
  return [...messages.slice(0, insertAfter + 1), closeout, ...messages.slice(insertAfter + 1)]
}

function findCloseoutInsertIndex(messages: ChatMessage[], placement: CloseoutPlacement): number {
  if (placement.closeoutRoundId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].metadata?.ensembleRoundId === placement.closeoutRoundId) return index
    }
  }
  if (placement.sourceRunId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].runId === placement.sourceRunId) return index
    }
  }
  if (placement.promptMessageId) {
    return messages.findIndex((message) => message.id === placement.promptMessageId)
  }
  return -1
}

function durationBetween(startedAt?: string, endedAt?: string): number {
  const start = startedAt ? Date.parse(startedAt) : NaN
  const end = endedAt ? Date.parse(endedAt) : NaN
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0
}

function formatWorkedFor(durationMs: number): string {
  return durationMs > 0 ? `Worked for ${formatCompactDuration(durationMs)}` : 'Worked for a moment'
}

function formatCompactDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function formatRunStatus(status: string | undefined, exitCode?: number): string {
  if (status === 'success' || status === 'completed') return 'complete'
  if (status === 'success_with_warnings') return 'complete with warnings'
  if (status === 'cancelled' || exitCode === 130) return 'stopped'
  if (status === 'failed' || (exitCode !== undefined && exitCode !== 0)) return 'failed'
  return status || 'complete'
}

function formatRoundStatus(status: EnsembleRoundState['status']): string {
  if (status === 'completed') return 'complete'
  if (status === 'cancelled') return 'stopped'
  return status
}

function latestAssistantSummary(messages: ChatMessage[], runId: string): string | null {
  const message = [...messages]
    .reverse()
    .find((item) => item.role === 'assistant' && item.runId === runId && item.content.trim())
  return firstUsefulLine(message?.content || '')
}

function firstUsefulLine(content: string): string | null {
  const line = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((item) =>
      item
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*]\s*/, '')
        .trim()
    )
    .find(Boolean)
  if (!line) return null
  return line.length > 180 ? `${line.slice(0, 177)}...` : line
}

function roundSummaryLine(chat: ChatRecord, roundId: string): string | null {
  const summary =
    chat.ensemble?.roundSummaries?.[roundId]?.summary ||
    (chat.ensemble?.activeRound?.roundId === roundId ? chat.ensemble?.lastRoundSummary : '')
  if (!summary) return null
  const explicit = summary.match(/Round summary:\s*([^\n]+)/i)?.[1]
  return firstUsefulLine(explicit || summary)
}

function fileSummaryLine(fileSummaries: DiffFileSummary[] | undefined): string | null {
  const files = (fileSummaries || []).filter((entry) => !(entry as { isNoise?: boolean }).isNoise)
  if (files.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += typeof file.additions === 'number' ? file.additions : 0
    deletions += typeof file.deletions === 'number' ? file.deletions : 0
  }
  const stats = additions > 0 || deletions > 0 ? ` (+${additions} -${deletions})` : ''
  return `${files.length} file${files.length === 1 ? '' : 's'}${stats}.`
}

function tokenSummaryLine(runs: ChatRun[]): string | null {
  const total = runs.reduce(
    (sum, run) => sum + extractUsageCountsFromCandidate(run.stats).totalTokens,
    0
  )
  return total > 0 ? `${formatContextTokens(total)} total` : null
}

function participantSummaryLine(round: EnsembleRoundState): string | null {
  const participants = round.participants || []
  if (participants.length === 0) return null
  const answered = participants.filter((participant) => participant.status === 'answered').length
  const yielded = participants.filter((participant) => participant.status === 'yielded').length
  const skipped = participants.filter((participant) => participant.status === 'skipped').length
  const failed = participants.filter((participant) => participant.status === 'failed').length
  const providers = Array.from(new Set(participants.map((participant) => participant.provider)))
    .map((provider) => getProviderLabel(provider))
    .join(', ')
  const parts = [
    `${answered + yielded} contributed`,
    skipped > 0 ? `${skipped} skipped` : '',
    failed > 0 ? `${failed} failed` : '',
    providers
  ].filter(Boolean)
  return parts.join('; ')
}

function resolveCloseoutGoal(
  activeGoal: ActiveGoal | undefined,
  runGoalId: string | undefined
): ActiveGoal | undefined {
  if (!runGoalId) return activeGoal
  return activeGoal?.id === runGoalId ? activeGoal : undefined
}

function goalSummaryLine(goal: ActiveGoal | undefined, now?: Date): string | null {
  if (!goal?.runtimeLedger) return goal ? `${goal.status}.` : null
  const timing = computeGoalRuntimeTiming(goal.runtimeLedger, now || new Date())
  const details = [
    `wall ${formatCompactDuration(timing.wallMs)}`,
    timing.activeMs > 0 ? `active ${formatCompactDuration(timing.activeMs)}` : '',
    timing.blockedMs > 0 ? `blocked ${formatCompactDuration(timing.blockedMs)}` : '',
    timing.pausedMs > 0 ? `paused ${formatCompactDuration(timing.pausedMs)}` : ''
  ].filter(Boolean)
  return `${goal.status}${details.length > 0 ? ` (${details.join(', ')})` : ''}.`
}
