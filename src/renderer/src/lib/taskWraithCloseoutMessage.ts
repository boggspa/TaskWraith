import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileStatus,
  DiffFileSummaryOwner,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  EnsembleRoundState,
  EnsembleSeatSnapshot,
  PermissionPresetId,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import { computeGoalRuntimeTiming } from '../../../main/GoalState'
import {
  TASKWRAITH_CLOSEOUT_KIND,
  taskWraithRoundCloseoutId,
  taskWraithRunCloseoutId
} from '../../../shared/taskWraithCloseout'
import type { SeatChangeLink, SeatChangeSeatState } from '../../../shared/seatChange'
import { formatContextTokens } from './contextWindows'
import { reasoningDisplayLabel } from './composerChipFormat'
import { humaniseModelIdCompact } from './modelDisplayName'
import {
  DEFAULT_APPROVAL_LABEL,
  PLAN_LABEL,
  READ_ONLY_RECON_LABEL,
  TRUSTED_SESSION_LABEL,
  WORKSPACE_WRITE_LABEL
} from './planModeLabels'
import { getProviderLabel } from './providerLabels'
import { extractUsageCountsFromCandidate } from './usageStats'
import { getLiveToolFileDiffSummaries } from './LiveFileDiffSummary'
import { isSubThreadDelegationMessage } from '../components/SubThreadDelegationCardModel'
import {
  isSubThreadReturnMessage,
  linkedChildReturnRelation
} from '../components/SubThreadReturnCardModel'

type CloseoutPlacement = {
  sourceRunId?: string
  promptMessageId?: string
  closeoutRoundId?: string
}

/** AI-authored close-out prose (from the bridge daemon's on-device summarizer).
 *  `text` is raw model output — the builders sanitize/escape/cap it the same
 *  way as extracted assistant prose before it reaches the transcript. */
export type CloseoutAiSummary = {
  text: string
  model?: string
}

/** Slim file-change row tombstoned onto close-out metadata (no diffText). */
export type CloseoutFileChange = {
  path: string
  status: DiffFileStatus
  additions?: number
  deletions?: number
  owners?: DiffFileSummaryOwner[]
}

export function buildTaskWraithRunCloseoutMessage(input: {
  chat: ChatRecord
  run: ChatRun
  completedAt: string
  exitCode?: number
  aiSummary?: CloseoutAiSummary
  fileChanges?: CloseoutFileChange[]
  now?: Date
}): ChatMessage {
  const { chat, run, completedAt, exitCode } = input
  const aiSummary = normalizeCloseoutAiSummary(input.aiSummary)
  const aiSummaryProse = aiSummary ? aiCloseoutSummaryProse(aiSummary.text) : null
  const durationMs = durationBetween(run.startedAt, completedAt)
  const runIds = new Set([run.runId])
  const lines = [
    formatWorkedFor(durationMs),
    '',
    'Close-out:',
    '',
    formatRunStatus(run.status, exitCode)
  ]
  appendCloseoutProse(
    lines,
    aiSummaryProse ||
      latestAssistantSummary(chat.messages, run.runId) ||
      missingRunSummary(run.status, exitCode)
  )
  appendCloseoutProse(lines, tokenUsageSentence('run', [run]))
  appendCloseoutProse(lines, validationSummarySentence(chat.messages, runIds))
  appendCloseoutProse(
    lines,
    goalSummarySentence(resolveCloseoutGoal(chat.activeGoal, run.activeGoalId), input.now)
  )
  const closeoutCommits = collectCloseoutCommits(
    chat.messages,
    (message) => message.runId === run.runId,
    { chat }
  )
  const closeoutFileChanges =
    input.fileChanges !== undefined
      ? normalizeCloseoutFileChanges(input.fileChanges)
      : collectCloseoutFileChanges(chat.messages, (message) => message.runId === run.runId)
  const closeoutSubagentDelegations = collectCloseoutSubagentDelegations({
    messages: chat.messages,
    parentRunIds: runIds,
    window: { startedAt: run.startedAt, completedAt }
  })
  // Commits + File Changes + Sub-threads render in the Task-complete epic stack
  // from metadata — keep the close-out bubble to Worked-for + prose.

  return {
    id: taskWraithRunCloseoutId(run.runId),
    role: 'system',
    content: lines.join('\n'),
    timestamp: completedAt,
    runId: run.runId,
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      ...closeoutSummaryProvenance(aiSummaryProse ? aiSummary : null),
      closeoutScope: 'run',
      sourceRunId: run.runId,
      closeoutStatus: run.status || (exitCode === 0 ? 'success' : 'failed'),
      ...(durationMs > 0 ? { closeoutDurationMs: durationMs } : {}),
      ...(run.activeGoalId ? { closeoutGoalId: run.activeGoalId } : {}),
      ...(chat.activeGoal?.status ? { closeoutGoalStatus: chat.activeGoal.status } : {}),
      ...(closeoutCommits.length > 0 ? { closeoutCommits } : {}),
      ...(closeoutFileChanges.length > 0 ? { closeoutFileChanges } : {}),
      ...(closeoutSubagentDelegations.length > 0
        ? { closeoutSubagentDelegations }
        : {})
    }
  }
}

export function buildTaskWraithRoundCloseoutMessage(input: {
  chat: ChatRecord
  round: EnsembleRoundState
  completedAt: string
  aiSummary?: CloseoutAiSummary
  fileChanges?: CloseoutFileChange[]
  now?: Date
}): ChatMessage {
  const { chat, round, completedAt } = input
  const aiSummary = normalizeCloseoutAiSummary(input.aiSummary)
  const aiSummaryProse = aiSummary ? aiCloseoutSummaryProse(aiSummary.text) : null
  const roundRuns = (chat.runs || []).filter((run) => run.ensembleRoundId === round.roundId)
  const roundRunIds = new Set(roundRuns.map((run) => run.runId))
  const closeoutParticipants = resolveCloseoutParticipants(chat, round, roundRuns)
  const durationMs = durationBetween(round.startedAt, completedAt)
  const lines = [formatWorkedFor(durationMs), '', 'Close-out:', '', formatRoundStatus(round.status)]
  appendCloseoutProse(
    lines,
    aiSummaryProse ||
      roundSummaryProse(chat, round, roundRunIds) ||
      missingRoundSummary(round.status, closeoutParticipants)
  )
  appendCloseoutProse(lines, tokenUsageSentence('round', roundRuns))
  appendCloseoutProse(lines, validationSummarySentence(chat.messages, roundRunIds))
  appendCloseoutProse(lines, goalSummarySentence(chat.activeGoal, input.now))
  const participantTable = buildCloseoutParticipantTable(chat, closeoutParticipants, roundRuns)
  const closeoutCommits = collectCloseoutCommits(
    chat.messages,
    (message) => message.metadata?.ensembleRoundId === round.roundId,
    { chat }
  )
  const closeoutFileChanges =
    input.fileChanges !== undefined
      ? normalizeCloseoutFileChanges(input.fileChanges)
      : collectCloseoutFileChanges(
          chat.messages,
          (message) => message.metadata?.ensembleRoundId === round.roundId
        )
  const closeoutSubagentDelegations = collectCloseoutSubagentDelegations({
    messages: chat.messages,
    parentRunIds: roundRunIds,
    window: { startedAt: round.startedAt, completedAt }
  })
  // Participants + Sub-threads + Commits + File Changes render in the
  // Task-complete epic stack. The close-out bubble keeps Worked-for + prose.

  return {
    id: taskWraithRoundCloseoutId(round.roundId),
    role: 'system',
    content: lines.join('\n'),
    timestamp: completedAt,
    metadata: {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      ...closeoutSummaryProvenance(aiSummaryProse ? aiSummary : null),
      closeoutScope: 'ensembleRound',
      closeoutRoundId: round.roundId,
      closeoutStatus: round.status,
      ...(durationMs > 0 ? { closeoutDurationMs: durationMs } : {}),
      ...(chat.activeGoal?.id ? { closeoutGoalId: chat.activeGoal.id } : {}),
      ...(chat.activeGoal?.status ? { closeoutGoalStatus: chat.activeGoal.status } : {}),
      ...(participantTable ? { closeoutParticipantTable: participantTable } : {}),
      ...(closeoutCommits.length > 0 ? { closeoutCommits } : {}),
      ...(closeoutFileChanges.length > 0 ? { closeoutFileChanges } : {}),
      ...(closeoutSubagentDelegations.length > 0
        ? { closeoutSubagentDelegations }
        : {})
    }
  }
}

/** Cap for slim file-change rows tombstoned onto close-out metadata. */
export const CLOSEOUT_FILE_CHANGES_LIMIT = 40

/**
 * Harvest slim file-change rows from tool-activity evidence in scoped messages
 * (same scoping pattern as {@link collectCloseoutCommits}). Omits diffText.
 */
