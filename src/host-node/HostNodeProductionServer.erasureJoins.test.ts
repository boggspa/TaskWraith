/**
 * Phase 1 Stage 4 (I8): the production server's erasure joins, in order.
 *
 * - `erase` / `reestablish-erasure`: captured publication permits go
 *   non-current synchronously, then the history router and the orphan fold
 *   are joined, then the publisher drains, and only then does the catalogue
 *   purge run. The mirror forgets after the purge.
 * - A global erasure (no chat) fences and drains every chat.
 * - A join that fails stops the step before the purge.
 * - `finish-erasure` lifts every fence only when the catalogue confirms it.
 *
 * The writers are recording stubs placed on the server's private fields: the
 * real ones are covered by their own erasure suites; this pins the wiring.
 */
import { describe, expect, it, vi } from 'vitest'

import type { ThreadCatalogueMaintenanceQuery } from '../shared/threadCatalogueProtocol'
import { HostNodeProductionServer } from './HostNodeProductionServer'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { finished?: boolean } = {}) {
  const order: string[] = []
  const router = deferred()
  const fold = deferred()
  const server = new HostNodeProductionServer({
    profilePath: '/profile',
    mode: 'production',
    environment: {},
    domainOptions: {} as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' })
  })
  const tag = (name: string) => (chatId?: string) => order.push(`${name}(${chatId ?? '*'})`)
  Object.assign(server as unknown as Record<string, unknown>, {
    threadCatalogue: {
      query: vi.fn(async (request: ThreadCatalogueMaintenanceQuery) => {
        const chatId = 'chatId' in request ? request.chatId : undefined
        order.push(`query.${request.method}(${chatId ?? '*'})`)
        return request.method === 'finish-erasure' ? (options.finished ?? true) : 'purged'
      })
    },
    threadRecovery: { forgetErased: vi.fn(tag('recovery.forgetErased')) },
    threadOwners: { invalidatePublicationForErasure: vi.fn(tag('owners.invalidate')) },
    threadHistoryRouter: {
      erasing: vi.fn((chatId?: string) => {
        order.push(`router.erasing(${chatId ?? '*'})`)
        return router.promise.then(() => {
          order.push('router.joined')
        })
      }),
      forgetErased: vi.fn(tag('router.forgetErased'))
    },
    orphanFold: {
      quiesceForErasure: vi.fn((chatId?: string) => {
        order.push(`fold.quiesce(${chatId ?? '*'})`)
        return fold.promise.then(() => {
          order.push('fold.joined')
        })
      }),
      liftErasure: vi.fn(tag('fold.lift'))
    },
    threadCataloguePublisher: {
      drain: vi.fn(async (chatIds?: string[]) => {
        order.push(`publisher.drain(${chatIds ? chatIds.join(',') : '*'})`)
      }),
      forgetErased: vi.fn(tag('publisher.forgetErased'))
    },
    threadCatalogueMirror: {
      forget: vi.fn(tag('mirror.forget')),
      forgetAll: vi.fn(() => order.push('mirror.forgetAll'))
    }
  })
  const maintain = (request: ThreadCatalogueMaintenanceQuery): Promise<{ data: unknown }> =>
    (
      server as unknown as {
        maintainCatalogue(request: ThreadCatalogueMaintenanceQuery): Promise<{ data: unknown }>
      }
    ).maintainCatalogue(request)
  return { order, router, fold, maintain }
}

describe('HostNodeProductionServer.maintainCatalogue: erasure joins (Phase 1 Stage 4)', () => {
  for (const method of ['erase', 'reestablish-erasure'] as const) {
    it(`${method}: invalidates, joins router and fold, drains, then purges`, async () => {
      const h = harness()
      const request =
        method === 'erase'
          ? { method, chatId: 'chat-a' }
          : { method, chatId: 'chat-a', generation: 'g-1' }
      const step = h.maintain(request)

      // The invalidation is synchronous and precedes both joins.
      expect(h.order).toEqual([
        'owners.invalidate(chat-a)',
        'router.erasing(chat-a)',
        'fold.quiesce(chat-a)'
      ])
      h.router.resolve()
      await macrotask()
      // One join done is not enough: nothing drains while the fold is live.
      expect(h.order).not.toContain('publisher.drain(chat-a)')
      h.fold.resolve()

      await expect(step).resolves.toEqual({ data: 'purged' })
      expect(h.order.slice(3)).toEqual([
        'router.joined',
        'fold.joined',
        'publisher.drain(chat-a)',
        `query.${method}(chat-a)`,
        'mirror.forget(chat-a)'
      ])
    })
  }

  it('a global erasure fences, drains and forgets every chat', async () => {
    const h = harness()
    h.router.resolve()
    h.fold.resolve()
    await h.maintain({ method: 'erase' })
    expect(h.order).toEqual([
      'owners.invalidate(*)',
      'router.erasing(*)',
      'fold.quiesce(*)',
      'router.joined',
      'fold.joined',
      'publisher.drain(*)',
      'query.erase(*)',
      'mirror.forgetAll'
    ])
  })

  it('a join that fails stops the step before the drain and the purge', async () => {
    const h = harness()
    const step = h.maintain({ method: 'erase', chatId: 'chat-a' })
    h.router.resolve()
    h.fold.reject(new Error('fold would not quiesce'))
    await expect(step).rejects.toThrow('fold would not quiesce')
    expect(h.order.some((entry) => entry.startsWith('publisher.drain'))).toBe(false)
    expect(h.order.some((entry) => entry.startsWith('query.'))).toBe(false)
    expect(h.order.some((entry) => entry.startsWith('mirror.'))).toBe(false)
  })

  it('finish-erasure lifts every fence once the catalogue confirms it', async () => {
    const h = harness()
    await expect(
      h.maintain({ method: 'finish-erasure', chatId: 'chat-a', generation: 'g-1' })
    ).resolves.toEqual({ data: true })
    expect(h.order).toEqual([
      'query.finish-erasure(chat-a)',
      'recovery.forgetErased(chat-a)',
      'publisher.forgetErased(chat-a)',
      'router.forgetErased(chat-a)',
      'fold.lift(chat-a)'
    ])
  })

  it('a global finish-erasure lifts the global fences', async () => {
    const h = harness()
    await h.maintain({ method: 'finish-erasure', generation: 'g-1' })
    expect(h.order).toEqual([
      'query.finish-erasure(*)',
      'recovery.forgetErased(*)',
      'publisher.forgetErased(*)',
      'router.forgetErased(*)',
      'fold.lift(*)'
    ])
  })

  it('an unconfirmed finish-erasure leaves every fence up', async () => {
    const h = harness({ finished: false })
    await expect(
      h.maintain({ method: 'finish-erasure', chatId: 'chat-a', generation: 'g-1' })
    ).resolves.toEqual({ data: false })
    expect(h.order).toEqual(['query.finish-erasure(chat-a)'])
  })
})
