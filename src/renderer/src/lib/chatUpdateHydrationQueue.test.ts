import { describe, expect, it, vi } from 'vitest'
import { ChatUpdateHydrationQueue } from './chatUpdateHydrationQueue'

interface RecordValue {
  id: string
  edits: string[]
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((fulfil, fail) => {
    resolve = fulfil
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ChatUpdateHydrationQueue', () => {
  it('hydrates once and commits rapid functional updates once in arrival order', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydration = deferred<RecordValue | null>()
    const hydrate = vi.fn(() => hydration.promise)
    const apply = vi.fn(
      (
        _key: string,
        base: RecordValue,
        updater: (value: RecordValue) => RecordValue
      ) => updater(base)
    )
    const enqueue = (edit: string): void => {
      queue.enqueue({
        key: 'chat-a',
        updater: (value) => ({ ...value, edits: [...value.edits, edit] }),
        hydrate,
        resolveAvailableBase: () => null,
        resolveBase: (_key, hydrated) => hydrated,
        apply
      })
    }

    enqueue('participant-a')
    enqueue('participant-b')
    enqueue('participant-c')

    expect(hydrate).toHaveBeenCalledTimes(1)
    hydration.resolve({ id: 'chat-a', edits: [] })
    await flushPromises()

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.results[0].value).toEqual({
      id: 'chat-a',
      edits: ['participant-a', 'participant-b', 'participant-c']
    })
  })