export function collectCloseoutFileChanges(
  messages: ChatMessage[],
  includeMessage: (message: ChatMessage) => boolean
): CloseoutFileChange[] {
  const scoped = messages.filter(includeMessage)
  if (scoped.length === 0) return []
  const summaries = getLiveToolFileDiffSummaries(scoped)
  if (summaries.length === 0) return []
  return normalizeCloseoutFileChanges(
    summaries.slice(0, CLOSEOUT_FILE_CHANGES_LIMIT).map((summary) => ({
      path: summary.path,
      status: summary.status,
      ...(typeof summary.additions === 'number' ? { additions: summary.additions } : {}),
      ...(typeof summary.deletions === 'number' ? { deletions: summary.deletions } : {}),
      ...(summary.owners && summary.owners.length > 0 ? { owners: summary.owners } : {})
    }))
  )
}

function normalizeCloseoutFileChanges(
  fileChanges: CloseoutFileChange[] | undefined
): CloseoutFileChange[] {
  if (!fileChanges || fileChanges.length === 0) return []
  return fileChanges
    .map((file) => {
      const path = typeof file.path === 'string' ? file.path.trim() : ''
      if (!path || !file.status) return null
      const row: CloseoutFileChange = { path, status: file.status }
      if (typeof file.additions === 'number' && Number.isFinite(file.additions)) {
        row.additions = file.additions
      }
      if (typeof file.deletions === 'number' && Number.isFinite(file.deletions)) {
        row.deletions = file.deletions
      }
      if (Array.isArray(file.owners) && file.owners.length > 0) {
        row.owners = file.owners
      }
      return row
    })
    .filter((row): row is CloseoutFileChange => row !== null)
}

/** True when an upsert would not change durable close-out prose or epic tables. */
export function isSameTaskWraithCloseout(existing: ChatMessage, next: ChatMessage): boolean {
  if (existing.content !== next.content || existing.timestamp !== next.timestamp) return false
  const a = existing.metadata
  const b = next.metadata
  return (
    a?.closeoutAiSummary === b?.closeoutAiSummary &&
    JSON.stringify(a?.closeoutParticipantTable ?? null) ===
      JSON.stringify(b?.closeoutParticipantTable ?? null) &&
    sameCloseoutTombstoneList(a?.closeoutCommits, b?.closeoutCommits) &&
    sameCloseoutTombstoneList(a?.closeoutFileChanges, b?.closeoutFileChanges) &&
    sameCloseoutTombstoneList(a?.closeoutSubagentDelegations, b?.closeoutSubagentDelegations)
  )
}

/** Empty rebuilds must not wipe a previously tombstoned list. */
function sameCloseoutTombstoneList(existing: unknown, next: unknown): boolean {
  if (JSON.stringify(existing ?? null) === JSON.stringify(next ?? null)) return true
  const existingList = Array.isArray(existing) ? existing : null
  const nextList = Array.isArray(next) ? next : null
  return Boolean(existingList && existingList.length > 0 && (!nextList || nextList.length === 0))
}

export function upsertTaskWraithCloseoutMessage(
  messages: ChatMessage[],
  closeout: ChatMessage,
  placement: CloseoutPlacement
): ChatMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === closeout.id)
  if (existingIndex >= 0) {
    const previous = messages[existingIndex]
    const nextMeta = { ...(closeout.metadata || {}) }
    // Preserve tombstoned epic tables when a rebuild harvests nothing (tool
    // activities may have been compacted away after the original close-out).
    if (
      (!Array.isArray(nextMeta.closeoutFileChanges) || nextMeta.closeoutFileChanges.length === 0) &&
      Array.isArray(previous.metadata?.closeoutFileChanges) &&
      previous.metadata.closeoutFileChanges.length > 0
    ) {
      nextMeta.closeoutFileChanges = previous.metadata.closeoutFileChanges
    }
    if (
      (!Array.isArray(nextMeta.closeoutCommits) || nextMeta.closeoutCommits.length === 0) &&
      Array.isArray(previous.metadata?.closeoutCommits) &&
      previous.metadata.closeoutCommits.length > 0
    ) {
      nextMeta.closeoutCommits = previous.metadata.closeoutCommits
    }
    if (!nextMeta.closeoutParticipantTable && previous.metadata?.closeoutParticipantTable) {
      nextMeta.closeoutParticipantTable = previous.metadata.closeoutParticipantTable
    }
    if (
      (!Array.isArray(nextMeta.closeoutSubagentDelegations) ||
        nextMeta.closeoutSubagentDelegations.length === 0) &&
      Array.isArray(previous.metadata?.closeoutSubagentDelegations) &&
      previous.metadata.closeoutSubagentDelegations.length > 0
    ) {
      nextMeta.closeoutSubagentDelegations = previous.metadata.closeoutSubagentDelegations
    }
    const next = [...messages]
    next[existingIndex] = { ...previous, ...closeout, metadata: nextMeta }
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

function appendCloseoutProse(lines: string[], sentence: string | null): void {
  if (sentence) lines.push('', sentence)
}

function formatRunStatus(status: string | undefined, exitCode?: number): string {
  if (status === 'success' || status === 'completed') return 'The run was completed.'
  if (status === 'success_with_warnings') return 'The run completed with warnings.'
  if (status === 'cancelled' || exitCode === 130) return 'The run was stopped.'
  if (status === 'failed' || (exitCode !== undefined && exitCode !== 0)) return 'The run failed.'
  return status
    ? `The run ended with status ${escapeMarkdownProse(status)}.`
    : 'The run was completed.'
}

function formatRoundStatus(status: EnsembleRoundState['status']): string {
  if (status === 'completed') return 'The round was completed.'
  if (status === 'cancelled') return 'The round was stopped.'
  if (status === 'failed') return 'The round failed.'
  return 'The round is still running.'
}

function latestAssistantSummary(messages: ChatMessage[], runId: string): string | null {
  const message = [...messages]
    .reverse()
    .find((item) => item.role === 'assistant' && item.runId === runId && item.content.trim())
  return assistantSummaryProse(message?.content || '')
}

function roundSummaryProse(
  chat: ChatRecord,
  round: EnsembleRoundState,
  roundRunIds: ReadonlySet<string>
): string | null {
  const roundId = round.roundId
  const summary =
    chat.ensemble?.roundSummaries?.[roundId]?.summary ||
    (chat.ensemble?.activeRound?.roundId === roundId ? chat.ensemble?.lastRoundSummary : '')
  if (summary?.trim()) return structuredRoundSummaryProse(summary)

  const finalContribution = [...chat.messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.content.trim() &&
        (message.metadata?.ensembleRoundId === roundId ||
          (Boolean(message.runId) && roundRunIds.has(message.runId!)))
    )
  return assistantSummaryProse(finalContribution?.content || '')
}

function tokenUsageSentence(scope: 'run' | 'round', runs: ChatRun[]): string | null {
  const total = runs.reduce(
    (sum, run) => sum + extractUsageCountsFromCandidate(run.stats).totalTokens,
    0
  )
  return total > 0 ? `The ${scope} used about ${formatContextTokens(total)} tokens in total.` : null
}

function missingRunSummary(status: string | undefined, exitCode?: number): string {
  if (status === 'cancelled' || exitCode === 130) {
    return 'The run stopped before it produced a final written summary.'
  }
  if (status === 'failed' || (exitCode !== undefined && exitCode !== 0)) {
    return 'The run failed before it produced a final written summary.'
  }
  return 'The run completed without a final written summary.'
}

function missingRoundSummary(
  status: EnsembleRoundState['status'],
  participants: EnsembleRoundParticipantState[]
): string {
  const contributed = participants.filter(
    (participant) => participant.status === 'answered' || participant.status === 'yielded'
  ).length
  if (status === 'cancelled' && contributed === 0) {
    return 'No participant completed a response before the round was stopped.'
  }
  if (status === 'completed') return 'The round completed without a canonical summary.'
  return 'The round ended without a canonical summary.'
}

const CLOSEOUT_SUMMARY_MAX_CHARS = 2000
const CLOSEOUT_SUMMARY_CONTINUATION = 'The remaining detail is available in the response above.'
const VALIDATION_SECTION_HEADING =
  /^(?:validation|verification|checks?|tests?|type(?:[-\s]?check(?:ing|s)?)|lint(?:ing)?|build|diagnostics?)(?:\s*:.*|\s+(?:passed|succeeded|clean|completed|failed)\b.*|\s*)$/i
const SUMMARY_SECTION_HEADING = /^(?:summary|outcome|result|close-out)\s*:?\s*(.*)$/i
const ROUND_SUMMARY_SECTION_LABELS = [
  ['decisions', 'Decisions'],
  ['corrections', 'Corrections'],
  ['open risks', 'Open risks'],
  ['next action', 'Next action']
] as const

function normalizeCloseoutAiSummary(
  aiSummary: CloseoutAiSummary | undefined
): CloseoutAiSummary | null {
  const text = aiSummary?.text?.trim()
  if (!text) return null
  const model = aiSummary?.model?.trim()
  return {
    text: Array.from(text).slice(0, CLOSEOUT_SUMMARY_MAX_CHARS).join(''),
    ...(model ? { model } : {})
  }
}

/** AI prose goes through the same neutralisation pipeline as extracted
 *  assistant prose: code fences dropped, per-line list/heading/quote markers
 *  stripped, markdown/links/emails flattened, sentence-capped, then
 *  markdown-escaped for the system-authored row. */
function aiCloseoutSummaryProse(text: string): string | null {
  const lines = stripFencedCodeBlocks(text.replace(/\r\n/g, '\n'))
    .split('\n')
    .map((line) => plainInlineText(stripSummaryLineStructure(line)))
    .filter(Boolean)
  if (lines.length === 0) return null
  return finalizeSummaryProse([lines.join(' ')])
}

function closeoutSummaryProvenance(
  aiSummary: CloseoutAiSummary | null
): Pick<
  NonNullable<ChatMessage['metadata']>,
  'closeoutSource' | 'closeoutModel' | 'closeoutAiSummary'
> {
  if (!aiSummary) return { closeoutSource: 'deterministicFallback' }
  return {
    closeoutSource: 'summaryProvider',
    closeoutAiSummary: aiSummary.text,
    ...(aiSummary.model ? { closeoutModel: aiSummary.model } : {})
  }
}

function assistantSummaryProse(content: string): string | null {
  const blocks = stripFencedCodeBlocks(content.replace(/\r\n/g, '\n'))
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  const explicitSummary = explicitAssistantSummaryProse(blocks)
  if (explicitSummary) return explicitSummary

  for (const block of blocks) {
    const rawLines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (rawLines.length === 0) continue
    const firstWasHeading = /^#{1,6}\s+/.test(rawLines[0])
    const lines = rawLines.map(stripSummaryLineStructure).map(plainInlineText).filter(Boolean)
    if (lines.length === 0) continue

    const first = lines[0]
    if (VALIDATION_SECTION_HEADING.test(first)) break
    if (firstWasHeading) lines.shift()
    if (lines.length === 0) continue

    if (lines.every((line) => /^\|?(?:\s*:?-{3,}:?\s*\|)+$/.test(line))) continue

    const prose = lines.join(' ').replace(/\s+/g, ' ').trim()
    if (prose) return finalizeSummaryProse([prose])
  }
  return null
}

function explicitAssistantSummaryProse(blocks: string[]): string | null {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const rawLines = blocks[blockIndex]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
      const heading = plainInlineText(stripSummaryLineStructure(rawLines[lineIndex])).match(
        SUMMARY_SECTION_HEADING
      )
      if (!heading) continue

      const fragments: string[] = []
      const inline = plainInlineText(heading[1] || '')
      if (inline) fragments.push(inline)

      let reachedNextSection = false
      const collectLines = (lines: string[], startIndex: number): void => {
        for (let index = startIndex; index < lines.length; index += 1) {
          const rawLine = lines[index].trim()
          if (!rawLine) continue
          const text = plainInlineText(stripSummaryLineStructure(rawLine))
          if (!text) continue
          if (VALIDATION_SECTION_HEADING.test(text) || /^#{1,6}\s+/.test(rawLine)) {
            reachedNextSection = true
            return
          }
          fragments.push(text)
        }
      }

      collectLines(rawLines, lineIndex + 1)
      for (
        let followingBlock = blockIndex + 1;
        followingBlock < blocks.length && !reachedNextSection;
        followingBlock += 1
      ) {
        collectLines(
          blocks[followingBlock]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          0
        )
      }

      const prose = finalizeSummaryProse(fragments)
      if (prose) return prose
    }
  }
  return null
}

