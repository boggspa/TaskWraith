import { createHash } from 'node:crypto'
import { isExternalProviderThreadImportMessage } from '../shared/externalProviderThreadImport'
import {
  isKnownPromptFallbackThreadTitle,
  isPlaceholderThreadTitle,
  normalizeLocalAiThreadTitle,
  threadTitleSourceFingerprint
} from '../shared/threadTitles'
import { EXTERNAL_CONTRIBUTION_TAG } from './collaboration/ExternalContributionContext'
import {
  isExternalUntrustedMessage,
  isHumanCollaboratorComment
} from './collaboration/HumanCollaboratorMessages'
import { isRetiredExternalChannelInboundMessage } from './LegacyExternalChannelHistory'
import { resolveEnsembleDmTargetForDispatch } from './services/EnsembleMentionAlias'
import type {
  ChatMessage,
  ChatRecord,
  ContinuationDraftIntentKind,
  ContinuationDraftProposal,
  ContinuationProposalPurpose,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  ContinuationTitleApplyRequest,
  EnsembleParticipant,
  EnsembleStageRole
} from './store/types'

export const CONTINUATION_GENERATOR_VERSION = 'composer-draft-v2' as const

const MAX_CONTEXT_VERSION = 220
const MAX_EVIDENCE_ITEMS = 24
const MAX_EVIDENCE_TEXT = 900
const MAX_EVIDENCE_TOTAL = 6_000
const MAX_PROPOSALS = 3
const MAX_DRAFT_CHARS = 360
const MIN_DRAFT_CHARS = 12
const QUALITY_THRESHOLD = 0.72

const INTENTS = new Set<ContinuationDraftIntentKind>([
  'clarify',
  'continue-step',
  'verify',
  'review'
])

export type ContinuationEvidenceAuthority = 'user' | 'host-fact' | 'untrusted-agent'

export type ContinuationEvidenceKind =
  | 'user-request'
  | 'goal'
  | 'goal-criterion'
  | 'current-todo'
  | 'assistant-outcome'
  | 'ensemble-summary'
  | 'round-status'
  | 'run-status'
  | 'run-warning'
  | 'failed-seat'
  | 'validation-failed'
  | 'validation-passed'
  | 'file-change'

export interface ContinuationEvidenceItem {
  id: string
  kind: ContinuationEvidenceKind
  authority: ContinuationEvidenceAuthority
  text: string
}

export interface ContinuationEvidenceParticipant {
  participantId: string
  label: string
  provider: string
  model?: string
  stageRole?: EnsembleStageRole
}

export interface ContinuationEvidencePayload {
  schemaVersion: 2
  generatorVersion: typeof CONTINUATION_GENERATOR_VERSION
  chatId: string
  purpose: ContinuationProposalPurpose
  phase: 'working' | 'blocked' | 'paused' | 'complete' | 'unknown'
  subject: {
    firstUserMessageId: string
    latestUserMessageId: string
    runId?: string
    roundId?: string
    goalId?: string
  }
  evidence: ContinuationEvidenceItem[]
  roster: ContinuationEvidenceParticipant[]
  title: {
    eligible: boolean
    expectedCurrent: string
    sourceMessageId: string
    sourceFingerprint: string
  }
}

