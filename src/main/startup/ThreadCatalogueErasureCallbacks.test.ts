import { describe, expect, it, vi } from 'vitest'
import type { CatalogueErasureFence, HistoryDeletionPreparation } from '../store'
import type { ThreadCatalogueMaintenanceQuery } from '../../shared/threadCatalogueProtocol'
import {
  createCatalogueErasureCallbacks,
  type CatalogueErasureDeps
} from './ThreadCatalogueErasureCallbacks'

function preparation(
  kind: HistoryDeletionPreparation['kind'],
  chatIds: string[]
): HistoryDeletionPreparation {
  return {
    operationId: 'op-1',
    kind,
    chatIds,
    runIds: [],
    quiescenceTargets: [],
    completedQuiescenceTargetIds: []
  }
}

function setup(overrides: Partial<CatalogueErasureDeps> = {}) {
  const events: string[] = []
  const queries: ThreadCatalogueMaintenanceQuery[] = []
  let minted = 0
  const deps: CatalogueErasureDeps = {
    maintain: vi.fn(async (query: ThreadCatalogueMaintenanceQuery) => {
      queries.push(query)
      const chat = 'chatId' in query ? (query.chatId ?? 'global') : 'global'
      events.push(`${query.method}:${chat}`)
      if (query.method === 'finish-erasure') return true as never
      if (query.method === 'reestablish-erasure') return query.generation as never
      minted += 1
      return `minted-${minted}` as never
    }),
    drainPublications: vi.fn(async (chatIds) => void events.push(`drain:${chatIds ?? 'all'}`)),
    mirror: {
      forget: (chatId) => void events.push(`mirror.forget:${chatId}`),
      forgetAll: () => void events.push('mirror.forgetAll')
    },
    recovery: () => ({ forgetErased: (chatId) => void events.push(`recovery:${chatId ?? 'all'}`) }),
    publisher: () => ({
      forgetErased: (chatId) => void events.push(`publisher:${chatId ?? 'all'}`)
    }),
    saveIntents: {
      forget: (chatId) => (events.push(`queue.forget:${chatId}`), true),
      forgetAll: () => void events.push('queue.forgetAll')
    },
    joins: {
      coordinator: { deactivate: async (chatId) => void events.push(`deactivate:${chatId}`) },
      followers: {
        forget: (chatId) => void events.push(`follower.forget:${chatId}`),
        close: () => void events.push('follower.close')
      },
      receiptStore: {
        forgetChat: async (chatId) => void events.push(`receipts.forget:${chatId}`),
        forgetAll: async () => void events.push('receipts.forgetAll')
      }
    },
    ...overrides
  }
  return { deps, events, queries, callbacks: createCatalogueErasureCallbacks(deps) }
}