function structuredRoundSummaryProse(content: string): string | null {
  const overview: string[] = []
  const sections = new Map<string, string[]>()
  let currentSection: string | null = null

  for (const rawLine of stripFencedCodeBlocks(content.replace(/\r\n/g, '\n')).split('\n')) {
    const line = plainInlineText(stripSummaryLineStructure(rawLine))
    if (!line) continue
    const labelMatch = line.match(
      /^(round summary|decisions|corrections|open risks|next action)\s*:\s*(.*)$/i
    )
    if (labelMatch) {
      const label = labelMatch[1].toLowerCase()
      const inline = labelMatch[2].trim()
      if (label === 'round summary') {
        currentSection = null
        if (inline) overview.push(inline)
      } else {
        currentSection = label
        if (!sections.has(label)) sections.set(label, [])
        if (inline) sections.get(label)!.push(inline)
      }
      continue
    }

    if (currentSection) sections.get(currentSection)?.push(line)
    else overview.push(line)
  }

  const fragments: string[] = []
  if (overview.length > 0) fragments.push(overview.join(' '))
  for (const [key, label] of ROUND_SUMMARY_SECTION_LABELS) {
    const values = sections.get(key)
    if (!values || values.length === 0) continue
    fragments.push(`${label}: ${joinSummaryItems(values)}`)
  }
  return finalizeSummaryProse(fragments)
}

function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
}

function stripSummaryLineStructure(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:>\s*)+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim()
}

function plainInlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/gi, 'a linked page')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi, 'a linked resource')
    .replace(/\bmailto:[^\s<>()]+/gi, 'an email address')
    .replace(/\bwww\.[^\s<>()]+/gi, 'a linked page')
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, 'an email address')
    .replace(/<[^>]*>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,!?;:]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function joinSummaryItems(items: string[]): string {
  return items
    .map((item) => item.replace(/[.;]+$/g, '').trim())
    .filter(Boolean)
    .join('; ')
}

