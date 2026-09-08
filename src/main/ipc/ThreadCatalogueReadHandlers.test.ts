import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import { registerThreadCatalogueReadHandlers } from './ThreadCatalogueReadHandlers'
import type { ThreadCatalogueProjection } from '../../shared/threadCatalogueTypes'

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