describe('catalogue erasure begin', () => {
  it('drains, fences, forgets the writers, then joins ownership, in that order', async () => {
    const { callbacks, events } = setup()

    const fences = await callbacks.begin(preparation('chat', ['chat-a']), [])

    expect(fences).toEqual([{ chatId: 'chat-a', generation: 'minted-1' }])
    expect(events).toEqual([
      'drain:chat-a',
      'erase:chat-a',
      'mirror.forget:chat-a',
      'recovery:chat-a',
      'publisher:chat-a',
      'deactivate:chat-a',
      'queue.forget:chat-a',
      'follower.forget:chat-a',
      'receipts.forget:chat-a'
    ])
  })

  it('never lifts the fence itself', async () => {
    const { callbacks, queries } = setup()

    await callbacks.begin(preparation('chat', ['chat-a']), [])

    expect(queries.some((query) => query.method === 'finish-erasure')).toBe(false)
  })

  it('resumes a recorded fence under its generation instead of minting another', async () => {
    const { callbacks, queries } = setup()
    const recorded: CatalogueErasureFence[] = [{ chatId: 'chat-a', generation: 'old-generation' }]

    const fences = await callbacks.begin(preparation('chat', ['chat-a', 'chat-b']), recorded)

    expect(queries).toEqual([
      { method: 'reestablish-erasure', generation: 'old-generation', chatId: 'chat-a' },
      { method: 'erase', chatId: 'chat-b' }
    ])
    expect(fences).toEqual([
      { chatId: 'chat-a', generation: 'old-generation' },
      { chatId: 'chat-b', generation: 'minted-1' }
    ])
  })

  it('fences the global scope once and joins every chat', async () => {
    const { callbacks, events, queries } = setup()

    const fences = await callbacks.begin(preparation('global', ['chat-a', 'chat-b']), [])

    expect(queries).toEqual([{ method: 'erase' }])
    expect(fences).toEqual([{ generation: 'minted-1' }])
    expect(events).toEqual([
      'drain:all',
      'erase:global',
      'mirror.forgetAll',
      'recovery:all',
      'publisher:all',
      'deactivate:chat-a',
      'deactivate:chat-b',
      'queue.forgetAll',
      'follower.close',
      'receipts.forgetAll'
    ])
  })

  it('a publisher that still has source writes fails the step before any ownership join', async () => {
    const { callbacks, events } = setup({
      publisher: () => ({
        forgetErased: () => {
          throw new Error('Erased source writes have not drained')
        }
      })
    })

    await expect(callbacks.begin(preparation('chat', ['chat-a']), [])).rejects.toThrow(
      'Erased source writes have not drained'
    )

    expect(events.some((event) => event.startsWith('deactivate'))).toBe(false)
  })

  it('attempts every ownership join even when one fails, then reports them together', async () => {
    const { callbacks, events } = setup({
      joins: {
        coordinator: {
          deactivate: async (chatId) => {
            events.push(`deactivate:${chatId}`)
            if (chatId === 'chat-a') throw new Error('stuck')
          }
        },
        receiptStore: {
          forgetChat: async (chatId) => void events.push(`receipts:${chatId}`),
          forgetAll: async () => {}
        }
      }
    })

    const error = await callbacks
      .begin(preparation('chat', ['chat-a', 'chat-b']), [])
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(1)
    expect(events).toContain('deactivate:chat-b')
    expect(events).toContain('queue.forget:chat-a')
    expect(events).toContain('receipts:chat-b')
  })

  it('works with no ownership joins composed', async () => {
    const { callbacks, events } = setup({ joins: undefined })

    await callbacks.begin(preparation('chat', ['chat-a']), [])

    expect(events).toEqual([
      'drain:chat-a',
      'erase:chat-a',
      'mirror.forget:chat-a',
      'recovery:chat-a',
      'publisher:chat-a',
      'queue.forget:chat-a'
    ])
  })
})

describe('catalogue erasure finish', () => {
  it('lifts each recorded fence under its own generation', async () => {
    const { callbacks, queries } = setup()

    await callbacks.finish(preparation('chat', ['chat-a', 'chat-b']), [
      { chatId: 'chat-a', generation: 'g-a' },
      { chatId: 'chat-b', generation: 'g-b' }
    ])

    expect(queries).toEqual([
      { method: 'finish-erasure', generation: 'g-a', chatId: 'chat-a' },
      { method: 'finish-erasure', generation: 'g-b', chatId: 'chat-b' }
    ])
  })

  it('lifts the global fence without a chat id', async () => {
    const { callbacks, queries } = setup()

    await callbacks.finish(preparation('global', []), [{ generation: 'g' }])

    expect(queries).toEqual([{ method: 'finish-erasure', generation: 'g' }])
  })

  it('throws when the catalogue does not acknowledge, so the intent is kept', async () => {
    const { callbacks } = setup({ maintain: vi.fn(async () => false as never) })

    await expect(
      callbacks.finish(preparation('chat', ['chat-a']), [{ chatId: 'chat-a', generation: 'stale' }])
    ).rejects.toThrow('History catalogue erasure was not acknowledged')
  })
})
