import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleRoundState,
  ToolActivity
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
  const tokenLine = tokenSummaryLine([run])
  if (tokenLine) lines.push(`- Tokens: ${tokenLine}.`)
  const goalLine = goalSummaryLine(
    resolveCloseoutGoal(chat.activeGoal, run.activeGoalId),
    input.now
  )
  if (goalLine) lines.push(`- Goal: ${goalLine}`)
  lines.push(
    ...formatCommitTableSection(
      collectCloseoutCommits(chat.messages, (message) => message.runId === run.runId)
    )
  )

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
  const goalLine = goalSummaryLine(chat.activeGoal, input.now)
  if (goalLine) lines.push(`- Goal: ${goalLine}`)
  lines.push(
    ...formatParticipantTableSection(round, roundRuns),
    ...formatCommitTableSection(
      collectCloseoutCommits(
        chat.messages,
        (message) => message.metadata?.ensembleRoundId === round.roundId
      )
    )
  )

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
  return durationMs > 0
    ? `**Worked for ${formatCompactDuration(durationMs)}**`
    : '**Worked for a moment**'
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
  const contributed = participants.filter(
    (participant) => participant.status === 'answered' || participant.status === 'yielded'
  ).length
  const otherStatusCounts = new Map<string, number>()
  for (const participant of participants) {
    if (participant.status === 'answered' || participant.status === 'yielded') continue
    otherStatusCounts.set(participant.status, (otherStatusCounts.get(participant.status) || 0) + 1)
  }
  const parts = [
    `${contributed} contributed`,
    ...Array.from(otherStatusCounts.entries()).map(([status, count]) => `${count} ${status}`)
  ]
  return parts.join('; ')
}

function formatParticipantTableSection(round: EnsembleRoundState, roundRuns: ChatRun[]): string[] {
  const participants = round.participants || []
  if (participants.length === 0) return []
  const turnCounts = new Map<string, number>()
  const tokenCounts = new Map<string, number>()
  for (const run of roundRuns) {
    if (!run.ensembleParticipantId) continue
    turnCounts.set(run.ensembleParticipantId, (turnCounts.get(run.ensembleParticipantId) || 0) + 1)
    tokenCounts.set(
      run.ensembleParticipantId,
      (tokenCounts.get(run.ensembleParticipantId) || 0) +
        extractUsageCountsFromCandidate(run.stats).totalTokens
    )
  }
  const totalTurns = Array.from(turnCounts.values()).reduce((sum, count) => sum + count, 0)
  const totalTokens = Array.from(tokenCounts.values()).reduce((sum, count) => sum + count, 0)
  const rows = participants.map((participant) => {
    const label = escapeMarkdownTableCell(
      participant.role?.trim() || getProviderLabel(participant.provider)
    )
    const turns = turnCounts.get(participant.participantId) || 0
    const tokens = tokenCounts.get(participant.participantId) || 0
    const tokenCell = formatParticipantTokenCell(tokens)
    return `| [@${label}](ensemble-dm://${participant.participantId}) | ${turns} | ${tokenCell} | ${participant.status} |`
  })
  const totalTokenCell = formatParticipantTokenCell(totalTokens)
  const totalStatusCell = formatStatusCountSummary(participants)
  rows.push(
    `| **Round Total** | ${totalTurns} | ${totalTokenCell} | ${totalStatusCell} |`
  )
  return [
    '',
    '**Participants**',
    '',
    '| Participant | Turns | Tokens | Status |',
    '| --- | --- | --- | --- |',
    ...rows
  ]
}

function formatParticipantTokenCell(totalTokens: number): string {
  return totalTokens > 0 ? formatContextTokens(totalTokens) : '—'
}

