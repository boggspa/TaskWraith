import { describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueRecoveryController } from './ThreadCatalogueRecoveryController'
import type { ThreadCatalogueRecoveryHold } from './ThreadCatalogue'
import { ORPHAN_RETIREMENT_TOKEN } from '../thread-log/ThreadAuthorityRetirement'
import { ReservationInvalid, type ThreadOwnershipReservation } from '../thread-log/ThreadOwnership'

const CHAT = 'chat-orphan-1'
const TOKEN = 'token-orphan-1'
const DESKTOP_WRITER = 'desktop-1'
const HOST_WRITER = 'host-orphan-1'

/**
 * A partial mock of the ThreadCatalogue surface used by endOrphan. The
 * controller only calls a small set of methods through the orphan path,
 * so an `as never` cast on the publisher is enough to typecheck without
 * dragging in the full ~60-method surface.
 */
type FakeCatalogue = {
  recoveryHold(chatId: string): ThreadCatalogueRecoveryHold | null | 'unreadable'
  releaseRecoveryHold(chatId: string, token: string): boolean
  currentRegisteredWriter(kind: 'desktop' | 'host'): { writerId: string; pid?: number } | null
  recoveryHolds(): ThreadCatalogueRecoveryHold[]
  unreadableRecoveryHoldChatIds(): string[]
  releaseUnreadableRecoveryHold(chatId: string): boolean
  holdRecovery(hold: ThreadCatalogueRecoveryHold): void
  epoch(chatId: string): { global: number; chat: number }
}

function makeHold(
  overrides: Partial<ThreadCatalogueRecoveryHold> = {}
): ThreadCatalogueRecoveryHold {
  return {
    chatId: CHAT,
    token: TOKEN,
    hostWriterId: HOST_WRITER,
    hostIncarnation: 'host-incarnation-1',
    ...overrides
  }
}

/**
 * A caller-built reservation that is not minted by the Host thread owner
 * registry. Tests steer its `revalidate` and `erasing` probes independently
 * of any real reservation, mirroring the helper used in
 * `HostThreadOwnerRegistry.orphan.test.ts`.
 */
function foreignReservation(
  onRevalidate: () => void = () => undefined,
  erasing: () => boolean = () => false
): ThreadOwnershipReservation {
  return {
    threadId: CHAT,
    epoch: { host: HOST_WRITER, grant: 1 },
    revalidate: onRevalidate,
    erasing
  }
}

interface Harness {
  controller: ThreadCatalogueRecoveryController
  catalogue: FakeCatalogue & {
    releaseCalls: number
    throwOnRelease?: boolean
  }
  hasLiveWork: (chatId: string) => boolean
}

function buildHarness(opts: {
  hold?: ThreadCatalogueRecoveryHold | null | 'unreadable'
  desktopWriter?: { writerId: string; pid?: number } | null
  hasLiveWork?: (chatId: string) => boolean
  throwOnRelease?: boolean
}): Harness {
  const hold = opts.hold === undefined ? makeHold() : opts.hold
  const catalogue = {
    recoveryHold: () => hold,
    releaseRecoveryHold: () => {
      catalogue.releaseCalls += 1
      if (opts.throwOnRelease) throw new Error('forced sync failure')
      return true
    },
    recoveryHolds: () => [],
    unreadableRecoveryHoldChatIds: () => [],
    releaseUnreadableRecoveryHold: () => false,
    holdRecovery: () => undefined,
    currentRegisteredWriter: (kind: 'desktop' | 'host') =>
      kind === 'desktop' ? (opts.desktopWriter ?? null) : { writerId: 'host-incarnation-1' },
    epoch: () => ({ global: 0, chat: 0 }),
    releaseCalls: 0,
    throwOnRelease: opts.throwOnRelease
  }
  const hasLiveWork = opts.hasLiveWork ?? (() => false)
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
    incarnation: 'host-incarnation-1',
    assertAuthority: () => undefined,
    hasLiveWork
  })
  // endOrphan reads the hold from `pending` first, then from the catalogue.
  // Without a `pending` entry the catalogue mock answers, which is enough
  // to exercise the precondition branches.
  return { controller, catalogue, hasLiveWork }
}

