import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueRecoveryController } from './ThreadCatalogueRecoveryController'
import type { ThreadCatalogueRecoveryHold } from './ThreadCatalogue'
import type { ThreadOwnershipReservation } from '../thread-log/ThreadOwnership'

const CHAT = 'chat-takeover-1'
const OTHER_CHAT = 'chat-takeover-2'
const INCARNATION = 'host-incarnation-takeover'
const DESKTOP = 'desk-takeover-a'
const OTHER_DESKTOP = 'desk-takeover-b'

/**
 * The recovery holds the controller keeps in the catalogue, in memory, plus a
 * set of chats whose durable hold file reads as 'unreadable'. Only the
 * surface the controller touches on the takeover path.
 */
function makeCatalogue() {
  const holds = new Map<string, ThreadCatalogueRecoveryHold>()
  const unreadableChats = new Set<string>()
  return {
    holds,
    unreadableChats,
    recoveryHolds: () => [...holds.values()],
    unreadableRecoveryHoldChatIds: () => [...unreadableChats],
    releaseUnreadableRecoveryHold: (chatId: string) => unreadableChats.delete(chatId),
    holdRecovery: (hold: ThreadCatalogueRecoveryHold) => {
      if (holds.has(hold.chatId)) throw new Error('a hold is already recorded for this chat')
      holds.set(hold.chatId, hold)
    },
    recoveryHold: (chatId: string) =>
      holds.get(chatId) ?? (unreadableChats.has(chatId) ? ('unreadable' as const) : null),
    releaseRecoveryHold: (chatId: string, token: string) => {
      const held = holds.get(chatId)
      if (!held || held.token !== token) return false
      holds.delete(chatId)
      return true
    },
    currentRegisteredWriter: (kind: 'desktop' | 'host') =>
      kind === 'host' ? { writerId: INCARNATION } : null
  }
}

const controllers: ThreadCatalogueRecoveryController[] = []

function build(hasLiveWork: (chatId: string) => boolean = () => false) {
  const catalogue = makeCatalogue()
  const controller = new ThreadCatalogueRecoveryController({
    client: { query: async <T>(): Promise<T> => null as unknown as T },
    publisher: {
      catalogue: catalogue as never,
      begin: () => ({}) as never,
      finishProjection: () => undefined,
      fail: () => undefined,
      canRecover: () => true
    },
    reader: {} as never,
    incarnation: INCARNATION,
    assertAuthority: () => undefined,
    hasLiveWork,
    ownsReservation: () => true
  })
  controllers.push(controller)
  return { controller, catalogue }
}

/** A caller-built reservation, as in the orphan tests: the harness's `ownsReservation` accepts it. */
function reservation(threadId: string): ThreadOwnershipReservation {
  return {
    threadId,
    epoch: { host: INCARNATION, grant: 1 },
    revalidate: () => undefined,
    erasing: () => false
  }
}

afterEach(() => {
  // Ends every pending hold, which also clears each hold's expiry timer.
  for (const controller of controllers.splice(0)) controller.forgetErased()
  vi.restoreAllMocks()
})

