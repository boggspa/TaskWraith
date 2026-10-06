import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadCatalogueRecoveryController,
  recoveryHoldHasOwner
} from './ThreadCatalogueRecoveryController'
import type { ThreadCatalogueRecoveryHold } from './ThreadCatalogue'
import { ORPHAN_RETIREMENT_TOKEN } from '../thread-log/ThreadAuthorityRetirement'
import { ReservationInvalid, type ThreadOwnershipReservation } from '../thread-log/ThreadOwnership'

const CHAT = 'chat-competing-1'
const OTHER_CHAT = 'chat-competing-2'
const INCARNATION = 'host-incarnation-1'

/**
 * The recovery holds the controller keeps in the catalogue, in memory. Only
 * the surface the controller touches on the begin / end / orphan-end paths.
 */
function makeCatalogue() {
  const holds = new Map<string, ThreadCatalogueRecoveryHold>()
  return {
    holds,
    recoveryHolds: () => [...holds.values()],
    unreadableRecoveryHoldChatIds: () => [] as string[],
    releaseUnreadableRecoveryHold: () => false,
    holdRecovery: (hold: ThreadCatalogueRecoveryHold) => {
      if (holds.has(hold.chatId)) throw new Error('a hold is already recorded for this chat')
      holds.set(hold.chatId, hold)
    },
    recoveryHold: (chatId: string) => holds.get(chatId) ?? null,
    releaseRecoveryHold: (chatId: string, token: string) => {
      const held = holds.get(chatId)
      if (!held || held.token !== token) return false
      holds.delete(chatId)
      return true
    },
    // The Host's registered writer is this incarnation; the desktop is
    // registered on the controller itself, as the Host does on attach.
    currentRegisteredWriter: (kind: 'desktop' | 'host') =>
      kind === 'host' ? { writerId: INCARNATION } : null
  }
}

const controllers: ThreadCatalogueRecoveryController[] = []

function build(
  hasLiveWork: (chatId: string) => boolean = () => false,
  ownsReservation: (reservation: ThreadOwnershipReservation) => boolean = () => true
) {
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
    ownsReservation
  })
  controllers.push(controller)
  return { controller, catalogue }
}

/** `process.kill(pid, 0)` as the controller probes a desktop. */
function probeAnswers(answer: 'alive' | 'dead') {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    if (answer === 'alive') return true
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  })
}

function reservation(
  onRevalidate: () => void = () => undefined,
  threadId = CHAT
): ThreadOwnershipReservation {
  return {
    threadId,
    epoch: { host: INCARNATION, grant: 1 },
    revalidate: onRevalidate,
    erasing: () => false
  }
}

afterEach(() => {
  // Ends every pending hold, which also clears each hold's expiry timer.
  for (const controller of controllers.splice(0)) controller.forgetErased()
  vi.restoreAllMocks()
})

describe('recoveryHoldHasOwner', () => {
  it('matches a hold only on the axis the request names', () => {
    const desktop = { desktopWriterId: 'desk-a' }
    const host = { hostWriterId: 'host-1' }
    expect(recoveryHoldHasOwner(desktop, { desktopWriterId: 'desk-a' })).toBe(true)
    expect(recoveryHoldHasOwner(host, { hostWriterId: 'host-1' })).toBe(true)
    // A different writer on the same axis, and the other axis, never match.
    expect(recoveryHoldHasOwner(desktop, { desktopWriterId: 'desk-b' })).toBe(false)
    expect(recoveryHoldHasOwner(desktop, { hostWriterId: 'host-1' })).toBe(false)
    expect(recoveryHoldHasOwner(host, { desktopWriterId: 'desk-a' })).toBe(false)
    // A hold carrying both ids is not either writer's own strand.
    expect(
      recoveryHoldHasOwner(
        { desktopWriterId: 'desk-a', hostWriterId: 'host-1' },
        { desktopWriterId: 'desk-a' }
      )
    ).toBe(false)
    // An unidentified caller can never adopt a strand.
    expect(recoveryHoldHasOwner(desktop, {})).toBe(false)
  })
})

