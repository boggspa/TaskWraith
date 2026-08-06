import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../main/store/types'
import {
  agentQuestionMarkerId,
  agentQuestionReplyId,
  appendAgentQuestionMarker,
  appendAgentQuestionReply,
  buildAgentQuestionMarkerMessage
} from './agentQuestionTranscript'

const RECORD = {
  questionId: 'q-pi-123',
  question: 'Which branch should the lane target?',
  options: ['master', 'a release branch'],
  context: 'The worktree is detached.',
  provider: 'pi' as const,
  createdAt: '2026-08-06T01:00:00.000Z'
}

function laneRow(id: string, roundId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'lane output',
    timestamp: '2026-08-06T00:59:00.000Z',
    runId: `run-${id}`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: roundId,
      ensembleLaneId: `lane-${id}`,
      ensembleParticipantId: `participant-${id}`
    }
  }
}

describe('buildAgentQuestionMarkerMessage', () => {
  it('carries the question, options and context the settled card reads back', () => {
    const marker = buildAgentQuestionMarkerMessage({
      record: RECORD,
      runId: 'run-9',
      ensembleRoundId: 'round-7'
    })

    expect(marker.id).toBe('agent-question-q-pi-123')
    expect(marker.role).toBe('system')
    expect(marker.timestamp).toBe('2026-08-06T01:00:00.000Z')
    expect(marker.runId).toBe('run-9')
    expect(marker.metadata).toMatchObject({
      kind: 'agentQuestion',
      questionId: 'q-pi-123',
      ensembleProvider: 'pi',
      agentQuestion: 'Which branch should the lane target?',
      agentQuestionOptions: ['master', 'a release branch'],
      agentQuestionContext: 'The worktree is detached.',
      ensembleRoundId: 'round-7'
    })
  })

  it('names the asker in the header line, and says "pick an option" only when there are options', () => {
    expect(buildAgentQuestionMarkerMessage({ record: RECORD }).content).toBe(
      'Pi asked you to pick an option:'
    )
    expect(
      buildAgentQuestionMarkerMessage({ record: { ...RECORD, options: [] } }).content
    ).toBe('Pi asked you a question:')
    expect(
      buildAgentQuestionMarkerMessage({ record: { ...RECORD, provider: undefined } }).content
    ).toBe('Agent asked you to pick an option:')
  })

  /* A fan-out lane's question belongs to the ROUND, not the lane. Stamping
   * lane/participant identity would sink the card into the collapsible fan-out
   * viewport, which is exactly where the record must not live. */
  it('never stamps lane or participant identity on the marker', () => {
    const marker = buildAgentQuestionMarkerMessage({
      record: RECORD,
      runId: 'run-9',
      ensembleRoundId: 'round-7'
    })
    expect(marker.metadata?.ensembleLaneId).toBeUndefined()
    expect(marker.metadata?.ensembleParticipantId).toBeUndefined()
  })

  it('omits the round id outside an ensemble round', () => {
    const marker = buildAgentQuestionMarkerMessage({ record: RECORD })
    expect(marker.metadata?.ensembleRoundId).toBeUndefined()
  })
})

describe('appendAgentQuestionMarker', () => {
  it('appends the marker so the answered question has something to settle onto', () => {
    const messages = [laneRow('worker-a', 'round-7')]
    const next = appendAgentQuestionMarker(messages, RECORD, {
      runId: 'run-9',
      ensembleRoundId: 'round-7'
    })

    expect(next).not.toBeNull()
    expect(next?.map((message) => message.id)).toEqual(['worker-a', 'agent-question-q-pi-123'])
  })

  it('is idempotent on the marker id, so the renderer writer cannot double it', () => {
    const messages = [
      laneRow('worker-a', 'round-7'),
      buildAgentQuestionMarkerMessage({ record: RECORD, ensembleRoundId: 'round-7' })
    ]
    expect(appendAgentQuestionMarker(messages, RECORD, { ensembleRoundId: 'round-7' })).toBeNull()
  })
})

describe('appendAgentQuestionReply', () => {
  it('inherits the round id off the marker so the reply stays in its round group', () => {
    const messages = [
      laneRow('worker-a', 'round-7'),
      buildAgentQuestionMarkerMessage({ record: RECORD, ensembleRoundId: 'round-7' })
    ]
    const next = appendAgentQuestionReply(messages, {
      questionId: 'q-pi-123',
      answer: 'master',
      isCustom: false,
      answeredAt: '2026-08-06T01:02:00.000Z'
    })

    const reply = next?.[next.length - 1]
    expect(reply?.id).toBe('agent-question-reply-q-pi-123')
    expect(reply?.role).toBe('user')
    expect(reply?.content).toBe('master')
    expect(reply?.timestamp).toBe('2026-08-06T01:02:00.000Z')
    expect(reply?.metadata).toEqual({
      kind: 'agentQuestionReply',
      questionId: 'q-pi-123',
      respondedToMessageId: 'agent-question-q-pi-123',
      isCustomAnswer: false,
      ensembleRoundId: 'round-7'
    })
  })

  it('still writes the reply when no marker is present', () => {
    const next = appendAgentQuestionReply([laneRow('worker-a', 'round-7')], {
      questionId: 'q-pi-123',
      answer: 'something else',
      isCustom: true,
      answeredAt: '2026-08-06T01:02:00.000Z'
    })
    const reply = next?.[next.length - 1]
    expect(reply?.metadata?.ensembleRoundId).toBeUndefined()
    expect(reply?.metadata?.isCustomAnswer).toBe(true)
  })

  it('is idempotent on the reply id, so the desktop writer cannot double it', () => {
    const messages = [
      buildAgentQuestionMarkerMessage({ record: RECORD, ensembleRoundId: 'round-7' })
    ]
    const first = appendAgentQuestionReply(messages, {
      questionId: 'q-pi-123',
      answer: 'master',
      isCustom: false,
      answeredAt: '2026-08-06T01:02:00.000Z'
    })
    expect(first).not.toBeNull()
    expect(
      appendAgentQuestionReply(first as ChatMessage[], {
        questionId: 'q-pi-123',
        answer: 'master',
        isCustom: false,
        answeredAt: '2026-08-06T01:03:00.000Z'
      })
    ).toBeNull()
  })
})

describe('id shapes', () => {
  /* Four independent writers key off these two shapes — the renderer's marker
   * and reply writers, this module, and `indexAgentQuestionReplies`, which
   * resolves legacy replies by reconstructing the marker id. */
  it('matches the ids every other writer already uses', () => {
    expect(agentQuestionMarkerId('q-pi-123')).toBe('agent-question-q-pi-123')
    expect(agentQuestionReplyId('q-pi-123')).toBe('agent-question-reply-q-pi-123')
  })
})