function finalizeSummaryProse(fragments: string[]): string | null {
  const prose = fragments
    .map((fragment) => ensureSentence(fragment.replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
    .join(' ')
  if (!prose) return null
  return escapeMarkdownProse(limitSummaryProse(prose))
}

function ensureSentence(value: string): string {
  if (!value) return ''
  return /[.!?…]["')\]]?$/.test(value) ? value : `${value}.`
}

function limitSummaryProse(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= CLOSEOUT_SUMMARY_MAX_CHARS) return value
  const candidate = characters.slice(0, CLOSEOUT_SUMMARY_MAX_CHARS).join('')
  const sentenceEnds = Array.from(candidate.matchAll(/[.!?…](?=\s|$)/g))
  const sentenceCut = sentenceEnds.at(-1)?.index
  const wordCut = candidate.lastIndexOf(' ')
  const cut =
    sentenceCut !== undefined && sentenceCut > CLOSEOUT_SUMMARY_MAX_CHARS * 0.6
      ? sentenceCut + 1
      : wordCut > 0
        ? wordCut
        : candidate.length
  return `${candidate.slice(0, cut).trim()} ${CLOSEOUT_SUMMARY_CONTINUATION}`
}

function escapeMarkdownProse(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_<>#|])/g, '\\$1')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

type CloseoutValidationKind = 'tests' | 'typecheck' | 'lint' | 'build' | 'diagnostics'
type CloseoutValidationAttempt = {
  kind: CloseoutValidationKind
  key: string
  passed: boolean
}

type CanonicalValidationTool = {
  name: 'run_task' | 'run_shell_command' | 'get_diagnostics'
  allowStructuredText: boolean
}

const CLOSEOUT_VALIDATION_ORDER: CloseoutValidationKind[] = [
  'tests',
  'typecheck',
  'lint',
  'build',
  'diagnostics'
]

const CLOSEOUT_VALIDATION_LABELS: Record<CloseoutValidationKind, string> = {
  tests: 'the tests',
  typecheck: 'typechecking',
  lint: 'lint checks',
  build: 'the build',
  diagnostics: 'diagnostics'
}

export function validationSummarySentence(
  messages: ChatMessage[],
  runIds: ReadonlySet<string>
): string | null {
  const latestByAttempt = new Map<string, CloseoutValidationAttempt>()
  for (const message of messages) {
    if (!message.runId || !runIds.has(message.runId)) continue
    for (const activity of message.toolActivities || []) {
      for (const attempt of validationAttemptsForActivity(activity)) {
        latestByAttempt.set(`${attempt.kind}:${attempt.key}`, attempt)
      }
    }
  }

  const passedKinds = CLOSEOUT_VALIDATION_ORDER.filter((kind) => {
    const attempts = Array.from(latestByAttempt.values()).filter((attempt) => attempt.kind === kind)
    return attempts.length > 0 && attempts.every((attempt) => attempt.passed)
  })
  if (passedKinds.length === 0) return null
  return `Validation passed for ${formatNaturalList(
    passedKinds.map((kind) => CLOSEOUT_VALIDATION_LABELS[kind])
  )}.`
}

function validationAttemptsForActivity(activity: ToolActivity): CloseoutValidationAttempt[] {
  const tool = canonicalValidationTool(activity.toolName)
  if (!tool) return []
  const records = validationResultRecords(activity.rawResultEvent, tool.allowStructuredText)

  if (tool.name === 'run_task') {
    const task =
      validationParameterText(activity.parameters, ['task', 'script', 'name']) ||
      validationRecordText(records, ['task', 'script', 'name'])
    const taskArgs =
      validationParameterText(activity.parameters, ['args', 'arguments']) ||
      validationRecordText(records, ['args', 'arguments'])
    const resolvedCommand = validationRecordText(records, ['command'])
    if (isInformationalValidationCommand(`${task} ${taskArgs} ${resolvedCommand}`.trim())) {
      return []
    }
    const kinds = validationKindsForTask(task)
    const passed = activity.status === 'success' && runTaskReceiptPassed(records)
    return kinds.map((kind) => ({ kind, key: normalizeValidationKey(task), passed }))
  }

  if (tool.name === 'get_diagnostics') {
    const source = validationParameterText(activity.parameters, ['source', 'kind']) || 'all'
    const path = validationParameterText(activity.parameters, ['path', 'file', 'project']) || '.'
    return [
      {
        kind: 'diagnostics',
        key: `${normalizeValidationKey(source)}:${normalizeValidationKey(path)}`,
        passed: activity.status === 'success' && diagnosticsReceiptPassed(records)
      }
    ]
  }

  const command = validationParameterText(activity.parameters, ['command', 'cmd'])
  const kinds = validationKindsForCommand(command)
  const passed =
    activity.status === 'success' &&
    shellReceiptPassed(records, activity.resultSummary, activity.outputPreview)
  return kinds.map((kind) => ({ kind, key: normalizeValidationKey(command), passed }))
}

function canonicalValidationTool(toolName: string): CanonicalValidationTool | null {
  const normalized = String(toolName || '')
    .trim()
    .toLowerCase()
  const taskWraithPrefixes = [
    'mcp__taskwraith-broker__',
    'mcp__taskwraith__',
    'mcp_taskwraith-broker_',
    'mcp_taskwraith-broker-',
    'mcp_taskwraith_',
    'mcp_taskwraith-',
    'taskwraith-broker__',
    'taskwraith_broker__',
    'taskwraith-broker_',
    'taskwraith_broker_',
    'taskwraith-broker-',
    'taskwraith_broker-',
    'taskwraith__'
  ]
  let ownedName = normalized
  for (const prefix of taskWraithPrefixes) {
    if (!normalized.startsWith(prefix)) continue
    ownedName = normalized.slice(prefix.length)
    break
  }

  if (ownedName === 'run_task' || ownedName === 'runtask') {
    return { name: 'run_task', allowStructuredText: true }
  }
  if (ownedName === 'run_shell_command' || ownedName === 'runshellcommand') {
    return { name: 'run_shell_command', allowStructuredText: true }
  }
  if (ownedName === 'get_diagnostics' || ownedName === 'getdiagnostics') {
    return { name: 'get_diagnostics', allowStructuredText: true }
  }

  if (
    normalized === 'shell' ||
    normalized === 'bash' ||
    normalized === 'run_terminal_command' ||
    normalized === 'runterminalcommand' ||
    normalized === 'terminal'
  ) {
    return { name: 'run_shell_command', allowStructuredText: false }
  }
  return null
}

function validationParameterText(parameters: ToolActivity['parameters'], keys: string[]): string {
  if (!parameters) return ''
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value) && value.length > 0) {
      return value
        .map((item) => String(item))
        .join(' ')
        .trim()
    }
  }
  return ''
}

function validationRecordText(records: Record<string, unknown>[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value) && value.length > 0) {
        return value
          .map((item) => String(item))
          .join(' ')
          .trim()
      }
    }
  }
  return ''
}

function validationResultRecords(
  value: unknown,
  allowStructuredText: boolean
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  collectValidationResultRecords(value, records, allowStructuredText)
  return records
}

function collectValidationResultRecords(
  value: unknown,
  records: Record<string, unknown>[],
  allowStructuredText: boolean,
  depth = 0
): void {
  if (value === null || value === undefined || depth > 7 || records.length > 120) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (!allowStructuredText || text.length === 0 || text.length > 100_000 || !/^[{[]/.test(text)) {
      return
    }
    try {
      collectValidationResultRecords(JSON.parse(text), records, allowStructuredText, depth + 1)
    } catch {
      // Ordinary stdout is not structured proof; fail closed.
    }
    return
  }
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValidationResultRecords(item, records, allowStructuredText, depth + 1)
    }
    return
  }
  const record = value as Record<string, unknown>
  records.push(record)

  for (const key of [
    'result',
    'structuredContent',
    'structured_content',
    'data',
    'details',
    'receipt',
    'summary',
    'content'
  ]) {
    const nested = record[key]
    if (nested === undefined || nested === null) continue
    collectValidationResultRecords(nested, records, allowStructuredText, depth + 1)
  }
  if (typeof record.text === 'string' && record.type === 'text') {
    collectValidationResultRecords(record.text, records, allowStructuredText, depth + 1)
  }
}

function runTaskReceiptPassed(records: Record<string, unknown>[]): boolean {
  const receipts = records.filter((record) => validationExitCode(record) !== null)
  if (receipts.length === 0 || receipts.some((receipt) => validationExitCode(receipt) !== 0)) {
    return false
  }
  if (
    receipts.some((receipt) => validationBoolean(receipt, ['timedOut', 'timed_out']) === true) ||
    !receipts.some((receipt) => validationBoolean(receipt, ['timedOut', 'timed_out']) === false)
  ) {
    return false
  }
  if (validationRecordsHaveError(records)) return false
  return !records.some((record) => {
    const status = String(record.status || '').toLowerCase()
    return status === 'failed' || status === 'error'
  })
}

function shellReceiptPassed(
  records: Record<string, unknown>[],
  resultSummary?: string,
  outputPreview?: string
): boolean {
  if (validationRecordsHaveError(records)) return false
  const receipts = records.filter((record) => validationExitCode(record) !== null)
  if (receipts.length > 0) {
    return receipts.every(
      (receipt) =>
        validationExitCode(receipt) === 0 &&
        validationBoolean(receipt, ['timedOut', 'timed_out']) !== true
    )
  }
  const exitCodes = Array.from(
    `${resultSummary || ''}\n${outputPreview || ''}`.matchAll(/^Exit code:\s*(-?\d+)\s*$/gim),
    (match) => Number(match[1])
  )
  return exitCodes.length > 0 && exitCodes.every((exitCode) => exitCode === 0)
}

function diagnosticsReceiptPassed(records: Record<string, unknown>[]): boolean {
  if (validationRecordsHaveError(records)) return false
  return records.some((record) => {
    const runs = Array.isArray(record.runs) ? record.runs : []
    const ranCleanCheck = runs.some(
      (run) =>
        Boolean(run) &&
        typeof run === 'object' &&
        (run as Record<string, unknown>).skipped !== true &&
        (run as Record<string, unknown>).ok === true
    )
    return (
      record.ok === true &&
      String(record.status || '').toLowerCase() === 'clean' &&
      record.hasProblems === false &&
      ranCleanCheck
    )
  })
}

function validationExitCode(record: Record<string, unknown>): number | null {
  const value = record.exitCode ?? record.exit_code
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validationBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean
  }
  return undefined
}

function validationRecordsHaveError(records: Record<string, unknown>[]): boolean {
  return records.some((record) => {
    if (record.isError === true || record.is_error === true) return true
    if (record.error === false || record.error === null || record.error === undefined) return false
    return typeof record.error !== 'string' || record.error.trim().length > 0
  })
}

function validationKindsForTask(task: string): CloseoutValidationKind[] {
  const normalized = task.trim().toLowerCase()
  if (/^test(?::|$)/.test(normalized)) return ['tests']
  if (/^(?:typecheck|type-check|check:types)(?::|$)/.test(normalized)) return ['typecheck']
  if (/^lint(?::|$)/.test(normalized)) return ['lint']
  if (/^build(?::|$)/.test(normalized)) return ['build']
  return []
}

