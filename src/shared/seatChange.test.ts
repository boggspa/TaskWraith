import { describe, expect, it } from 'vitest'
import {
  SEAT_CHANGE_COALESCE_WINDOW_MS,
  SEAT_CHANGE_LINK_PREFIX,
  coalesceSeatChangeMessages,
  decodeSeatChangeLink,
  encodeSeatChangeLink,
  coalesceSeatRosterMessages,
  coalesceSeatParticipantAddedMessages,
  isSeatParticipantAddedPayload,
  isSeatRosterPayload,
  resolveSeatAuthority,
  type SeatChangeCarrierMessage,
  type SeatChangePayload,
  type SeatParticipantAddedPayload,
  type SeatRosterPayload
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

  it('keeps a brief update announced when a later tweak in the flurry did not touch it', () => {
    // The surviving row shows the INHERITED before-state, so it stands for the
    // whole flurry. Letting the latest tweak's (absent) flag win would un-say a
    // brief change the reader was already shown — the note would blink out.
    const prior = seatChangeMessage('m1', 'p1', T0 - 30_000)
    prior.metadata!.seatChange!.briefUpdated = true
    expect(nextPayload.briefUpdated).toBeUndefined()
    const { payload } = coalesceSeatChangeMessages([prior], nextPayload, T0)
    expect(payload.briefUpdated).toBe(true)
  })

  it('leaves the flag off entirely when no brief moved on either side', () => {
    // Absent, not `false`: the row renders no note, and old persisted rows that
    // predate the flag decode the same way a fresh unchanged one does.
    const prior = seatChangeMessage('m1', 'p1', T0 - 30_000)
    const { payload } = coalesceSeatChangeMessages([prior], nextPayload, T0)
    expect(payload.briefUpdated).toBeUndefined()
  })

  it('keeps the latest enabled state across a coalesced flurry', () => {
    const disabled = seatChangeMessage('m1', 'p1', T0 - 30_000)
    disabled.metadata!.seatChange!.enabledChangedTo = false

    // A later non-toggle edit keeps the earlier status annotation alive.
    const afterUnrelatedEdit = coalesceSeatChangeMessages([disabled], nextPayload, T0).payload
    expect(afterUnrelatedEdit.enabledChangedTo).toBe(false)

    // A later toggle supersedes it. The false -> true transition must use the
    // next event's state rather than OR-ing booleans like `briefUpdated` does.
    const enabledAgain = { ...nextPayload, enabledChangedTo: true }
    const afterSecondToggle = coalesceSeatChangeMessages([disabled], enabledAgain, T0).payload
    expect(afterSecondToggle.enabledChangedTo).toBe(true)
  })

  it('does not annotate ordinary seat changes with an enabled state', () => {
    const prior = seatChangeMessage('m1', 'p1', T0 - 30_000)
    const { payload } = coalesceSeatChangeMessages([prior], nextPayload, T0)
    expect(payload.enabledChangedTo).toBeUndefined()
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

describe('resolveSeatAuthority', () => {
  it('marks the boss', () => {
    expect(resolveSeatAuthority({ participantId: 'p1', bossmanParticipantId: 'p1' })).toBe('boss')
  })

  it('marks a captain', () => {
    expect(resolveSeatAuthority({ participantId: 'p2', captainParticipantIds: ['p2', 'p3'] })).toBe(
      'captain'
    )
  })

  it('never shows the boss as a captain too', () => {
    // One mark per seat: two would make the roster harder to scan, not easier.
    expect(
      resolveSeatAuthority({
        participantId: 'p1',
        bossmanParticipantId: 'p1',
        captainParticipantIds: ['p1']
      })
    ).toBe('boss')
  })

  it('gives a BACKGROUND seat no authority glyph', () => {
    // A background lane is not in the round's command chain, so a crown there
    // would overstate what it does — matching the composer chips exactly.
    expect(
      resolveSeatAuthority({
        participantId: 'p1',
        stageRole: 'background',
        bossmanParticipantId: 'p1',
        captainParticipantIds: ['p1']
      })
    ).toBeUndefined()
  })

  it('is undefined for an ordinary seat', () => {
    expect(
      resolveSeatAuthority({ participantId: 'p9', captainParticipantIds: ['p2'] })
    ).toBeUndefined()
    expect(resolveSeatAuthority({ participantId: '' })).toBeUndefined()
  })
})

describe('seat link carries the glyph fields', () => {
  it('round-trips stageRole and authority', () => {
    // A new seat field missing from SEAT_LINK_KEYS is silently dropped from
    // every close-out row — the table keeps rendering, just without the glyph.
    const link = {
      participantId: 'p1',
      before: { provider: 'claude', model: 'm', stageRole: 'scout' as const },
      after: {
        provider: 'claude',
        model: 'm',
        stageRole: 'reviewer' as const,
        authority: 'boss' as const
      }
    }
    const decoded = decodeSeatChangeLink(encodeSeatChangeLink(link))
    expect(decoded?.after.stageRole).toBe('reviewer')
    expect(decoded?.after.authority).toBe('boss')
    expect(decoded?.before.stageRole).toBe('scout')
  })

  it('drops an unknown stage role or authority on decode', () => {
    const bad = encodeSeatChangeLink({
      participantId: 'p1',
      before: { provider: 'claude', model: 'm' },
      after: {
        provider: 'claude',
        model: 'm',
        stageRole: 'overlord' as never,
        authority: 'king' as never
      }
    })
    const decoded = decodeSeatChangeLink(bad)
    expect(decoded?.after).not.toHaveProperty('stageRole')
    expect(decoded?.after).not.toHaveProperty('authority')
  })
})

/* ── Roster-created stack ───────────────────────────────────────── */

function rosterSeat(participantId: string, provider: string, model: string, role: string) {
  return { participantId, provider, model, role, permissionPresetId: 'default' }
}

function rosterMessage(
  id: string,
  appliedAtMs: number,
  seats = [rosterSeat('a', 'claude', 'claude-opus-5', 'Boss')]
) {
  return {
    id,
    role: 'system',
    content: 'Ensemble roster created.',
    timestamp: new Date(appliedAtMs).toISOString(),
    metadata: {
      seatChange: {
        seats,
        label: 'Ensemble roster created',
        appliedAt: new Date(appliedAtMs).toISOString()
      }
    }
  } as unknown as SeatChangeCarrierMessage
}

const nextRoster: SeatRosterPayload = {
  seats: [
    rosterSeat('a', 'claude', 'claude-opus-5', 'Boss'),
    rosterSeat('b', 'codex', 'gpt-5.6', 'Scout')
  ],
  label: 'Ensemble roster created',
  appliedAt: new Date(T0).toISOString()
}

describe('isSeatRosterPayload', () => {
  it('separates the roster variant from a seat change on the same carrier', () => {
    expect(isSeatRosterPayload(nextRoster)).toBe(true)
    expect(isSeatRosterPayload(nextPayload)).toBe(false)
  })

  it('refuses a roster payload whose seats are not an array', () => {
    expect(isSeatRosterPayload({ seats: 'two' } as unknown as SeatRosterPayload)).toBe(false)
  })
})

describe('coalesceSeatRosterMessages', () => {
  it('create-or-refresh writes a fresh row when the round has none', () => {
    const messages = [plain('m1')]
    const result = coalesceSeatRosterMessages(messages, nextRoster, T0, 'create-or-refresh')
    expect(result.payload).toEqual(nextRoster)
    expect(result.messages).toHaveLength(1)
  })

  it('folds a run of adds into ONE row carrying the roster as it now stands', () => {
    const messages = [plain('m1'), rosterMessage('r1', T0 - 5_000), plain('m2')]
    const result = coalesceSeatRosterMessages(messages, nextRoster, T0, 'create-or-refresh')
    // Lose exactly one row, gain exactly one — the transcript-stability contract.
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['m1', 'm2'])
    expect(result.payload?.seats).toHaveLength(2)
  })

  it('tombstones a row outside the window and starts a new one', () => {
    const stale = T0 - SEAT_CHANGE_COALESCE_WINDOW_MS - 1
    const messages = [rosterMessage('r1', stale)]
    const result = coalesceSeatRosterMessages(messages, nextRoster, T0, 'create-or-refresh')
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['r1'])
    expect(result.payload).toEqual(nextRoster)
  })

  it('refresh-only writes NOTHING when there is no in-window row to refresh', () => {
    const result = coalesceSeatRosterMessages([plain('m1')], nextRoster, T0, 'refresh-only')
    expect(result.payload).toBeNull()
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['m1'])
  })

  it('refresh-only restamps an in-window row so a mid-flurry seat edit cannot leave it stale', () => {
    const messages = [rosterMessage('r1', T0 - 1_000)]
    const result = coalesceSeatRosterMessages(messages, nextRoster, T0, 'refresh-only')
    expect(result.messages).toHaveLength(0)
    expect(result.payload?.seats).toHaveLength(2)
  })

  it('never mistakes a seat-CHANGE row for a roster row', () => {
    const messages = [seatChangeMessage('s1', 'p1', T0 - 1_000)]
    const result = coalesceSeatRosterMessages(messages, nextRoster, T0, 'refresh-only')
    expect(result.payload).toBeNull()
    expect(result.messages).toHaveLength(1)
  })

  it('and the change coalescer never consumes a ROSTER row', () => {
    const messages = [rosterMessage('r1', T0 - 1_000)]
    const result = coalesceSeatChangeMessages(messages, nextPayload, T0)
    expect(result.messages).toHaveLength(1)
    expect(result.payload).toEqual(nextPayload)
  })
})