  it('keeps competing chat hydrations isolated and rebases onto a live individual edit', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydrationA = deferred<RecordValue | null>()
    const hydrationB = deferred<RecordValue | null>()
    const current = new Map<string, RecordValue>()
    const committed = new Map<string, RecordValue>()
    const hydrate = vi.fn((key: string) =>
      key === 'chat-a' ? hydrationA.promise : hydrationB.promise
    )
    const enqueue = (key: string, edit: string): void => {
      queue.enqueue({
        key,
        updater: (value) => ({ ...value, edits: [...value.edits, edit] }),
        hydrate,
        resolveAvailableBase: (chatId) => current.get(chatId) || null,
        resolveBase: (chatId, hydrated) => current.get(chatId) || hydrated,
        apply: (chatId, base, updater) => {
          const updated = updater(base)
          committed.set(chatId, updated)
          return updated
        }
      })
    }

    enqueue('chat-a', 'queued-a1')
    enqueue('chat-b', 'queued-b1')
    enqueue('chat-a', 'queued-a2')
    current.set('chat-a', { id: 'chat-a', edits: ['live-individual-edit'] })
    enqueue('chat-a', 'queued-after-live-hydration')

    hydrationB.resolve({ id: 'chat-b', edits: [] })
    await flushPromises()
    expect(committed.get('chat-b')?.edits).toEqual(['queued-b1'])
    expect(committed.get('chat-a')?.edits).toEqual([
      'live-individual-edit',
      'queued-a1',
      'queued-a2',
      'queued-after-live-hydration'
    ])

    hydrationA.resolve({ id: 'chat-a', edits: ['stale-hydration'] })
    await flushPromises()

    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(committed.get('chat-a')?.edits).toEqual([
      'live-individual-edit',
      'queued-a1',
      'queued-a2',
      'queued-after-live-hydration'
    ])
  })

  it('does not apply a hydration which resolves after its chat is cancelled', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydration = deferred<RecordValue | null>()
    const apply = vi.fn()

    queue.enqueue({
      key: 'chat-a',
      updater: (value) => ({ ...value, edits: [...value.edits, 'late'] }),
      hydrate: () => hydration.promise,
      resolveAvailableBase: () => null,
      resolveBase: (_key, hydrated) => hydrated,
      apply: (_key, base, updater) => {
        apply()
        return updater(base)
      }
    })
    queue.cancel('chat-a')
    hydration.resolve({ id: 'chat-a', edits: [] })
    await flushPromises()

    expect(apply).not.toHaveBeenCalled()
    expect(queue.hasPending('chat-a')).toBe(false)
  })

  it('does not apply any hydration which resolves after the queue is cleared', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydrationA = deferred<RecordValue | null>()
    const hydrationB = deferred<RecordValue | null>()
    const apply = vi.fn()
    for (const [key, hydration] of [
      ['chat-a', hydrationA],
      ['chat-b', hydrationB]
    ] as const) {
      queue.enqueue({
        key,
        updater: (value) => value,
        hydrate: () => hydration.promise,
        resolveAvailableBase: () => null,
        resolveBase: (_chatId, hydrated) => hydrated,
        apply: (_key, base, updater) => {
          apply()
          return updater(base)
        }
      })
    }

    queue.clear()
    hydrationA.resolve({ id: 'chat-a', edits: [] })
    hydrationB.resolve({ id: 'chat-b', edits: [] })
    await flushPromises()

    expect(apply).not.toHaveBeenCalled()
  })

  it('synchronously drains pending and current updates over a full base and returns it', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydration = deferred<RecordValue | null>()
    let current: RecordValue | null = null
    const apply = (
      _key: string,
      base: RecordValue,
      updater: (value: RecordValue) => RecordValue
    ): RecordValue => {
      current = updater(base)
      return current
    }
    const request = (edit: string) => ({
      key: 'chat-a',
      updater: (value: RecordValue) => ({ ...value, edits: [...value.edits, edit] }),
      hydrate: () => hydration.promise,
      resolveAvailableBase: () => current,
      resolveBase: (_key: string, hydrated: RecordValue) => current || hydrated,
      apply
    })

    expect(queue.enqueue(request('queued-first'))).toBeNull()
    current = { id: 'chat-a', edits: ['full-base'] }
    const updated = queue.enqueue(request('current-update'))

    expect(updated).toEqual({
      id: 'chat-a',
      edits: ['full-base', 'queued-first', 'current-update']
    })
    expect(updated).toBe(current)
    expect(queue.hasPending('chat-a')).toBe(false)

    hydration.resolve({ id: 'chat-a', edits: ['stale-hydration'] })
    await flushPromises()
    expect(current?.edits).toEqual(['full-base', 'queued-first', 'current-update'])
  })

  it('recovers queued updates onto a full base when hydration resolves null', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydration = deferred<RecordValue | null>()
    let current: RecordValue | null = null

    queue.enqueue({
      key: 'chat-a',
      updater: (value) => ({ ...value, edits: [...value.edits, 'queued'] }),
      hydrate: () => hydration.promise,
      resolveAvailableBase: () => current,
      resolveBase: (_key, hydrated) => current || hydrated,
      apply: (_key, base, updater) => (current = updater(base))
    })
    current = { id: 'chat-a', edits: ['full-base'] }
    hydration.resolve(null)
    await flushPromises()

    expect(current.edits).toEqual(['full-base', 'queued'])
    expect(queue.hasPending('chat-a')).toBe(false)
  })

  it('recovers queued updates onto a full base when hydration rejects', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const hydration = deferred<RecordValue | null>()
    let current: RecordValue | null = null

    queue.enqueue({
      key: 'chat-a',
      updater: (value) => ({ ...value, edits: [...value.edits, 'queued'] }),
      hydrate: () => hydration.promise,
      resolveAvailableBase: () => current,
      resolveBase: (_key, hydrated) => current || hydrated,
      apply: (_key, base, updater) => (current = updater(base))
    })
    current = { id: 'chat-a', edits: ['full-base'] }
    hydration.reject(new Error('hydrate failed'))
    await flushPromises()

    expect(current.edits).toEqual(['full-base', 'queued'])
    expect(queue.hasPending('chat-a')).toBe(false)
  })

  it('recovers synchronously when hydration throws after a full base becomes available', () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    let current: RecordValue | null = null

    const updated = queue.enqueue({
      key: 'chat-a',
      updater: (value) => ({ ...value, edits: [...value.edits, 'queued'] }),
      hydrate: () => {
        current = { id: 'chat-a', edits: ['full-base'] }
        throw new Error('hydrate failed')
      },
      resolveAvailableBase: () => current,
      resolveBase: (_key, hydrated) => current || hydrated,
      apply: (_key, base, updater) => (current = updater(base))
    })

    expect(updated).toEqual({ id: 'chat-a', edits: ['full-base', 'queued'] })
    expect(queue.hasPending('chat-a')).toBe(false)
  })

  it('retains failed updates until a later full base can drain them', async () => {
    const queue = new ChatUpdateHydrationQueue<RecordValue>()
    const failedHydration = deferred<RecordValue | null>()
    const retryHydration = deferred<RecordValue | null>()
    let current: RecordValue | null = null
    let hydrateCalls = 0
    const request = (edit: string) => ({
      key: 'chat-a',
      updater: (value: RecordValue) => ({ ...value, edits: [...value.edits, edit] }),
      hydrate: () => {
        hydrateCalls += 1
        return hydrateCalls === 1 ? failedHydration.promise : retryHydration.promise
      },
      resolveAvailableBase: () => current,
      resolveBase: (_key: string, hydrated: RecordValue) => current || hydrated,
      apply: (
        _key: string,
        base: RecordValue,
        updater: (value: RecordValue) => RecordValue
      ) => (current = updater(base))
    })

    queue.enqueue(request('survives-failure'))
    failedHydration.resolve(null)
    await flushPromises()
    expect(queue.hasPending('chat-a')).toBe(true)

    current = { id: 'chat-a', edits: ['full-base'] }
    const updated = queue.enqueue(request('later-update'))
    expect(updated?.edits).toEqual(['full-base', 'survives-failure', 'later-update'])
    expect(hydrateCalls).toBe(1)
  })
})
