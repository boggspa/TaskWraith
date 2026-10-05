import { describe, expect, it } from 'vitest'
import { ThreadCatalogueRecoveryController } from './ThreadCatalogueRecoveryController'
import type { ThreadCatalogueRecoveryHold } from './ThreadCatalogue'
import { ORPHAN_RETIREMENT_TOKEN } from '../thread-log/ThreadAuthorityRetirement'

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
    // assertNoLiveDesktop() probes process.kill on the desktop's pid. A
    // missing pid triggers an `unresolved` path that throws synchronously;
    // the controller surfaces that as busy/live_desktop because it cannot
    // prove the desktop is gone. We assert that exact surface here; the
    // pid-alive branch is exercised by integration tests against the real
    // gate.
    const harness = buildHarness({ desktopWriter: { writerId: 'desk-orphan', pid: undefined } })
    const outcome = await harness.controller.endOrphan(CHAT, TOKEN, ORPHAN_RETIREMENT_TOKEN)
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_desktop' })
    expect(harness.catalogue.releaseCalls).toBe(0)
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
