import { describe, expect, it, vi } from 'vitest'
import { ChatUpdateHydrationQueue } from './chatUpdateHydrationQueue'

interface RecordValue {
  id: string
  edits: string[]
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
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
        resolveBase: (chatId, hydrated) => current.get(chatId) || hydrated,
        apply: (chatId, base, updater) => committed.set(chatId, updater(base))
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
    expect(committed.has('chat-a')).toBe(false)

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
      resolveBase: (_key, hydrated) => hydrated,
      apply
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
        resolveBase: (_chatId, hydrated) => hydrated,
        apply
      })
    }

    queue.clear()
    hydrationA.resolve({ id: 'chat-a', edits: [] })
    hydrationB.resolve({ id: 'chat-b', edits: [] })
    await flushPromises()

    expect(apply).not.toHaveBeenCalled()
  })
})
