import type { ChatMessage, ChatRecord, ChatRun } from '../main/store/types'

export type TranscriptExportRoundStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unknown'

export type TranscriptExportScope = { kind: 'entire-task' } | { kind: 'round'; roundId: string }

export interface TranscriptExportRound {
  roundId: string
  /** One-based position in the task's chronological round history. */
  ordinal: number
  prompt: string
  startedAt: string
  endedAt?: string
  status: TranscriptExportRoundStatus
  hops: number
  participantCount: number
  participantLabels: string[]
}

export interface ScopedTranscriptChat {
  chat: ChatRecord
  round: TranscriptExportRound | null
  roundCount: number
}

interface MutableRound {
  roundId: string
  encounterIndex: number
  prompt: string
  startedAt: string
  endedAt?: string
  lastActivityAt?: string
  status: TranscriptExportRoundStatus
  hops: number
  participants: Map<string, string>
  runStatuses: string[]
  hasOpenRun: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function earlierTimestamp(current: string, candidate: string): string {
  const currentMs = timestampMs(current)
  const candidateMs = timestampMs(candidate)
  if (candidateMs === null) return current
  if (currentMs === null || candidateMs < currentMs) return candidate
  return current
}

function laterTimestamp(current: string | undefined, candidate: string): string {
  if (!current) return candidate
  const currentMs = timestampMs(current)
  const candidateMs = timestampMs(candidate)
  if (candidateMs === null) return current
  if (currentMs === null || candidateMs > currentMs) return candidate
  return current
}

function normalizeRoundStatus(value: unknown): TranscriptExportRoundStatus {
  const normalized = nonEmptyString(value).toLowerCase()
  if (normalized === 'running' || normalized === 'active' || normalized === 'starting') {
    return 'running'
  }
  if (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'answered'
  ) {
    return 'completed'
  }
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  return 'unknown'
}

function messageRoundId(message: ChatMessage): string {
  return (
    nonEmptyString(message.metadata?.ensembleRoundId) ||
    nonEmptyString(message.metadata?.closeoutRoundId)
  )
}

function participantLabel(role: unknown, provider: unknown, participantId: string): string {
  const roleLabel = nonEmptyString(role)
  const providerLabel = nonEmptyString(provider)
  if (roleLabel && providerLabel) return `${roleLabel} · ${providerLabel}`
  return roleLabel || providerLabel || participantId
}

function addParticipant(
  round: MutableRound,
  participantIdValue: unknown,
  role: unknown,
  provider: unknown
): void {
  const participantId = nonEmptyString(participantIdValue)
  const roleLabel = nonEmptyString(role)
  const providerLabel = nonEmptyString(provider)
  if (!participantId && !roleLabel && !providerLabel) return
  const key = participantId || `${roleLabel}\u0000${providerLabel}`
  const label = participantLabel(roleLabel, providerLabel, participantId || 'Participant')
  const existing = round.participants.get(key)
  if (!existing || existing === participantId) round.participants.set(key, label)
}

function addCloseoutParticipants(round: MutableRound, value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.rows)) return
  for (const item of value.rows) {
    if (!isRecord(item)) continue
    const seatLink = isRecord(item.seatLink) ? item.seatLink : null
    const after = seatLink && isRecord(seatLink.after) ? seatLink.after : null
    addParticipant(round, item.participantId, after?.role ?? item.seatText, after?.provider)
  }
}

function runParticipantRole(run: ChatRun): unknown {
  return run.ensembleRole
}

function runParticipantProvider(run: ChatRun): unknown {
  return run.ensembleSeatSnapshot?.provider ?? run.provider
}

/**
 * Builds the chronological round history from durable transcript evidence.
 * Historical rounds do not retain one monolithic round object, so this joins
 * prompt/status messages, close-outs, runs, and the live round snapshot.
 */