export interface ContinuationEvidenceSnapshot extends ContinuationEvidencePayload {
  fingerprint: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function compactOpaque(value: unknown, label: string, maxLength = MAX_CONTEXT_VERSION): string {
  const text = compactText(value, maxLength)
  if (!text) throw new Error(`${label} is required.`)
  if (!/^[A-Za-z0-9._,:-]+$/.test(text)) throw new Error(`${label} is invalid.`)
  return text
}

export function sanitizeContinuationProposalRequest(input: unknown): ContinuationProposalRequest {
  const record = asRecord(input) || {}
  if (record.schemaVersion !== 2) throw new Error('Continuation proposal schema is invalid.')
  const purpose = record.purpose
  if (purpose !== 'draft' && purpose !== 'title') {
    throw new Error('Continuation proposal purpose is invalid.')
  }
  return {
    schemaVersion: 2,
    chatId: compactOpaque(record.chatId, 'Continuation proposal chat id', 180),
    contextVersion: compactOpaque(record.contextVersion, 'Continuation proposal context version'),
    purpose
  }
}

export function sanitizeContinuationTitleApplyRequest(
  input: unknown
): ContinuationTitleApplyRequest {
  const record = asRecord(input) || {}
  if (record.schemaVersion !== 1) throw new Error('Continuation title apply schema is invalid.')
  const title = normalizeLocalAiThreadTitle(record.title)
  if (!title) throw new Error('Continuation title is invalid.')
  const sourceFingerprint = compactText(record.sourceFingerprint, 80)
  const evidenceFingerprint = compactText(record.evidenceFingerprint, 80)
  if (!/^title-source-v1:[a-f0-9]{8}$/.test(sourceFingerprint)) {
    throw new Error('Continuation title source fingerprint is invalid.')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(evidenceFingerprint)) {
    throw new Error('Continuation title evidence fingerprint is invalid.')
  }
  return {
    schemaVersion: 1,
    chatId: compactOpaque(record.chatId, 'Continuation title chat id', 180),
    title,
    sourceMessageId: compactOpaque(record.sourceMessageId, 'Continuation title source id', 180),
    sourceFingerprint,
    evidenceFingerprint,
    expectedTitle: compactText(record.expectedTitle, 160)
  }
}

function isRealUserMessage(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    Boolean(message.content?.trim()) &&
    !isRetiredExternalChannelInboundMessage(message) &&
    !isHumanCollaboratorComment(message) &&
    !isExternalUntrustedMessage(message) &&
    !isExternalProviderThreadImportMessage(message) &&
    !message.content.includes(`<${EXTERNAL_CONTRIBUTION_TAG}`)
  )
}

function isAssistantEvidence(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    Boolean(message.content?.trim()) &&
    !isExternalUntrustedMessage(message) &&
    !isExternalProviderThreadImportMessage(message)
  )
}

function normalizedIdentityText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function latestSettledRun(chat: ChatRecord, latestUserMessageId: string) {
  const latestAttempt = (chat.runs || [])
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.promptMessageId === latestUserMessageId)
    .sort((left, right) => {
      const leftAt = Date.parse(left.run.startedAt) || 0
      const rightAt = Date.parse(right.run.startedAt) || 0
      return leftAt - rightAt || left.index - right.index
    })
    .at(-1)?.run
  if (
    !latestAttempt?.endedAt ||
    latestAttempt.status === 'running' ||
    latestAttempt.status === 'sleeping'
  ) {
    return undefined
  }
  return latestAttempt
}

function chatPhase(chat: ChatRecord): ContinuationEvidencePayload['phase'] {
  if (chat.activeGoal?.status === 'completed') return 'complete'
  if (chat.activeGoal?.status === 'blocked') return 'blocked'
  if (chat.activeGoal?.status === 'paused') return 'paused'
  if (chat.activeGoal?.status === 'active') return 'working'
  return 'unknown'
}

function titleIsEligible(chat: ChatRecord, firstUser: ChatMessage): boolean {
  const source = chat.threadTitle?.source
  if (source === 'user' || source === 'local-ai') return false
  if (source === 'placeholder' || source === 'prompt-fallback') return true
  return (
    isPlaceholderThreadTitle(chat.title) ||
    isKnownPromptFallbackThreadTitle(chat.title, firstUser.content)
  )
}

function runChangedFiles(chat: ChatRecord, runId: string | undefined) {
  const run = runId ? (chat.runs || []).find((candidate) => candidate.runId === runId) : undefined
  if (!run?.runDiff) return []
  return [...run.runDiff.createdFiles, ...run.runDiff.modifiedFiles, ...run.runDiff.deletedFiles]
}

function latestCloseoutMessage(
  chat: ChatRecord,
  runId: string | undefined
): ChatMessage | undefined {
  if (!runId) return undefined
  return [...(chat.messages || [])]
    .reverse()
    .find(
      (message) =>
        Boolean(message.metadata?.closeoutReceipt || message.metadata?.closeoutStatus) &&
        message.metadata?.sourceRunId === runId
    )
}

