import { describe, expect, it } from 'vitest'
import type { BlackboardEntry, ChatRecord } from '../store/types'
import { applyBlackboardPollVoteToChat } from './BlackboardPoll'

const CREATED_AT = '2026-07-24T12:00:00.000Z'
const VOTED_AT = '2026-07-24T12:01:00.000Z'

function pollEntry(overrides: Partial<BlackboardEntry> = {}): BlackboardEntry {
  return {
    id: 'blackboard-poll-1',
    chatId: 'chat-1',
    roundId: 'round-1',
    participantId: 'p1',
    key: 'release-vote',
    value: 'Ship this release?',
    category: 'decision',
    scope: 'session',
    createdAt: CREATED_AT,
    seenBy: ['p1', 'p2'],
    poll: {
      status: 'open',
      options: ['Ship', 'Keep working'],
      votes: [],
      eligibleParticipantIds: ['p1', 'p2'],
      includeUser: true,
      updatedAt: CREATED_AT
    },
    ...overrides
  }
}

function chat(entries: BlackboardEntry[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    updatedAt: 1,
    ensemble: {
      participants: [],
      activeRound: { roundId: 'round-1', status: 'running' },
      blackboard: entries
    }
  } as unknown as ChatRecord
}

function vote(
  target: ChatRecord,
  overrides: Partial<Parameters<typeof applyBlackboardPollVoteToChat>[0]> = {}
) {
  return applyBlackboardPollVoteToChat({
    chat: target,
    pollId: 'blackboard-poll-1',
    choice: 'Ship',
    voterId: 'p2',
    rationale: 'The checks are green.',
    votedAt: VOTED_AT,
    updatedAtMs: 2,
    ...overrides
  })
}

describe('applyBlackboardPollVoteToChat', () => {
  it('atomically records a participant vote and resurfaces the revision to peers', () => {
    const originalEntry = pollEntry()
    const original = chat([originalEntry])
    const result = vote(original)

    expect(result.handled).toBe(true)
    if (!result.handled || !result.ok) throw new Error('expected a successful vote')
    expect(result.entry.poll?.votes).toEqual([
      {
        voterId: 'p2',
        choice: 'Ship',
        rationale: 'The checks are green.',
        votedAt: VOTED_AT
      }
    ])
    expect(result.entry.poll?.updatedAt).toBe(VOTED_AT)
    expect(result.entry.seenBy).toEqual(['p2'])
    expect(result.tally).toEqual([
      { choice: 'Ship', votes: 1 },
      { choice: 'Keep working', votes: 0 }
    ])
    expect(result.updatedChat.ensemble?.blackboard?.[0]).not.toBe(originalEntry)
    expect(original.ensemble?.blackboard?.[0]).toBe(originalEntry)
  })

  it('lets a voter change choice without creating a duplicate ballot', () => {
    const first = vote(chat([pollEntry()]))
    if (!first.handled || !first.ok) throw new Error('expected first vote')
    const changed = vote(first.updatedChat, {
      choice: 'Keep working',
      rationale: '',
      votedAt: '2026-07-24T12:02:00.000Z',
      updatedAtMs: 3
    })

    if (!changed.handled || !changed.ok) throw new Error('expected changed vote')
    expect(changed.entry.poll?.votes).toEqual([
      {
        voterId: 'p2',
        choice: 'Keep working',
        votedAt: '2026-07-24T12:02:00.000Z'
      }
    ])
  })

  it('accepts the human as a distinct optional voter', () => {
    const result = vote(chat([pollEntry()]), {
      voterId: 'user',
      rationale: undefined
    })

    if (!result.handled || !result.ok) throw new Error('expected user vote')
    expect(result.entry.poll?.votes[0]).toMatchObject({ voterId: 'user', choice: 'Ship' })
  })

  it('falls through only when no Blackboard poll matches the id', () => {
    expect(vote(chat([pollEntry({ poll: undefined })]))).toEqual({ handled: false })
    expect(vote(chat([pollEntry()]), { pollId: 'bossman-poll-1' })).toEqual({ handled: false })
  })

  it('claims a matching Blackboard poll and rejects invalid ballots without mutation', () => {
    const original = chat([pollEntry()])
    const invalid = vote(original, { choice: 'Abstain' })

    expect(invalid).toMatchObject({
      handled: true,
      ok: false,
      error: 'blackboard_poll_invalid_choice'
    })
    expect(original.ensemble?.blackboard?.[0]?.poll?.votes).toEqual([])
  })

  it('rejects ineligible, closed, foreign-round, and malformed polls', () => {
    expect(vote(chat([pollEntry()]), { voterId: 'p9' })).toMatchObject({
      handled: true,
      ok: false,
      error: 'blackboard_poll_voter_not_eligible'
    })
    expect(
      vote(
        chat([
          pollEntry({
            poll: { ...pollEntry().poll!, includeUser: false }
          })
        ]),
        { voterId: 'user' }
      )
    ).toMatchObject({
      handled: true,
      ok: false,
      error: 'blackboard_poll_voter_not_eligible'
    })
    expect(
      vote(
        chat([
          pollEntry({
            poll: { ...pollEntry().poll!, status: 'closed', closedAt: VOTED_AT }
          })
        ])
      )
    ).toMatchObject({ handled: true, ok: false, error: 'blackboard_poll_closed' })
    expect(vote(chat([pollEntry({ scope: 'round', roundId: 'round-old' })]))).toMatchObject({
      handled: true,
      ok: false,
      error: 'blackboard_poll_not_visible'
    })
    expect(
      vote(
        chat([
          pollEntry({
            poll: { ...pollEntry().poll!, options: ['Only one'] }
          })
        ])
      )
    ).toMatchObject({ handled: true, ok: false, error: 'blackboard_poll_invalid' })
    expect(
      vote(
        chat([
          pollEntry({
            poll: {
              ...pollEntry().poll!,
              votes: [null] as unknown as NonNullable<BlackboardEntry['poll']>['votes']
            }
          })
        ])
      )
    ).toMatchObject({ handled: true, ok: false, error: 'blackboard_poll_invalid' })
    expect(
      vote(
        chat([
          pollEntry({
            poll: null as unknown as NonNullable<BlackboardEntry['poll']>
          })
        ])
      )
    ).toMatchObject({ handled: true, ok: false, error: 'blackboard_poll_invalid' })
  })
})
