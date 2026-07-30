import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../main/store/types'
import {
  chatDispatchesAsEnsemble,
  chatPresentsAsPanel,
  externalSeatIds,
  isExternalSeat,
  resolveEffectiveRoster,
  type ExternalSeatInput
} from './effectiveEnsembleRoster'

function seat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: overrides.id ?? 'p1',
    provider: overrides.provider ?? 'claude',
    enabled: overrides.enabled ?? true,
    role: overrides.role ?? 'Builder',
    instructions: overrides.instructions ?? '',
    order: overrides.order ?? 0,
    ...(overrides.model ? { model: overrides.model } : {})
  } as EnsembleParticipant
}

function ext(overrides: Partial<ExternalSeatInput> = {}): ExternalSeatInput {
  return {
    shareId: overrides.shareId ?? 'share-1',
    collaboratorId: overrides.collaboratorId ?? 'c1',
    displayName: overrides.displayName ?? 'Olly',
    ...(overrides.seatOrder !== undefined ? { seatOrder: overrides.seatOrder } : {}),
    ...(overrides.present !== undefined ? { present: overrides.present } : {}),
    ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {})
  }
}

describe('resolveEffectiveRoster', () => {
  it('composes model seats and externals into one ordered roster', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a', order: 1 }), seat({ id: 'b', order: 0 })],
      externals: [ext({ collaboratorId: 'c1', displayName: 'Olly' })]
    })
    expect(roster.seats.map((s) => s.seatId)).toEqual(['b', 'a', 'c1'])
    expect(roster.modelSeatCount).toBe(2)
    expect(roster.externalSeatCount).toBe(1)
    expect(roster.totalSeatCount).toBe(3)
  })

  it('appends an unpositioned external AFTER every model seat, never at the front', () => {
    // An external with no host-set position must not silently pre-empt the
    // panel — order 0 would put a human ahead of every model on turn one.
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a', order: 5 }), seat({ id: 'b', order: 9 })],
      externals: [ext({ collaboratorId: 'c1' }), ext({ collaboratorId: 'c2' })]
    })
    expect(roster.seats.map((s) => s.seatId)).toEqual(['a', 'b', 'c1', 'c2'])
    const orders = roster.seats.map((s) => s.order)
    expect(orders[2]).toBeGreaterThan(9)
    expect(orders[3]).toBeGreaterThan(orders[2] as number)
  })

  it('lets a host-set seatOrder INTERLEAVE an external between model seats', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a', order: 0 }), seat({ id: 'b', order: 2 })],
      externals: [ext({ collaboratorId: 'c1', seatOrder: 1 })]
    })
    expect(roster.seats.map((s) => s.seatId)).toEqual(['a', 'c1', 'b'])
  })

  it('breaks an order tie for the model seat, then stably by id', () => {
    // A render and a turn queue built from the same inputs must never disagree.
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'zz', order: 3 }), seat({ id: 'aa', order: 3 })],
      externals: [ext({ collaboratorId: 'c1', seatOrder: 3 })]
    })
    expect(roster.seats.map((s) => s.seatId)).toEqual(['aa', 'zz', 'c1'])
  })

  it('counts ENABLED model seats separately — that is the real panel floor', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a' }), seat({ id: 'b', enabled: false })],
      externals: [ext({ collaboratorId: 'c1' })]
    })
    expect(roster.modelSeatCount).toBe(2)
    expect(roster.enabledModelSeatCount).toBe(1)
    // A muted seat keeps its position; it is not removed from the roster.
    expect(roster.seats.map((s) => s.seatId)).toContain('b')
  })

  it('tracks PRESENT externals apart from seated ones (grace holds the seat)', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a' })],
      externals: [
        ext({ collaboratorId: 'c1', present: true }),
        ext({ collaboratorId: 'c2', present: false })
      ]
    })
    expect(roster.externalSeatCount).toBe(2)
    expect(roster.presentExternalSeatCount).toBe(1)
    // An expired external still holds its seat until the caller removes it.
    expect(roster.seats.map((s) => s.seatId)).toEqual(['a', 'c1', 'c2'])
  })

  /**
   * SECURITY-SHAPED: a collision means one identity could shadow another. It
   * must be reported, never resolved silently — the authority fields store bare
   * seat ids, so an ambiguous id is an ambiguous authority holder.
   */
  it('refuses an external whose id collides with a model seat, and SAYS SO', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'shared-id' })],
      externals: [ext({ collaboratorId: 'shared-id' }), ext({ collaboratorId: 'c2' })]
    })
    expect(roster.collidedExternalSeatIds).toEqual(['shared-id'])
    expect(roster.externalSeatCount).toBe(1)
    // The incumbent model seat survives and is still a model seat.
    const incumbent = roster.seats.find((s) => s.seatId === 'shared-id')
    expect(incumbent?.kind).toBe('model')
  })

  it('drops duplicate ids within each source without inventing seats', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a' }), seat({ id: 'a', role: 'Dupe' })],
      externals: [ext({ collaboratorId: 'c1' }), ext({ collaboratorId: 'c1' })]
    })
    expect(roster.modelSeatCount).toBe(1)
    expect(roster.externalSeatCount).toBe(1)
    expect(roster.collidedExternalSeatIds).toEqual(['c1'])
  })

  it('survives junk input without throwing', () => {
    expect(resolveEffectiveRoster({}).totalSeatCount).toBe(0)
    expect(resolveEffectiveRoster({ participants: null, externals: null }).seats).toEqual([])
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: '' }), seat({ id: 'a', order: Number.NaN })],
      externals: [ext({ collaboratorId: '' }), ext({ collaboratorId: 'c1', displayName: '   ' })]
    })
    expect(roster.seats.map((s) => s.seatId)).toEqual(['a', 'c1'])
    // A blank display name falls back rather than rendering an empty chip.
    expect(roster.seats.find((s) => s.seatId === 'c1')?.label).toBe('External')
  })

  it('labels a model seat by role, falling back to model then provider', () => {
    const roster = resolveEffectiveRoster({
      participants: [
        seat({ id: 'a', role: 'Reviewer' }),
        seat({ id: 'b', role: '   ', model: 'opus' }),
        seat({ id: 'c', role: '', provider: 'codex' })
      ]
    })
    expect(roster.seats.map((s) => s.label)).toEqual(['Reviewer', 'opus', 'codex'])
  })

  it('exposes external seat ids for permission chokepoints', () => {
    const roster = resolveEffectiveRoster({
      participants: [seat({ id: 'a' })],
      externals: [ext({ collaboratorId: 'c1' }), ext({ collaboratorId: 'c2' })]
    })
    expect(externalSeatIds(roster)).toEqual(['c1', 'c2'])
    expect(roster.seats.filter(isExternalSeat)).toHaveLength(2)
  })
})

