/**
 * Host Arc Track3 Mixed Wave A — usePendingQuestionsProjection pins.
 *
 * THE DUAL-READ CONTRACT (mirrors Cap dispatch host-arc-5c-phase2-dispatch):
 * - Host not live / not freshness-live → renderer pending map VERBATIM.
 * - Host live + open question cards → Host membership filters by questionId.
 * - Host live with ZERO open cards → renderer list verbatim (never drop on empty).
 * - Host-only cards are OMITTED — never rendered from wire fields alone.
 *
 * The pins are pure (no DOM) — same split as usePendingApprovalsProjection.
 */

import { describe, expect, it } from 'vitest'
import type { AgentQuestionState } from '../components/AgentQuestionCard'
import type {
  HostProjectedQuestion,
  HostProjectedSnapshot
} from '../lib/host/hostSnapshotProjection'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import { joinHostPendingQuestions } from './usePendingQuestionsProjection'

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

function openCard(
  questionId: string,
  overrides: Partial<HostProjectedQuestion> = {}
): HostProjectedQuestion {
  return {
    questionId,
    threadId: 'thread-1',
    status: 'open',
    promptPreview: `Preview ${questionId}`,
    askedAt: 1,
    ...overrides
  }
}

function projection(
  questions: HostProjectedQuestion[],
  freshness: 'live' | 'cached' = 'live'
): HostProjectedSnapshot {
  return {
    generation: 1,
    cursor: 1,
    generatedAt: '2026-08-07T12:00:00.000Z',
    freshness,
    health: { hostStatus: 'ok', supervised: true },
    workspaces: [],
    threads: [],
    providers: [],
    questions,
    approvals: [],
    usage: { availability: 'unavailable' },
    warningCodes: [],
    counts: {
      runs: 0,
      missions: 0,
      rounds: 0,
      questions: questions.length,
      approvals: 0,
      warnings: 0
    }
  }
}

function liveState(questions: HostProjectedQuestion[]): HostProjectionState {
  return { status: 'live', projection: projection(questions), lastCursor: 1, lastGeneration: 1 }
}

describe('joinHostPendingQuestions', () => {
  it('flattens per-chat queues, carrying the map-key chatId', () => {
    const out = joinHostPendingQuestions(
      { status: 'idle' },
      {
        'chat-a': [question('q1'), question('q2')],
        'chat-b': [question('q3')]
      }
    )
    expect(out.map((entry) => [entry.chatId, entry.question.questionId])).toEqual([
      ['chat-a', 'q1'],
      ['chat-a', 'q2'],
      ['chat-b', 'q3']
    ])
  })

  it('Host not live → renderer list verbatim (fail-closed fallback)', () => {
    const byChatId = {
      'chat-a': [question('q1'), question('q2')]
    }
    for (const state of [
      { status: 'idle' },
      { status: 'loading' },
      { status: 'unavailable', unavailableReason: 'offline' },
      { status: 'unavailable', projection: projection([openCard('q1')], 'cached') }
    ] as HostProjectionState[]) {
      const out = joinHostPendingQuestions(state, byChatId)
      expect(out.map((entry) => entry.question.questionId)).toEqual(['q1', 'q2'])
    }
  })

  it('Host live but cached freshness → renderer list verbatim (cached is not live)', () => {
    const state: HostProjectionState = {
      status: 'live',
      projection: projection([openCard('q1')], 'cached')
    }
    const out = joinHostPendingQuestions(state, { 'chat-a': [question('q1')] })
    expect(out).toHaveLength(1)
  })

  it('Host live + open cards → Host membership filters the renderer list by questionId', () => {
    const out = joinHostPendingQuestions(liveState([openCard('q1')]), {
      'chat-a': [question('q1'), question('q2')],
      'chat-b': [question('q3')]
    })
    // q2 and q3 are absent from the Host open set → main resolved them and
    // the renderer's clear event was missed; the stale rows drop.
    expect(out.map((entry) => [entry.chatId, entry.question.questionId])).toEqual([
      ['chat-a', 'q1']
    ])
  })

  it('Host live with ZERO open cards never drops renderer rows', () => {
    const out = joinHostPendingQuestions(liveState([]), {
      'chat-a': [question('q1'), question('q2')]
    })
    expect(out.map((entry) => entry.question.questionId)).toEqual(['q1', 'q2'])
  })

  it('Host-only open cards are omitted — never rendered from wire fields alone', () => {
    const out = joinHostPendingQuestions(liveState([openCard('ghost')]), {})
    expect(out).toEqual([])
  })

  it('a non-open card (answered) does not count as open membership', () => {
    const answered: HostProjectedQuestion = { ...openCard('q1'), status: 'answered' }
    const out = joinHostPendingQuestions(liveState([answered]), { 'chat-a': [question('q1')] })
    // Zero OPEN cards → the empty-set rule keeps the renderer row.
    expect(out.map((entry) => entry.question.questionId)).toEqual(['q1'])
  })

  it('joins on questionId even when the renderer row also carries other local fields', () => {
    const out = joinHostPendingQuestions(liveState([openCard('q-keep'), openCard('q-drop')]), {
      'chat-a': [
        question('q-keep', { messageId: 'msg-local', options: ['A', 'B'] }),
        question('stale-only')
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.question.messageId).toBe('msg-local')
    expect(out[0]?.question.options).toEqual(['A', 'B'])
  })
})
