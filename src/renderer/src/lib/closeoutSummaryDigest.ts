import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  CloseoutSummaryRequest,
  EnsembleRoundState
} from '../../../main/store/types'
import { getLiveToolFileDiffSummaries } from './LiveFileDiffSummary'
import { getProviderLabel } from './providerLabels'
import { humaniseModelIdCompact } from './modelDisplayName'
import { collectCloseoutCommits, validationSummarySentence } from './taskWraithCloseoutMessage'

/** Size caps for the digest handed to the on-device summarizer. The main
 *  process re-clamps everything in `sanitizeCloseoutSummaryRequest`; these
 *  renderer-side caps just keep the IPC payload honest and cheap. */
const DIGEST_PROMPT_MAX_CHARS = 600
const DIGEST_FINAL_TEXT_MAX_CHARS = 1200
const DIGEST_PARTICIPANT_TEXT_MAX_CHARS = 320
const DIGEST_PATH_MAX_CHARS = 160
const DIGEST_WARNING_MAX_CHARS = 240
const DIGEST_COMMIT_SUBJECT_MAX_CHARS = 120
const DIGEST_MAX_FILES = 16
const DIGEST_MAX_COMMITS = 8
const DIGEST_MAX_WARNINGS = 8
const DIGEST_MAX_PARTICIPANTS = 8

export function buildRunCloseoutSummaryDigest(input: {
  chat: ChatRecord
  run: ChatRun
  completedAt: string
}): CloseoutSummaryRequest {
  const { chat, run, completedAt } = input
  const runIds = new Set([run.runId])
  const runMessages = (chat.messages || []).filter((message) => message.runId === run.runId)
  return {
    targetId: run.runId,
    scope: 'run',
    ...(run.status ? { status: run.status } : {}),
    ...durationField(run.startedAt, completedAt),
    ...(run.provider ? { provider: getProviderLabel(run.provider) } : {}),
    ...modelField(run),
    ...promptField(chat, run.promptMessageId),
    ...finalTextField(runMessages, DIGEST_FINAL_TEXT_MAX_CHARS),
    ...fileChangesField(runMessages),
    ...commitsField(chat.messages || [], (message) => message.runId === run.runId),
    ...toolCountsField(runMessages),
    ...validationsField(chat.messages || [], runIds),
    ...warningsField(run.warnings, runMessages)
  }
}

export function buildRoundCloseoutSummaryDigest(input: {
  chat: ChatRecord
  round: EnsembleRoundState
  completedAt: string
}): CloseoutSummaryRequest {
  const { chat, round, completedAt } = input
  const roundRuns = collectRoundRuns(chat, round)
  const roundRunIds = new Set(roundRuns.map((run) => run.runId))
  const includeMessage = (message: ChatMessage): boolean =>
    message.metadata?.ensembleRoundId === round.roundId ||
    (Boolean(message.runId) && roundRunIds.has(message.runId!))
  const roundMessages = (chat.messages || []).filter(includeMessage)
  const promptMessageId = roundRuns
    .map((run) => run.promptMessageId)
    .find((id): id is string => Boolean(id))
  return {
    targetId: round.roundId,
    scope: 'ensembleRound',
    ...(round.status ? { status: round.status } : {}),
    ...durationField(round.startedAt, completedAt),
    ...promptField(chat, promptMessageId),
    ...finalTextField(roundMessages, DIGEST_FINAL_TEXT_MAX_CHARS),
    ...fileChangesField(roundMessages),
    ...commitsField(chat.messages || [], includeMessage),
    ...toolCountsField(roundMessages),
    ...validationsField(chat.messages || [], roundRunIds),
    ...warningsField(
      roundRuns.flatMap((run) => run.warnings || []),
      roundMessages
    ),
    ...participantsField(chat, round, roundRuns)
  }
}

function collectRoundRuns(chat: ChatRecord, round: EnsembleRoundState): ChatRun[] {
  const runIds = new Set<string>()
  for (const run of chat.runs || []) {
    if (run.ensembleRoundId === round.roundId) runIds.add(run.runId)
  }
  for (const participant of round.participants || []) {
    if (participant.runId) runIds.add(participant.runId)
  }
  for (const lane of Object.values(round.lanes || {})) {
    if (lane?.runId) runIds.add(lane.runId)
  }
  return (chat.runs || []).filter((run) => runIds.has(run.runId))
}

function durationField(
  startedAt?: string,
  endedAt?: string
): Pick<CloseoutSummaryRequest, 'durationMs'> {
  const start = startedAt ? Date.parse(startedAt) : NaN
  const end = endedAt ? Date.parse(endedAt) : NaN
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0
  return durationMs > 0 ? { durationMs } : {}
}

function modelField(run: ChatRun): Pick<CloseoutSummaryRequest, 'model'> {
  const modelId = run.actualModel || run.requestedModel
  if (!modelId) return {}
  return { model: humaniseModelIdCompact(run.provider, modelId) || modelId }
}