export function buildContinuationEvidenceSnapshot(
  chat: ChatRecord,
  purpose: ContinuationProposalPurpose
): ContinuationEvidenceSnapshot | null {
  const indexedMessages = (chat.messages || [])
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isRealUserMessage(message))
  const firstUser = indexedMessages[0]
  const latestUser = indexedMessages.at(-1)
  if (!firstUser || !latestUser) return null

  if (purpose === 'title') {
    const payload: ContinuationEvidencePayload = {
      schemaVersion: 2,
      generatorVersion: CONTINUATION_GENERATOR_VERSION,
      chatId: chat.appChatId,
      purpose,
      phase: 'unknown',
      subject: {
        firstUserMessageId: firstUser.message.id,
        latestUserMessageId: firstUser.message.id
      },
      evidence: [
        {
          id: 'e0',
          kind: 'user-request',
          authority: 'user',
          text: compactText(firstUser.message.content, 1_200)
        }
      ],
      roster: [],
      title: {
        eligible: titleIsEligible(chat, firstUser.message),
        expectedCurrent: chat.title,
        sourceMessageId: firstUser.message.id,
        sourceFingerprint: threadTitleSourceFingerprint(
          firstUser.message.id,
          firstUser.message.content
        )
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return { ...payload, fingerprint: `sha256:${fingerprint}` }
  }

  const latestRun = latestSettledRun(chat, latestUser.message.id)
  const evidence: ContinuationEvidenceItem[] = []
  let evidenceChars = 0
  const addEvidence = (
    kind: ContinuationEvidenceKind,
    authority: ContinuationEvidenceAuthority,
    value: unknown,
    maxLength = MAX_EVIDENCE_TEXT
  ): void => {
    if (evidence.length >= MAX_EVIDENCE_ITEMS || evidenceChars >= MAX_EVIDENCE_TOTAL) return
    const remaining = Math.min(maxLength, MAX_EVIDENCE_TOTAL - evidenceChars)
    const text = compactText(value, remaining)
    if (!text) return
    evidence.push({ id: `e${evidence.length}`, kind, authority, text })
    evidenceChars += text.length
  }

  addEvidence('user-request', 'user', latestUser.message.content, 1_000)
  const goal = chat.activeGoal?.objectiveSource === 'user' ? chat.activeGoal : undefined
  if (goal) {
    addEvidence('goal', 'user', goal.objective, 600)
    for (const criterion of goal.specification?.acceptanceCriteria?.slice(0, 4) || []) {
      addEvidence('goal-criterion', 'user', criterion, 200)
    }
  }

  if (goal) {
    const currentTodos = Object.entries(chat.chatTodos || {})
      .flatMap(([laneId, items]) => (items || []).map((item) => ({ ...item, laneId })))
      .filter(
        (item) =>
          item.goalId === goal.id && (item.status === 'pending' || item.status === 'in_progress')
      )
      .sort((left, right) =>
        `${left.laneId}:${left.id}`.localeCompare(`${right.laneId}:${right.id}`)
      )
      .slice(0, 4)
    for (const todo of currentTodos) {
      addEvidence('current-todo', 'untrusted-agent', `${todo.status}: ${todo.content}`, 240)
    }
  }

  if (latestRun) {
    addEvidence('run-status', 'host-fact', `Run status: ${latestRun.status || 'unknown'}`, 120)
    for (const warning of latestRun.warnings?.slice(-4) || []) {
      addEvidence('run-warning', 'host-fact', warning.message, 320)
    }
  }

  const activeRound = chat.ensemble?.activeRound
  const roundStartedAt = activeRound ? Date.parse(activeRound.startedAt) : Number.NaN
  const latestUserAt = Date.parse(latestUser.message.timestamp)
  const round =
    activeRound &&
    activeRound.status !== 'running' &&
    (!Number.isFinite(roundStartedAt) ||
      !Number.isFinite(latestUserAt) ||
      roundStartedAt >= latestUserAt) &&
    normalizedIdentityText(activeRound.prompt) ===
      normalizedIdentityText(latestUser.message.content)
      ? activeRound
      : undefined
  if (round) {
    addEvidence('round-status', 'host-fact', `Round status: ${round.status}`, 120)
    for (const participant of round.participants || []) {
      if (participant.status !== 'failed' && participant.status !== 'unreachable') continue
      addEvidence(
        'failed-seat',
        'host-fact',
        `${participant.role?.trim() || participant.provider}: ${participant.status}`,
        180
      )
    }
  }

  const closeout = latestCloseoutMessage(chat, latestRun?.runId)
  for (const failed of closeout?.metadata?.closeoutReceipt?.validations?.failed || []) {
    addEvidence('validation-failed', 'host-fact', `Validation failed: ${failed}`, 180)
  }
  for (const passed of closeout?.metadata?.closeoutReceipt?.validations?.passed || []) {
    addEvidence('validation-passed', 'host-fact', `Validation passed: ${passed}`, 180)
  }
  if (latestRun) {
    for (const file of runChangedFiles(chat, latestRun.runId).slice(0, 8)) {
      addEvidence('file-change', 'host-fact', `${file.status}: ${file.path}`, 260)
    }
  }

  const assistantMessages = (chat.messages || [])
    .slice(latestUser.index + 1)
    .filter(isAssistantEvidence)
    .slice(-2)
  for (const message of assistantMessages) {
    addEvidence('assistant-outcome', 'untrusted-agent', message.content, 650)
  }
  if (round && chat.ensemble?.lastRoundSummary?.trim()) {
    addEvidence('ensemble-summary', 'untrusted-agent', chat.ensemble.lastRoundSummary, 650)
  }

  const roster = (chat.ensemble?.participants || [])
    .filter((participant) => participant.enabled !== false)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(
      (participant): ContinuationEvidenceParticipant => ({
        participantId: participant.id,
        label: compactText(participant.role, 80) || participant.provider,
        provider: participant.provider,
        ...(participant.model ? { model: compactText(participant.model, 120) } : {}),
        ...(participant.stageRole ? { stageRole: participant.stageRole } : {})
      })
    )

  const payload: ContinuationEvidencePayload = {
    schemaVersion: 2,
    generatorVersion: CONTINUATION_GENERATOR_VERSION,
    chatId: chat.appChatId,
    purpose,
    phase: chatPhase(chat),
    subject: {
      firstUserMessageId: firstUser.message.id,
      latestUserMessageId: latestUser.message.id,
      ...(latestRun ? { runId: latestRun.runId } : {}),
      ...(round?.roundId ? { roundId: round.roundId } : {}),
      ...(goal ? { goalId: goal.id } : {})
    },
    evidence,
    roster,
    title: {
      eligible: titleIsEligible(chat, firstUser.message),
      expectedCurrent: chat.title,
      sourceMessageId: firstUser.message.id,
      sourceFingerprint: threadTitleSourceFingerprint(
        firstUser.message.id,
        firstUser.message.content
      )
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return { ...payload, fingerprint: `sha256:${fingerprint}` }
}

const ACTIONABLE_KINDS = new Set<ContinuationEvidenceKind>([
  'goal-criterion',
  'current-todo',
  'assistant-outcome',
  'ensemble-summary',
  'run-warning',
  'failed-seat',
  'validation-failed',
  'file-change'
])
const UNRESOLVED_KINDS = new Set<ContinuationEvidenceKind>([
  'current-todo',
  'run-warning',
  'failed-seat',
  'validation-failed'
])

export function continuationEvidenceCanDraft(snapshot: ContinuationEvidenceSnapshot): boolean {
  if (snapshot.phase === 'complete' || snapshot.phase === 'paused') return false
  const hasSettledExecution = snapshot.evidence.some(
    (item) =>
      item.kind === 'run-status' ||
      item.kind === 'round-status' ||
      item.kind === 'failed-seat' ||
      item.kind === 'ensemble-summary'
  )
  if (!hasSettledExecution) return false
  const successfulRun = snapshot.evidence.some(
    (item) =>
      (item.kind === 'run-status' &&
        /run status:\s*(?:success(?:_with_warnings)?|completed)\b/i.test(item.text)) ||
      (item.kind === 'round-status' && /round status:\s*completed\b/i.test(item.text))
  )
  const unresolvedHostState = snapshot.evidence.some((item) => UNRESOLVED_KINDS.has(item.kind))
  if (successfulRun && !unresolvedHostState) return false
  return (
    snapshot.evidence.some((item) => item.authority === 'user') &&
    snapshot.evidence.some((item) => ACTIONABLE_KINDS.has(item.kind))
  )
}

function normalizedWords(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'could',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'please',
  'the',
  'this',
  'to',
  'we',
  'with',
  'you'
])

function tokenSet(value: string): Set<string> {
  return new Set(normalizedWords(value).filter((word) => !STOP_WORDS.has(word)))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function normalizeDraftText(value: unknown): string | null {
  const lines = String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  const compactLines: string[] = []
  for (const line of lines) {
    if (!line && compactLines.at(-1) === '') continue
    compactLines.push(line)
  }
  if (compactLines.length === 0 || compactLines.length > 3) return null
  const text = compactLines.join('\n')
  if (Array.from(text).length > MAX_DRAFT_CHARS) return null
  return Array.from(text).length >= MIN_DRAFT_CHARS ? text : null
}

function forbiddenDraft(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return (
    /^(?:continue(?:\s+with)?|retry|rerun|commit)\b/i.test(normalized) ||
    /\b(?:commit|push|publish|delete|install)\b/i.test(normalized) ||
    /\b(?:retry|rerun)\s+(?:the|that|last)\s+turn\b/i.test(normalized) ||
    /\bswitch\s+(?:to\s+)?(?:a\s+)?(?:model|provider)\b/i.test(normalized) ||
    /^(?:yes|yep|yeah|sure|okay|ok|go ahead|proceed)\b/i.test(normalized) ||
    /^please\s+(?:go ahead|proceed)\b/i.test(normalized) ||
    /@|:\/\//.test(normalized)
  )
}

function intentSupported(
  intent: ContinuationDraftIntentKind,
  cited: ContinuationEvidenceItem[]
): boolean {
  const kinds = new Set(cited.map((item) => item.kind))
  const has = (...wanted: ContinuationEvidenceKind[]) => wanted.some((kind) => kinds.has(kind))
  if (intent === 'continue-step') {
    return has('goal-criterion', 'current-todo', 'assistant-outcome', 'ensemble-summary')
  }
  if (intent === 'verify') {
    return has('validation-failed', 'run-warning', 'assistant-outcome', 'failed-seat')
  }
  if (intent === 'review') return has('file-change', 'assistant-outcome', 'ensemble-summary')
  return has('assistant-outcome', 'ensemble-summary', 'run-warning', 'failed-seat')
}

function untrustedEcho(text: string, snapshot: ContinuationEvidenceSnapshot): boolean {
  const candidate = normalizedWords(text).join(' ')
  if (candidate.length < 12) return false
  return snapshot.evidence.some(
    (item) =>
      item.authority === 'untrusted-agent' &&
      normalizedWords(item.text).join(' ').includes(candidate)
  )
}

function candidateScore(text: string, cited: ContinuationEvidenceItem[]): number {
  const hasUser = cited.some((item) => item.authority === 'user')
  const hasActionable = cited.some((item) => ACTIONABLE_KINDS.has(item.kind))
  const citedTokens = tokenSet(cited.map((item) => item.text).join(' '))
  const draftTokens = tokenSet(text)
  let overlap = 0
  for (const token of draftTokens) if (citedTokens.has(token)) overlap += 1
  const grounding = draftTokens.size > 0 ? overlap / draftTokens.size : 0
  const specificity = draftTokens.size >= 5 ? 0.1 : draftTokens.size >= 3 ? 0.05 : 0
  const concise = Array.from(text).length <= 240 ? 0.05 : 0.025
  return Math.min(
    1,
    (hasUser ? 0.3 : 0) +
      (hasActionable ? 0.3 : 0) +
      Math.min(0.25, grounding * 0.5) +
      specificity +
      concise
  )
}

function normalizeCandidate(
  raw: unknown,
  snapshot: ContinuationEvidenceSnapshot,
  ordinal: number
): ContinuationDraftProposal | null {
  const record = asRecord(raw)
  if (!record) return null
  const intent = record.intentKind
  if (typeof intent !== 'string' || !INTENTS.has(intent as ContinuationDraftIntentKind)) return null
  const body = normalizeDraftText(record.body ?? record.text)
  if (!body || forbiddenDraft(body) || untrustedEcho(body, snapshot)) return null

  const evidenceIds = Array.isArray(record.evidenceIds)
    ? [...new Set(record.evidenceIds.filter((id): id is string => typeof id === 'string'))].slice(
        0,
        4
      )
    : []
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
  if (evidenceIds.length === 0 || evidenceIds.some((id) => !evidenceById.has(id))) return null
  const cited = evidenceIds.map((id) => evidenceById.get(id)!)
  if (!cited.some((item) => item.authority === 'user')) return null
  if (!cited.some((item) => ACTIONABLE_KINDS.has(item.kind))) return null
  if (!intentSupported(intent as ContinuationDraftIntentKind, cited)) return null

  const bodyTokens = tokenSet(body)
  const userTexts = snapshot.evidence.filter((item) => item.authority === 'user')
  if (
    userTexts.some((item) => {
      const userTokens = tokenSet(item.text)
      let contained = 0
      for (const token of bodyTokens) if (userTokens.has(token)) contained += 1
      return (
        jaccard(bodyTokens, userTokens) > 0.62 ||
        (bodyTokens.size >= 4 && contained / bodyTokens.size >= 0.85)
      )
    })
  ) {
    return null
  }

  const actionableTokens = tokenSet(
    cited
      .filter((item) => ACTIONABLE_KINDS.has(item.kind))
      .map((item) => item.text)
      .join(' ')
  )
  let actionableOverlap = 0
  for (const token of bodyTokens) if (actionableTokens.has(token)) actionableOverlap += 1
  if (bodyTokens.size === 0 || actionableOverlap < 2 || actionableOverlap / bodyTokens.size < 0.3) {
    return null
  }

  const score = candidateScore(body, cited)
  if (score < QUALITY_THRESHOLD) return null

  let text = body
  let target: ContinuationDraftProposal['target']
  const hasTarget = Object.prototype.hasOwnProperty.call(record, 'targetParticipantId')
  if (
    hasTarget &&
    (typeof record.targetParticipantId !== 'string' || !record.targetParticipantId.trim())
  ) {
    return null
  }
  const targetId =
    typeof record.targetParticipantId === 'string' ? record.targetParticipantId.trim() : ''
  if (targetId) {
    const participant = snapshot.roster.find((candidate) => candidate.participantId === targetId)
    if (!participant || participant.stageRole === 'background') return null
    const mentionText = `@${participant.label.replace(/[@\r\n]/g, '').trim()}`
    if (mentionText === '@') return null
    text = `${mentionText} ${body}`
    const routingParticipants: EnsembleParticipant[] = snapshot.roster.map((candidate, index) => ({
      id: candidate.participantId,
      provider: candidate.provider as EnsembleParticipant['provider'],
      enabled: true,
      role: candidate.label,
      instructions: '',
      order: index,
      ...(candidate.model ? { model: candidate.model } : {}),
      ...(candidate.stageRole ? { stageRole: candidate.stageRole } : {})
    }))
    const resolution = resolveEnsembleDmTargetForDispatch({
      text,
      participants: routingParticipants,
      exactPickerParticipantId: targetId
    })
    if (resolution.kind !== 'target' || resolution.participantId !== targetId) return null
    target = { participantId: participant.participantId, mentionText }
  }
  if (Array.from(text).length > MAX_DRAFT_CHARS) return null

  const explanationKinds = [...new Set(cited.map((item) => item.kind.replace(/-/g, ' ')))]
  return {
    id: `semantic:${snapshot.fingerprint.slice(7, 23)}:${ordinal}`,
    text,
    intentKind: intent as ContinuationDraftIntentKind,
    evidenceIds,
    qualityScore: Number(score.toFixed(3)),
    explanation: `Grounded in ${explanationKinds.join(' and ')}.`,
    ...(target ? { target } : {})
  }
}

export function normalizeContinuationProposalResult(
  request: ContinuationProposalRequest,
  snapshot: ContinuationEvidenceSnapshot,
  result: unknown,
  generatedAt: string
): ContinuationProposalSnapshot {
  const record = asRecord(result) || {}
  if (record.fingerprint !== snapshot.fingerprint) {
    return buildContinuationStaleSnapshot(request, generatedAt, 'evidence-changed')
  }

  if (
    typeof record.abstain !== 'boolean' ||
    !Array.isArray(record.candidates) ||
    record.candidates.length > MAX_PROPOSALS
  ) {
    return buildContinuationProposalUnavailableSnapshot(
      request,
      'Foundation Models returned an invalid continuation protocol response.',
      generatedAt
    )
  }
  const rawCandidates = record.abstain ? [] : record.candidates
  const normalized = rawCandidates
    .map((candidate, index) => normalizeCandidate(candidate, snapshot, index))
    .filter((candidate): candidate is ContinuationDraftProposal => candidate !== null)
    .sort((left, right) => right.qualityScore - left.qualityScore)
  const seen = new Set<string>()
  const proposals = normalized
    .filter((candidate) => {
      const key = normalizedWords(candidate.text).join(' ')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_PROPOSALS)

  const title =
    snapshot.title.eligible && !record.abstain ? normalizeLocalAiThreadTitle(record.title) : null
  const model = compactText(record.model, 120) || 'Apple Foundation Models'
  if (request.purpose === 'draft' && proposals.length === 0 && !title) {
    return buildContinuationAbstainedSnapshot(request, generatedAt, 'no-valid-candidates', {
      fingerprint: snapshot.fingerprint,
      model
    })
  }
  if (request.purpose === 'title' && !title) {
    return buildContinuationAbstainedSnapshot(request, generatedAt, 'model-abstained', {
      fingerprint: snapshot.fingerprint,
      model
    })
  }
  return {
    schemaVersion: 2,
    chatId: request.chatId,
    contextVersion: request.contextVersion,
    generatedAt,
    status: 'ready',
    proposals: request.purpose === 'draft' ? proposals : [],
    ...(title
      ? {
          title,
          titleSourceMessageId: snapshot.title.sourceMessageId,
          titleSourceFingerprint: snapshot.title.sourceFingerprint,
          titleExpectedCurrent: snapshot.title.expectedCurrent
        }
      : {}),
    fingerprint: snapshot.fingerprint,
    model
  }
}

function baseSnapshot(
  request: ContinuationProposalRequest,
  generatedAt: string,
  status: ContinuationProposalSnapshot['status'],
  reason: string,
  extra: Partial<ContinuationProposalSnapshot> = {}
): ContinuationProposalSnapshot {
  return {
    schemaVersion: 2,
    chatId: request.chatId,
    contextVersion: request.contextVersion,
    generatedAt,
    status,
    proposals: [],
    reason: compactText(reason, 240) || 'unavailable',
    ...extra
  }
}

export function buildContinuationProposalUnavailableSnapshot(
  request: ContinuationProposalRequest,
  reason: string,
  generatedAt = new Date().toISOString()
): ContinuationProposalSnapshot {
  return baseSnapshot(request, generatedAt, 'unavailable', reason)
}

export function buildContinuationAbstainedSnapshot(
  request: ContinuationProposalRequest,
  generatedAt: string,
  reason: string,
  extra: Partial<ContinuationProposalSnapshot> = {}
): ContinuationProposalSnapshot {
  return baseSnapshot(request, generatedAt, 'abstained', reason, extra)
}

export function buildContinuationStaleSnapshot(
  request: ContinuationProposalRequest,
  generatedAt: string,
  reason: string
): ContinuationProposalSnapshot {
  return baseSnapshot(request, generatedAt, 'stale', reason)
}
