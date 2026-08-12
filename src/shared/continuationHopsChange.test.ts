import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_HOPS_CHANGE_KIND,
  CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS,
  isContinuationHopsChangePayload
} from './continuationHopsChange'

describe('continuation hops change transcript payload', () => {
  it('accepts the durable user and authority variants', () => {
    expect(
      isContinuationHopsChangePayload({
        before: 6,
        after: 76,
        actor: 'user',
        changedAt: '2026-08-12T00:09:39.000Z'
      })
    ).toBe(true)
    expect(
      isContinuationHopsChangePayload({
        before: 76,
        after: 12,
        actor: 'captain',
        actorParticipantId: 'captain-1',
        actorRole: 'Release Captain',
        reason: 'Enough turns remain.',
        changedAt: '2026-08-12T00:10:00.000Z'
      })
    ).toBe(true)
  })

  it('rejects malformed persisted values', () => {
    expect(isContinuationHopsChangePayload(null)).toBe(false)
    expect(
      isContinuationHopsChangePayload({
        before: 0,
        after: 6,
        actor: 'user',
        changedAt: '2026-08-12T00:09:39.000Z'
      })
    ).toBe(false)
    expect(
      isContinuationHopsChangePayload({
        before: 6,
        after: 7.5,
        actor: 'boss',
        changedAt: 'not-a-date'
      })
    ).toBe(false)
  })

  it('pins the persisted kind and seat-parity reveal delay', () => {
    expect(CONTINUATION_HOPS_CHANGE_KIND).toBe('ensembleContinuationHopsChange')
    expect(CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS).toBe(2_000)
  })
})