function formatStatusCountSummary(participants: EnsembleRoundState['participants']): string {
  const counts = new Map<string, number>()
  for (const participant of participants) {
    counts.set(participant.status, (counts.get(participant.status) || 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')
}

const CLOSEOUT_COMMIT_TABLE_LIMIT = 8

type CloseoutCommit = {
  hash: string
  subject?: string
  stats?: string
}

function collectCloseoutCommits(
  messages: ChatMessage[],
  includeMessage: (message: ChatMessage) => boolean
): CloseoutCommit[] {
  const commits = new Map<string, CloseoutCommit>()
  for (const message of messages) {
    if (!includeMessage(message)) continue
    for (const activity of message.toolActivities || []) {
      if (!isGitCommitActivity(activity)) continue
      for (const commit of extractCommitsFromActivity(activity)) {
        const existing = commits.get(commit.hash)
        if (!existing || scoreCloseoutCommit(commit) > scoreCloseoutCommit(existing)) {
          commits.set(commit.hash, commit)
        }
      }
    }
  }
  return Array.from(commits.values())
}

function scoreCloseoutCommit(commit: CloseoutCommit): number {
  return (commit.subject ? 2 : 0) + (commit.stats ? 1 : 0)
}

function formatCommitTableSection(commits: CloseoutCommit[]): string[] {
  if (commits.length === 0) return []
  const visible = commits.slice(0, CLOSEOUT_COMMIT_TABLE_LIMIT)
  const lines = [
    '',
    '**Commits**',
    '',
    '| Hash | Message | Changes |',
    '| --- | --- | --- |',
    ...visible.map((commit) => {
      const hash = commit.hash.slice(0, 9)
      const subject = escapeMarkdownTableCell(commit.subject || '—')
      const stats = escapeMarkdownTableCell(commit.stats || '—')
      return `| \`${hash}\` | ${subject} | ${stats} |`
    })
  ]
  const overflow = commits.length - visible.length
  if (overflow > 0) {
    lines.push('', `_${overflow} more commit${overflow === 1 ? '' : 's'} not shown._`)
  }
  return lines
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function normalizeCommitText(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t').trim()
}

function cleanCommitSubject(subject: string): string {
  return subject
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/["',;]+$/g, '')
    .trim()
}

function formatCommitStats(raw: string): string {
  const files = raw.match(/^(\d+\s+files?\s+changed)/i)?.[1]
  const insertions = raw.match(/(\d+)\s+insertions?\(\+\)/i)?.[1]
  const deletions = raw.match(/(\d+)\s+deletions?\(-\)/i)?.[1]
  const filePart = files?.replace(/\s+changed$/i, '') || '1 file'
  if (insertions || deletions) {
    const statParts: string[] = []
    if (insertions) statParts.push(`+${insertions}`)
    if (deletions) statParts.push(`−${deletions}`)
    return `${filePart}, ${statParts.join(' ')}`
  }
  return filePart
}

function isGitCommitActivity(activity: ToolActivity): boolean {
  const text = `${activity.toolName || ''} ${activity.displayName || ''}`.toLowerCase()
  return text.includes('git_commit') || text.includes('git commit')
}

function extractCommitsFromActivity(activity: ToolActivity): CloseoutCommit[] {
  const fragments: string[] = []
  collectCommitTextFragments(activity.resultSummary, fragments)
  collectCommitTextFragments(activity.outputPreview, fragments)
  collectCommitTextFragments(activity.rawResultEvent, fragments)
  return extractCommitsFromText(fragments.join('\n'))
}

function collectCommitTextFragments(value: unknown, fragments: string[], depth = 0): void {
  if (value === null || value === undefined || depth > 4 || fragments.length > 80) return
  if (typeof value === 'string') {
    if (value.trim()) fragments.push(value)
    return
  }
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectCommitTextFragments(item, fragments, depth + 1)
    return
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectCommitTextFragments(entry, fragments, depth + 1)
  }
}

function extractCommitsFromText(text: string): CloseoutCommit[] {
  const normalized = normalizeCommitText(text)
  const commits = new Map<string, CloseoutCommit>()
  const bracketPattern =
    /\[([^\]\n]*)\s([0-9a-f]{7,40})\]\s*([^\n]+)(?:\n([^\n[]+))?/gi
  let match: RegExpExecArray | null
  while ((match = bracketPattern.exec(normalized)) !== null) {
    const hash = match[2]
    const subject = cleanCommitSubject(match[3] || '')
    const nextLine = match[4]?.trim()
    const stats =
      nextLine && /files?\s+changed/i.test(nextLine) ? formatCommitStats(nextLine) : undefined
    mergeCloseoutCommit(commits, { hash, ...(subject ? { subject } : {}), ...(stats ? { stats } : {}) })
  }
  const commitLinePattern = /^commit\s+([0-9a-f]{7,40})\b.*$/gim
  while ((match = commitLinePattern.exec(normalized)) !== null) {
    mergeCloseoutCommit(commits, { hash: match[1] })
  }
  const genericHashPattern = /\b([0-9a-f]{7,40})\b/gi
  while ((match = genericHashPattern.exec(normalized)) !== null) {
    mergeCloseoutCommit(commits, { hash: match[1] })
  }
  return Array.from(commits.values())
}

function mergeCloseoutCommit(commits: Map<string, CloseoutCommit>, commit: CloseoutCommit): void {
  const existing = commits.get(commit.hash)
  if (!existing || scoreCloseoutCommit(commit) >= scoreCloseoutCommit(existing)) {
    commits.set(commit.hash, {
      hash: commit.hash,
      subject: commit.subject || existing?.subject,
      stats: commit.stats || existing?.stats
    })
  }
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
