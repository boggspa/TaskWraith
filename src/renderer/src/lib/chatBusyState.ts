import type { ChatRecord, RunQueueJobStatus } from '../../../main/store/types'

export const ACTIVE_RUN_QUEUE_STATUSES = new Set<RunQueueJobStatus>([
  'steer_promoting',
  'starting',
  'active',
  'cancelling'
])

interface ChatBusyActiveRun {
  chatId?: string | null
}

interface ChatBusyQueueJob {
  id?: string
  runId?: string
  chatId?: string | null
  status?: RunQueueJobStatus
}

export interface IsChatBusyForDispatchInput {
  chatId?: string | null
  activeRuns?: Iterable<ChatBusyActiveRun>
  runQueueJobs?: Iterable<ChatBusyQueueJob>
  ignoreQueueRunId?: string
}

type EnsembleActiveRound = NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>

const LIVE_ENSEMBLE_PARTICIPANT_STATUSES = new Set(['idle', 'running', 'sleeping'])

const LIVE_ENSEMBLE_LANE_STATUSES = new Set(['pending', 'running', 'blocked', 'awaiting-approval'])

export function isEnsembleActiveRoundDispatchLive(
  round: EnsembleActiveRound | null | undefined
): boolean {
  if (round?.status !== 'running') return false
  const participants = Array.isArray(round.participants) ? round.participants : []
  if (round.activeParticipantId) {
    const activeParticipant = participants.find(
      (participant) => participant.participantId === round.activeParticipantId
    )
    if (!activeParticipant || LIVE_ENSEMBLE_PARTICIPANT_STATUSES.has(activeParticipant.status)) {
      return true
    }
  }

  const lanes = Object.values(round.lanes || {})
  if (lanes.some((lane) => LIVE_ENSEMBLE_LANE_STATUSES.has(lane.status))) return true
  if ((round.pendingWakeupIds?.length || 0) > 0) return true
  if ((round.sleepingParticipantIds?.length || 0) > 0) return true

  if (participants.length === 0) return true
  return participants.some((participant) =>
    LIVE_ENSEMBLE_PARTICIPANT_STATUSES.has(participant.status)
  )
}

export function isChatBusyForDispatch(input: IsChatBusyForDispatchInput): boolean {
  const chatId = input.chatId
  if (!chatId) return false

  for (const run of input.activeRuns || []) {
    if (run.chatId === chatId) return true
  }

  for (const job of input.runQueueJobs || []) {
    if (job.chatId !== chatId || !job.status || !ACTIVE_RUN_QUEUE_STATUSES.has(job.status)) {
      continue
    }
    const jobRunId = job.runId || job.id
    if (input.ignoreQueueRunId && jobRunId === input.ignoreQueueRunId) {
      continue
    }
    return true
  }

  return false
}
