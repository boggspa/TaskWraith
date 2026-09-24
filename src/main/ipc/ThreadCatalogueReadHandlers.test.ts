import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import { registerThreadCatalogueReadHandlers } from './ThreadCatalogueReadHandlers'
import type { ThreadCatalogueProjection } from '../../shared/threadCatalogueTypes'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }
}))

const projection = (id: string): ThreadCatalogueProjection => ({
  revision: 1,
  summary: {
    chatId: id,
    title: id,
    provider: 'claude',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messageCount: 1000,
    runCount: 100
  },
  recovery: {
    unsettledRuns: 0,
    soloWakeups: 0,
    ensembleWakeups: 0,
    workerEvents: 0,
    joinPolicies: 0,
    nextBlackboardExpiryAt: null
  }
})

describe('sender-bound catalogue reads', () => {
  beforeEach(() => handlers.clear())
  it('binds each lease to its opener and rejects foreign references and maintenance', async () => {
    const query = vi.fn(async () => ({ leaseId: 'lease', entry: {} }))
    const mirror = new ThreadCatalogueMirror({ query: query as never })
    registerThreadCatalogueReadHandlers(
      () => ({ kind: 'chat', chatId: 'owned' }),
      () => mirror
    )
    const read = handlers.get('thread-catalogue:read')!
    const first = { sender: { id: 1, once: vi.fn() } }
    const second = { sender: { id: 2, once: vi.fn() } }
    await read(first, { method: 'open', chatId: 'owned', mode: 'pages' })
    await expect(
      read(second, { method: 'objects', leaseId: 'lease', kind: 'message' })
    ).rejects.toThrow('does not own')
    await expect(read(first, { method: 'open', chatId: 'other', mode: 'record' })).rejects.toThrow(
      'does not own'
    )
    await expect(
      read(first, {
        method: 'chunk',
        leaseId: 'lease',
        offset: 0,
        reference: {
          chatId: 'other',
          generation: 'generation',
          kind: 'message',
          ordinal: 0,
          byteLength: 10,
          sha256: 'a'.repeat(64)
        }
      })
    ).rejects.toThrow('another chat')
    await expect(read(first, { method: 'erase', chatId: 'owned' })).rejects.toThrow(
      'Invalid history read'
    )
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('pages the presentation mirror without querying bodies and uses a consistent tie order', async () => {
    const query = vi.fn()
    const mirror = new ThreadCatalogueMirror({ query: query as never })
    for (const id of ['a', 'B', 'A', 'b']) mirror.observe(projection(id))
    registerThreadCatalogueReadHandlers(
      () => ({ kind: 'all' }),
      () => mirror
    )
    const read = handlers.get('thread-catalogue:read')!
    const event = { sender: { id: 1, once: vi.fn() } }
    const first = (await read(event, { method: 'list', limit: 2 })).data
    const next = (await read(event, { method: 'list', limit: 2, before: first.next })).data
    expect(
      [...first.entries, ...next.entries].map((entry) => entry.projection.summary.chatId)
    ).toEqual(['A', 'B', 'a', 'b'])
    expect(query).not.toHaveBeenCalled()
    expect(first.coverage).toBe('partial')
  })
})

describe('transient catalogue read failures', () => {
  beforeEach(() => handlers.clear())

  const readerFor = (query: ReturnType<typeof vi.fn>) => {
    const mirror = new ThreadCatalogueMirror({ query: query as never })
    registerThreadCatalogueReadHandlers(
      () => ({ kind: 'chat', chatId: 'owned' }),
      () => mirror,
      { retryDelayMs: () => 0 }
    )
    return handlers.get('thread-catalogue:read')!
  }
  const event = () => ({ sender: { id: 1, once: vi.fn() } })
  const open = { method: 'open', chatId: 'owned', mode: 'record' }

  // `source_changed` means the history moved under the indexer: the read never
  // ran, so re-reading is correct. The background importer already treats it
  // this way (ThreadCatalogueWorkerService.importFailed -> notifyChanged). The
  // renderer read must not be the one place that turns it into a dead run.
  it('retries a retryable source_changed rather than failing the run', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new ThreadCatalogueRequestError('source_changed'))
      .mockResolvedValueOnce({ leaseId: 'lease', entry: {} })
    const reply = await readerFor(query)(event(), open)
    expect(reply.available).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('retries source_unsettled and lease_expired too', async () => {
    for (const code of ['source_unsettled', 'lease_expired'] as const) {
      handlers.clear()
      const query = vi
        .fn()
        .mockRejectedValueOnce(new ThreadCatalogueRequestError(code))
        .mockResolvedValueOnce({ leaseId: 'lease', entry: {} })
      const reply = await readerFor(query)(event(), open)
      expect(reply.available).toBe(true)
      expect(query).toHaveBeenCalledTimes(2)
    }
  })

  // lease_erased is the one code the taxonomy marks non-retryable: the page was
  // deliberately invalidated, so retrying would spin against a real decision.
  it('does not retry a non-retryable lease_erased', async () => {
    const query = vi.fn().mockRejectedValue(new ThreadCatalogueRequestError('lease_erased'))
    await expect(readerFor(query)(event(), open)).rejects.toThrow('invalidated by erasure')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('still surfaces the failure once retries are exhausted, and stays bounded', async () => {
    const query = vi.fn().mockRejectedValue(new ThreadCatalogueRequestError('source_changed'))
    await expect(readerFor(query)(event(), open)).rejects.toThrow('History changed during indexing')
    expect(query.mock.calls.length).toBeGreaterThan(1)
    expect(query.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('leaves an unrelated error untouched', async () => {
    const query = vi.fn().mockRejectedValue(new Error('disk exploded'))
    await expect(readerFor(query)(event(), open)).rejects.toThrow('disk exploded')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