function promptField(
  chat: ChatRecord,
  promptMessageId: string | undefined
): Pick<CloseoutSummaryRequest, 'promptText'> {
  if (!promptMessageId) return {}
  const prompt = (chat.messages || []).find((message) => message.id === promptMessageId)
  const text = clampDigestText(prompt?.content, DIGEST_PROMPT_MAX_CHARS)
  return text ? { promptText: text } : {}
}

function finalTextField(
  messages: ChatMessage[],
  maxChars: number
): Pick<CloseoutSummaryRequest, 'finalText'> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.content.trim()) continue
    const text = clampDigestText(message.content, maxChars)
    return text ? { finalText: text } : {}
  }
  return {}
}

function fileChangesField(messages: ChatMessage[]): Pick<CloseoutSummaryRequest, 'fileChanges'> {
  const summaries = getLiveToolFileDiffSummaries(messages)
  if (summaries.length === 0) return {}
  return {
    fileChanges: summaries.slice(0, DIGEST_MAX_FILES).map((summary) => ({
      path:
        clampDigestText(summary.path, DIGEST_PATH_MAX_CHARS) ||
        summary.path.slice(0, DIGEST_PATH_MAX_CHARS),
      ...(summary.additions !== undefined ? { additions: summary.additions } : {}),
      ...(summary.deletions !== undefined ? { deletions: summary.deletions } : {})
    }))
  }
}

function commitsField(
  messages: ChatMessage[],
  includeMessage: (message: ChatMessage) => boolean
): Pick<CloseoutSummaryRequest, 'commits'> {
  const commits = collectCloseoutCommits(messages, includeMessage)
  if (commits.length === 0) return {}
  return {
    commits: commits.slice(0, DIGEST_MAX_COMMITS).map((commit) => ({
      hash: commit.hash.slice(0, 12),
      ...(commit.subject
        ? { subject: clampDigestText(commit.subject, DIGEST_COMMIT_SUBJECT_MAX_CHARS) }
        : {})
    }))
  }
}

function toolCountsField(messages: ChatMessage[]): Pick<CloseoutSummaryRequest, 'toolCounts'> {
  const counts: Record<string, number> = {}
  for (const message of messages) {
    for (const activity of message.toolActivities || []) {
      const category = activity.category || 'unknown'
      counts[category] = (counts[category] || 0) + 1
    }
  }
  return Object.keys(counts).length > 0 ? { toolCounts: counts } : {}
}

function validationsField(
  messages: ChatMessage[],
  runIds: ReadonlySet<string>
): Pick<CloseoutSummaryRequest, 'validations'> {
  const sentence = validationSummarySentence(messages, runIds)
  return sentence ? { validations: [sentence] } : {}
}

function warningsField(
  runWarnings: ChatRun['warnings'] | undefined,
  messages: ChatMessage[]
): Pick<CloseoutSummaryRequest, 'warnings'> {
  const warnings: string[] = []
  for (const warning of runWarnings || []) {
    const text = clampDigestText(warning?.message, DIGEST_WARNING_MAX_CHARS)
    if (text) warnings.push(text)
  }
  for (const message of messages) {
    if (message.role !== 'error') continue
    const text = clampDigestText(message.content, DIGEST_WARNING_MAX_CHARS)
    if (text) warnings.push(text)
  }
  return warnings.length > 0 ? { warnings: warnings.slice(0, DIGEST_MAX_WARNINGS) } : {}
}

function participantsField(
  chat: ChatRecord,
  round: EnsembleRoundState,
  roundRuns: ChatRun[]
): Pick<CloseoutSummaryRequest, 'participants'> {
  const participants = [...(round.participants || [])]
    .sort((left, right) => left.order - right.order)
    .slice(0, DIGEST_MAX_PARTICIPANTS)
  if (participants.length === 0) return {}
  const runsByParticipant = new Map<string, ChatRun[]>()
  for (const run of roundRuns) {
    if (!run.ensembleParticipantId) continue
    runsByParticipant.set(run.ensembleParticipantId, [
      ...(runsByParticipant.get(run.ensembleParticipantId) || []),
      run
    ])
  }
  return {
    participants: participants.map((participant) => {
      const participantRuns = runsByParticipant.get(participant.participantId) || []
      const participantRunIds = new Set(participantRuns.map((run) => run.runId))
      const participantMessages = (chat.messages || []).filter(
        (message) =>
          (Boolean(message.runId) && participantRunIds.has(message.runId!)) ||
          message.metadata?.ensembleParticipantId === participant.participantId
      )
      const latestRun = participantRuns[participantRuns.length - 1]
      const modelId = latestRun?.actualModel || participant.model
      return {
        label: participant.role?.trim() || getProviderLabel(participant.provider),
        provider: getProviderLabel(participant.provider),
        ...(modelId
          ? { model: humaniseModelIdCompact(participant.provider, modelId) || modelId }
          : {}),
        ...(participant.status ? { status: participant.status } : {}),
        ...finalTextField(participantMessages, DIGEST_PARTICIPANT_TEXT_MAX_CHARS)
      }
    })
  }
}

function clampDigestText(value: string | undefined | null, maxChars: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const characters = Array.from(text)
  if (characters.length <= maxChars) return text
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}
