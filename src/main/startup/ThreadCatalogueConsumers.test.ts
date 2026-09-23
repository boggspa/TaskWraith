import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type {
  ThreadCatalogueOpenResult,
  ThreadCatalogueProjection
} from '../../shared/threadCatalogueTypes'
import {
  CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS,
  catalogueExecutionOwnerStatus,
  preloadCatalogueExecutionOwners,
  startCatalogueExecutionRecovery
} from './ThreadCatalogueExecutionOwners'
import { createCatalogueOrphanDrain } from './ThreadCatalogueOrphanDrain'

function row(): ThreadCatalogueProjection {
  return {
    revision: 1,
    summary: {
      chatId: 'chat',
      title: 'Owner',
      provider: 'claude',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messageCount: 1000,
      runCount: 0
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('late catalogue consumers', () => {
  it('distinguishes an unresolved execution owner from an absent or archived owner', () => {
    const mirror = new ThreadCatalogueMirror({ query: vi.fn() })
    expect(() => catalogueExecutionOwnerStatus(mirror, 'chat', () => true)).toThrow('loading')
    expect(catalogueExecutionOwnerStatus(mirror, 'chat', () => false)).toBe('missing')
    mirror.observe(row())
    expect(catalogueExecutionOwnerStatus(mirror, 'chat', () => true)).toBe('live')
    mirror.observe({ ...row(), summary: { ...row().summary, archived: true } })
    expect(catalogueExecutionOwnerStatus(mirror, 'chat', () => true)).toBe('missing')
    mirror.observe({ ...row(), sourceComplete: false })
    expect(() => catalogueExecutionOwnerStatus(mirror, 'chat', () => true)).toThrow('loading')
  })

  it('cannot reinstall owner metadata from a read that predates erasure', async () => {
    let resolve!: (value: ThreadCatalogueOpenResult) => void
    const pending = new Promise<ThreadCatalogueOpenResult>((done) => {
      resolve = done
    })
    const release = vi.fn()
    const mirror = new ThreadCatalogueMirror({
      query: async <T>(query) => {
        if (query.method === 'open') {
          expect(query.mode).toBe('metadata')
          return (await pending) as T
        }
        expect(query.method).toBe('release')
        release()
        return true as T
      }
    })
    const work = preloadCatalogueExecutionOwners(mirror, ['chat', 'chat'])
    mirror.forget('chat')
    resolve({
      leaseId: 'lease',
      entry: {
        chatId: 'chat',
        databaseId: 'db',
        generation: 'g',
        sourceWitness: 'w',
        epoch: { global: 'e', chat: 'e' },
        heads: { desktop: null, host: null },
        projection: row(),
        snapshot: false
      }
    })
    expect(await work).toEqual(['chat'])
    expect(mirror.get('chat')).toBeUndefined()
    expect(release).toHaveBeenCalledOnce()
  })

  it('serializes late orphan drains and retries a failed deletion without a new inventory event', async () => {
    vi.useFakeTimers()
    let enabled = false
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const drain = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const consumer = createCatalogueOrphanDrain({ enabled: () => enabled, drain, onError })
    consumer.notify()
    expect(drain).not.toHaveBeenCalled()
    enabled = true
    consumer.notify()
    consumer.notify()
    consumer.notify()
    expect(drain).toHaveBeenCalledOnce()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(drain).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2000)
    expect(drain).toHaveBeenCalledTimes(3)
    consumer.dispose()
    consumer.notify()
    await vi.advanceTimersByTimeAsync(5000)
    expect(drain).toHaveBeenCalledTimes(3)
  })
})

describe('startup execution recovery passes', () => {
  /** Owners whose metadata read resolves to nothing are not failures; a throw is. */
  function catalogue(open: () => Promise<null>): ThreadCatalogueMirror {
    return new ThreadCatalogueMirror({
      query: async <T>(query: { method: string }) =>
        (query.method === 'open' ? await open() : true) as T
    })
  }

  it('runs one pass when every owner loads', async () => {
    vi.useFakeTimers()
    const recover = vi.fn()
    const onError = vi.fn()
    const stop = startCatalogueExecutionRecovery({
      mirror: catalogue(async () => null),
      ownerIds: () => ['chat'],
      recover,
      onError
    })

    await vi.advanceTimersByTimeAsync(3_600_000)
    stop()

    expect(recover).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('runs again on a backoff capped at a minute while an owner will not load, and stops at the bound', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const passes: number[] = []
    const stop = startCatalogueExecutionRecovery({
      mirror: catalogue(async () => {
        throw new Error('Thread catalogue Host is not ready')
      }),
      ownerIds: () => ['chat'],
      recover: () => {
        passes.push(Date.now() - startedAt)
      },
      onError: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(3_600_000)
    stop()

    expect(CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      ...Array(10).fill(60_000)
    ])
    expect(passes).toEqual([
      0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000, 182_000, 242_000, 302_000, 362_000, 422_000,
      482_000, 542_000, 602_000, 662_000
    ])
  })

  it('hands every failed pass to onError, saying whether another pass follows', async () => {
    vi.useFakeTimers()
    const recover = vi.fn()
    const onError = vi.fn()
    const stop = startCatalogueExecutionRecovery({
      mirror: catalogue(async () => null),
      ownerIds: () => {
        throw new Error('execution registry unreadable')
      },
      recover,
      onError,
      retryDelaysMs: [1_000, 1_000]
    })

    await vi.advanceTimersByTimeAsync(600_000)
    stop()

    expect(
      onError.mock.calls.map(([error, retrying]) => [(error as Error).message, retrying])
    ).toEqual([
      ['execution registry unreadable', true],
      ['execution registry unreadable', true],
      ['execution registry unreadable', false]
    ])
    expect(recover).not.toHaveBeenCalled()
  })

  it('runs no further pass once stopped', async () => {
    vi.useFakeTimers()
    const recover = vi.fn()
    const stop = startCatalogueExecutionRecovery({
      mirror: catalogue(async () => {
        throw new Error('Thread catalogue Host is not ready')
      }),
      ownerIds: () => ['chat'],
      recover,
      onError: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledTimes(1)

    stop()
    await vi.advanceTimersByTimeAsync(600_000)

    expect(recover).toHaveBeenCalledTimes(1)
  })
})
