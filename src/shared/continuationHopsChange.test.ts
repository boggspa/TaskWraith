import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_HOPS_CHANGE_KIND,
  CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS,
  isContinuationHopsAdvancePayload,
  isContinuationHopsChangePayload,
  resolveContinuationHopsChangePayload
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
        event: 'limit',
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

  it('accepts first-hop and batched advance variants with a stable denominator', () => {
    const firstHop = {
      event: 'advance',
      before: 0,
      after: 1,
      maxHops: 124,
      targetLabel: 'Boss',
      sourceLabel: '@-mention',
      changedAt: '2026-08-29T22:05:00.000Z'
    }
    expect(isContinuationHopsAdvancePayload(firstHop)).toBe(true)
    expect(isContinuationHopsChangePayload(firstHop)).toBe(true)
    expect(
      isContinuationHopsChangePayload({
        ...firstHop,
        before: 48,
        after: 51,
        sourceLabel: 'Automatic pass 4'
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
    expect(
      isContinuationHopsChangePayload({
        event: 'advance',
        before: 1,
        after: 1,
        maxHops: 12,
        changedAt: '2026-08-12T00:09:39.000Z'
      })
    ).toBe(false)
    expect(
      isContinuationHopsChangePayload({
        event: 'advance',
        before: 11,
        after: 13,
        maxHops: 12,
        changedAt: '2026-08-12T00:09:39.000Z'
      })
    ).toBe(false)
    expect(
      isContinuationHopsChangePayload({
        event: 'advance',
        before: 0,
        after: 1,
        maxHops: 12,
        targetLabel: '   ',
        changedAt: '2026-08-12T00:09:39.000Z'
      })
    ).toBe(false)
  })

  it('pins the persisted kind and seat-parity reveal delay', () => {
    expect(CONTINUATION_HOPS_CHANGE_KIND).toBe('ensembleContinuationHopsChange')
    expect(CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS).toBe(2_000)
  })

  it('promotes only the exact legacy handoff fallback for display', () => {
    expect(
      resolveContinuationHopsChangePayload({
        role: 'system',
        content: '@-mention: extra turn appended for Boss. Continuous handoff 49/124.',
        timestamp: '2026-08-29T22:05:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      })
    ).toMatchObject({
      event: 'advance',
      before: 48,
      after: 49,
      maxHops: 124,
      targetLabel: 'Boss',
      sourceLabel: '@-mention'
    })
    expect(
      resolveContinuationHopsChangePayload({
        role: 'assistant',
        content: '@-mention: extra turn appended for Boss. Continuous handoff 49/124.',
        timestamp: '2026-08-29T22:05:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      })
    ).toBeNull()
  })
})
