import { describe, expect, it } from 'vitest'
import { validateBlackboardPollRecord } from './blackboardPollValidation'

function poll(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'open',
    options: ['Ship', 'Keep working'],
    votes: [],
    eligibleParticipantIds: ['p1', 'p2'],
    includeUser: true,
    updatedAt: '2026-07-24T12:00:00.000Z',
    ...overrides
  }
}

describe('validateBlackboardPollRecord', () => {
  it('accepts the durable poll contract', () => {
    expect(
      validateBlackboardPollRecord(
        poll({
          votes: [
            {
              voterId: 'p1',
              choice: 'Ship',
              rationale: 'Green checks.',
              votedAt: '2026-07-24T12:01:00.000Z'
            },
            {
              voterId: 'user',
              choice: 'Keep working',
              votedAt: '2026-07-24T12:02:00.000Z'
            }
          ]
        })
      ).ok
    ).toBe(true)
  })

  it('rejects null and malformed eligibility snapshots without throwing', () => {
    expect(validateBlackboardPollRecord(null)).toEqual({ ok: false })
    expect(validateBlackboardPollRecord(poll({ eligibleParticipantIds: [null] }))).toEqual({
      ok: false
    })
  })

  it('rejects duplicate or ineligible persisted ballots', () => {
    const ballot = {
      voterId: 'p1',
      choice: 'Ship',
      votedAt: '2026-07-24T12:01:00.000Z'
    }
    expect(validateBlackboardPollRecord(poll({ votes: [ballot, ballot] }))).toEqual({
      ok: false
    })
    expect(
      validateBlackboardPollRecord(
        poll({
          votes: [{ ...ballot, voterId: 'p9' }]
        })
      )
    ).toEqual({ ok: false })
  })
})
