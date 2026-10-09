import {
  isEnsembleRoundDispatchLive,
  LIVE_ENSEMBLE_LANE_STATUSES
} from '../shared/ensembleRoundLifecycle'
import type { ChatRecord, ChatRun, EnsembleParticipantStatus } from './store/types'

const LIVE_PARTICIPANT = new Set<EnsembleParticipantStatus>(['idle', 'running', 'sleeping'])

/** Include terminal runs whose round projection was stranded by a process exit. */
export function ensembleRoundRecoveryRunIds(
  chat: Pick<ChatRecord, 'ensemble'>
): ReadonlySet<string> {
  const round = chat.ensemble?.activeRound
  if (round?.status !== 'running') return new Set()
  const ids = new Set<string>()
  for (const participant of Array.isArray(round.participants) ? round.participants : []) {
    if (
      participant.runId &&
      participant.status !== 'sleeping' &&
      LIVE_PARTICIPANT.has(participant.status)
    )
      ids.add(participant.runId)
  }
  for (const lane of Object.values(round.lanes ?? {})) {
    if (lane.runId && LIVE_ENSEMBLE_LANE_STATUSES.has(lane.status)) ids.add(lane.runId)
  }
  if (round.turnTransition) ids.add(round.turnTransition.sourceRunId)
  return ids
}

function terminalStatus(run: ChatRun): 'completed' | 'failed' | 'cancelled' | null {
  // A sleeping seat can finish its provider turn successfully while keeping a
  // durable wakeup. That is intentional lifecycle state, not a stranded lane.
  if (run.ensembleParticipantStatus === 'sleeping') return null
  if (run.status === 'success') return 'completed'
  if (run.status === 'failed' || run.status === 'cancelled') return run.status
  return null
}

/**
 * Exact persisted attempt outcomes repair the corresponding round projection.
 * A live orchestrator/finalizer wins over disk evidence. No missing run is
 * treated as dead, and sleeping seats/queued work without terminal proof stay.
 */
export function recoverEnsembleRoundFromRuns(
  chat: ChatRecord,
  isRunLive: (runId: string) => boolean,
  nowIso: string
): ChatRecord {
  const round = chat.ensemble?.activeRound
  if (!chat.ensemble || round?.status !== 'running') return chat
  const wanted = ensembleRoundRecoveryRunIds(chat)
  const terminal = new Map(
    (chat.runs ?? []).flatMap((run) => {
      if (!wanted.has(run.runId) || isRunLive(run.runId)) return []
      const status = terminalStatus(run)
      return status ? [[run.runId, { status, at: run.endedAt || nowIso }] as const] : []
    })
  )
  if (terminal.size === 0) return chat
  let changed = false
  const participants = round.participants.map((participant) => {
    const record = participant.runId ? terminal.get(participant.runId) : undefined
    if (!record || participant.status === 'sleeping' || !LIVE_PARTICIPANT.has(participant.status))
      return participant
    changed = true
    return {
      ...participant,
      status: record.status === 'completed' ? ('answered' as const) : record.status,
      endedAt: record.at
    }
  })
  const lanes = round.lanes
    ? Object.fromEntries(
        Object.entries(round.lanes).map(([id, lane]) => {
          const record = lane.runId ? terminal.get(lane.runId) : undefined
          if (!record || !LIVE_ENSEMBLE_LANE_STATUSES.has(lane.status)) return [id, lane]
          changed = true
          return [id, { ...lane, status: record.status, endedAt: record.at, approvalsQueued: 0 }]
        })
      )
    : round.lanes
  const next = { ...round, participants, lanes }
  if (
    next.activeParticipantId &&
    participants.some(
      (p) => p.participantId === next.activeParticipantId && !LIVE_PARTICIPANT.has(p.status)
    )
  ) {
    next.activeParticipantId = undefined
    changed = true
  }
  if (!isEnsembleRoundDispatchLive(next)) {
    next.status = participants.some((p) => p.status === 'failed')
      ? 'failed'
      : participants.some((p) => p.status === 'cancelled')
        ? 'cancelled'
        : 'completed'
    next.endedAt = nowIso
    next.turnTransition = undefined
    next.activeParticipantId = undefined
    changed = true
  }
  return changed ? { ...chat, ensemble: { ...chat.ensemble, activeRound: next } } : chat
}