describe('ThreadCatalogueRecoveryController authenticated takeover', () => {
  it('refuses with identity_changed and leaves the hold when the caller is not the registered desktop', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    const hold = controller.begin(CHAT, DESKTOP)

    expect(controller.takeoverThread(CHAT, OTHER_DESKTOP)).toEqual({
      kind: 'busy',
      reason: 'identity_changed'
    })
    expect(catalogue.recoveryHold(CHAT)).toEqual(hold)
    // An unidentified caller matches nothing either.
    expect(controller.takeoverThread(CHAT, '')).toEqual({
      kind: 'busy',
      reason: 'identity_changed'
    })
    expect(catalogue.recoveryHold(CHAT)).toEqual(hold)
  })

  it('refuses with live_work and keeps the hold while the chat has live work', () => {
    let liveWork = false
    const { controller, catalogue } = build((chatId) => chatId === CHAT && liveWork)
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    const hold = controller.begin(CHAT, DESKTOP)
    liveWork = true

    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({
      kind: 'busy',
      reason: 'live_work'
    })
    expect(catalogue.recoveryHold(CHAT)).toEqual(hold)
  })

  it('ends the pending hold for exactly the named chat and no other', () => {
    const { controller, catalogue } = build()
    const holdA = controller.beginHost(CHAT)
    const holdB = controller.beginHost(OTHER_CHAT)
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })

    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({ kind: 'taken' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
    expect(controller.end(CHAT, holdA.token)).toBe(false)
    // The unrelated chat's hold is untouched, still the Host's to end.
    expect(catalogue.recoveryHold(OTHER_CHAT)).toEqual(holdB)
    expect(() => controller.assertHeld(OTHER_CHAT, holdB.token)).not.toThrow()
  })

  it('ends a durable-only hold a previous incarnation left on disk', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    // Seeded straight into the catalogue, as a hold file written by an
    // incarnation that no longer runs and was never in this controller's
    // pending map. (The constructor sweep only sees what was on disk before
    // it ran; this strand landed after.)
    const stranded: ThreadCatalogueRecoveryHold = {
      chatId: CHAT,
      hostWriterId: 'host-incarnation-previous',
      hostIncarnation: 'host-incarnation-previous',
      token: 'token-previous-incarnation'
    }
    catalogue.holds.set(CHAT, stranded)

    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({ kind: 'taken' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
  })

  it('refuses with orphan_custody and keeps the hold begun through beginOrphanViaReservation', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    const begun = controller.beginOrphanViaReservation(CHAT, reservation(CHAT))
    if (begun.kind !== 'held') throw new Error(`expected held, got ${begun.reason}`)

    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({
      kind: 'busy',
      reason: 'orphan_custody'
    })
    expect(catalogue.recoveryHold(CHAT)).toEqual(begun.hold)
    expect(controller.end(CHAT, begun.hold.token)).toBe(true)
    // Once the orphan fold itself ended its custody, a takeover finds nothing.
    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({ kind: 'none' })
  })

  it('returns none when no hold is pending or durable', () => {
    const { controller } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({ kind: 'none' })
  })

  it('refuses with unreadable and keeps the file when the durable hold cannot be read', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    catalogue.unreadableChats.add(CHAT)

    expect(controller.takeoverThread(CHAT, DESKTOP)).toEqual({
      kind: 'busy',
      reason: 'unreadable'
    })
    expect(catalogue.unreadableChats.has(CHAT)).toBe(true)
  })
})

describe('ThreadCatalogueRecoveryController hasPendingHold', () => {
  it('is true for an in-memory pending hold and false with no hold at all', () => {
    const { controller } = build()
    controller.registerDesktop({ writerId: DESKTOP, pid: 4101 })
    expect(controller.hasPendingHold(CHAT)).toBe(false)
    const hold = controller.begin(CHAT, DESKTOP)
    expect(controller.hasPendingHold(CHAT)).toBe(true)
    controller.end(CHAT, hold.token)
    expect(controller.hasPendingHold(CHAT)).toBe(false)
  })

  it('is true for a durable-only hold from a previous incarnation', () => {
    const { controller, catalogue } = build()
    catalogue.holds.set(CHAT, {
      chatId: CHAT,
      hostWriterId: 'host-incarnation-previous',
      hostIncarnation: 'host-incarnation-previous',
      token: 'token-previous-incarnation'
    })
    expect(controller.hasPendingHold(CHAT)).toBe(true)
  })

  it('fails closed: an unreadable durable hold counts as pending', () => {
    const { controller, catalogue } = build()
    catalogue.unreadableChats.add(CHAT)
    expect(controller.hasPendingHold(CHAT)).toBe(true)
  })
})
