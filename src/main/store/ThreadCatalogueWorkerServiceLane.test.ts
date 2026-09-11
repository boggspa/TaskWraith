import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ThreadCatalogueWorkerService } from './ThreadCatalogueWorkerService'

/**
 * `query`'s `'open'` case decides which lane a read takes. It used to hardcode
 * the fast one, so the post-paint recovery drain — every thread in the corpus,
 * at mode 'metadata' — sat FIFO with a user's chat open.
 *
 * Built through the prototype rather than the real service: the mapping is one
 * argument, and an integration test cannot pin it because inventory discovery
 * enqueues its own jobs in readdir order before the test can look.
 */
function laneProbe(): {
  service: ThreadCatalogueWorkerService
  priorities: (boolean | undefined)[]
} {
  const priorities: (boolean | undefined)[] = []
  const service = Object.create(ThreadCatalogueWorkerService.prototype)
  Object.assign(service, {
    closed: false,
    leases: new Map(),
    ensureIndexed: vi.fn((_chatId: string, _mode: string, priority?: boolean) => {
      priorities.push(priority)
      return Promise.resolve(null)
    })
  })
  return { service: service as ThreadCatalogueWorkerService, priorities }
}

const open = { method: 'open', chatId: 'chat-1', mode: 'metadata' } as never

describe('thread catalogue read lanes', () => {
  it('opens in the slow lane for a background request', async () => {
    const { service, priorities } = laneProbe()
    await service.query(open, 'background')
    expect(priorities).toEqual([false])
  })

  it('opens in the fast lane for a foreground request', async () => {
    const { service, priorities } = laneProbe()
    await service.query(open, 'foreground')
    expect(priorities).toEqual([true])
  })

  // Every caller that predates the envelope field sends no lane at all, and
  // must keep the behaviour it has always had.
  it('opens in the fast lane when no lane was named', async () => {
    const { service, priorities } = laneProbe()
    await service.query(open)
    expect(priorities).toEqual([true])
  })

  // The worker is the only thing that reads the envelope, and it is a module
  // with top-level side effects — so the seam is pinned by shape.
  it('carries the envelope lane from the worker into the service', () => {
    const worker = readFileSync(
      new URL('../workers/threadCatalogueWorker.ts', import.meta.url),
      'utf8'
    )
    expect(worker).toContain("priority?: 'foreground' | 'background'")
    expect(worker).toContain('service.query(query, request.priority)')
  })
})
