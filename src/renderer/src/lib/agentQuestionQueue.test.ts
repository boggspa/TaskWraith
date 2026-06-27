import { describe, expect, it } from 'vitest'
import type { AgentQuestionState } from '../components/AgentQuestionCard'
import {
  EMPTY_AGENT_QUESTION_QUEUE,
  agentQuestionQueueHasMessage,
  enqueueAgentQuestion,
  findQueuedAgentQuestion,
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
})