function validationKindsForCommand(command: string): CloseoutValidationKind[] {
  const unsafeSeparators = command.replace(/&&/g, '')
  if (!command.trim() || /[|;&\n]/.test(unsafeSeparators) || /\bset\s+\+e\b/i.test(command)) {
    return []
  }
  const kinds = new Set<CloseoutValidationKind>()
  const segments = command.split(/&&/)
  for (const rawSegment of segments) {
    const segment = normalizeValidationCommandSegment(rawSegment)
    if (!segment) continue
    if (isInformationalValidationCommand(segment)) continue
    if (
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::|\s|$)/.test(segment) ||
      /^npx(?:\s+--[\w-]+)*\s+(?:vitest|jest)(?:\s|$)/.test(segment) ||
      /^(?:vitest|jest|pytest)(?:\s|$)/.test(segment) ||
      /^python\d*\s+-m\s+pytest(?:\s|$)/.test(segment) ||
      /^(?:swift|cargo|go|dotnet)\s+test(?:\s|$)/.test(segment) ||
      /^xcodebuild\b.*\btest\b/.test(segment)
    ) {
      kinds.add('tests')
      continue
    }
    if (
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check:types)(?::|\s|$)/.test(
        segment
      ) ||
      /^(?:npx(?:\s+--[\w-]+)*\s+)?tsc\b.*\s--noemit(?:\s|$)/.test(segment) ||
      /^(?:pyright|mypy)(?:\s|$)/.test(segment)
    ) {
      kinds.add('typecheck')
      continue
    }
    if (
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?::|\s|$)/.test(segment) ||
      /^(?:npx\s+)?eslint(?:\s|$)/.test(segment) ||
      /^(?:biome|ruff)\s+check(?:\s|$)/.test(segment) ||
      /^swiftlint(?:\s|$)/.test(segment)
    ) {
      kinds.add('lint')
      continue
    }
    if (
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::|\s|$)/.test(segment) ||
      /^(?:swift|cargo|go|dotnet)\s+build(?:\s|$)/.test(segment) ||
      /^xcodebuild\b.*\bbuild\b/.test(segment) ||
      /^(?:electron-vite|vite)\s+build(?:\s|$)/.test(segment)
    ) {
      kinds.add('build')
    }
  }
  return Array.from(kinds)
}

function isInformationalValidationCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  if (
    /(?:^|\s)(?:--help|-h|--version|--list|--list-tests|--listtests|--collect-only|--print-config|--show-config|--showconfig)(?:=\S+|\s|$)/.test(
      normalized
    )
  ) {
    return true
  }
  return /^(?:(?:npx(?:\s+--[\w-]+)*\s+)?(?:vitest|jest)|pytest)\s+list(?:\s|$)/.test(normalized)
}

function normalizeValidationCommandSegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/^(?:env\s+)?(?:[a-z_][a-z0-9_]*=[^\s]+\s+)*/i, '')
    .replace(/^(?:time|sudo)\s+/, '')
    .trim()
}

function normalizeValidationKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase() || 'unknown'
}

function formatNaturalList(items: string[]): string {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

const ENSEMBLE_PARTICIPANT_STATUS_SET = new Set<EnsembleParticipantStatus>([
  'idle',
  'running',
  'answered',
  'yielded',
  'failed',
  'skipped',
  'cancelled',
  'sleeping',
  'unreachable'
])

function resolveCloseoutParticipants(
  chat: ChatRecord,
  round: EnsembleRoundState,
  roundRuns: ChatRun[]
): EnsembleRoundParticipantState[] {
  const roundParticipantIds = new Set(
    (round.participants || []).map((participant) => participant.participantId)
  )
  const byId = new Map(
    (round.participants || []).map((participant) => [participant.participantId, participant])
  )
  for (const run of roundRuns) {
    const participantId = run.ensembleParticipantId
    if (!participantId) continue
    const existing = byId.get(participantId)
    if (existing) {
      if (!roundParticipantIds.has(participantId)) {
        byId.set(participantId, {
          ...existing,
          status: participantStatusFromRun(chat, run),
          runId: run.runId
        })
      }
      continue
    }
    const snapshot = run.ensembleSeatSnapshot
    byId.set(participantId, {
      participantId,
      provider: snapshot?.provider || run.provider || 'gemini',
      role: run.ensembleRole || '',
      order: run.ensembleOrder ?? Number.MAX_SAFE_INTEGER,
      status: participantStatusFromRun(chat, run),
      ...(snapshot?.model ? { model: snapshot.model } : {}),
      ...(snapshot?.reasoningEffort !== undefined
        ? { reasoningEffort: snapshot.reasoningEffort }
        : {}),
      ...(snapshot?.fastModeEnabled !== undefined
        ? { fastModeEnabled: snapshot.fastModeEnabled }
        : {}),
      ...(snapshot?.thinkingEnabled !== undefined
        ? { thinkingEnabled: snapshot.thinkingEnabled }
        : {}),
      ...(snapshot?.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
      ...(snapshot
        ? {
            permissionPresetId: snapshot.configuredPermissionPresetId,
            initialSeatSnapshot: snapshot
          }
        : {}),
      runId: run.runId
    })
  }
  return Array.from(byId.values()).sort((left, right) => left.order - right.order)
}

function participantStatusFromRun(chat: ChatRecord, run: ChatRun): EnsembleParticipantStatus {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index]
    if (message.runId !== run.runId) continue
    const status = message.metadata?.ensembleStatus
    if (
      typeof status === 'string' &&
      ENSEMBLE_PARTICIPANT_STATUS_SET.has(status as EnsembleParticipantStatus)
    ) {
      return status as EnsembleParticipantStatus
    }
  }
  if (run.status === 'failed') return 'failed'
  if (run.status === 'cancelled') return 'cancelled'
  if (run.status === 'running') return 'running'
  return 'answered'
}

export function buildCloseoutParticipantTable(
  chat: ChatRecord,
  participants: EnsembleRoundParticipantState[],
  roundRuns: ChatRun[]
): CloseoutParticipantTable | null {
  if (participants.length === 0) return null
  const turnCounts = new Map<string, number>()
  const tokenCounts = new Map<string, number>()
  const estimatedTokenParticipants = new Set<string>()
  const runsByParticipant = new Map<string, ChatRun[]>()
  for (const run of roundRuns) {
    if (!run.ensembleParticipantId) continue
    turnCounts.set(run.ensembleParticipantId, (turnCounts.get(run.ensembleParticipantId) || 0) + 1)
    tokenCounts.set(
      run.ensembleParticipantId,
      (tokenCounts.get(run.ensembleParticipantId) || 0) +
        extractUsageCountsFromCandidate(run.stats).totalTokens
    )
    if (run.stats?._taskwraith_token_count_confidence === 'estimated') {
      estimatedTokenParticipants.add(run.ensembleParticipantId)
    }
    runsByParticipant.set(run.ensembleParticipantId, [
      ...(runsByParticipant.get(run.ensembleParticipantId) || []),
      run
    ])
  }
  const totalTurns = Array.from(turnCounts.values()).reduce((sum, count) => sum + count, 0)
  const totalTokens = Array.from(tokenCounts.values()).reduce((sum, count) => sum + count, 0)
  const rows = participants.map((participant) => {
    const label = participant.role?.trim() || getProviderLabel(participant.provider)
    const turns = turnCounts.get(participant.participantId) || 0
    const tokens = tokenCounts.get(participant.participantId) || 0
    const participantRuns = [...(runsByParticipant.get(participant.participantId) || [])].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
    )
    const fallbackSnapshot = participantFallbackSeatSnapshot(participant)
    const turnConfigurations = participantRuns.map((run) =>
      participantTurnConfiguration(chat, participant, run)
    )
    const providerSeq = seatFieldSequence<ProviderId>(
      turnConfigurations.map((configuration) => ({
        raw: configuration.provider,
        display: getProviderLabel(configuration.provider)
      })),
      {
        raw: fallbackSnapshot.provider,
        display: getProviderLabel(fallbackSnapshot.provider)
      }
    )
    const modelSeq = seatFieldSequence<string>(
      turnConfigurations.map((configuration) => ({
        raw: configuration.modelId,
        display: configuration.modelId
          ? formatParticipantModel(configuration.provider, configuration.modelId)
          : null
      })),
      {
        raw: fallbackSnapshot.model || '',
        display: formatParticipantModel(fallbackSnapshot.provider, fallbackSnapshot.model)
      }
    )
    const reasoningSeq = seatFieldSequence<SeatReasoningRaw>(
      turnConfigurations.map((configuration) => ({
        raw: {
          reasoningEffort: configuration.reasoningEffort,
          thinkingEnabled: configuration.thinkingEnabled
        },
        display: configuration.reasoningCaptured ? formatParticipantReasoning(configuration) : null
      })),
      {
        raw: {
          reasoningEffort: fallbackSnapshot.reasoningEffort,
          thinkingEnabled: fallbackSnapshot.thinkingEnabled
        },
        display: formatParticipantReasoning({
          provider: fallbackSnapshot.provider,
          modelId: fallbackSnapshot.model || '',
          reasoningEffort: fallbackSnapshot.reasoningEffort,
          thinkingEnabled: fallbackSnapshot.thinkingEnabled
        })
      }
    )
    const permissionSeq = seatFieldSequence<PermissionPresetId>(
      turnConfigurations.map((configuration) => ({
        raw: configuration.permissionPresetId || fallbackSnapshot.configuredPermissionPresetId,
        display: configuration.permissionPresetId
          ? formatPermissionPreset(configuration.permissionPresetId)
          : null
      })),
      {
        raw: fallbackSnapshot.configuredPermissionPresetId,
        display: formatPermissionPreset(fallbackSnapshot.configuredPermissionPresetId)
      }
    )
    // Link TEXT keeps every field the five culled columns used to carry, so
    // surfaces that don't intercept the scheme lose nothing but the motion.
    const seatText = [
      `@${label}`,
      providerSeq.text,
      modelSeq.text,
      reasoningSeq.text,
      permissionSeq.text
    ]
      .filter((part) => part && part !== '—')
      .join(' · ')
    const seatLink = participantSeatChangeLink(participant, label, {
      provider: providerSeq,
      model: modelSeq,
      reasoning: reasoningSeq,
      permission: permissionSeq
    })
    return {
      participantId: participant.participantId,
      seatLink,
      seatText,
      workLabel: formatParticipantWorkCell(
        turns,
        tokens,
        estimatedTokenParticipants.has(participant.participantId)
      ),
      status: participant.status,
      statusGlyphMarkdown: statusGlyph(participant.status)
    }
  })
  return {
    rows,
    totalWorkLabel: formatParticipantWorkCell(
      totalTurns,
      totalTokens,
      estimatedTokenParticipants.size > 0
    )
  }
}

