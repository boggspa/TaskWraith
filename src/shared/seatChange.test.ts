import { describe, expect, it } from 'vitest'
import {
  SEAT_CHANGE_COALESCE_WINDOW_MS,
  SEAT_CHANGE_LINK_PREFIX,
  coalesceSeatChangeMessages,
  decodeSeatChangeLink,
  encodeSeatChangeLink,
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

describe('close-out seat links', () => {
  const after = {
    provider: 'claude',
    model: 'claude-opus-5',
    role: 'GemProWork',
    seatNumber: 8,
    reasoningEffort: 'max',
    permissionPresetId: 'default',
    grantsCount: 2
  }
  const before = {
    provider: 'grok',
    model: 'grok-4.5-fast',
    role: 'GemProWork',
    seatNumber: 8,
    reasoningEffort: 'high',
    permissionPresetId: 'default',
    grantsCount: 2
  }

  it('round-trips both sides of a changed seat', () => {
    const href = encodeSeatChangeLink({ participantId: 'p-8', before, after })
    expect(href.startsWith(SEAT_CHANGE_LINK_PREFIX)).toBe(true)
    expect(decodeSeatChangeLink(href)).toEqual({ participantId: 'p-8', before, after })
  })

  it('omits the before side for an unchanged seat, decoding to identical sides', () => {
    const href = encodeSeatChangeLink({ participantId: 'p-8', before: after, after })
    expect(href).not.toContain('bp=')
    expect(decodeSeatChangeLink(href)).toEqual({ participantId: 'p-8', before: after, after })
  })

  it('survives values that would break a markdown link or a naive query parser', () => {
    // `)` would close the markdown destination, `&`/`=`/`+`/space would be
    // mis-split or mis-decoded by a hand-rolled or URLSearchParams parser.
    const awkward = {
      provider: 'ollama',
      model: 'qwen3-coder:30b+tools (q4_K_M)',
      role: 'R&D = Lead',
      seatNumber: 3
    }
    const href = encodeSeatChangeLink({ participantId: 'a b', before: awkward, after: awkward })
    expect(href).not.toContain(')')
    expect(href).not.toContain(' ')
    expect(decodeSeatChangeLink(href)).toEqual({
      participantId: 'a b',
      before: awkward,
      after: awkward
    })
  })

  it('rejects hrefs that are not seat links, or carry no resolvable seat', () => {
    expect(decodeSeatChangeLink('ensemble-dm://p-8')).toBeNull()
    expect(decodeSeatChangeLink('ensemble-seat://p-8')).toBeNull()
    expect(decodeSeatChangeLink('ensemble-seat://p-8?m=claude-opus-5')).toBeNull()
    expect(decodeSeatChangeLink('ensemble-seat://?p=claude')).toBeNull()
  })
})