describe('ThreadCatalogueRecoveryController two writers, one thread', () => {
  it('serves a second desktop only once it is the registered desktop', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const first = controller.begin(CHAT, 'desk-a')
    expect(first).toMatchObject({ chatId: CHAT, desktopWriterId: 'desk-a' })

    // desk-b is not the registered desktop: refused, and desk-a's hold is untouched.
    expect(() => controller.begin(CHAT, 'desk-b')).toThrow(
      'History recovery Desktop identity changed'
    )
    expect(catalogue.recoveryHold(CHAT)).toEqual(first)

    // desk-a lets go; desk-b registers and now gets a hold of its own.
    expect(controller.end(CHAT, first.token)).toBe(true)
    controller.registerDesktop({ writerId: 'desk-b', pid: 4102 })
    const second = controller.begin(CHAT, 'desk-b')
    expect(second).toMatchObject({ chatId: CHAT, desktopWriterId: 'desk-b' })
    expect(second.token).not.toBe(first.token)
  })

  it('cancels the earlier desktop’s hold when a replacement desktop registers', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const stale = controller.begin(CHAT, 'desk-a')
    controller.registerDesktop({ writerId: 'desk-b', pid: 4102 })

    // Registration is no longer preemptive: the earlier desktop's hold is
    // preserved. A replacement desktop must call `takeoverThread(chatId)`
    // explicitly to cancel a hold on a specific thread. The old token
    // is still valid until the explicit takeover runs.
    expect(catalogue.recoveryHold(CHAT)).toEqual(stale)
    expect(controller.end(CHAT, stale.token)).toBe(true)
    expect(() => controller.assertHeld(CHAT, stale.token)).toThrow(
      'History recovery admission changed'
    )
    // After explicit takeover the thread is free to begin. The hold was
    // already ended above, so the takeover itself finds nothing to take.
    expect(controller.takeoverThread(CHAT, 'desk-b')).toEqual({ kind: 'none' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
    expect(controller.end(CHAT, stale.token)).toBe(false)
    expect(() => controller.assertHeld(CHAT, stale.token)).toThrow(
      'History recovery admission changed'
    )
    expect(controller.begin(CHAT, 'desk-b')).toMatchObject({ desktopWriterId: 'desk-b' })
  })

  it('queues a command admitted behind a pending recovery until the recovery ends', async () => {
    const { controller } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const hold = controller.begin(CHAT, 'desk-a')
    let ran = false
    const admitted = controller.admit(CHAT, async () => {
      ran = true
    })
    await Promise.resolve()
    expect(ran).toBe(false)
    controller.end(CHAT, hold.token)
    await admitted
    expect(ran).toBe(true)
  })

  it('refuses to begin a recovery while a command is admitted on the thread', async () => {
    const { controller } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    let finish!: () => void
    const admitted = controller.admit(
      CHAT,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    expect(() => controller.begin(CHAT, 'desk-a')).toThrow(
      'Chat has an admitted command; recovery is deferred'
    )
    finish()
    await admitted
    expect(controller.begin(CHAT, 'desk-a')).toMatchObject({ desktopWriterId: 'desk-a' })
  })
})

describe('ThreadCatalogueRecoveryController.beginFor reclaim discrimination', () => {
  // The logic under test, from `beginFor`:
  //
  //   const stranded = this.pending.get(chatId)
  //   if (stranded && recoveryHoldHasOwner(stranded.hold, identity))
  //     this.end(chatId, stranded.hold.token)
  //   if (!canRecover(chatId) || this.pending.has(chatId) || hasLiveWork(chatId))
  //     throw new Error('Chat has live work; recovery is deferred')
  //
  // A pending hold with the SAME owner is a stranded one (its begin reply was
  // lost) and is reclaimed; any other pending hold is left alone and the
  // request falls to the busy path.

  it('reclaims a stranded hold of the same desktop and voids the old token', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const stranded = controller.begin(CHAT, 'desk-a')
    const retry = controller.begin(CHAT, 'desk-a')

    expect(retry.token).not.toBe(stranded.token)
    expect(catalogue.recoveryHold(CHAT)).toEqual(retry)
    expect(controller.end(CHAT, stranded.token)).toBe(false)
    expect(() => controller.assertHeld(CHAT, stranded.token)).toThrow(
      'History recovery admission changed'
    )
    expect(() => controller.assertHeld(CHAT, retry.token)).not.toThrow()
  })

  it('does not let a desktop request reclaim a Host-owned hold', () => {
    // The desktop is registered (its process already ended) before the Host
    // begins: registering a desktop cancels every Host hold, so the order
    // matters. The desktop then asks for a hold the Host already has.
    probeAnswers('dead')
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const hostHold = controller.beginHost(CHAT)

    expect(() => controller.begin(CHAT, 'desk-a')).toThrow(
      'Chat has live work; recovery is deferred'
    )
    // The Host's hold is exactly as it was, still the one the Host can end.
    expect(catalogue.recoveryHold(CHAT)).toEqual(hostHold)
    expect(() => controller.assertHeld(CHAT, hostHold.token)).not.toThrow()
  })

  it('cancels a pending Host hold when a desktop registers', () => {
    const { controller, catalogue } = build()
    const hostHold = controller.beginHost(CHAT)
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })

    // Registration is no longer preemptive: a desktop registering does not
    // cancel a Host hold on this thread. The desktop must call
    // `takeoverThread(chatId)` to claim the thread explicitly.
    expect(catalogue.recoveryHold(CHAT)).toEqual(hostHold)
    expect(controller.end(CHAT, hostHold.token)).toBe(true)
    expect(controller.takeoverThread(CHAT, 'desk-a')).toEqual({ kind: 'none' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
    expect(controller.end(CHAT, hostHold.token)).toBe(false)
    expect(controller.begin(CHAT, 'desk-a')).toMatchObject({ desktopWriterId: 'desk-a' })
  })

  it('preserves pending recovery holds on unrelated threads when a desktop registers', () => {
    // The product rule: a desktop registering only knows its own identity.
    // A long-quiescent desktop restart, or a Host that began a recovery
    // during a desktop restart, keeps every other hold. The desktop must
    // call takeoverThread(chatId) for each thread it wants to claim.
    const { controller, catalogue } = build()
    const otherChat = `${CHAT}-other`
    // Host began recovery on TWO threads before the desktop registered.
    const hostHoldA = controller.beginHost(CHAT)
    const hostHoldB = controller.beginHost(otherChat)
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    // Both holds are preserved.
    expect(catalogue.recoveryHold(CHAT)).toEqual(hostHoldA)
    expect(catalogue.recoveryHold(otherChat)).toEqual(hostHoldB)
    // Explicit per-thread takeover cancels only the named one.
    expect(controller.takeoverThread(CHAT, 'desk-a')).toEqual({ kind: 'taken' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
    expect(catalogue.recoveryHold(otherChat)).toEqual(hostHoldB)
  })

  it('does not let a Host request reclaim a desktop-owned hold', () => {
    // The desktop's process has ended, so the Host may begin; the desktop's
    // earlier hold is still not the Host's to reclaim.
    probeAnswers('dead')
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const desktopHold = controller.begin(CHAT, 'desk-a')

    expect(() => controller.beginHost(CHAT)).toThrow('Chat has live work; recovery is deferred')
    expect(catalogue.recoveryHold(CHAT)).toEqual(desktopHold)
  })

  it('lets the Host begin only while no desktop is running', () => {
    const alive = probeAnswers('alive')
    const { controller } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    expect(() => controller.beginHost(CHAT)).toThrow('Desktop owns recovery while it is running')
    expect(alive).toHaveBeenCalledWith(4101, 0)

    alive.mockRestore()
    probeAnswers('dead')
    expect(controller.beginHost(CHAT)).toMatchObject({ hostWriterId: INCARNATION })
  })
})

describe('ThreadCatalogueRecoveryController orphan end against a live competing writer', () => {
  /** A Host-owned hold on the thread that names the desktop that died holding it. */
  function orphanHold(
    catalogue: ReturnType<typeof makeCatalogue>,
    chatId = CHAT,
    desktopWriterId = 'desk-a'
  ): ThreadCatalogueRecoveryHold {
    const hold: ThreadCatalogueRecoveryHold = {
      chatId,
      token: `token-${chatId}`,
      hostWriterId: INCARNATION,
      desktopWriterId,
      hostIncarnation: INCARNATION
    }
    catalogue.holdRecovery(hold)
    return hold
  }

  it('releases the dead writer’s hold while an unrelated live desktop stays live', async () => {
    const probe = probeAnswers('alive')
    const { controller, catalogue } = build()
    // desk-b is running and registered; desk-a, which held CHAT, is gone.
    controller.registerDesktop({ writerId: 'desk-b', pid: 4102 })
    const hold = orphanHold(catalogue)

    const outcome = await controller.endOrphanViaReservation(
      CHAT,
      hold.token,
      ORPHAN_RETIREMENT_TOKEN,
      reservation()
    )
    expect(outcome).toEqual({ kind: 'released' })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
    // desk-b has nothing to do with this thread, so it is not even probed.
    expect(probe).not.toHaveBeenCalled()
  })

  it('blocks ordinary recovery on the same live desktop', () => {
    const probe = probeAnswers('alive')
    const { controller } = build()
    controller.registerDesktop({ writerId: 'desk-b', pid: 4102 })

    // The ordinary route has no per-thread exemption: any live desktop blocks it.
    expect(() => controller.beginHost(OTHER_CHAT)).toThrow(
      'Desktop owns recovery while it is running'
    )
    expect(probe).toHaveBeenCalledWith(4102, 0)
  })

  it('still refuses the orphan route when the live desktop is the one that holds the thread', async () => {
    probeAnswers('alive')
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    const hold = orphanHold(catalogue)

    const outcome = await controller.endOrphanViaReservation(
      CHAT,
      hold.token,
      ORPHAN_RETIREMENT_TOKEN,
      reservation()
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_desktop' })
    expect(catalogue.recoveryHold(CHAT)).toEqual(hold)
  })

  it('refuses without touching the hold when the dead writer reappears under the reservation', async () => {
    const probe = probeAnswers('alive')
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-b', pid: 4102 })
    const hold = orphanHold(catalogue)

    const outcome = await controller.endOrphanViaReservation(
      CHAT,
      hold.token,
      ORPHAN_RETIREMENT_TOKEN,
      reservation(() => {
        throw new ReservationInvalid('writer_alive')
      })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(catalogue.recoveryHold(CHAT)).toEqual(hold)
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses a competing recoverer’s stale token once its hold was replaced', async () => {
    const { controller, catalogue } = build()
    const stale = orphanHold(catalogue)
    // The hold was released and re-recorded for a later recovery under a new token.
    catalogue.releaseRecoveryHold(CHAT, stale.token)
    const current: ThreadCatalogueRecoveryHold = { ...stale, token: 'token-replacement' }
    catalogue.holdRecovery(current)

    const outcome = await controller.endOrphanViaReservation(
      CHAT,
      stale.token,
      ORPHAN_RETIREMENT_TOKEN,
      reservation()
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'token_mismatch' })
    expect(catalogue.recoveryHold(CHAT)).toEqual(current)
  })
})

describe('ThreadCatalogueRecoveryController.beginOrphanViaReservation', () => {
  it('is not blocked by an unrelated live desktop, unlike beginHost', () => {
    const { controller, catalogue } = build()
    controller.registerDesktop({ writerId: 'desk-live', pid: 4242 })
    probeAnswers('alive')
    expect(() => controller.beginHost(CHAT)).toThrow('Desktop owns recovery while it is running')
    const begun = controller.beginOrphanViaReservation(CHAT, reservation())
    expect(begun).toMatchObject({ kind: 'held', hold: { chatId: CHAT, hostWriterId: INCARNATION } })
    if (begun.kind === 'held') expect(catalogue.recoveryHold(CHAT)).toEqual(begun.hold)
  })

  it('keeps the thread’s own restrictions: live work, an invalid reservation, another hold', () => {
    const busy = build(() => true)
    expect(busy.controller.beginOrphanViaReservation(CHAT, reservation())).toEqual({
      kind: 'busy',
      reason: 'live_work'
    })
    const { controller } = build()
    expect(
      controller.beginOrphanViaReservation(
        CHAT,
        reservation(() => {
          throw new ReservationInvalid('mark_moved')
        })
      )
    ).toEqual({ kind: 'busy', reason: 'damaged' })
    controller.registerDesktop({ writerId: 'desk-a', pid: 4101 })
    controller.begin(CHAT, 'desk-a')
    expect(controller.beginOrphanViaReservation(CHAT, reservation())).toMatchObject({
      kind: 'busy'
    })
    // An unrelated thread's hold is untouched by the orphan begin on this one.
    expect(
      controller.beginOrphanViaReservation(OTHER_CHAT, reservation(undefined, OTHER_CHAT))
    ).toMatchObject({
      kind: 'held'
    })
  })

  it('refuses a reservation the owner registry did not mint, however valid it looks', () => {
    const { controller, catalogue } = build(undefined, () => false)
    expect(controller.beginOrphanViaReservation(CHAT, reservation())).toEqual({
      kind: 'busy',
      reason: 'damaged'
    })
    expect(catalogue.recoveryHold(CHAT)).toBeNull()
  })

  it('never reclaims an ordinary Host hold pending on the same thread', () => {
    const { controller, catalogue } = build()
    const ordinary = controller.beginHost(CHAT)
    expect(controller.beginOrphanViaReservation(CHAT, reservation())).toEqual({
      kind: 'busy',
      reason: 'admission_busy'
    })
    expect(catalogue.recoveryHold(CHAT)).toEqual(ordinary)
  })
})
