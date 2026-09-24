import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueSourcePublisher } from '../../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import { THREAD_CATALOGUE_REQUEST_TIMEOUT_MS } from './ThreadCatalogueClient'
import {
  recoveryHoldHasOwner,
  THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS,
  ThreadCatalogueRecoveryController
} from './ThreadCatalogueRecoveryController'

/**
 * The source parent commits every piece of a recovery hold on the begin-recovery
 * REQUEST -- the admission hold, the fsynced hold file and the `pending` entry --
 * and only then replies. When that reply is lost the caller never learns the
 * token, so no `end-recovery` can ever name it, and `ThreadCatalogueWriteGate`
 * queues every command for the chat behind an admission with no timeout and no
 * rejection. `controller.admit` below is the exact seam
 * `HostNodeProductionServer` routes threaded commands through.
 */
describe('a recovery hold whose begin-recovery reply never came back', () => {
  let profile: string
  let assertAuthority: () => void
  let publisher: ThreadCatalogueSourcePublisher
  let controller: ThreadCatalogueRecoveryController

  beforeEach(() => {
    vi.useFakeTimers()
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-catalogue-hold-ttl-'))
    assertAuthority = (): void => {}
    publisher = new ThreadCatalogueSourcePublisher({
      profilePath: profile,
      writer: 'desktop',
      writerId: 'desktop-1',
      segmented: false,
      canWrite: () => true,
      canManageRecoveryHolds: () => true
    })
    controller = new ThreadCatalogueRecoveryController({
      client: { query: async () => null as never },
      publisher,
      reader: { profilePath: profile, runtimeInstanceId: 'desktop-1', segmented: false },
      incarnation: 'desktop-1',
      assertAuthority: () => assertAuthority(),
      hasLiveWork: () => false
    })
  })

  afterEach(() => {
    assertAuthority = (): void => {}
    controller.dispose()
    vi.useRealTimers()
    fs.rmSync(profile, { recursive: true, force: true })
  })

  /** A command that can only run once the chat's admission is released. */
  function queueCommand(chatId: string): { ran: () => boolean; result: Promise<string> } {
    let ran = false
    const result = controller.admit(chatId, async () => {
      ran = true
      return 'committed'
    })
    return { ran: () => ran, result }
  }

  it('releases the admission its wedged commands are queued behind', async () => {
    const hold = controller.begin('chat-1', 'desktop-1')
    expect(publisher.catalogue.recoveryHold('chat-1')).toMatchObject({ token: hold.token })

    const command = queueCommand('chat-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(command.ran()).toBe(false)

    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS)

    await expect(command.result).resolves.toBe('committed')
    expect(publisher.catalogue.recoveryHold('chat-1')).toBeNull()
  })

  it('never expires while token-bearing requests keep naming it', async () => {
    const hold = controller.begin('chat-1', 'desktop-1')
    const command = queueCommand('chat-1')

    // Four requests arriving just inside the budget: far past a single TTL in
    // total, but never a whole TTL of silence.
    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS - 1)
      controller.assertHeld('chat-1', hold.token)
    }
    expect(command.ran()).toBe(false)
    expect(publisher.catalogue.recoveryHold('chat-1')).toMatchObject({ token: hold.token })

    // ...and it is the renewal doing that, not an expiry that never fires.
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS)
    await expect(command.result).resolves.toBe('committed')
    expect(publisher.catalogue.recoveryHold('chat-1')).toBeNull()
  })

  it('is not renewed by a request bearing a token it does not own', async () => {
    controller.begin('chat-1', 'desktop-1')
    const command = queueCommand('chat-1')

    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS - 1)
    // `adopt` renews on arrival, before it has validated anything, so a stale
    // token from a replaced recovery must buy the live hold no time at all.
    await expect(controller.adopt('chat-1', 'not-the-token', 'prepared-1')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1)

    await expect(command.result).resolves.toBe('committed')
    expect(publisher.catalogue.recoveryHold('chat-1')).toBeNull()
  })

  it('re-arms after an expiry that could not complete', async () => {
    const hold = controller.begin('chat-1', 'desktop-1')
    const command = queueCommand('chat-1')

    // Profile authority in flux: `end` throws straight out of the timer.
    assertAuthority = (): void => {
      throw new Error('History profile authority is unavailable')
    }
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS)
    expect(command.ran()).toBe(false)
    expect(publisher.catalogue.recoveryHold('chat-1')).toMatchObject({ token: hold.token })

    // A one-shot expiry would have disarmed itself on that failure and left the
    // hold immortal again, which is the defect this whole file is about.
    assertAuthority = (): void => {}
    await vi.advanceTimersByTimeAsync(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS)
    await expect(command.result).resolves.toBe('committed')
    expect(publisher.catalogue.recoveryHold('chat-1')).toBeNull()
  })

  it('is sized above the request budget its holders actually await', () => {
    // Both holders await ThreadCatalogueClient, not the shorter
    // HostProjectionClient budget, and the longest gap between two
    // token-bearing requests on a working path spans two of them.
    expect(THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS).toBeGreaterThan(
      2 * THREAD_CATALOGUE_REQUEST_TIMEOUT_MS
    )
  })

  // The expiry is the backstop for a caller that never comes back. A caller
  // that DOES come back -- the desktop's own retry, seconds later -- must not
  // have to wait it out: ten minutes of `admit` queueing is ten minutes of
  // picker selections, transcript writes and record persists going nowhere on
  // that thread.
  it('is reclaimed by the same writer retrying, without waiting it out', () => {
    const lost = controller.begin('chat-1', 'desktop-1')

    const replacement = controller.begin('chat-1', 'desktop-1')

    expect(replacement.token).not.toBe(lost.token)
    expect(publisher.catalogue.recoveryHold('chat-1')).toMatchObject({
      token: replacement.token
    })
  })

  it('leaves the reclaimed token powerless', async () => {
    const lost = controller.begin('chat-1', 'desktop-1')
    const replacement = controller.begin('chat-1', 'desktop-1')

    // A late request bearing the reclaimed token can neither commit nor cancel,
    // so the strand cannot come back to life behind its replacement.
    expect(controller.end('chat-1', lost.token)).toBe(false)
    await expect(controller.adopt('chat-1', lost.token, 'prepared-1')).rejects.toThrow()
    expect(publisher.catalogue.recoveryHold('chat-1')).toMatchObject({
      token: replacement.token
    })
  })

  it('frees the thread on the replacement’s ordinary end, not on a timer', async () => {
    controller.begin('chat-1', 'desktop-1')
    const command = queueCommand('chat-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(command.ran()).toBe(false)

    const replacement = controller.begin('chat-1', 'desktop-1')
    expect(controller.end('chat-1', replacement.token)).toBe(true)

    await expect(command.result).resolves.toBe('committed')
    expect(publisher.catalogue.recoveryHold('chat-1')).toBeNull()
  })
})

