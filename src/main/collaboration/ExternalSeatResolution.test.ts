import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import {
  externalSeatsForShare,
  hasNonExternalApprovalAuthority,
  resolveChatEffectiveRoster
} from './ExternalSeatResolution'

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share-1',
    chatId: 'chat-1',
    mode: 'comments',
    enabled: true,
    createdAt: 1000,
    updatedAt: 1000,
    nextSequence: 1,
    participants: [],
    invites: [],
    ...overrides
  } as HumanCollaborationShare
}

function participant(
  overrides: Partial<HumanCollaborationShare['participants'][number]> = {}
): HumanCollaborationShare['participants'][number] {
  return {
    collaboratorId: overrides.collaboratorId ?? 'c1',
    displayName: overrides.displayName ?? 'Olly',
    publicKeyId: overrides.publicKeyId ?? 'pk1',
    status: overrides.status ?? 'active',
    ...(overrides.seatOrder !== undefined ? { seatOrder: overrides.seatOrder } : {}),
    ...(overrides.colorIndex !== undefined ? { colorIndex: overrides.colorIndex } : {}),
    ...(overrides.seatDisabled !== undefined ? { seatDisabled: overrides.seatDisabled } : {})
  }
}

function modelSeat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: overrides.id ?? 'p1',
    provider: overrides.provider ?? 'claude',
    enabled: overrides.enabled ?? true,
    role: overrides.role ?? 'Builder',
    instructions: '',
    order: overrides.order ?? 0
  } as EnsembleParticipant
}

describe('externalSeatsForShare', () => {
  it('seats ACTIVE participants only', () => {
    // A pending participant has not completed SAS and a revoked one has had
    // trust withdrawn. Neither holds a seat, and neither is a presence question.
    const seats = externalSeatsForShare(
      share({
        participants: [
          participant({ collaboratorId: 'active', status: 'active' }),
          participant({ collaboratorId: 'pending', status: 'pending' }),
          participant({ collaboratorId: 'revoked', status: 'revoked' })
        ]
      })
    )
    expect(seats.map((seat) => seat.collaboratorId)).toEqual(['active'])
  })

  it('yields nothing for a disabled share', () => {
    const seats = externalSeatsForShare(share({ enabled: false, participants: [participant()] }))
    expect(seats).toEqual([])
  })

  it('yields nothing for an absent share', () => {
    expect(externalSeatsForShare(null)).toEqual([])
    expect(externalSeatsForShare(undefined)).toEqual([])
  })

  it('counts live AND in-grace as present — the whole point of the grace window', () => {
    // A reconnecting collaborator must not vanish from the panel mid-reconnect.
    const target = share({
      participants: [
        participant({ collaboratorId: 'live' }),
        participant({ collaboratorId: 'grace' }),
        participant({ collaboratorId: 'expired' }),
        participant({ collaboratorId: 'never-seen' })
      ]
    })
    const seats = externalSeatsForShare(target, (id) => {
      if (id === 'live') return 'live'
      if (id === 'grace') return 'grace'
      if (id === 'expired') return 'expired'
      return undefined
    })
    expect(seats.map((seat) => [seat.collaboratorId, seat.present])).toEqual([
      ['live', true],
      ['grace', true],
      ['expired', false],
      // Absence of evidence is not evidence of presence.
      ['never-seen', false]
    ])
  })

  it('treats an unknown presence record as NOT present', () => {
    const seats = externalSeatsForShare(share({ participants: [participant()] }), () => 'unknown')
    expect(seats[0]?.present).toBe(false)
  })

  it('defaults to present when the caller asks no presence question at all', () => {
    // An admin surface listing seats should not have to fabricate presence.
    const seats = externalSeatsForShare(share({ participants: [participant()] }))
    expect(seats[0]?.present).toBe(true)
  })

  it('carries a host-set seat order through, and omits it when unset', () => {
    const seats = externalSeatsForShare(
      share({
        participants: [
          participant({ collaboratorId: 'ordered', seatOrder: 3 }),
          participant({ collaboratorId: 'unordered' })
        ]
      })
    )
    expect(seats[0]?.seatOrder).toBe(3)
    expect(seats[1]?.seatOrder).toBeUndefined()
  })

  /**
   * Mute is presentation and MUST NOT read as removal. A muted seat still
   * appears and still holds its position; only `enabled` flips. Conflating this
   * with revocation is the mistake the two verbs exist to keep apart.
   */
  it('maps a muted seat to enabled:false while still seating it', () => {
    const seats = externalSeatsForShare(
      share({ participants: [participant({ seatDisabled: true })] })
    )
    expect(seats).toHaveLength(1)
    expect(seats[0]?.enabled).toBe(false)
  })

  it('leaves enabled unset for a normal seat', () => {
    const seats = externalSeatsForShare(share({ participants: [participant()] }))
    expect(seats[0]?.enabled).toBeUndefined()
  })
})

