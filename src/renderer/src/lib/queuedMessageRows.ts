import type { ChatMessage, ChatRecord, RunQueueJob } from '../../../main/store/types'
import type { QueuedMessageRowEntry } from '../components/QueuedMessagesAboveRow'
import type { QueuedRunRequest } from './runRequestTypes'

type QueuedRunLifecycleStatus =
  | 'queued'
  | 'dispatched'
  | 'promoted'
  | 'cancelled'
  | 'edited'
  | 'unknown'

type QueuedRunLifecycleProjectionInput = {
  messages: ChatMessage[]
  pendingQueuedAppRunIds?: ReadonlySet<string>
  queuedRunStatusByAppRunId?: Partial<Record<string, string>>
}

const WILL_DISPATCH_SUFFIX =
  /\n—\s*Will dispatch when this chat's current [^\n.]+\.?\s*(?:\n|$)/

const stripQueuedLifecycleSuffix = (content: string): string => content.replace(WILL_DISPATCH_SUFFIX, '').trim()

const coerceQueuedLifecycleStatus = (
  appRunId: string,
  pendingQueuedAppRunIds?: ReadonlySet<string>,
  queuedRunStatusByAppRunId?: Partial<Record<string, string>>
): QueuedRunLifecycleStatus => {
  if (pendingQueuedAppRunIds && pendingQueuedAppRunIds.has(appRunId)) {
    return 'queued'
  }
  const rawStatus = typeof queuedRunStatusByAppRunId?.[appRunId] === 'string'
    ? queuedRunStatusByAppRunId[appRunId]
    : undefined
  switch (rawStatus) {
    case 'queued':
      return 'queued'
    case 'steer_promoting':
    case 'promoted':
      return 'promoted'
    case 'cancelled':
    case 'failed':
      return 'cancelled'
    case 'completed':
      return 'dispatched'
    case 'active':
    case 'starting':
    case 'dispatched':
      return 'dispatched'
    case 'edited':
      return 'edited'
    default:
      return 'unknown'
  }
}

const queuedLifecycleSuffix = (status: QueuedRunLifecycleStatus): string | null => {
  switch (status) {
    case 'promoted':
      return '— Promoted to dispatch'
    case 'cancelled':
      return '— Cancelled before dispatch'
    case 'edited':
      return '— Removed from queue for editing'
    case 'dispatched':
    case 'unknown':
      return '— Run no longer queued'
    default:
      return null
  }
}

const projectQueuedLifecycleMessageContent = (
  content: string,
  status: QueuedRunLifecycleStatus
): string => {
  if (status === 'queued') return content
  const stripped = stripQueuedLifecycleSuffix(content)
  const suffix = queuedLifecycleSuffix(status)
  if (!suffix) return stripped
  if (stripped === content && content.includes('—')) return content
  return `${stripped}\n${suffix}`
}

export const deriveQueuedLifecycleProjection = ({
  messages,
  pendingQueuedAppRunIds,
  queuedRunStatusByAppRunId
}: QueuedRunLifecycleProjectionInput): ChatMessage[] => {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const projected: ChatMessage[] = []
  for (const message of messages) {
    if (message?.metadata?.kind !== 'queuedRunRequest') {
      projected.push(message)
      continue
    }
    const appRunId =
      typeof message.metadata?.appRunId === 'string' && message.metadata.appRunId
        ? message.metadata.appRunId
        : undefined
    if (!appRunId) {
      projected.push({
        ...message,
        role: 'system'
      })
      continue
    }
    const status = coerceQueuedLifecycleStatus(
      appRunId,
      pendingQueuedAppRunIds,
      queuedRunStatusByAppRunId
    )
    if (status === 'queued') {
      projected.push({
        ...message,
        role: 'system'
      })
      continue
    }
    projected.push({
      ...message,
      role: 'system',
      content: projectQueuedLifecycleMessageContent(message.content, status)
    })
  }
  return projected
}

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