export function collectTranscriptExportRounds(
  chat: ChatRecord | null | undefined
): TranscriptExportRound[] {
  if (!chat) return []

  const rounds = new Map<string, MutableRound>()
  let encounterIndex = 0
  const ensureRound = (roundIdValue: unknown): MutableRound | null => {
    const roundId = nonEmptyString(roundIdValue)
    if (!roundId) return null
    const existing = rounds.get(roundId)
    if (existing) return existing
    const created: MutableRound = {
      roundId,
      encounterIndex,
      prompt: '',
      startedAt: '',
      status: 'unknown',
      hops: 0,
      participants: new Map(),
      runStatuses: [],
      hasOpenRun: false
    }
    encounterIndex += 1
    rounds.set(roundId, created)
    return created
  }

  for (const message of chat.messages || []) {
    const round = ensureRound(messageRoundId(message))
    if (!round) continue
    if (message.timestamp) {
      round.startedAt = earlierTimestamp(round.startedAt, message.timestamp)
      round.lastActivityAt = laterTimestamp(round.lastActivityAt, message.timestamp)
    }
    if (
      (message.metadata?.kind === 'ensembleRoundPrompt' || message.role === 'user') &&
      !round.prompt
    ) {
      round.prompt = message.content.trim()
    }
    if (
      message.metadata?.kind === 'ensembleParticipantStatus' &&
      message.metadata.ensembleStatus === 'yielded'
    ) {
      round.hops += 1
    }
    addParticipant(
      round,
      message.metadata?.ensembleParticipantId,
      message.metadata?.ensembleRole,
      message.metadata?.ensembleProvider
    )
    if (message.metadata?.closeoutRoundId === round.roundId) {
      const closeoutStatus = normalizeRoundStatus(message.metadata.closeoutStatus)
      if (closeoutStatus !== 'unknown') round.status = closeoutStatus
      if (message.timestamp) round.endedAt = laterTimestamp(round.endedAt, message.timestamp)
      const durationMs = Number(message.metadata.closeoutDurationMs)
      const endedMs = timestampMs(message.timestamp)
      if (!round.startedAt && endedMs !== null && Number.isFinite(durationMs) && durationMs > 0) {
        round.startedAt = new Date(endedMs - durationMs).toISOString()
      }
      addCloseoutParticipants(round, message.metadata.closeoutParticipantTable)
    }
  }

  for (const run of chat.runs || []) {
    const round = ensureRound(run.ensembleRoundId)
    if (!round) continue
    if (run.startedAt) {
      round.startedAt = earlierTimestamp(round.startedAt, run.startedAt)
      round.lastActivityAt = laterTimestamp(round.lastActivityAt, run.startedAt)
    }
    if (run.endedAt) round.lastActivityAt = laterTimestamp(round.lastActivityAt, run.endedAt)
    round.runStatuses.push(nonEmptyString(run.status))
    if (!run.endedAt && normalizeRoundStatus(run.status) === 'running') round.hasOpenRun = true
    addParticipant(
      round,
      run.ensembleParticipantId,
      runParticipantRole(run),
      runParticipantProvider(run)
    )
  }

  const activeRound = chat.ensemble?.activeRound
  if (activeRound) {
    const round = ensureRound(activeRound.roundId)
    if (round) {
      round.prompt = activeRound.prompt.trim() || round.prompt
      round.startedAt = activeRound.startedAt || round.startedAt
      round.endedAt = activeRound.endedAt || round.endedAt
      round.status = activeRound.status
      round.hops = Math.max(0, activeRound.continuationHops ?? round.hops)
      for (const participant of activeRound.participants || []) {
        addParticipant(round, participant.participantId, participant.role, participant.provider)
      }
    }
  }

  const ordered = [...rounds.values()].sort((left, right) => {
    const leftMs = timestampMs(left.startedAt)
    const rightMs = timestampMs(right.startedAt)
    if (leftMs !== null && rightMs !== null && leftMs !== rightMs) return leftMs - rightMs
    if (leftMs !== null && rightMs === null) return -1
    if (leftMs === null && rightMs !== null) return 1
    return left.encounterIndex - right.encounterIndex
  })

  return ordered.map((round, index) => {
    let status = round.status
    if (status === 'unknown') {
      const statuses = round.runStatuses.map(normalizeRoundStatus)
      if (round.hasOpenRun || statuses.includes('running')) status = 'running'
      else if (statuses.length > 0 && statuses.every((candidate) => candidate === 'failed')) {
        status = 'failed'
      } else if (
        statuses.some((candidate) => candidate === 'completed') ||
        index < ordered.length - 1
      ) {
        status = 'completed'
      }
    }
    const endedAt =
      round.endedAt || (status === 'running' ? undefined : round.lastActivityAt || undefined)
    const participantLabels = [...round.participants.values()]
    return {
      roundId: round.roundId,
      ordinal: index + 1,
      prompt: round.prompt,
      startedAt: round.startedAt,
      ...(endedAt ? { endedAt } : {}),
      status,
      hops: round.hops,
      participantCount: participantLabels.length,
      participantLabels
    }
  })
}

export function isTranscriptExportScope(value: unknown): value is TranscriptExportScope {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (value.kind === 'entire-task') return keys.length === 1
  if (value.kind !== 'round' || keys.some((key) => key !== 'kind' && key !== 'roundId')) {
    return false
  }
  const roundId = nonEmptyString(value.roundId)
  return keys.length === 2 && roundId === value.roundId && roundId.length <= 512
}

export function transcriptExportScopeLabel(
  round: TranscriptExportRound | null,
  roundCount: number
): string {
  return round ? `Round ${round.ordinal} of ${roundCount}` : 'Entire task'
}

/**
 * Applies a validated export scope without mutating the canonical chat. Rows
 * carrying an explicit round id win; otherwise timestamps between adjacent
 * round starts adopt steering, replies, and app-authored notices into the round.
 */
export function scopeChatForTranscriptExport(
  chat: ChatRecord,
  scope: TranscriptExportScope
): ScopedTranscriptChat | null {
  const rounds = collectTranscriptExportRounds(chat)
  if (scope.kind === 'entire-task') {
    return { chat, round: null, roundCount: rounds.length }
  }

  const roundIndex = rounds.findIndex((candidate) => candidate.roundId === scope.roundId)
  if (roundIndex < 0) return null
  const round = rounds[roundIndex]
  const startedAtMs = timestampMs(round.startedAt)
  const nextStartedAtMs = timestampMs(rounds[roundIndex + 1]?.startedAt)
  const endedAtMs = timestampMs(round.endedAt)
  const messages = (chat.messages || []).filter((message) => {
    const explicitRoundId = messageRoundId(message)
    if (explicitRoundId) return explicitRoundId === round.roundId
    const messageMs = timestampMs(message.timestamp)
    if (messageMs === null || startedAtMs === null || messageMs < startedAtMs) return false
    if (nextStartedAtMs !== null) return messageMs < nextStartedAtMs
    return endedAtMs === null || messageMs <= endedAtMs
  })
  const runs = (chat.runs || []).filter((run) => run.ensembleRoundId === round.roundId)
  const scopedEnsemble = chat.ensemble
    ? {
        ...chat.ensemble,
        activeRound:
          chat.ensemble.activeRound?.roundId === round.roundId
            ? chat.ensemble.activeRound
            : undefined
      }
    : undefined
  return {
    chat: {
      ...chat,
      messages,
      runs,
      ...(scopedEnsemble ? { ensemble: scopedEnsemble } : {})
    },
    round,
    roundCount: rounds.length
  }
}