/**
 * The seat as it entered and left the round — the ends of each field's
 * sequence, so the element's before/after always match the link text beside
 * it. Captured into the close-out CONTENT so it is tombstoned: later rounds
 * renaming the role or swapping the model can never rewrite what this round
 * actually ran.
 */
function participantSeatChangeLink(
  participant: EnsembleRoundParticipantState,
  label: string,
  fields: {
    provider: SeatFieldSequence<ProviderId>
    model: SeatFieldSequence<string>
    reasoning: SeatFieldSequence<SeatReasoningRaw>
    permission: SeatFieldSequence<PermissionPresetId>
  }
): SeatChangeLink {
  const side = (which: 'first' | 'last'): SeatChangeSeatState => ({
    provider: fields.provider[which],
    model: fields.model[which],
    role: label,
    ...(participant.order ? { seatNumber: participant.order } : {}),
    ...(fields.reasoning[which].reasoningEffort
      ? { reasoningEffort: fields.reasoning[which].reasoningEffort }
      : {}),
    ...(fields.reasoning[which].thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: fields.reasoning[which].thinkingEnabled }),
    permissionPresetId: fields.permission[which]
  })
  return { participantId: participant.participantId, before: side('first'), after: side('last') }
}

type ParticipantTurnConfiguration = {
  provider: ProviderId
  modelId: string
  reasoningEffort?: string
  thinkingEnabled?: boolean
  reasoningCaptured: boolean
  permissionPresetId?: PermissionPresetId
}

function participantFallbackSeatSnapshot(
  participant: EnsembleRoundParticipantState
): EnsembleSeatSnapshot {
  if (participant.initialSeatSnapshot) return participant.initialSeatSnapshot
  return {
    schemaVersion: 1,
    provider: participant.provider,
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.reasoningEffort !== undefined
      ? { reasoningEffort: participant.reasoningEffort }
      : {}),
    ...(participant.fastModeEnabled !== undefined
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(participant.thinkingEnabled !== undefined
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(participant.serviceTier ? { serviceTier: participant.serviceTier } : {}),
    configuredPermissionPresetId: participant.permissionPresetId || 'default'
  }
}

function participantTurnConfiguration(
  chat: ChatRecord,
  participant: EnsembleRoundParticipantState,
  run: ChatRun
): ParticipantTurnConfiguration {
  const snapshot = run.ensembleSeatSnapshot
  const metadata = latestEnsembleMetadataForRun(chat, run.runId)
  const metadataReasoning =
    typeof metadata?.ensembleReasoningEffort === 'string'
      ? metadata.ensembleReasoningEffort
      : undefined
  const metadataThinking =
    typeof metadata?.ensembleThinkingEnabled === 'boolean'
      ? metadata.ensembleThinkingEnabled
      : undefined
  const metadataModel =
    typeof metadata?.ensembleModel === 'string' ? metadata.ensembleModel : undefined
  const provider =
    run.providerReroute?.to || snapshot?.provider || run.provider || participant.provider
  return {
    provider,
    modelId: run.actualModel || snapshot?.model || run.requestedModel || metadataModel || '',
    reasoningEffort: snapshot?.reasoningEffort ?? metadataReasoning,
    thinkingEnabled: snapshot?.thinkingEnabled ?? metadataThinking,
    reasoningCaptured:
      Boolean(snapshot) ||
      metadataReasoning !== undefined ||
      metadataThinking !== undefined ||
      typeof metadata?.ensembleProvider === 'string',
    permissionPresetId: run.permissionPosture?.presetId || snapshot?.configuredPermissionPresetId
  }
}

function latestEnsembleMetadataForRun(
  chat: ChatRecord,
  runId: string
): ChatMessage['metadata'] | undefined {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index]
    if (message.runId === runId && message.metadata) return message.metadata
  }
  return undefined
}

function formatParticipantModel(provider: ProviderId, modelId?: string): string {
  if (!modelId) return '—'
  return humaniseModelIdCompact(provider, modelId) || modelId
}

/**
 * One field's journey across a round's turns, rendered two ways at once.
 *
 * The close-out seat cell is a LINK: the rendered element reads the raw ids
 * out of the href, and the link text is the plain-text fallback for surfaces
 * that don't intercept the scheme. They are two renderings of the same row,
 * so they must never disagree — which means one compaction has to produce
 * both. Turns that didn't capture the field are dropped and adjacent repeats
 * collapse (so a seat that never moved shows a single value and rolls
 * nothing); `first`/`last` are the raw ids for the element's before/after,
 * and `text` is the display sequence.
 *
 * Deriving the element's sides per-TURN instead invents changes the text
 * never shows: a turn that captured no permission preset would fall back to
 * the round-entry snapshot and read as a tier change.
 */
interface SeatFieldTurn<T> {
  raw: T
  display?: string | null
}

interface SeatFieldSequence<T> {
  text: string
  first: T
  last: T
}

function seatFieldSequence<T>(
  turns: Array<SeatFieldTurn<T>>,
  fallback: { raw: T; display: string }
): SeatFieldSequence<T> {
  const compact: Array<{ raw: T; display: string }> = []
  for (const turn of turns) {
    const display = turn.display?.trim()
    if (!display) continue
    if (compact[compact.length - 1]?.display === display) continue
    compact.push({ raw: turn.raw, display })
  }
  if (compact.length === 0) {
    return { text: fallback.display, first: fallback.raw, last: fallback.raw }
  }
  return {
    text: compact.map((entry) => entry.display).join(' → '),
    first: compact[0].raw,
    last: compact[compact.length - 1].raw
  }
}

/** Reasoning has two raw inputs (effort token and Kimi's thinking flag) that
 * together produce one display label, so they travel as one raw payload. */
interface SeatReasoningRaw {
  reasoningEffort?: string
  thinkingEnabled?: boolean
}

function formatParticipantReasoning(input: {
  provider: ProviderId
  modelId: string
  reasoningEffort?: string
  thinkingEnabled?: boolean
}): string {
  const label = reasoningDisplayLabel({
    provider: input.provider,
    composerStyle: 'default',
    modelId: input.modelId,
    modelLabel: '',
    codexReasoningEffort: input.provider === 'codex' ? input.reasoningEffort : undefined,
    claudeReasoningEffort: input.provider === 'claude' ? input.reasoningEffort : undefined,
    kimiReasoningEffort: input.provider === 'kimi' ? input.reasoningEffort : undefined,
    grokReasoningEffort: input.provider === 'grok' ? input.reasoningEffort : undefined,
    cursorReasoningEffort: input.provider === 'cursor' ? input.reasoningEffort : undefined,
    kimiThinkingEnabled: input.provider === 'kimi' ? input.thinkingEnabled : undefined
  })
  if (label) return label

  if (input.provider === 'kimi') {
    return 'On'
  }
  if (input.provider === 'codex' || input.provider === 'claude') {
    return input.reasoningEffort?.toLowerCase() === 'off' ? 'Off' : 'Default'
  }
  if ((input.provider === 'grok' || input.provider === 'cursor') && input.reasoningEffort) {
    if (input.reasoningEffort.toLowerCase() === 'off') return 'Off'
    return input.reasoningEffort
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase())
  }
  return '—'
}

