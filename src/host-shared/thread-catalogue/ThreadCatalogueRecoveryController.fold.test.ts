import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueRecoveryController } from './ThreadCatalogueRecoveryController'
import { adoptFoldedThreadRecord, type FoldedAdoptionGuard } from './ThreadCatalogueAdoption'
import type { ThreadCatalogueRecoveryHold } from './ThreadCatalogue'
import { ReservationInvalid, type ThreadOwnershipReservation } from '../thread-log/ThreadOwnership'
import type { FoldedLogOutcome } from '../../shared/threadCatalogueTypes'

// The adoption itself is covered against real files in ThreadCatalogueAdoption.fold.test.ts.
// Here it is a probe: what the controller hands it, and what it does with the result.
vi.mock('./ThreadCatalogueAdoption', () => ({
  adoptFoldedThreadRecord: vi.fn(),
  adoptPreparedThreadRecord: vi.fn()
}))

const CHAT = 'chat-fold-1'
const TOKEN = 'token-fold-1'
const FOLD_ID = 'fold-id-1'
const HOST_WRITER = 'host-fold-1'
const INCARNATION = 'host-incarnation-1'
const EPOCH = { global: 'g', chat: 'c' }

const FOLD = {
  foldId: FOLD_ID,
  chatId: CHAT,
  epoch: EPOCH,
  sourceWitness: 'w'.repeat(64),
  headRevision: 9,
  updatedAt: '2026-05-01T00:00:00.000Z',
  projection: { revision: 9 }
} as unknown as FoldedLogOutcome

function makeHold(
  overrides: Partial<ThreadCatalogueRecoveryHold> = {}
): ThreadCatalogueRecoveryHold {
  return {
    chatId: CHAT,
    token: TOKEN,
    hostWriterId: HOST_WRITER,
    hostIncarnation: INCARNATION,
    ...overrides
  }
}

function reservation(onRevalidate: () => void = () => undefined): ThreadOwnershipReservation {
  return {
    threadId: CHAT,
    epoch: { host: HOST_WRITER, grant: 1 },
    revalidate: onRevalidate,
    erasing: () => false
  }
}

function build(
  opts: {
    hold?: ThreadCatalogueRecoveryHold | null | 'unreadable'
    desktopWriter?: { writerId: string; pid?: number } | null
    hasLiveWork?: boolean
    owns?: boolean
    fold?: FoldedLogOutcome | null
    epoch?: { global: string; chat: string }
  } = {}
) {
  const hold = opts.hold === undefined ? makeHold() : opts.hold
  const queries: Array<{ method: string }> = []
  const publisher = {
    catalogue: {
      recoveryHold: () => hold,
      recoveryHolds: () => [],
      unreadableRecoveryHoldChatIds: () => [],
      releaseUnreadableRecoveryHold: () => false,
      releaseRecoveryHold: () => true,
      holdRecovery: () => undefined,
      currentRegisteredWriter: (kind: 'desktop' | 'host') =>
        kind === 'desktop' ? (opts.desktopWriter ?? null) : { writerId: INCARNATION },
      epoch: () => opts.epoch ?? EPOCH
    },
    begin: vi.fn(() => ({ ticket: true })),
    finishProjection: vi.fn(),
    fail: vi.fn(),
    canRecover: () => true
  }
  const onAdopted = vi.fn()
  const controller = new ThreadCatalogueRecoveryController({
    client: {
      query: (async (query: { method: string }) => {
        queries.push(query)
        if (query.method === 'folded') return opts.fold === undefined ? FOLD : opts.fold
        return true
      }) as never
    },
    publisher: publisher as never,
    reader: { profilePath: '/profile' } as never,
    incarnation: INCARNATION,
    assertAuthority: () => undefined,
    hasLiveWork: () => opts.hasLiveWork ?? false,
    ownsReservation: () => opts.owns ?? true,
    onAdopted
  })
  return { controller, publisher, queries, onAdopted }
}

const lastGuard = (): FoldedAdoptionGuard =>
  vi.mocked(adoptFoldedThreadRecord).mock.calls.at(-1)![2]

afterEach(() => {
  vi.mocked(adoptFoldedThreadRecord).mockReset()
  vi.restoreAllMocks()
})

