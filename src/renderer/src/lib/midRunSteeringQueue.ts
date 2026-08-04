import type { ChatKind, ChatMessage, RunQueueJob } from '../../../main/store/types'
import {
  SOLO_STEER_TRANSCRIPT_PREPARATION,
  midRunQueuedMessageId
} from '../../../shared/midRunSteeringQueue'

export { midRunQueuedMessageId } from '../../../shared/midRunSteeringQueue'

export type MidRunQueuedMessageSource = 'scheduledRun' | 'soloSteer'

/**
 * Durable half of the solo-steer transcript barrier. Restart repair requires
 * the exact main-minted preparation kind and owner pair; renderer-supplied
 * queue fields alone can never make an ordinary paused job runnable.
 */
export function isPreparedSoloSteerQueueJob(
  job: Pick<
    RunQueueJob,
    | 'promotionOwnerToken'
    | 'promotionToken'
    | 'queueMessageId'
    | 'request'
    | 'runId'
    | 'status'
    | 'steerPreparationKind'
  >
): boolean {
  return Boolean(
    job.status === 'steer_promoting' &&
    job.steerPreparationKind === SOLO_STEER_TRANSCRIPT_PREPARATION &&
    job.promotionOwnerToken &&
    job.promotionToken === job.promotionOwnerToken &&
    job.request &&
    job.queueMessageId === midRunQueuedMessageId(job.runId)
  )
}

export function findMidRunQueuedMessage(
  messages: readonly ChatMessage[],
  runId: string | null | undefined
): ChatMessage | null {
  if (!runId) return null
  const messageId = midRunQueuedMessageId(runId)
  return messages.find((message) => message.id === messageId && message.role === 'user') || null
}

export function buildMidRunQueuedMessage(input: {
  runId: string
  content: string
  timestampIso: string
  source: MidRunQueuedMessageSource
  metadata?: ChatMessage['metadata']
}): ChatMessage {
  return {
    id: midRunQueuedMessageId(input.runId),
    role: 'user',
    content: input.content,
    timestamp: input.timestampIso,
    metadata: {
      ...(input.metadata || {}),
      kind: 'midRunSteering',
      midRunQueueRunId: input.runId,
      midRunQueueSource: input.source
    }
  }
}

export function appendMidRunQueuedMessage(
  messages: ChatMessage[],
  input: Parameters<typeof buildMidRunQueuedMessage>[0]
): { messages: ChatMessage[]; message: ChatMessage; appended: boolean } {
  const existing = findMidRunQueuedMessage(messages, input.runId)
  if (existing) {
    return { messages, message: existing, appended: false }
  }
  const message = buildMidRunQueuedMessage(input)
  return { messages: [...messages, message], message, appended: true }
}

export function pendingMidRunQueuedMessageIds(runIds: Iterable<string>): string[] {
  return [...new Set(Array.from(runIds, midRunQueuedMessageId))]
}

export function shouldAppendDueScheduledRun(input: {
  scheduledRunAt: string | null | undefined
  nowMs: number
  chatBusy: boolean
  chatKind: ChatKind
}): boolean {
  if (input.chatKind !== 'single' || !input.chatBusy || !input.scheduledRunAt) return false
  const runAtMs = Date.parse(input.scheduledRunAt)
  return Number.isFinite(runAtMs) && runAtMs <= input.nowMs
}