/* ── Participant-added strip ─────────────────────────────────────── */

function addedMessage(
  id: string,
  participantId: string,
  appliedAtMs: number,
  overrides: Partial<SeatParticipantAddedPayload> = {}
): SeatChangeCarrierMessage {
  return {
    id,
    role: 'system',
    content: 'Participant added.',
    timestamp: new Date(appliedAtMs).toISOString(),
    metadata: {
      seatChange: {
        participantId,
        label: 'Added worker',
        seat: seat('kimi', 'kimi-k2.7-code', 'read_only'),
        appliedAt: new Date(appliedAtMs).toISOString(),
        ...overrides
      }
    }
  } as unknown as SeatChangeCarrierMessage
}

const nextAdded: SeatParticipantAddedPayload = {
  participantId: 'p-added',
  label: 'Added worker',
  seat: seat('kimi', 'kimi-k2.7-code', 'read_only'),
  appliedAt: new Date(T0).toISOString()
}

describe('isSeatParticipantAddedPayload', () => {
  it('identifies an added seat by its single `seat` field', () => {
    expect(isSeatParticipantAddedPayload(nextAdded)).toBe(true)
  })

  it('rejects a seat CHANGE (has `after`) and a roster (has array `seats`)', () => {
    expect(isSeatParticipantAddedPayload(nextPayload)).toBe(false)
    expect(isSeatParticipantAddedPayload(nextRoster)).toBe(false)
  })

  it('rejects malformed carriers', () => {
    expect(isSeatParticipantAddedPayload(undefined)).toBe(false)
    expect(isSeatParticipantAddedPayload({ participantId: 'p1', appliedAt: 'now' } as never)).toBe(
      false
    )
    expect(
      isSeatParticipantAddedPayload({
        participantId: 'p1',
        seat: [{ provider: 'x', model: 'm' }],
        appliedAt: 'now'
      } as never)
    ).toBe(false)
  })
})

