import { describe, expect, it, vi } from 'vitest'
import type { BlackboardEntry, ChatRecord } from '../store/types'
import { executeBlackboardAwarePollResponse } from './BlackboardPollMcp'

const NOW = new Date('2026-07-24T13:00:00.000Z')

function pollEntry(): BlackboardEntry {
  return {
    id: 'blackboard-poll-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'p1',
    key: 'release-vote',
    value: 'Ship?',
    category: 'decision',
    scope: 'session',
    createdAt: '2026-07-24T12:00:00.000Z',
    poll: {
      status: 'open',
      options: ['Ship', 'Keep working'],
      votes: [],
      eligibleParticipantIds: ['p1', 'p2'],
      includeUser: true,
      updatedAt: '2026-07-24T12:00:00.000Z'
    }
  }
}

function chat(entries: BlackboardEntry[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    updatedAt: 1,
    ensemble: {
      participants: [],
      blackboard: entries
    }
  } as unknown as ChatRecord
}

function run(target: ChatRecord, choice = 'Ship') {
  const fallback = vi.fn(() => ({
    ok: true,
    tool: 'ensemble_poll_response' as const,
    message: 'legacy accepted'
  }))
  const deps = {
    getChat: vi.fn(() => target),
    getParticipantIdForRun: vi.fn(() => 'p2'),
    saveAndBroadcastChat: vi.fn(),
    now: vi.fn(() => NOW)
  }
  const result = executeBlackboardAwarePollResponse(deps, {
    appChatId: 'chat-1',
    appRunId: 'run-2',
    pollId: 'blackboard-poll-1',
    choice,
    rationale: 'Green checks.',
    fallback
  })
  return { result, deps, fallback }
}

describe('executeBlackboardAwarePollResponse', () => {
  it('derives voter identity from the active run and records a matching Blackboard vote', () => {
    const { result, deps, fallback } = run(chat([pollEntry()]))

    expect(result).toMatchObject({ ok: true, pollId: 'blackboard-poll-1' })
    expect(deps.getParticipantIdForRun).toHaveBeenCalledWith('run-2')
    expect(deps.saveAndBroadcastChat).toHaveBeenCalledOnce()
    expect(
      deps.saveAndBroadcastChat.mock.calls[0][0].ensemble?.blackboard?.[0]?.poll?.votes
    ).toEqual([
      {
        voterId: 'p2',
        choice: 'Ship',
        rationale: 'Green checks.',
        votedAt: NOW.toISOString()
      }
    ])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('claims a matching invalid vote without falling through', () => {
    const { result, deps, fallback } = run(chat([pollEntry()]), 'Abstain')

    expect(result).toMatchObject({ ok: false, error: 'blackboard_poll_invalid_choice' })
    expect(deps.saveAndBroadcastChat).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls through only when no Blackboard poll matches', () => {
    const { result, fallback } = run(chat([]))

    expect(result).toMatchObject({ ok: true, message: 'legacy accepted' })
    expect(fallback).toHaveBeenCalledOnce()
  })
})