describe('resolveChatEffectiveRoster', () => {
  it('composes model seats with a share’s externals', () => {
    const roster = resolveChatEffectiveRoster({
      participants: [modelSeat({ id: 'm1', order: 0 }), modelSeat({ id: 'm2', order: 1 })],
      share: share({
        participants: [
          participant({ collaboratorId: 'c1', displayName: 'Olly' }),
          participant({ collaboratorId: 'c2', displayName: 'Sam', status: 'pending' })
        ]
      }),
      resolvePresence: () => 'live'
    })
    expect(roster.seats.map((seat) => seat.seatId)).toEqual(['m1', 'm2', 'c1'])
    expect(roster.modelSeatCount).toBe(2)
    expect(roster.externalSeatCount).toBe(1)
    expect(roster.presentExternalSeatCount).toBe(1)
  })

  it('is a model-only roster when nothing is shared', () => {
    const roster = resolveChatEffectiveRoster({ participants: [modelSeat({ id: 'm1' })] })
    expect(roster.externalSeatCount).toBe(0)
    expect(roster.presentExternalSeatCount).toBe(0)
    expect(roster.totalSeatCount).toBe(1)
  })

  it('seats an expired external but does not count it as present', () => {
    // It still holds its position until the host removes it; the PANEL predicate
    // keys on presence, so an expired seat must not keep a solo thread looking
    // like a panel forever.
    const roster = resolveChatEffectiveRoster({
      participants: [modelSeat({ id: 'm1' })],
      share: share({ participants: [participant({ collaboratorId: 'c1' })] }),
      resolvePresence: () => 'expired'
    })
    expect(roster.externalSeatCount).toBe(1)
    expect(roster.presentExternalSeatCount).toBe(0)
  })

  it('survives a chat with no model seats at all', () => {
    const roster = resolveChatEffectiveRoster({
      share: share({ participants: [participant({ collaboratorId: 'c1' })] }),
      resolvePresence: () => 'live'
    })
    expect(roster.seats.map((seat) => seat.seatId)).toEqual(['c1'])
    // A panel with an external and no model has no seat that can actually run —
    // callers must read enabledModelSeatCount, not totalSeatCount, for the floor.
    expect(roster.enabledModelSeatCount).toBe(0)
  })
})

describe('hasNonExternalApprovalAuthority', () => {
  const ensemble = (overrides: Record<string, unknown> = {}) => ({
    bossmanParticipantId: 'boss',
    ...overrides
  })

  it('REFUSES when the external seat set is unknown', () => {
    // The whole point of the gate is to stop recorded consent elevating when
    // every configured authority is an external human. If we cannot enumerate
    // externals we cannot prove any authority is NOT one, so the only honest
    // answer is "no non-external authority" — both callers use `true` to PERMIT
    // (an unattended auto-approval, and the enable door for auto-approvals), so
    // answering `true` here auto-approves on the strength of an authority
    // nobody verified.
    expect(hasNonExternalApprovalAuthority({ ensemble: ensemble(), externalSeatIds: null })).toBe(
      false
    )
  })

  it('allows a real non-external Boss once the external set is known', () => {
    expect(hasNonExternalApprovalAuthority({ ensemble: ensemble(), externalSeatIds: [] })).toBe(
      true
    )
  })

  it('refuses when every configured authority is external', () => {
    expect(
      hasNonExternalApprovalAuthority({ ensemble: ensemble(), externalSeatIds: ['boss'] })
    ).toBe(false)
  })

  it('allows when a Captain is non-external even though the Boss is external', () => {
    expect(
      hasNonExternalApprovalAuthority({
        ensemble: ensemble({ captainParticipantIds: ['captain'] }),
        externalSeatIds: ['boss']
      })
    ).toBe(true)
  })

  it('accepts secondInCommand as the captain fallback seat', () => {
    expect(
      hasNonExternalApprovalAuthority({
        ensemble: ensemble({ secondInCommandParticipantId: 'second' }),
        externalSeatIds: ['boss']
      })
    ).toBe(true)
  })

  it('refuses without a configured Boss, and refuses a missing ensemble', () => {
    expect(hasNonExternalApprovalAuthority({ ensemble: {}, externalSeatIds: [] })).toBe(false)
    expect(hasNonExternalApprovalAuthority({ ensemble: null, externalSeatIds: [] })).toBe(false)
  })
})
