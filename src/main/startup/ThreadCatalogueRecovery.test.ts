import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-recovery-dispose-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

import { AppStore } from '../store'
import { threadCatalogueWriteGate } from '../store/ThreadCatalogueWriteGate'
import {
  ThreadCatalogueRecovery,
  type CatalogueRecoveryDependencies
} from './ThreadCatalogueRecovery'
import type { ThreadCatalogueProjection } from '../store/ThreadCatalogue'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'

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

/**
 * The live path of the same defect `dispose()` covers above.
 *
 * `runMutation` used to await the `end-recovery` acknowledgement while still
 * holding the process-local write gate, so an unreachable Host — or one whose
 * writer authority moved — held that chat's gate for the life of the process:
 * every composer-selection persist, `saveRendererChat` and `mutateTranscript`
 * for the thread waited on an `admit` that has no timeout and no rejection.
 * Teardown was only the case somebody happened to hit first.
 */
describe('a cancel the Host never acknowledges', () => {
  const chatId = 'chat-cancel-unacknowledged'

  function recoveryRefusingCancel(options: { onCancel?: () => void } = {}): {
    recovery: ThreadCatalogueRecovery
    cancels: () => number
  } {
    let cancels = 0
    const query = async (request: { method: string }): Promise<unknown> =>
      request.method === 'open'
        ? {
            leaseId: 'lease-1',
            entry: { projection: { sourceComplete: true }, sourceWitness: 'witness-1' }
          }
        : null
    const maintain = async (request: { method: string }): Promise<unknown> => {
      if (request.method === 'begin-recovery')
        return { chatId, token: 'recovery-token', hostIncarnation: 'host-1' }
      if (request.method === 'end-recovery') {
        cancels += 1
        options.onCancel?.()
        throw new Error('Host history maintenance is unavailable')
      }
      // A null `prepare` ends the mutation before it can adopt anything, which
      // keeps this test on the cancel path and off the commit path.
      return null
    }
    const recovery = new ThreadCatalogueRecovery({
      catalogue: {
        maintain,
        mirror: { port: { query } },
        setMutationGuard: () => () => {}
      },
      isRunLive: () => false,
      isChatLive: () => false,
      isErasing: () => false
    } as unknown as CatalogueRecoveryDependencies)
    return { recovery, cancels: () => cancels }
  }

  function settleRuns(): Parameters<ThreadCatalogueRecovery['mutate']>[1] {
    return {
      kind: 'settle-runs',
      nowIso: new Date().toISOString(),
      minAgeMs: 0,
      runs: []
    } as unknown as Parameters<ThreadCatalogueRecovery['mutate']>[1]
  }

  beforeEach(() => {
    vi.spyOn(AppStore, 'catalogueRecoveryAllowed').mockReturnValue(true)
    vi.spyOn(AppStore, 'quiesceForCatalogueMutation').mockResolvedValue(undefined)
    vi.spyOn(AppStore, 'hasPendingCatalogueWrites').mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('releases the chat gate instead of holding it until the process exits', async () => {
    const { recovery } = recoveryRefusingCancel()
    await expect(recovery.mutate(chatId, settleRuns())).rejects.toThrow(
      'Host history maintenance is unavailable'
    )
    expect(threadCatalogueWriteGate.isHeld(chatId)).toBe(false)
    recovery.dispose()
  })

  it('lets a composer-selection persist queued behind it through', async () => {
    // `admit` is the seam `persistChatComposerSelection` goes through, and it
    // has no timeout: a waiter parked here is the picker silently refusing to
    // save for the rest of the session.
    const { recovery } = recoveryRefusingCancel()
    let persisted = false
    const mutation = recovery.mutate(chatId, settleRuns())
    const persist = threadCatalogueWriteGate.admit(chatId, async () => {
      persisted = true
      return 'selection-saved'
    })
    await expect(mutation).rejects.toThrow()
    await expect(persist).resolves.toBe('selection-saved')
    expect(persisted).toBe(true)
    recovery.dispose()
  })

  it('keeps chasing the cancel after it has settled locally', async () => {
    // Releasing the local gate is not abandoning the Host's durable hold: the
    // retry keeps running, it just no longer has the thread hostage.
    vi.useFakeTimers()
    try {
      const { recovery, cancels } = recoveryRefusingCancel()
      await expect(recovery.mutate(chatId, settleRuns())).rejects.toThrow()
      expect(cancels()).toBe(1)
      await vi.advanceTimersByTimeAsync(2100)
      expect(cancels()).toBe(2)
      expect(threadCatalogueWriteGate.isHeld(chatId)).toBe(false)
      recovery.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // The drain opens every thread in the corpus at first paint. Its read has to
  // ride the slow lane or a user's chat open queues behind repair -- measured
  // 2026-09-11, nine sends pressed 14:01:04-10 all dispatched at 14:01:13, the
  // second the drain's last thread landed.
  //
  // `release` must NOT be delayed: a held lease occupies one of the 512 (16 per
  // chat) slots a foreground open needs, so slowing the release would starve
  // the very requests this lane protects.
  it('reads in the background lane and releases its lease in the foreground one', async () => {
    const seen: { method: string; priority?: string }[] = []
    const query = async (request: { method: string }, options?: { priority?: string }) => {
      seen.push({
        method: request.method,
        ...(options?.priority ? { priority: options.priority } : {})
      })
      if (request.method === 'open')
        return {
          leaseId: 'lease-1',
          entry: { projection: { revision: 1, sourceComplete: true }, sourceWitness: 'witness' }
        }
      if (request.method === 'objects') return []
      return true
    }
    const recovery = new ThreadCatalogueRecovery({
      catalogue: {
        mirror: {
          port: { query },
          get: () => recoveryProjection('chat-1', 1, { joinPolicies: 1 })
        },
        setMutationGuard: () => () => {}
      },
      isRunLive: () => false,
      isChatLive: () => false,
      isErasing: () => false
    } as unknown as CatalogueRecoveryDependencies)

    await (recovery as unknown as { recover(chatId: string): Promise<void> }).recover('chat-1')

    expect(seen.find((entry) => entry.method === 'open')?.priority).toBe('background')
    expect(seen.find((entry) => entry.method === 'release')?.priority).toBeUndefined()
  })
})

function recoveryProjection(
  chatId: string,
  revision: number,
  recovery: Partial<ThreadCatalogueProjection['recovery']>
): ThreadCatalogueProjection {
  return {
    revision,
    summary: { chatId },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null,
      ...recovery
    }
  } as unknown as ThreadCatalogueProjection
}

describe('hot-source recovery scheduling', () => {
  it('cools down one active join-policy source, lets a quiet thread finish, and wakes on terminal evidence', async () => {
    const rows = new Map([
      ['hot', recoveryProjection('hot', 1, { unsettledRuns: 1, joinPolicies: 1 })],
      ['quiet', recoveryProjection('quiet', 1, { joinPolicies: 1 })]
    ])
    const listeners = new Set<(row: ThreadCatalogueProjection | null, id: string) => void>()
    const openCalls: Array<{ chatId: string; priority?: string }> = []
    const leases = new Map<string, string>()
    let hotLive = true
    let hotStable = false
    let quietDone!: () => void
    let hotDone!: () => void
    const quietRecovered = new Promise<void>((resolve) => {
      quietDone = resolve
    })
    const hotRecovered = new Promise<void>((resolve) => {
      hotDone = resolve
    })
    const port = {
      query: async <T>(
        query: { method: string; chatId?: string; leaseId?: string },
        options?: {
          priority?: string
        }
      ): Promise<T> => {
        if (query.method === 'open') {
          const chatId = String(query.chatId)
          openCalls.push({ chatId, priority: options?.priority })
          if (chatId === 'hot' && !hotStable)
            throw new ThreadCatalogueRequestError('source_changed')
          const leaseId = `lease-${chatId}`
          leases.set(leaseId, chatId)
          return {
            leaseId,
            entry: {
              projection: rows.get(chatId),
              sourceWitness: `witness-${chatId}`,
              snapshot: false
            }
          } as T
        }
        if (query.method === 'objects') return [] as T
        if (query.method === 'release') {
          leases.delete(String(query.leaseId))
          return true as T
        }
        throw new Error(`unexpected query ${query.method}`)
      }
    }
    const mirror = {
      complete: true,
      port,
      get: (id: string) => rows.get(id),
      projections: () => [...rows.values()],
      subscribe: (listener: (row: ThreadCatalogueProjection | null, id: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const errors: unknown[] = []
    const recovery = new ThreadCatalogueRecovery({
      catalogue: { mirror, setMutationGuard: () => () => {} },
      isRunLive: () => false,
      isChatLive: (chatId) => chatId === 'hot' && hotLive,
      getRunSession: () => undefined,
      isErasing: () => false,
      onError: (error) => errors.push(error),
      onOperationalRecords: (projection) => {
        if (projection.summary.chatId === 'quiet') quietDone()
        if (projection.summary.chatId === 'hot') hotDone()
      }
    } as unknown as CatalogueRecoveryDependencies)
    try {
      recovery.start()
      await quietRecovered

      expect(openCalls.map(({ chatId }) => chatId)).toEqual(['hot', 'quiet'])
      expect(openCalls.every(({ priority }) => priority === 'background')).toBe(true)
      expect(errors).toHaveLength(1)
      expect(leases.size).toBe(0)

      for (let revision = 2; revision <= 12; revision += 1) {
        rows.set('hot', recoveryProjection('hot', revision, { unsettledRuns: 1, joinPolicies: 1 }))
        for (const listener of listeners) listener(rows.get('hot')!, 'hot')
      }
      await Promise.resolve()
      expect(openCalls.filter(({ chatId }) => chatId === 'hot')).toHaveLength(1)

      hotStable = true
      hotLive = false
      rows.set('hot', recoveryProjection('hot', 13, { joinPolicies: 1 }))
      for (const listener of listeners) listener(rows.get('hot')!, 'hot')
      await hotRecovered

      expect(openCalls.filter(({ chatId }) => chatId === 'hot')).toHaveLength(2)
      expect(recovery.joinsReady).toBe(true)
      expect(leases.size).toBe(0)
    } finally {
      recovery.dispose()
    }
  })

  it('defers only live run settlement and resumes it when the same chat becomes terminal', async () => {
    let row = recoveryProjection('live-run', 1, { unsettledRuns: 1 })
    let live = true
    let listener: ((row: ThreadCatalogueProjection | null, id: string) => void) | undefined
    let opens = 0
    let recovered!: () => void
    const done = new Promise<void>((resolve) => {
      recovered = resolve
    })
    const mirror = {
      complete: true,
      get: () => row,
      projections: () => [row],
      subscribe: (next: typeof listener) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      port: {
        query: async <T>(query: { method: string }): Promise<T> => {
          if (query.method === 'open') {
            opens += 1
            return {
              leaseId: 'lease-live-run',
              entry: { projection: row, sourceWitness: 'witness', snapshot: false }
            } as T
          }
          if (query.method === 'objects') return [] as T
          if (query.method === 'release') return true as T
          throw new Error(`unexpected query ${query.method}`)
        }
      }
    }
    const recovery = new ThreadCatalogueRecovery({
      catalogue: { mirror, setMutationGuard: () => () => {} },
      isRunLive: () => false,
      isChatLive: () => live,
      getRunSession: () => undefined,
      isErasing: () => false,
      onOperationalRecords: () => recovered()
    } as unknown as CatalogueRecoveryDependencies)
    try {
      recovery.start()
      await Promise.resolve()
      expect(opens).toBe(0)

      live = false
      row = recoveryProjection('live-run', 2, { unsettledRuns: 1 })
      listener?.(row, 'live-run')
      await done
      expect(opens).toBe(1)
    } finally {
      recovery.dispose()
    }
  })
})
