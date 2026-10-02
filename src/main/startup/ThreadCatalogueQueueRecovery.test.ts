import { describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueQueueRecovery } from './ThreadCatalogueQueueRecovery'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness() {
  const queryHold = deferred()
  const cleanupHold = deferred()
  let erasing = false
  const query = vi.fn(async (request: { method: string }) => {
    if (request.method === 'open') {
      await queryHold.promise
      return {
        leaseId: 'lease',
        entry: {
          sourceWitness: 'witness',
          snapshot: false,
          projection: { sourceComplete: true, summary: { workspaceId: 'workspace' } }
        }
      }
    }
    if (request.method === 'ordinal') return 0
    if (request.method === 'objects')
      return [{ kind: 'inline', value: { runId: 'run', status: 'completed' } }]
    if (request.method === 'summary') return { sourceWitness: 'witness' }
    if (request.method === 'release') {
      await cleanupHold.promise
      return null
    }
    throw new Error('Unexpected query')
  })
  const settle = vi.fn()
  const recovery = new ThreadCatalogueQueueRecovery({
    mirror: { port: { query }, get: () => undefined } as unknown as ThreadCatalogueMirror,
    jobs: () => [{ runId: 'run', chatId: 'chat', status: 'starting' }],
    isRunLive: () => false,
    isErasing: () => erasing,
    settle
  })
  return {
    recovery,
    query,
    settle,
    queryHold,
    cleanupHold,
    erase: () => {
      erasing = true
    }
  }
}

describe('ThreadCatalogueQueueRecovery quit quiescence', () => {
  it('allows admitted settlement, refuses new passes, and joins lease cleanup', async () => {
    const h = harness()
    h.recovery.reconcile()
    h.recovery.beginShutdown()
    h.recovery.reconcile()
    let done = false
    const joined = h.recovery.quiesce().then(() => {
      done = true
    })
    h.queryHold.resolve()
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce())
    expect(done).toBe(false)
    expect(h.query.mock.calls.filter(([request]) => request.method === 'open')).toHaveLength(1)
    h.cleanupHold.resolve()
    await joined
    const count = h.query.mock.calls.length
    h.recovery.reconcile()
    await h.recovery.quiesce()
    expect(h.query).toHaveBeenCalledTimes(count)
  })

  it('retains the deletion check across a held query without settling stale evidence', async () => {
    const h = harness()
    h.recovery.reconcile()
    h.recovery.beginShutdown()
    h.erase()
    h.queryHold.resolve()
    h.cleanupHold.resolve()
    await h.recovery.quiesce()
    expect(h.settle).not.toHaveBeenCalled()
    expect(h.query.mock.calls.some(([request]) => request.method === 'release')).toBe(true)
  })

  it('joins a rejected query and remains idempotently fenced', async () => {
    const h = harness()
    h.query.mockImplementationOnce(async () => {
      throw new Error('source unavailable')
    })
    h.recovery.reconcile()
    await h.recovery.quiesce()
    await h.recovery.quiesce()
    h.recovery.reconcile()
    expect(h.settle).not.toHaveBeenCalled()
    expect(h.query).toHaveBeenCalledOnce()
  })

  it('reports an uncaught pass failure and permits a fenced join retry', async () => {
    const jobs = vi.fn((): [] => {
      throw new Error('job snapshot failed')
    })
    const recovery = new ThreadCatalogueQueueRecovery({
      mirror: {} as ThreadCatalogueMirror,
      jobs,
      isRunLive: () => false,
      isErasing: () => false,
      settle: vi.fn()
    })
    recovery.reconcile()
    await expect(recovery.quiesce()).rejects.toThrow('job snapshot failed')
    await expect(recovery.quiesce()).rejects.toThrow('job snapshot failed')
    jobs.mockImplementation(() => [])
    await recovery.quiesce()
    recovery.reconcile()
    expect(jobs).toHaveBeenCalledTimes(3)
  })

  it('retries failed release before quiescence without repeating settlement', async () => {
    const h = harness()
    const original = h.query.getMockImplementation()!
    let releases = 0
    h.query.mockImplementation(async (request) => {
      if (request.method === 'release' && ++releases === 1) throw new Error('release failed')
      return original(request)
    })
    h.queryHold.resolve()
    h.cleanupHold.resolve()
    h.recovery.reconcile()
    await expect(h.recovery.quiesce()).rejects.toThrow('release failed')
    await h.recovery.quiesce()
    expect(releases).toBe(2)
    expect(h.settle).toHaveBeenCalledOnce()
    await h.recovery.quiesce()
    expect(releases).toBe(2)
  })

  it('retains settlement failure until a fenced retry actually settles it', async () => {
    const h = harness()
    h.queryHold.resolve()
    h.cleanupHold.resolve()
    h.settle.mockImplementation(() => {
      throw new Error('settlement failed')
    })
    h.recovery.reconcile()
    await expect(h.recovery.quiesce()).rejects.toThrow('settlement failed')
    await expect(h.recovery.quiesce()).rejects.toThrow('settlement failed')
    h.query.mockImplementationOnce(async () => {
      throw new Error('metadata unavailable')
    })
    await expect(h.recovery.quiesce()).rejects.toThrow('settlement failed')
    h.settle.mockImplementation(() => undefined)
    await h.recovery.quiesce()
    expect(h.settle).toHaveBeenCalledTimes(3)
    await h.recovery.quiesce()
    expect(h.settle).toHaveBeenCalledTimes(3)
  })

  it('a successful later pass cannot hide an earlier failed lease release', async () => {
    const h = harness()
    const original = h.query.getMockImplementation()!
    let opens = 0
    let allowA = false
    const failedA = deferred()
    h.query.mockImplementation(async (request) => {
      if (request.method === 'open') {
        if (++opens > 1) return null
      }
      if (request.method === 'release' && !allowA) {
        failedA.resolve()
        throw new Error('release A unresolved')
      }
      return original(request)
    })
    h.queryHold.resolve()
    h.cleanupHold.resolve()
    h.recovery.reconcile()
    await failedA.promise
    // Let A retire, then admit B before the quit fence is raised.
    await new Promise<void>((resolve) => setImmediate(resolve))
    h.recovery.reconcile()
    await expect(h.recovery.quiesce()).rejects.toThrow('release A unresolved')
    allowA = true
    await h.recovery.quiesce()
    expect(h.settle).toHaveBeenCalledOnce()
  })
})
