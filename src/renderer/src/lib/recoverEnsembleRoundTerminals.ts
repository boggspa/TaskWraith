import type {
  ChatRecord,
  ConcurrentLane,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  RunQueueJobStatus,
  RunRecoveryRecord
} from '../../../main/store/types'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'

type EnsembleRound = NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>
type EnsembleRoundStatus = EnsembleRound['status']

const TERMINAL_RECOVERY_STATUSES = new Set<RunQueueJobStatus>(['completed', 'failed', 'cancelled'])

const LIVE_PARTICIPANT_STATUSES = new Set<EnsembleParticipantStatus>(['idle', 'running', 'sleeping'])

export function applyRecoveryRecordsToEnsembleRounds(
  records: ReadonlyArray<RunRecoveryRecord>,
  chats: ReadonlyArray<ChatRecord>
): ChatRecord[] {
  if (records.length === 0 || chats.length === 0) return chats as ChatRecord[]

  const recordsByChatId = recoveryRecordsByChatId(records)
  if (recordsByChatId.size === 0) return chats as ChatRecord[]

  let anyChatChanged = false
  const next = chats.map((chat) => {
    const chatRecords = recordsByChatId.get(chat.appChatId)
    const activeRound = chat.ensemble?.activeRound
    if (
      chat.chatKind !== 'ensemble' ||
      !chat.ensemble ||
      !activeRound ||
      activeRound.status !== 'running' ||
      !chatRecords ||
      chatRecords.length === 0
    ) {
      return chat
    }

    const recordByRunId = latestTerminalRecoveryRecordByRunId(chatRecords)
    if (recordByRunId.size === 0) return chat

    const recoveredRunIds = new Set(recordByRunId.keys())
    const roundHasRecoveredRun =
      activeRound.participants.some(
        (participant) => participant.runId && recoveredRunIds.has(participant.runId)
      ) ||
      Object.values(activeRound.lanes || {}).some(
        (lane) => lane.runId && recoveredRunIds.has(lane.runId)
      )
    if (!roundHasRecoveredRun) return chat

    let roundChanged = false
    const participants = activeRound.participants.map((participant) => {
      const record = participant.runId ? recordByRunId.get(participant.runId) : undefined
      if (!record) return participant
      const status = mapRecoveryStatusToParticipantStatus(record.recoveredStatus)
      if (!status || !LIVE_PARTICIPANT_STATUSES.has(participant.status)) return participant
      roundChanged = true
      return terminalParticipantFromRecovery(participant, status, record)
    })

    const lanes = activeRound.lanes
      ? Object.fromEntries(
          Object.entries(activeRound.lanes).map(([laneId, lane]) => {
            const record = lane.runId ? recordByRunId.get(lane.runId) : undefined
            if (!record || lane.endedAt) return [laneId, lane]
            const status = mapRecoveryStatusToLaneStatus(record.recoveredStatus)
            if (!status) return [laneId, lane]
            roundChanged = true
            return [
              laneId,
              {
                ...lane,
                status,
                endedAt: record.recoveredAt,
                reason: record.reason || lane.reason
              } satisfies ConcurrentLane
            ]
          })
        )
      : activeRound.lanes

    const activeParticipant = activeRound.activeParticipantId
      ? participants.find(
          (participant) => participant.participantId === activeRound.activeParticipantId
        )
      : undefined
    const activeParticipantRecovered =
      Boolean(activeParticipant?.runId && recoveredRunIds.has(activeParticipant.runId)) ||
      Boolean(activeParticipant && !LIVE_PARTICIPANT_STATUSES.has(activeParticipant.status))
    const nextActiveParticipantId = activeParticipantRecovered
      ? undefined
      : activeRound.activeParticipantId
    if (nextActiveParticipantId !== activeRound.activeParticipantId) {
      roundChanged = true
    }

    const reconciledRound: EnsembleRound = {
      ...activeRound,
      participants,
      lanes,
      activeParticipantId: nextActiveParticipantId
    }

    const shouldCloseRound = !isEnsembleActiveRoundDispatchLive(reconciledRound)
    if (!roundChanged && !shouldCloseRound) return chat

    const closedRound: EnsembleRound = shouldCloseRound
      ? {
          ...reconciledRound,
          status: recoveryRoundStatus(Array.from(recordByRunId.values())),
          endedAt: latestRecoveredAt(Array.from(recordByRunId.values()), activeRound.endedAt),
          activeParticipantId: undefined,
          pendingWakeupIds: [],
          sleepingParticipantIds: []
        }
      : reconciledRound

    anyChatChanged = true
    return {
      ...chat,
      updatedAt: Math.max(chat.updatedAt || 0, Date.now()),
      ensemble: {
        ...chat.ensemble,
        activeRound: closedRound
      }
    }
  })

  return anyChatChanged ? next : (chats as ChatRecord[])
}

function recoveryRecordsByChatId(
  records: ReadonlyArray<RunRecoveryRecord>
): Map<string, RunRecoveryRecord[]> {
  const byChatId = new Map<string, RunRecoveryRecord[]>()
  for (const record of records) {
    if (!record.chatId) continue
    const existing = byChatId.get(record.chatId) || []
    existing.push(record)
    byChatId.set(record.chatId, existing)
  }
  return byChatId
}

function latestTerminalRecoveryRecordByRunId(
  records: ReadonlyArray<RunRecoveryRecord>
): Map<string, RunRecoveryRecord> {
  const byRunId = new Map<string, RunRecoveryRecord>()
  for (const record of records) {
    if (!TERMINAL_RECOVERY_STATUSES.has(record.recoveredStatus)) continue
    const existing = byRunId.get(record.runId)
    if (
      !existing ||
      new Date(record.recoveredAt).getTime() > new Date(existing.recoveredAt).getTime()
    ) {
      byRunId.set(record.runId, record)
    }
  }
  return byRunId
}

function mapRecoveryStatusToParticipantStatus(
  status: RunQueueJobStatus
): EnsembleParticipantStatus | undefined {
  switch (status) {
    case 'completed':
      return 'answered'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

function mapRecoveryStatusToLaneStatus(
  status: RunQueueJobStatus
): ConcurrentLane['status'] | undefined {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

function terminalParticipantFromRecovery(
  participant: EnsembleRoundParticipantState,
  status: EnsembleParticipantStatus,
  record: RunRecoveryRecord
): EnsembleRoundParticipantState {
  return {
    ...participant,
    status,
    endedAt: record.recoveredAt,
    reason: record.reason || participant.reason,
    lastFailureReason:
      status === 'failed'
        ? record.reason || participant.lastFailureReason
        : participant.lastFailureReason
  }
}

function recoveryRoundStatus(records: ReadonlyArray<RunRecoveryRecord>): EnsembleRoundStatus {
  if (records.some((record) => record.recoveredStatus === 'failed')) return 'failed'
  if (records.some((record) => record.recoveredStatus === 'cancelled')) return 'cancelled'
  return 'completed'
}

function latestRecoveredAt(
  records: ReadonlyArray<RunRecoveryRecord>,
  fallback: string | undefined
): string | undefined {
  let latest = fallback
  let latestMs = latest ? new Date(latest).getTime() : Number.NEGATIVE_INFINITY
  for (const record of records) {
    const ms = new Date(record.recoveredAt).getTime()
    if (ms > latestMs) {
      latest = record.recoveredAt
      latestMs = ms
    }
  }
  return latest
}