/**
 * Reclaiming is scoped to the exact writer now asking to begin. A Desktop
 * request must never take over a Host-owned recovery (or the reverse): those
 * two are kept apart by `assertNoLiveDesktop`, and a reclaim that ignored
 * ownership would walk straight through it.
 */
describe('recoveryHoldHasOwner', () => {
  it('matches the same Desktop writer', () => {
    expect(
      recoveryHoldHasOwner({ desktopWriterId: 'desktop-1' }, { desktopWriterId: 'desktop-1' })
    ).toBe(true)
  })

  it('refuses a different Desktop writer', () => {
    expect(
      recoveryHoldHasOwner({ desktopWriterId: 'desktop-1' }, { desktopWriterId: 'desktop-2' })
    ).toBe(false)
  })

  it('refuses a Host-owned hold for a Desktop request', () => {
    expect(recoveryHoldHasOwner({ hostWriterId: 'host-1' }, { desktopWriterId: 'desktop-1' })).toBe(
      false
    )
  })

  it('refuses a Desktop-owned hold for a Host request', () => {
    expect(recoveryHoldHasOwner({ desktopWriterId: 'desktop-1' }, { hostWriterId: 'host-1' })).toBe(
      false
    )
  })

  it('matches the same Host writer', () => {
    expect(recoveryHoldHasOwner({ hostWriterId: 'host-1' }, { hostWriterId: 'host-1' })).toBe(true)
  })

  it('refuses a request that names no writer at all', () => {
    expect(recoveryHoldHasOwner({ desktopWriterId: 'desktop-1' }, {})).toBe(false)
  })
})
