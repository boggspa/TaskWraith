import type { ChatRecord, RunQueueJob } from '../../../main/store/types'
import type { QueuedMessageRowEntry } from '../components/QueuedMessagesAboveRow'
import type { QueuedRunRequest } from './runRequestTypes'

export const collectRunQueueJobIds = (jobs: RunQueueJob[]): Set<string> => {
  const ids = new Set<string>()
  for (const job of jobs) {
    if (job.runId) ids.add(job.runId)
    if (job.id) ids.add(job.id)
  }
  return ids
}

export const queuedRunRequestChatId = (request: QueuedRunRequest): string | undefined =>
  request.chatRecord?.appChatId

export const queuedRunDisplayPrompt = (request: QueuedRunRequest): string =>
  request.displayPrompt || request.prompt || ''

export const queuedRunScheduledRunAt = (request: QueuedRunRequest): string | undefined =>
  request.scheduledRunAt

export const ensembleQueuedPromptsFromRound = (
  round: NonNullable<ChatRecord['ensemble']>['activeRound'] | null | undefined
): string[] => {
  if (!round) return []
  if (Array.isArray(round.queuedPrompts) && round.queuedPrompts.length > 0) {
    return round.queuedPrompts
  }
  return round.queuedPrompt ? [round.queuedPrompt] : []
}

export const appendLocalQueuedRunEntries = ({
  entries,
  queuedRuns,
  runQueueJobs,
  chatId,
  queuedRunFallbackId
}: {
  entries: QueuedMessageRowEntry[]
  queuedRuns: QueuedRunRequest[]
  runQueueJobs: RunQueueJob[]
  chatId: string
  queuedRunFallbackId: (request: QueuedRunRequest) => string
}): QueuedMessageRowEntry[] => {
  const knownRunQueueJobIds = collectRunQueueJobIds(runQueueJobs)
  const merged = entries.slice()
  const entryIds = new Set(merged.map((entry) => entry.id))
  for (const request of queuedRuns) {
    const id = queuedRunFallbackId(request)
    if (entryIds.has(id)) continue
    if (queuedRunRequestChatId(request) !== chatId) continue
    if (request.appRunId && knownRunQueueJobIds.has(request.appRunId)) continue
    merged.push({
      id,
      provider: request.provider,
      prompt: queuedRunDisplayPrompt(request),
      scheduledRunAt: queuedRunScheduledRunAt(request),
      dmTargetParticipantId: request.dmTargetParticipantId
    })
    entryIds.add(id)
  }
  return merged
}

export const preserveOptimisticEnsembleQueue = (
  incoming: ChatRecord,
  local: ChatRecord | null | undefined
): ChatRecord => {
  const incomingRound = incoming.ensemble?.activeRound
  const localRound = local?.ensemble?.activeRound
  if (
    incoming.chatKind !== 'ensemble' ||
    !incomingRound ||
    !localRound ||
    incomingRound.roundId !== localRound.roundId ||
    incomingRound.status !== 'running' ||
    localRound.status !== 'running'
  ) {
    return incoming
  }
  const incomingQueue = ensembleQueuedPromptsFromRound(incomingRound)
  const localQueue = ensembleQueuedPromptsFromRound(localRound)
  if (localQueue.length <= incomingQueue.length) return incoming
  return {
    ...incoming,
    ensemble: {
      ...incoming.ensemble!,
      activeRound: {
        ...incomingRound,
        queuedPrompt: localQueue[0],
        queuedPrompts: localQueue
      }
    }
  }
}