describe('ThreadCatalogueRecoveryController.adoptViaFold', () => {
  it('adopts the fetched fold under a valid reservation and hold', async () => {
    const harness = build()
    const outcome = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(outcome).toEqual({ kind: 'adopted', projection: FOLD.projection })
    expect(harness.publisher.begin).toHaveBeenCalledWith(CHAT, TOKEN)
    expect(adoptFoldedThreadRecord).toHaveBeenCalledWith(
      expect.anything(),
      FOLD,
      expect.any(Object)
    )
    expect(harness.publisher.finishProjection).toHaveBeenCalledWith(
      { ticket: true },
      FOLD.projection
    )
    expect(harness.publisher.fail).not.toHaveBeenCalled()
    expect(harness.onAdopted).toHaveBeenCalledWith(CHAT)
    expect(harness.queries.map((query) => query.method)).toEqual(['folded', 'discard-folded'])
  })

  it('refuses a reservation the owner registry did not mint, before any query', async () => {
    const harness = build({ owns: false })
    const outcome = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(harness.queries).toEqual([])
    expect(harness.publisher.begin).not.toHaveBeenCalled()
  })

  it('returns busy/damaged without querying when the reservation no longer validates', async () => {
    const harness = build()
    const outcome = await harness.controller.adoptViaFold(
      CHAT,
      TOKEN,
      FOLD_ID,
      reservation(() => {
        throw new ReservationInvalid('mark_moved')
      })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(harness.queries).toEqual([])
    expect(adoptFoldedThreadRecord).not.toHaveBeenCalled()
  })

  it('blocks while the desktop that owns this thread is alive', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const harness = build({
      hold: makeHold({ desktopWriterId: 'desk-fold' }),
      desktopWriter: { writerId: 'desk-fold', pid: process.pid }
    })
    const outcome = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_desktop' })
    expect(adoptFoldedThreadRecord).not.toHaveBeenCalled()
    expect(harness.publisher.begin).not.toHaveBeenCalled()
  })

  it('is not blocked by an unrelated live desktop', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const harness = build({
      hold: makeHold({ desktopWriterId: 'desk-fold' }),
      desktopWriter: { writerId: 'someone-else', pid: process.pid }
    })
    const outcome = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(outcome.kind).toBe('adopted')
  })

  it.each([
    ['a different token', { hold: makeHold({ token: 'other' }) }, 'token_mismatch'],
    ['an unreadable hold', { hold: 'unreadable' as const }, 'token_mismatch'],
    [
      'a hold a desktop owns',
      { hold: makeHold({ hostWriterId: undefined, desktopWriterId: 'd' }) },
      'not_host_writer'
    ],
    [
      'a hold from another incarnation',
      { hold: makeHold({ hostIncarnation: 'older' }) },
      'token_mismatch'
    ],
    ['live work on the thread', { hasLiveWork: true }, 'live_work'],
    ['a fold the worker no longer holds', { fold: null }, 'fold_unavailable'],
    [
      'a fold for another thread',
      { fold: { ...FOLD, chatId: 'other' } as FoldedLogOutcome },
      'fold_unavailable'
    ]
  ])('is busy for %s and adopts nothing', async (_name, opts, reason) => {
    const harness = build(opts)
    const outcome = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(outcome).toEqual({ kind: 'busy', reason })
    expect(adoptFoldedThreadRecord).not.toHaveBeenCalled()
    expect(harness.publisher.begin).not.toHaveBeenCalled()
  })

  it('maps a reservation that lapses during adoption to busy/damaged and fails the ticket', async () => {
    let valid = true
    const harness = build()
    vi.mocked(adoptFoldedThreadRecord).mockImplementation((_options, _fold, guard) => {
      valid = false
      guard.authority()
    })
    const outcome = await harness.controller.adoptViaFold(
      CHAT,
      TOKEN,
      FOLD_ID,
      reservation(() => {
        if (!valid) throw new ReservationInvalid('writer_alive')
      })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(harness.publisher.fail).toHaveBeenCalledWith({ ticket: true })
    expect(harness.publisher.finishProjection).not.toHaveBeenCalled()
    expect(harness.queries.map((query) => query.method)).toEqual(['folded'])
  })

  it('fails the ticket and rethrows when adoption itself throws', async () => {
    const harness = build()
    vi.mocked(adoptFoldedThreadRecord).mockImplementation(() => {
      throw new Error('History changed before recovery')
    })
    await expect(
      harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    ).rejects.toThrow('History changed before recovery')
    expect(harness.publisher.fail).toHaveBeenCalledOnce()
    expect(harness.publisher.finishProjection).not.toHaveBeenCalled()
    expect(harness.onAdopted).not.toHaveBeenCalled()
  })

  it('answers a repeated adoption of the same fold from its record, not a second adoption', async () => {
    const harness = build()
    await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    const again = await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
    expect(again).toEqual({ kind: 'adopted', projection: FOLD.projection })
    expect(adoptFoldedThreadRecord).toHaveBeenCalledOnce()
  })

  describe('the guard it hands to adoption', () => {
    async function guardFor(epoch = EPOCH): Promise<FoldedAdoptionGuard> {
      const harness = build({ epoch })
      await harness.controller.adoptViaFold(CHAT, TOKEN, FOLD_ID, reservation())
      return lastGuard()
    }

    it('accepts the values the fold promised', async () => {
      const guard = await guardFor()
      expect(() => {
        guard.authority()
        guard.epoch(EPOCH)
        guard.witness(FOLD.sourceWitness)
        guard.headRevision(FOLD.headRevision)
        guard.updatedAt(FOLD.updatedAt)
      }).not.toThrow()
    })

    it('rejects a moved head, a different timestamp, a changed witness and an erased epoch', async () => {
      const guard = await guardFor({ global: 'g', chat: 'newer' })
      expect(() => guard.headRevision(FOLD.headRevision + 1)).toThrow(/head/)
      expect(() => guard.updatedAt('2026-05-01T00:00:01.000Z')).toThrow(/timestamp/)
      expect(() => guard.witness('x'.repeat(64))).toThrow(/changed/)
      expect(() => guard.epoch(EPOCH)).toThrow(/erased/)
    })
  })
})