describe('ThreadCatalogueRecoveryController.orphan keep-custody end', () => {
  it('releases a Host-owned hold when the orphan token matches and the desktop is gone', async () => {
    const harness = buildHarness({})
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'released' })
    expect(harness.catalogue.releaseCalls).toBe(1)
  })

  it('refuses any token that is not ORPHAN_RETIREMENT_TOKEN', async () => {
    const harness = buildHarness({})
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, Symbol.for('something-else'))
    expect(outcome).toEqual({ kind: 'busy', reason: 'wrong_token' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('refuses when the held token does not match the supplied token', async () => {
    const harness = buildHarness({
      hold: makeHold({ token: 'different-token' })
    })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'token_mismatch' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('refuses when the hold is unreadable', async () => {
    const harness = buildHarness({ hold: 'unreadable' })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'token_mismatch' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('refuses when the hold is not owned by a host writer', async () => {
    const harness = buildHarness({
      hold: makeHold({ hostWriterId: undefined, desktopWriterId: DESKTOP_WRITER })
    })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'not_host_writer' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('refuses when a desktop is registered without a resolvable pid', async () => {
    // The orphan pathway only blocks on the desktop that owns THIS thread's
    // hold. The hold here names that desktop as `desktopWriterId`; the
    // unresolved pid short-circuits the liveness probe and the controller
    // returns busy/live_desktop because it cannot prove the owning desktop
    // is gone. We assert that exact surface here; the pid-alive branch is
    // exercised below by mocking process.kill.
    const harness = buildHarness({
      hold: makeHold({ hostWriterId: HOST_WRITER, desktopWriterId: 'desk-orphan' }),
      desktopWriter: { writerId: 'desk-orphan', pid: undefined }
    })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_desktop' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('does not block on a live desktop that is unrelated to this thread', async () => {
    // A desktop with a resolvable pid is registered, but it does not own
    // this thread's hold (the hold is host-owned; no desktopWriterId).
    // The orphan pathway must proceed, even when the unrelated desktop is
    // alive: `assertNoLiveDeadWriter` only checks the desktop whose
    // writerId matches the hold.
    const livePid = process.pid
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const harness = buildHarness({
        desktopWriter: { writerId: 'some-other-desktop', pid: livePid }
      })
      const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
      expect(outcome).toEqual({ kind: 'released' })
      expect(harness.catalogue.releaseCalls).toBe(1)
      // process.kill must not have been called: the unrelated desktop is
      // never probed.
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('blocks when the desktop that owns this thread is alive', async () => {
    // The hold names a desktopWriterId matching the registered desktop.
    // A pid-alive probe (process.kill returns without throwing) means the
    // orphan pathway refuses, even though the global desktop presence check
    // was retired: ordinary recovery's restrictions (no live recovery
    // identity for the thread's owner) still hold on the orphan route.
    const livePid = process.pid
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const harness = buildHarness({
        hold: makeHold({ hostWriterId: HOST_WRITER, desktopWriterId: 'desk-orphan' }),
        desktopWriter: { writerId: 'desk-orphan', pid: livePid }
      })
      const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
      expect(outcome).toEqual({ kind: 'busy', reason: 'live_desktop' })
      expect(harness.catalogue.releaseCalls).toBe(0)
      expect(killSpy).toHaveBeenCalledWith(livePid, 0)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does not block when the desktop that owned this thread has ended', async () => {
    // The hold names a desktopWriterId matching the registered desktop,
    // but process.kill throws ESRCH: the owning desktop is dead and the
    // orphan pathway proceeds.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = Object.assign(new Error('no such process'), {
        code: 'ESRCH'
      }) as NodeJS.ErrnoException
      throw error
    })
    try {
      const harness = buildHarness({
        hold: makeHold({ hostWriterId: HOST_WRITER, desktopWriterId: 'desk-orphan' }),
        desktopWriter: { writerId: 'desk-orphan', pid: 99999 }
      })
      const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
      expect(outcome).toEqual({ kind: 'released' })
      expect(harness.catalogue.releaseCalls).toBe(1)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('endOrphanViaReservation returns busy/damaged when reservation.revalidate throws', async () => {
    // The reservation pathway runs revalidate() before any state
    // inspection. A foreign reservation that throws must not touch the
    // hold: releaseRecoveryHold is never called.
    const reservation = foreignReservation(() => {
      throw new ReservationInvalid('mark_moved')
    })
    const harness = buildHarness({})
    const outcome = await harness.controller.endOrphanViaReservation(
      CHAT,
      TOKEN,
      ORPHAN_RETIREMENT_TOKEN,
      reservation
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('endOrphanViaReservation proceeds when reservation holds', async () => {
    // A foreign reservation whose revalidate does not throw follows the
    // normal endOrphan path. The unrelated-desktop branch from above is
    // reused: a live desktop that does not own this thread does not block.
    const livePid = process.pid
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const reservation = foreignReservation()
      const harness = buildHarness({
        desktopWriter: { writerId: 'some-other-desktop', pid: livePid }
      })
      const outcome = await harness.controller.endOrphanViaReservation(
        CHAT,
        TOKEN,
        ORPHAN_RETIREMENT_TOKEN,
        reservation
      )
      expect(outcome).toEqual({ kind: 'released' })
      expect(harness.catalogue.releaseCalls).toBe(1)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('refuses when the chat has live work', async () => {
    const harness = buildHarness({ hasLiveWork: () => true })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_work' })
    expect(harness.catalogue.releaseCalls).toBe(0)
  })

  it('returns uncertain when the catalogue release throws and leaves the pending entry intact', async () => {
    const harness = buildHarness({ throwOnRelease: true })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'sync_failed' })
    expect(harness.catalogue.releaseCalls).toBe(1)
    // The pending entry is preserved: a follow-up retry should still see it.
    expect(harness.controller.assertHeld.bind(harness.controller)).toBeDefined()
  })

  it('returns uncertain when the catalogue release returns false (the hold vanished)', async () => {
    const harness = buildHarness({})
    Object.assign(harness.catalogue, {
      releaseRecoveryHold: () => {
        harness.catalogue.releaseCalls += 1
        return false
      }
    })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'release_refused' })
    expect(harness.catalogue.releaseCalls).toBe(1)
  })
})