function formatPermissionPreset(presetId: PermissionPresetId): string {
  if (presetId === 'read_only') return READ_ONLY_RECON_LABEL
  if (presetId === 'plan') return PLAN_LABEL
  if (presetId === 'workspace_write') return WORKSPACE_WRITE_LABEL
  if (presetId === 'full_access') return TRUSTED_SESSION_LABEL
  if (presetId === 'custom') return 'Custom'
  return DEFAULT_APPROVAL_LABEL
}

/**
 * The seat's status, riding the END of the work cell rather than owning a
 * column — a column of glyphs never earned its width. The renderer swaps this
 * link for the roster chip's own `ParticipantStatusIcon` plus its `status-*`
 * colour class, so the table and the participants-above row stay one
 * vocabulary; the link text is the status word, which is the accessible name
 * and what plain-text surfaces read.
 */
function statusGlyph(status: EnsembleParticipantStatus): string {
  return `[${status.charAt(0).toUpperCase()}${status.slice(1)}](ensemble-status://${status})`
}

/** Turns and tokens share one column: "939k Tks / 4 Turns". */
function formatParticipantWorkCell(turns: number, tokens: number, estimated: boolean): string {
  const parts: string[] = []
  if (tokens > 0) parts.push(`${formatParticipantTokenCell(tokens, estimated)} Tks`)
  if (turns > 0) parts.push(`${turns} ${turns === 1 ? 'Turn' : 'Turns'}`)
  return parts.length > 0 ? parts.join(' / ') : '—'
}

function formatParticipantTokenCell(totalTokens: number, estimated = false): string {
  if (totalTokens <= 0) return '—'
  return `${estimated ? '~' : ''}${formatContextTokens(totalTokens)}`
}

/** Visible sub-thread rows in the Task-complete epic stack (metadata may keep more). */
export const CLOSEOUT_SUBAGENT_TABLE_LIMIT = 8

export type CloseoutSubagentDelegationStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'returned'
  | 'unknown'

/** Slim sub-thread / Agent Invocation row for the Task-complete epic stack. */
export type CloseoutSubagentDelegation = {
  subThreadId: string
  /** Seed for `assignAgentIdentityFromSeed` — same as subThreadId. */
  identitySeed: string
  title: string
  provider: ProviderId
  parentProvider?: ProviderId
  status: CloseoutSubagentDelegationStatus
  promptPreview?: string
}

/**
 * Harvest durable parent-transcript sub-thread delegation/return cards into
 * Task-complete rows. Cards usually lack `message.runId`; scope via join
 * groupId / parallelResultWaveId / waveId ∈ parentRunIds (or wave ids affiliated
 * through the run/round time window), else the time window for unstamped cards.
 * Side-chat returns are excluded. Dedupes by subThreadId (return outcome wins).
 */
export function collectCloseoutSubagentDelegations(input: {
  messages: ChatMessage[]
  parentRunIds: ReadonlySet<string>
  window?: { startedAt: string; completedAt: string }
  childChats?: ChatRecord[]
}): CloseoutSubagentDelegation[] {
  const rows = new Map<string, CloseoutSubagentDelegation>()
  const childById = new Map(
    (input.childChats || [])
      .filter((child) => typeof child.appChatId === 'string' && child.appChatId)
      .map((child) => [child.appChatId, child] as const)
  )
  const affiliatedGroupIds = expandCloseoutSubagentGroupIds(
    input.messages,
    input.parentRunIds,
    input.window
  )

  for (const message of input.messages) {
    const isDelegation = isSubThreadDelegationMessage(message)
    const isReturn = isSubThreadReturnMessage(message)
    if (!isDelegation && !isReturn) continue
    if (isReturn && linkedChildReturnRelation(message) === 'sideChat') continue
    if (!messageInSubagentCloseoutScope(message, affiliatedGroupIds, input.window)) continue

    const metadata = message.metadata || {}
    const subThreadId =
      typeof metadata.subThreadId === 'string' ? metadata.subThreadId.trim() : ''
    if (!subThreadId) continue

    const provider =
      typeof metadata.subThreadProvider === 'string'
        ? (metadata.subThreadProvider as ProviderId)
        : undefined
    if (!provider) continue

    const title =
      (typeof metadata.subThreadTitle === 'string' && metadata.subThreadTitle.trim()) ||
      'Untitled sub-thread'
    const parentProvider =
      typeof metadata.parentProvider === 'string'
        ? (metadata.parentProvider as ProviderId)
        : undefined
    const promptPreview =
      (typeof metadata.delegationPromptPreview === 'string' &&
        metadata.delegationPromptPreview.trim()) ||
      (typeof metadata.delegationPrompt === 'string' && metadata.delegationPrompt.trim()) ||
      undefined

    const existing = rows.get(subThreadId)
    const status = resolveCloseoutSubagentStatus({
      isReturn,
      outcome: metadata.subThreadOutcome,
      child: childById.get(subThreadId),
      fallback: existing?.status || 'created'
    })

    rows.set(subThreadId, {
      subThreadId,
      identitySeed: subThreadId,
      title:
        (existing?.title && existing.title !== 'Untitled sub-thread' ? existing.title : title) ||
        title,
      provider: existing?.provider || provider,
      ...(existing?.parentProvider || parentProvider
        ? { parentProvider: existing?.parentProvider || parentProvider }
        : {}),
      status: isReturn
        ? status
        : existing && existing.status !== 'created' && existing.status !== 'unknown'
          ? existing.status
          : status,
      ...(existing?.promptPreview || promptPreview
        ? { promptPreview: existing?.promptPreview || promptPreview }
        : {})
    })
  }

  return Array.from(rows.values())
}

/** Affinity set: parent run ids plus `wave-*` groups observed inside the window. */
function expandCloseoutSubagentGroupIds(
  messages: ChatMessage[],
  parentRunIds: ReadonlySet<string>,
  window?: { startedAt: string; completedAt: string }
): Set<string> {
  const affiliated = new Set(parentRunIds)
  for (const message of messages) {
    if (!isSubThreadDelegationMessage(message) && !isSubThreadReturnMessage(message)) continue
    if (isSubThreadReturnMessage(message) && linkedChildReturnRelation(message) === 'sideChat') {
      continue
    }
    const groupIds = closeoutSubagentGroupIds(message)
    if (groupIds.length === 0) continue
    const runBound =
      Boolean(message.runId && parentRunIds.has(message.runId)) ||
      groupIds.some((id) => parentRunIds.has(id))
    const inWindow = messageInCloseoutTimeWindow(message, window)
    if (runBound) {
      for (const id of groupIds) affiliated.add(id)
      continue
    }
    // delegate_wave stamps groupId=waveId (never the parent run id). Affiliate
    // in-window wave-* groups so those workers still land on this closeout.
    if (inWindow) {
      for (const id of groupIds) {
        if (id.startsWith('wave-')) affiliated.add(id)
      }
    }
  }
  return affiliated
}

function closeoutSubagentGroupIds(message: ChatMessage): string[] {
  const metadata = message.metadata || {}
  const ids: string[] = []
  const joinGroupId =
    metadata.joinPolicy &&
    typeof metadata.joinPolicy === 'object' &&
    typeof (metadata.joinPolicy as { groupId?: unknown }).groupId === 'string'
      ? (metadata.joinPolicy as { groupId: string }).groupId.trim()
      : ''
  if (joinGroupId) ids.push(joinGroupId)
  if (typeof metadata.waveId === 'string' && metadata.waveId.trim()) {
    ids.push(metadata.waveId.trim())
  }
  if (typeof metadata.parallelResultWaveId === 'string' && metadata.parallelResultWaveId.trim()) {
    ids.push(metadata.parallelResultWaveId.trim())
  }
  return ids
}

function messageInCloseoutTimeWindow(
  message: ChatMessage,
  window?: { startedAt: string; completedAt: string }
): boolean {
  if (!window) return false
  const ts = Date.parse(message.timestamp)
  const start = Date.parse(window.startedAt)
  const end = Date.parse(window.completedAt)
  if (!Number.isFinite(ts) || !Number.isFinite(start) || !Number.isFinite(end)) return false
  return ts >= start && ts <= end
}

function messageInSubagentCloseoutScope(
  message: ChatMessage,
  affiliatedGroupIds: ReadonlySet<string>,
  window?: { startedAt: string; completedAt: string }
): boolean {
  if (message.runId && affiliatedGroupIds.has(message.runId)) return true
  const groupIds = closeoutSubagentGroupIds(message)
  if (groupIds.length > 0) {
    return groupIds.some((id) => affiliatedGroupIds.has(id))
  }
  // Cards without join/wave stamps fall back to the run/round time window.
  return messageInCloseoutTimeWindow(message, window)
}

