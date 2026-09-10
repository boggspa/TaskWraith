import { describe, expect, it, vi } from 'vitest'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-recovery-dispose-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

import { threadCatalogueWriteGate } from '../store/ThreadCatalogueWriteGate'
import {
  ThreadCatalogueRecovery,
  type CatalogueRecoveryDependencies
} from './ThreadCatalogueRecovery'

/**
 * `dispose()` must not strand a write-gate hold.
 *
 * When `end-recovery` fails, `runMutation` parks its `finish` -- the only
 * closure that calls the gate `release()` -- in the private `cleanup` map and
 * retries on a timer. `dispose()` used to clear `queued` and `retries` and
 * drop `cleanup` on the floor, so the process-local hold survived teardown.
 * `ThreadCatalogueWriteGate.admit` waits on a held chat with no timeout and
 * no rejection, so every later command on that thread blocked forever.
 *
 * The cleanup map is private and only reachable through a mutation path that
 * needs the whole catalogue stack, so these tests seed it directly. That is
 * the shape `runMutation` leaves behind: a token plus the `finish` closure
 * that owns the release.
 */
type CleanupEntry = { token: string; finish(): void; timer?: ReturnType<typeof setTimeout> }

function recoveryWithParkedCleanup(chatId: string): {
  recovery: ThreadCatalogueRecovery
  releaseCalls: () => number
} {
  const recovery = new ThreadCatalogueRecovery({} as unknown as CatalogueRecoveryDependencies)
  const release = threadCatalogueWriteGate.hold(chatId)
  if (!release) throw new Error(`gate was already held for ${chatId}`)
  let calls = 0
  const cleanup = (recovery as unknown as { cleanup: Map<string, CleanupEntry> }).cleanup
  cleanup.set(chatId, {
    token: 'recovery-token',
    finish: () => {
      calls += 1
      release()
    }
  })
  return { recovery, releaseCalls: () => calls }
}

describe('ThreadCatalogueRecovery.dispose', () => {
  it('releases a deferred recovery hold instead of stranding it', () => {
    const chatId = 'chat-dispose-releases'
    const { recovery, releaseCalls } = recoveryWithParkedCleanup(chatId)
    expect(threadCatalogueWriteGate.isHeld(chatId)).toBe(true)

    recovery.dispose()

    expect(releaseCalls()).toBe(1)
    expect(threadCatalogueWriteGate.isHeld(chatId)).toBe(false)
  })

  it('unblocks a command already waiting on that chat', async () => {
    // The user-visible consequence: `admit` has no timeout, so a waiter parked
    // behind a stranded hold never returns.
    const chatId = 'chat-dispose-unblocks'
    const { recovery } = recoveryWithParkedCleanup(chatId)

    let admitted = false
    const waiting = threadCatalogueWriteGate.admit(chatId, async () => {
      admitted = true
      return 'done'
    })
    await Promise.resolve()
    expect(admitted).toBe(false)

    recovery.dispose()

    await expect(waiting).resolves.toBe('done')
    expect(admitted).toBe(true)
  })

  it('cancels the deferred cleanup timer so it cannot outlive teardown', () => {
    const chatId = 'chat-dispose-timer'
    const recovery = new ThreadCatalogueRecovery({} as unknown as CatalogueRecoveryDependencies)
    const release = threadCatalogueWriteGate.hold(chatId)
    if (!release) throw new Error('gate was already held')
    let fired = false
    const timer = setTimeout(() => {
      fired = true
    }, 5)
    const cleanup = (recovery as unknown as { cleanup: Map<string, CleanupEntry> }).cleanup
    cleanup.set(chatId, { token: 'recovery-token', finish: release, timer })

    recovery.dispose()

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(false)
        expect(threadCatalogueWriteGate.isHeld(chatId)).toBe(false)
        resolve()
      }, 25)
    })
  })

  it('leaves an unrelated chat’s hold alone', () => {
    const disposedChat = 'chat-dispose-scoped'
    const otherChat = 'chat-dispose-untouched'
    const { recovery } = recoveryWithParkedCleanup(disposedChat)
    const otherRelease = threadCatalogueWriteGate.hold(otherChat)
    if (!otherRelease) throw new Error('gate was already held')

    recovery.dispose()

    expect(threadCatalogueWriteGate.isHeld(disposedChat)).toBe(false)
    expect(threadCatalogueWriteGate.isHeld(otherChat)).toBe(true)
    otherRelease()
  })
})
