import { describe, expect, it } from 'vitest'
import {
  SEAT_CHANGE_COALESCE_WINDOW_MS,
  coalesceSeatChangeMessages,
  type SeatChangePayload,
  type SeatChangeCarrierMessage
} from './seatChange'

const T0 = Date.parse('2026-08-05T12:00:00.000Z')

function seat(provider: string, model: string, presetId: string) {
  return { provider, model, permissionPresetId: presetId }
}

function seatChangeMessage(
  id: string,
  participantId: string,
  appliedAtMs: number,
  before = seat('cursor', 'grok-4.5', 'default'),
  after = seat('claude', 'claude-fable-5', 'workspace_write')
): SeatChangeCarrierMessage {
  return {
    id,
    role: 'system',
    content: 'Authoritative seat change applied.',
    timestamp: new Date(appliedAtMs).toISOString(),
    metadata: {
      seatChange: {
        participantId,
        label: 'CursorWork',
        before,
        after,
        appliedAt: new Date(appliedAtMs).toISOString()
      }
    }
  } as unknown as SeatChangeCarrierMessage
}

function plain(id: string): SeatChangeCarrierMessage {
  return {
    id,
    role: 'system',
    content: 'notice',
    timestamp: new Date(T0).toISOString()
  } as unknown as SeatChangeCarrierMessage
}

const nextPayload: SeatChangePayload = {
  participantId: 'p1',
  label: 'CursorWork',
  before: seat('claude', 'claude-fable-5', 'workspace_write'),
  after: seat('antigravity', 'gemini-3.1-pro', 'full_access'),
  appliedAt: new Date(T0).toISOString()
}

describe('coalesceSeatChangeMessages (120 s sliding window, tombstoning)', () => {
  it('coalesces an in-window row for the same participant: removes it, inherits its ORIGINAL before', () => {
    const prior = seatChangeMessage('m1', 'p1', T0 - 30_000)
    const { messages, payload } = coalesceSeatChangeMessages(
      [plain('a'), prior, plain('b')],
      nextPayload,
      T0
    )
    expect(messages.map((m) => m.id)).toEqual(['a', 'b'])
    // lose exactly one row; the caller appends exactly one — transcript invariance
    expect(payload.before).toEqual(seat('cursor', 'grok-4.5', 'default'))
    expect(payload.after).toEqual(nextPayload.after)
  })

  it('tombstones: outside the window nothing is touched and the payload passes through', () => {
    const prior = seatChangeMessage('m1', 'p1', T0 - SEAT_CHANGE_COALESCE_WINDOW_MS - 1)
    const { messages, payload } = coalesceSeatChangeMessages([prior], nextPayload, T0)
    expect(messages.map((m) => m.id)).toEqual(['m1'])
    expect(payload).toEqual(nextPayload)
  })

  it('the window slides from the LATEST adjustment, and only the newest row is considered', () => {
    // old tombstone + a fresh in-window row: coalesce the fresh one only.
    const tombstone = seatChangeMessage('old', 'p1', T0 - 10 * 60_000)
    const fresh = seatChangeMessage(
      'fresh',
      'p1',
      T0 - 119_000,
      seat('mistral', 'devstral-small', 'read_only')
    )
    const { messages, payload } = coalesceSeatChangeMessages([tombstone, fresh], nextPayload, T0)
    expect(messages.map((m) => m.id)).toEqual(['old'])
    expect(payload.before).toEqual(seat('mistral', 'devstral-small', 'read_only'))
  })

  it('never touches other participants or malformed rows', () => {
    const other = seatChangeMessage('other', 'p2', T0 - 5_000)
    const malformed = {
      id: 'bad',
      role: 'system',
      content: 'x',
      timestamp: new Date(T0).toISOString(),
      metadata: { seatChange: { participantId: 'p1', appliedAt: 'not-a-date' } }
    } as unknown as SeatChangeCarrierMessage
    const r1 = coalesceSeatChangeMessages([other], nextPayload, T0)
    expect(r1.messages.map((m) => m.id)).toEqual(['other'])
    expect(r1.payload).toEqual(nextPayload)
    // malformed newest row acts as a tombstone (fail-safe: never delete what we
    // cannot positively identify as an in-window sibling)
    const r2 = coalesceSeatChangeMessages([malformed], nextPayload, T0)
    expect(r2.messages.map((m) => m.id)).toEqual(['bad'])
  })
})
