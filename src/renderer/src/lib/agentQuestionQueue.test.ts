import { describe, expect, it } from 'vitest'
import type { AgentQuestionState } from '../components/AgentQuestionCard'
import {
  EMPTY_AGENT_QUESTION_QUEUE,
  agentQuestionQueueHasMessage,
  chatHasPendingAgentQuestion,
  enqueueAgentQuestion,
  findQueuedAgentQuestion,
  flattenPendingAgentQuestions,
  removeAgentQuestionFromQueue
} from './agentQuestionQueue'

function question(
  questionId: string,
  overrides: Partial<AgentQuestionState> = {}
): AgentQuestionState {
  return {
    questionId,
    appRunId: `run-${questionId}`,
    messageId: `message-${questionId}`,
    provider: 'codex',
    question: `Question ${questionId}?`,
    askedAt: 1,
    ...overrides
  }
}

describe('agent question queue helpers', () => {
  it('appends new questions and replaces matching question ids', () => {
    const first = question('one', { question: 'Original?' })
    const second = question('two')
    const replacement = question('one', { question: 'Updated?' })

    const queued = enqueueAgentQuestion(enqueueAgentQuestion([first], second), replacement)

    expect(queued).toEqual([replacement, second])
  })

  it('removes questions and returns the shared empty queue when drained', () => {
    const remaining = removeAgentQuestionFromQueue([question('one'), question('two')], 'one')
    expect(remaining).toEqual([question('two')])

    expect(removeAgentQuestionFromQueue([question('one')], 'one')).toBe(EMPTY_AGENT_QUESTION_QUEUE)
    expect(removeAgentQuestionFromQueue(undefined, 'missing')).toBe(EMPTY_AGENT_QUESTION_QUEUE)
  })

  it('finds queued questions across chat buckets', () => {
    const target = question('target')

    expect(
      findQueuedAgentQuestion(
        {
          chatA: [question('other')],
          chatB: [target]
        },
        'target'
      )
    ).toEqual({ chatId: 'chatB', question: target })
    expect(findQueuedAgentQuestion({ chatA: [question('other')] }, 'missing')).toBeNull()
  })

  it('detects queues containing a transcript message id', () => {
    expect(
      agentQuestionQueueHasMessage([question('one', { messageId: 'message-a' })], 'message-a')
    ).toBe(true)
    expect(
      agentQuestionQueueHasMessage([question('one', { messageId: 'message-a' })], 'message-b')
    ).toBe(false)
    expect(agentQuestionQueueHasMessage(undefined, 'message-a')).toBe(false)
  })

  it('reports whether a chat has any pending question', () => {
    const queues = {
      chatA: [question('one')],
      chatB: EMPTY_AGENT_QUESTION_QUEUE
    }
    expect(chatHasPendingAgentQuestion(queues, 'chatA')).toBe(true)
    expect(chatHasPendingAgentQuestion(queues, 'chatB')).toBe(false)
    expect(chatHasPendingAgentQuestion(queues, 'missing')).toBe(false)
    expect(chatHasPendingAgentQuestion(undefined, 'chatA')).toBe(false)
  })

  it('flattens pending questions with their filing chat ids', () => {
    const first = question('one')
    const second = question('two')
    expect(
      flattenPendingAgentQuestions({
        chatA: [first],
        chatB: [second],
        chatC: EMPTY_AGENT_QUESTION_QUEUE
      })
    ).toEqual([
      { chatId: 'chatA', question: first },
      { chatId: 'chatB', question: second }
    ])
    expect(flattenPendingAgentQuestions(undefined)).toEqual([])
  })
})