function resolveCloseoutSubagentStatus(input: {
  isReturn: boolean
  outcome: unknown
  child?: ChatRecord
  fallback: CloseoutSubagentDelegationStatus
}): CloseoutSubagentDelegationStatus {
  if (input.child) {
    const fromChild = statusFromChildChat(input.child)
    if (fromChild) return fromChild
  }
  if (input.isReturn) {
    const outcome =
      typeof input.outcome === 'string' ? input.outcome.trim().toLowerCase() : ''
    if (outcome === 'failed' || outcome === 'error') return 'failed'
    if (outcome === 'cancelled' || outcome === 'canceled') return 'cancelled'
    if (outcome === 'success' || outcome === 'completed' || outcome === 'done') return 'returned'
    return 'returned'
  }
  return input.fallback
}

function statusFromChildChat(child: ChatRecord): CloseoutSubagentDelegationStatus | null {
  if (child.delegationContext?.dispatchError) return 'failed'
  if (child.delegationContext?.resultReturnedAt) return 'returned'
  const lastRun = child.runs?.[child.runs.length - 1]
  if (!lastRun) return 'created'
  if (
    lastRun.status === 'running' ||
    lastRun.status === 'queued' ||
    lastRun.status === 'starting' ||
    lastRun.status === 'active' ||
    lastRun.status === 'paused'
  ) {
    return 'running'
  }
  if (lastRun.status === 'failed' || lastRun.status === 'error') return 'failed'
  if (lastRun.status === 'cancelled' || lastRun.status === 'canceled') return 'cancelled'
  if (lastRun.status === 'success' || lastRun.status === 'completed') return 'completed'
  return null
}

/** Visible commit rows in the Task-complete epic stack (metadata keeps the rest). */
export const CLOSEOUT_COMMIT_TABLE_LIMIT = 8

export type CloseoutCommit = {
  hash: string
  subject?: string
  stats?: string
  /** Seat that authored the commit — same element as the Participants column. */
  seatLink?: SeatChangeLink
  participantId?: string
}

export type CloseoutParticipantRow = {
  participantId: string
  seatLink: SeatChangeLink
  /** Plain-text seat fallback used by markdown / non-intercepting surfaces. */
  seatText: string
  workLabel: string
  status: EnsembleParticipantStatus
  statusGlyphMarkdown: string
}

export type CloseoutParticipantTable = {
  rows: CloseoutParticipantRow[]
  totalWorkLabel: string
}

export function collectCloseoutCommits(
  messages: ChatMessage[],
  includeMessage: (message: ChatMessage) => boolean,
  options?: { chat?: ChatRecord }
): CloseoutCommit[] {
  const commits = new Map<string, CloseoutCommit>()
  for (const message of messages) {
    if (!includeMessage(message)) continue
    const seatLink = options?.chat ? seatLinkForCommitMessage(options.chat, message) : null
    const participantId =
      typeof message.metadata?.ensembleParticipantId === 'string'
        ? message.metadata.ensembleParticipantId
        : undefined
    for (const activity of message.toolActivities || []) {
      if (!isGitCommitActivity(activity)) continue
      for (const commit of extractCommitsFromActivity(activity)) {
        const attributed: CloseoutCommit = {
          ...commit,
          ...(seatLink ? { seatLink } : {}),
          ...(participantId ? { participantId } : {})
        }
        const existing = commits.get(commit.hash)
        if (!existing || scoreCloseoutCommit(attributed) > scoreCloseoutCommit(existing)) {
          commits.set(commit.hash, attributed)
        }
      }
    }
  }
  return Array.from(commits.values())
}

function scoreCloseoutCommit(commit: CloseoutCommit): number {
  return (
    (commit.subject ? 2 : 0) +
    (commit.stats ? 1 : 0) +
    (commit.seatLink ? 2 : 0) +
    (commit.participantId ? 1 : 0)
  )
}

function seatLinkForCommitMessage(chat: ChatRecord, message: ChatMessage): SeatChangeLink | null {
  const participantId =
    typeof message.metadata?.ensembleParticipantId === 'string'
      ? message.metadata.ensembleParticipantId
      : null
  if (!participantId) return null
  const rosterSeat = (chat.ensemble?.participants || []).find(
    (participant) => participant.id === participantId
  )
  const provider =
    (typeof message.metadata?.ensembleProvider === 'string'
      ? (message.metadata.ensembleProvider as ProviderId)
      : undefined) || rosterSeat?.provider
  if (!provider) return null
  const model =
    (typeof message.metadata?.ensembleModel === 'string' ? message.metadata.ensembleModel : '') ||
    rosterSeat?.model ||
    ''
  const role =
    (typeof message.metadata?.ensembleRole === 'string' ? message.metadata.ensembleRole : '') ||
    rosterSeat?.role ||
    getProviderLabel(provider)
  const permissionPresetId =
    rosterSeat?.permissionPresetId ||
    (typeof message.metadata?.ensemblePermissionPresetId === 'string'
      ? (message.metadata.ensemblePermissionPresetId as PermissionPresetId)
      : undefined)
  const reasoningEffort =
    typeof message.metadata?.ensembleReasoningEffort === 'string'
      ? message.metadata.ensembleReasoningEffort
      : rosterSeat?.reasoningEffort
  const thinkingEnabled =
    typeof message.metadata?.ensembleThinkingEnabled === 'boolean'
      ? message.metadata.ensembleThinkingEnabled
      : rosterSeat?.thinkingEnabled
  const state: SeatChangeSeatState = {
    provider,
    model,
    role,
    ...(typeof rosterSeat?.order === 'number' ? { seatNumber: rosterSeat.order } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(thinkingEnabled === undefined ? {} : { thinkingEnabled }),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
  return { participantId, before: state, after: state }
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
  const claimedSpans: Array<[number, number]> = []
  const bracketPattern = /\[([^\]\n]*)\s([0-9a-f]{7,40})\]\s*([^\n]+)(?:\n([^\n[]+))?/gi
  let match: RegExpExecArray | null
  while ((match = bracketPattern.exec(normalized)) !== null) {
    claimedSpans.push([match.index, match.index + match[0].length])
    const hash = match[2]
    const subject = cleanCommitSubject(match[3] || '')
    const nextLine = match[4]?.trim()
    const stats =
      nextLine && /files?\s+changed/i.test(nextLine) ? formatCommitStats(nextLine) : undefined
    mergeCloseoutCommit(commits, {
      hash,
      ...(subject ? { subject } : {}),
      ...(stats ? { stats } : {})
    })
  }
  const commitLinePattern = /^commit\s+([0-9a-f]{7,40})\b.*$/gim
  while ((match = commitLinePattern.exec(normalized)) !== null) {
    claimedSpans.push([match.index, match.index + match[0].length])
    mergeCloseoutCommit(commits, { hash: match[1] })
  }
  // Bare hash on its own line only (rev-parse / log --format=%H style output).
  // Scanning for hex substrings ANYWHERE minted phantom "commits" out of blob
  // SHAs in diff hunk headers ("index 89e6c98..fa3d112") and hashes referenced
  // inside commit subjects ("Revert 9f8e7d6: ..."), which then fed fabricated
  // entries to the commit table and the close-out summarizer.
  const bareHashLinePattern = /^\s*([0-9a-f]{7,40})\s*$/gim
  while ((match = bareHashLinePattern.exec(normalized)) !== null) {
    const start = match.index
    if (claimedSpans.some(([from, to]) => start >= from && start < to)) continue
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

function goalSummarySentence(goal: ActiveGoal | undefined, now?: Date): string | null {
  if (!goal) return null
  const statusPhrase =
    goal.status === 'completed'
      ? 'was completed'
      : goal.status === 'blocked'
        ? 'was blocked'
        : goal.status === 'paused'
          ? 'was paused'
          : 'remained active'
  if (!goal.runtimeLedger) return `The linked goal ${statusPhrase}.`
  const timing = computeGoalRuntimeTiming(goal.runtimeLedger, now || new Date())
  const details = [
    `wall ${formatCompactDuration(timing.wallMs)}`,
    timing.activeMs > 0 ? `active ${formatCompactDuration(timing.activeMs)}` : '',
    timing.blockedMs > 0 ? `blocked ${formatCompactDuration(timing.blockedMs)}` : '',
    timing.pausedMs > 0 ? `paused ${formatCompactDuration(timing.pausedMs)}` : ''
  ].filter(Boolean)
  return `The linked goal ${statusPhrase}${details.length > 0 ? ` (${details.join(', ')})` : ''}.`
}
