import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import type { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import {
  ThreadCatalogueMirror,
  type ThreadCatalogueReadPort
} from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import type { ThreadCatalogueRequestOptions } from '../shared/threadCatalogueProtocol'
import type {
  HostCatalogueRunOrigin,
  ThreadCatalogueOpenResult,
  ThreadCatalogueProjection,
  ThreadCatalogueQuery
} from '../shared/threadCatalogueTypes'
import type { HostWriteDecision } from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadWriteGate } from '../host-runtime/HostThreadWriteGate'
import { ThreadCatalogueHostRecovery } from './ThreadCatalogueHostRecovery'

const origin: HostCatalogueRunOrigin = {
  schemaVersion: 1,
  kind: 'host-node',
  hostId: 'host',
  incarnation: 'current'
}

function projection(chatId: string, revision = 1): ThreadCatalogueProjection {
  return {
    revision,
    summary: {
      chatId,
      title: chatId,
      provider: 'codex',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: revision,
      archived: false,
      messageCount: 0,
      runCount: 1
    },
    recovery: {
      unsettledRuns: 1,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

function opened(chatId: string): ThreadCatalogueOpenResult {
  return {
    leaseId: `lease-${chatId}`,
    entry: {
      databaseId: 'database',
      chatId,
      generation: `generation-${chatId}`,
      sourceWitness: `witness-${chatId}`,
      epoch: { global: 'global', chat: `epoch-${chatId}` },
      heads: { desktop: null, host: null },
      projection: projection(chatId),
      snapshot: false
    }
  }
}

function mirrorWith(...rows: ThreadCatalogueProjection[]): ThreadCatalogueMirror {
  const port: ThreadCatalogueReadPort = {
    query: async () => {
      throw new Error('Unexpected mirror poll')
    }
  }
  const mirror = new ThreadCatalogueMirror(port)
  for (const row of rows) mirror.observe(row)
  return mirror
}

function controller(): ThreadCatalogueRecoveryController {
  return {
    beginHost: vi.fn(),
    adopt: vi.fn(),
    end: vi.fn()
  } as unknown as ThreadCatalogueRecoveryController
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ThreadCatalogueHostRecovery scheduling', () => {
  it('coalesces a hot mirror burst behind one cooldown while a quiet chat progresses', async () => {
    vi.useFakeTimers()
    const mirror = mirrorWith(projection('hot'), projection('quiet'))
    let rejectFirstHot!: (error: Error) => void
    const firstHot = new Promise<never>((_resolve, reject) => {
      rejectFirstHot = reject
    })
    let hotOpens = 0
    const events: string[] = []
    let releaseRetriedHot!: () => void
    const retriedHotReleased = new Promise<void>((resolve) => {
      releaseRetriedHot = resolve
    })
    const query = vi.fn(
      async (
        request: ThreadCatalogueQuery,
        _options?: ThreadCatalogueRequestOptions
      ): Promise<unknown> => {
        if (request.method === 'open') {
          events.push(`open:${request.chatId}`)
          if (request.chatId === 'hot' && ++hotOpens === 1) return firstHot
          return opened(request.chatId)
        }
        if (request.method === 'objects') {
          events.push(`objects:${request.leaseId}`)
          return []
        }
        if (request.method === 'release') {
          events.push(`release:${request.leaseId}`)
          if (request.leaseId === 'lease-hot') releaseRetriedHot()
          return true
        }
        throw new Error(`Unexpected request ${request.method}`)
      }
    )
    const recovery = new ThreadCatalogueHostRecovery({
      client: { query } as unknown as Pick<ThreadCatalogueClient, 'query'>,
      mirror,
      controller: controller(),
      origin
    })

    try {
      expect(events).toEqual(['open:hot'])
      for (let revision = 2; revision <= 8; revision += 1)
        mirror.observe(projection('hot', revision))
      rejectFirstHot(new Error('Host metadata is moving'))
      await flushMicrotasks()

      expect(events.filter((event) => event.startsWith('open:'))).toEqual([
        'open:hot',
        'open:quiet'
      ])
      expect(hotOpens).toBe(1)
      for (let revision = 9; revision <= 16; revision += 1)
        mirror.observe(projection('hot', revision))
      await flushMicrotasks()
      expect(hotOpens).toBe(1)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(hotOpens).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await retriedHotReleased
      expect(hotOpens).toBe(2)
      expect(events.filter((event) => event.startsWith('open:'))).toEqual([
        'open:hot',
        'open:quiet',
        'open:hot'
      ])
      expect(events.filter((event) => event === 'open:quiet')).toHaveLength(1)
    } finally {
      recovery.dispose()
      await mirror.dispose()
    }
  })

  it('marks only the initial metadata open as background priority', async () => {
    const mirror = mirrorWith(projection('chat'))
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const query = vi.fn(
      async (
        request: ThreadCatalogueQuery,
        _options?: ThreadCatalogueRequestOptions
      ): Promise<unknown> => {
        if (request.method === 'open') return opened(request.chatId)
        if (request.method === 'objects') return []
        if (request.method === 'release') {
          finish()
          return true
        }
        throw new Error(`Unexpected request ${request.method}`)
      }
    )
    const recovery = new ThreadCatalogueHostRecovery({
      client: { query } as unknown as Pick<ThreadCatalogueClient, 'query'>,
      mirror,
      controller: controller(),
      origin
    })

    try {
      await finished
      expect(query).toHaveBeenCalledWith(
        { method: 'open', chatId: 'chat', mode: 'metadata' },
        { priority: 'background' }
      )
      const objects = query.mock.calls.find(([request]) => request.method === 'objects')
      const release = query.mock.calls.find(([request]) => request.method === 'release')
      expect(objects?.[1]).toBeUndefined()
      expect(release?.[1]).toBeUndefined()
    } finally {
      recovery.dispose()
      await mirror.dispose()
    }
  })

  it('cancels cooldown timers and ignores later mirror notifications on disposal', async () => {
    vi.useFakeTimers()
    const mirror = mirrorWith(projection('chat'))
    let opens = 0
    const query = vi.fn(async (request: ThreadCatalogueQuery): Promise<unknown> => {
      if (request.method === 'open') {
        opens += 1
        throw new Error('Host metadata is moving')
      }
      throw new Error(`Unexpected request ${request.method}`)
    })
    const recovery = new ThreadCatalogueHostRecovery({
      client: { query } as unknown as Pick<ThreadCatalogueClient, 'query'>,
      mirror,
      controller: controller(),
      origin
    })

    await flushMicrotasks()
    expect(opens).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    recovery.dispose()
    mirror.observe(projection('chat', 2))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(opens).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await mirror.dispose()
  })
})

describe('ThreadCatalogueHostRecovery and the Host’s own writes', () => {
  /** A catalogue whose thread holds one run a former incarnation of this Host left unsettled. */
  function catalogueWithAnUnsettledRun(events: string[]) {
    return vi.fn(async (request: ThreadCatalogueQuery): Promise<unknown> => {
      events.push(request.method)
      if (request.method === 'open') return opened(request.chatId)
      if (request.method === 'objects') {
        return request.after === undefined
          ? [
              {
                ordinal: 1,
                kind: 'inline',
                value: {
                  kind: 'run',
                  runId: 'run-1',
                  hostRunOrigin: { ...origin, incarnation: 'earlier' }
                }
              }
            ]
          : []
      }
      if (request.method === 'prepare') return { preparedId: 'prepared-1' }
      if (request.method === 'release') return true
      throw new Error(`Unexpected request ${request.method}`)
    })
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 500 && !condition(); turn += 1) await Promise.resolve()
    expect(condition()).toBe(true)
  }

  it('settles a thread’s runs only when the Host may write it, and looks again later when it may not', async () => {
    vi.useFakeTimers()
    const mirror = mirrorWith(projection('chat'))
    const events: string[] = []
    const decisions: HostWriteDecision[] = [
      { kind: 'busy', reason: 'thread_busy_in_desktop' },
      { kind: 'write' }
    ]
    const gate = new HostThreadWriteGate({ decide: async () => decisions.shift()! })
    const recoveryController = {
      beginHost: vi.fn(() => {
        events.push(`hold:${gate.writing('chat')}`)
        return { chatId: 'chat', token: 'token-1' }
      }),
      adopt: vi.fn(async () => {
        events.push(`adopt:${gate.writing('chat')}`)
      }),
      end: vi.fn(() => {
        events.push('end')
      })
    }
    const recovery = new ThreadCatalogueHostRecovery({
      client: { query: catalogueWithAnUnsettledRun(events) } as unknown as Pick<
        ThreadCatalogueClient,
        'query'
      >,
      mirror,
      controller: recoveryController as unknown as ThreadCatalogueRecoveryController,
      origin,
      writes: gate
    })
    try {
      await until(() => events.includes('release'))
      expect(events).toEqual(['open', 'objects', 'objects', 'release'])
      expect(recoveryController.beginHost).not.toHaveBeenCalled()

      // Changes to the thread while it is refused do not ask again at once.
      mirror.observe(projection('chat', 2))
      await vi.advanceTimersByTimeAsync(29_999)
      expect(events.filter((event) => event === 'open')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1)
      await until(() => events.filter((event) => event === 'release').length === 2)
      expect(events.slice(4)).toEqual([
        'open',
        'objects',
        'objects',
        'hold:true',
        'prepare',
        'adopt:true',
        'end',
        'release'
      ])
      expect(recoveryController.adopt).toHaveBeenCalledWith('chat', 'token-1', 'prepared-1')
      expect(gate.writing('chat')).toBe(false)
      expect(gate.snapshot().paths).toEqual({ 'catalogue.recovery': { asked: 2, refused: 1 } })
    } finally {
      recovery.dispose()
      await mirror.dispose()
    }
  })

  it('without a gate, settles at once as it always has', async () => {
    const mirror = mirrorWith(projection('chat'))
    const events: string[] = []
    const recoveryController = {
      beginHost: vi.fn(() => ({ chatId: 'chat', token: 'token-1' })),
      adopt: vi.fn(async () => undefined),
      end: vi.fn()
    }
    const recovery = new ThreadCatalogueHostRecovery({
      client: { query: catalogueWithAnUnsettledRun(events) } as unknown as Pick<
        ThreadCatalogueClient,
        'query'
      >,
      mirror,
      controller: recoveryController as unknown as ThreadCatalogueRecoveryController,
      origin
    })
    try {
      await until(() => events.includes('release'))
      expect(events).toEqual(['open', 'objects', 'objects', 'prepare', 'release'])
      expect(recoveryController.adopt).toHaveBeenCalledWith('chat', 'token-1', 'prepared-1')
    } finally {
      recovery.dispose()
      await mirror.dispose()
    }
  })
})
