import type { ChatMessage } from '../../../main/store/types'

export type MidRunQueuedMessageSource = 'scheduledRun' | 'soloSteer'

const MID_RUN_QUEUED_MESSAGE_PREFIX = 'midrun-queued-user-'

export function midRunQueuedMessageId(runId: string): string {
  return `${MID_RUN_QUEUED_MESSAGE_PREFIX}${runId}`
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
}): boolean {
  if (!input.chatBusy || !input.scheduledRunAt) return false
  const runAtMs = Date.parse(input.scheduledRunAt)
  return Number.isFinite(runAtMs) && runAtMs <= input.nowMs
}