describe('coalesceSeatParticipantAddedMessages', () => {
  it('writes a fresh row when no in-window add for the same participant exists', () => {
    const messages = [plain('m1'), addedMessage('a1', 'other', T0 - 5_000)]
    const result = coalesceSeatParticipantAddedMessages(messages, nextAdded, T0)
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['m1', 'a1'])
    expect(result.payload).toEqual(nextAdded)
  })

  it('coalesces an in-window row for the same participant', () => {
    const prior = addedMessage('a1', 'p-added', T0 - 30_000)
    const result = coalesceSeatParticipantAddedMessages(
      [plain('m1'), prior, plain('m2')],
      nextAdded,
      T0
    )
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['m1', 'm2'])
    expect(result.payload).toEqual(nextAdded)
  })

  it('tombstones a row outside the window', () => {
    const stale = addedMessage('a1', 'p-added', T0 - SEAT_CHANGE_COALESCE_WINDOW_MS - 1)
    const result = coalesceSeatParticipantAddedMessages([stale], nextAdded, T0)
    expect(result.messages.map((m) => (m as { id: string }).id)).toEqual(['a1'])
    expect(result.payload).toEqual(nextAdded)
  })

  it('never consumes a seat-change or roster row', () => {
    const messages = [seatChangeMessage('s1', 'p-added', T0 - 1_000), rosterMessage('r1', T0 - 1_000)]
    const result = coalesceSeatParticipantAddedMessages(messages, nextAdded, T0)
    expect(result.messages).toHaveLength(2)
    expect(result.payload).toEqual(nextAdded)
  })
})
