import type { AgentQuestionState } from '../components/AgentQuestionCard'

export const EMPTY_AGENT_QUESTION_QUEUE: readonly AgentQuestionState[] = Object.freeze([])

export function enqueueAgentQuestion(
  queue: readonly AgentQuestionState[] = EMPTY_AGENT_QUESTION_QUEUE,
  next: AgentQuestionState
): readonly AgentQuestionState[] {
  const existingIndex = queue.findIndex((question) => question.questionId === next.questionId)
  if (existingIndex >= 0) {
    const updated = [...queue]
    updated[existingIndex] = next
    return updated
  }
  return [...queue, next]
}

export function removeAgentQuestionFromQueue(
  queue: readonly AgentQuestionState[] = EMPTY_AGENT_QUESTION_QUEUE,
  questionId: string
): readonly AgentQuestionState[] {
  const next = queue.filter((question) => question.questionId !== questionId)
  return next.length > 0 ? next : EMPTY_AGENT_QUESTION_QUEUE
}

export function findQueuedAgentQuestion(
  queuesByChatId: Record<string, readonly AgentQuestionState[]>,
  questionId: string
): { chatId: string; question: AgentQuestionState } | null {
  for (const [chatId, queue] of Object.entries(queuesByChatId)) {
    const question = queue.find((entry) => entry.questionId === questionId)
    if (question) return { chatId, question }
  }
  return null
}

export function agentQuestionQueueHasMessage(
  queue: readonly AgentQuestionState[] | undefined,
  messageId: string
): boolean {
  return Boolean(queue?.some((question) => question.messageId === messageId))
}