describe('chatPresentsAsPanel / chatDispatchesAsEnsemble', () => {
  it('presents as a panel on the persisted kind alone', () => {
    expect(chatPresentsAsPanel({ chatKind: 'ensemble' }, 0)).toBe(true)
    expect(chatPresentsAsPanel({ chatKind: 'single' }, 0)).toBe(false)
  })

  it('presents as a panel for a SHARED solo thread with a live external', () => {
    expect(chatPresentsAsPanel({ chatKind: 'single' }, 1)).toBe(true)
  })

  /**
   * THE LANDMINE THIS PREDICATE EXISTS TO AVOID. `projectChatKind` answers
   * `ensemble?.enabled || participants.length > 0`, and solo records carry STALE
   * `ensemble` blocks (normalizeChatRecord declines to re-add one but never
   * deletes it; only setChatKind strips it). Copying that formula would flip
   * ordinary solo chats — no share, no invite, no external — onto the ensemble
   * lane. This predicate must ignore the ensemble block entirely.
   */
  it('IGNORES a stale ensemble block on a solo record', () => {
    const stale = {
      chatKind: 'single' as const,
      ensemble: { enabled: true, participants: [seat({ id: 'ghost' })] }
    }
    expect(chatPresentsAsPanel(stale, 0)).toBe(false)
    expect(chatDispatchesAsEnsemble(stale)).toBe(false)
  })

  it('dispatches as an ensemble on the persisted kind ONLY — never on an external', () => {
    // A shared solo thread presents as a panel but must keep dispatching solo,
    // or a join would reroute the host's send, Stop and steer.
    expect(chatDispatchesAsEnsemble({ chatKind: 'single' })).toBe(false)
    expect(chatPresentsAsPanel({ chatKind: 'single' }, 2)).toBe(true)
    expect(chatDispatchesAsEnsemble({ chatKind: 'ensemble' })).toBe(true)
  })

  it('handles absent chats', () => {
    expect(chatPresentsAsPanel(null, 3)).toBe(false)
    expect(chatDispatchesAsEnsemble(undefined)).toBe(false)
  })
})
