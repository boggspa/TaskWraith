import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostProfileRun } from '../host-runtime/HostProfileDomainStore'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import { ThreadCatalogueHostRunWindow } from './ThreadCatalogueHostRunWindow'

type RunWindowPage = {
  entries: Array<{ chatId: string; sourceWitness: string; run: HostProfileRun }>
  total: number
  next: number | null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function page(sourceWitness: string, runId: string): RunWindowPage {
  return {
    entries: [
      {
        chatId: 'chat-1',
        sourceWitness,
        run: { runId, provider: 'muse', status: 'running' }
      }
    ],
    total: 1,
    next: null
  }
}

function opened(sourceComplete = true) {
  return {
    leaseId: 'lease-1',
    entry: {
      snapshot: false,
      projection: { sourceComplete }
    }
  }
}

function mirrorHarness() {
  const witnesses = new Map<string, string>([['chat-1', 'witness-1']])
  let listener: ((row: object | null, chatId: string) => void) | null = null
  const query = vi.fn()
  const mirror = {
    complete: true,
    port: { query },
    subscribe(next: (row: object | null, chatId: string) => void) {
      listener = next
      return () => {
        listener = null
      }
    },
    sourceWitnessFor(chatId: string) {
      return witnesses.get(chatId)
    }
  } as unknown as ThreadCatalogueMirror
  return {
    mirror,
    query,
    // The mirror stores a chat's new witness before it notifies.
    setWitness(next: string, chatId = 'chat-1') {
      witnesses.set(chatId, next)
      listener?.({} as object, chatId)
    },
    // A reapply-equal apply moves the witness without notifying.
    setWitnessSilently(next: string) {
      witnesses.set('chat-1', next)
    },
    remove() {
      witnesses.delete('chat-1')
      listener?.(null, 'chat-1')
    },
    touch(chatId: string) {
      listener?.({} as object, chatId)
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ThreadCatalogueHostRunWindow.refreshFor', () => {
  it('queries immediately for the exact current-witness run without advancing the debounce timer', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'open') return opened()
      if (query.method === 'host-runs') return page('witness-1', 'run-1')
      if (query.method === 'release') return true
      throw new Error(`unexpected query ${query.method}`)
    })
    const changed = vi.fn()
    const window = new ThreadCatalogueHostRunWindow(h.mirror, changed)

    await expect(window.refreshFor('chat-1', 'run-1')).resolves.toBe(true)

    expect(h.query).toHaveBeenCalledTimes(3)
    expect(h.query.mock.calls.map(([query]) => query.method)).toEqual([
      'open',
      'host-runs',
      'release'
    ])
    expect(h.query.mock.calls[0]![0]).toEqual({
      method: 'open',
      chatId: 'chat-1',
      mode: 'metadata'
    })
    expect(window.snapshot().entries).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        run: expect.objectContaining({ runId: 'run-1' })
      })
    ])
    expect(changed).toHaveBeenCalledTimes(1)
    window.dispose()
  })

  it('waits for an older in-flight refresh and then performs a second current refresh', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    const older = deferred<RunWindowPage>()
    const olderStarted = deferred<void>()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'host-runs') {
        hostRunQueries += 1
        if (hostRunQueries === 1) {
          olderStarted.resolve()
          return older.promise
        }
        return page('witness-2', 'run-current')
      }
      if (query.method === 'open') return opened()
      if (query.method === 'release') return true
      throw new Error(`unexpected query ${query.method}`)
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())

    await vi.advanceTimersByTimeAsync(100)
    await olderStarted.promise
    h.setWitness('witness-2')
    const refreshing = window.refreshFor('chat-1', 'run-current')
    older.resolve(page('witness-1', 'run-old'))

    await expect(refreshing).resolves.toBe(true)
    expect(h.query.mock.calls.map(([query]) => query.method)).toEqual([
      'host-runs',
      'open',
      'host-runs',
      'release'
    ])
    expect(window.snapshot().entries).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        run: expect.objectContaining({ runId: 'run-current' })
      })
    ])
    window.dispose()
  })

  it('returns false on query failure, releases the lease, and never counts an old-witness row as fresh', async () => {
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'open') return opened()
      if (query.method === 'release') return true
      if (query.method === 'host-runs') {
        hostRunQueries += 1
        if (hostRunQueries === 1) return page('witness-1', 'run-old')
        throw new Error('worker unavailable')
      }
      throw new Error(`unexpected query ${query.method}`)
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await expect(window.refreshFor('chat-1', 'run-old')).resolves.toBe(true)

    h.setWitness('witness-2')
    await expect(window.refreshFor('chat-1', 'run-current')).resolves.toBe(false)

    expect(h.query.mock.calls.map(([query]) => query.method)).toEqual([
      'open',
      'host-runs',
      'release',
      'open',
      'host-runs',
      'release'
    ])
    // The last indexed row stays visible but the window cannot claim it is current.
    expect(window.snapshot()).toEqual({
      entries: [
        expect.objectContaining({
          chatId: 'chat-1',
          sourceWitness: 'witness-1',
          run: expect.objectContaining({ runId: 'run-old' })
        })
      ],
      total: 1,
      complete: false
    })
    window.dispose()
  })

  it('never proves a run from an old-witness row while the index lags the mirror', async () => {
    const h = mirrorHarness()
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'open') return opened()
      if (query.method === 'release') return true
      // The index still serves the previous source's rows, run id included.
      if (query.method === 'host-runs') return page('witness-1', 'run-1')
      throw new Error(`unexpected query ${query.method}`)
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await expect(window.refreshFor('chat-1', 'run-1')).resolves.toBe(true)

    h.setWitness('witness-2')

    await expect(window.refreshFor('chat-1', 'run-1')).resolves.toBe(false)
    expect(window.snapshot()).toEqual({
      entries: [expect.objectContaining({ chatId: 'chat-1', sourceWitness: 'witness-1' })],
      total: 1,
      complete: false
    })
    window.dispose()
  })
})

describe('ThreadCatalogueHostRunWindow.snapshot', () => {
  const current = (sourceWitness: string) =>
    expect.objectContaining({
      chatId: 'chat-1',
      sourceWitness,
      run: expect.objectContaining({ runId: 'run-1' })
    })

  it('keeps a chat’s last indexed rows across a witness change until a current refresh', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'host-runs') {
        hostRunQueries += 1
        return page(hostRunQueries === 1 ? 'witness-1' : 'witness-2', 'run-1')
      }
      throw new Error(`unexpected query ${query.method}`)
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-1')],
      total: 1,
      complete: true
    })

    // A persist publishes a new source: hiding the rows here read as deletion,
    // and a command-scoped diff tombstoned every run the chat had.
    h.setWitness('witness-2')
    expect(window.snapshot()).toEqual({
      entries: [current('witness-1')],
      total: 1,
      complete: false
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-2')],
      total: 1,
      complete: true
    })
    window.dispose()
  })

  it('drops a removed chat’s rows and never restores them from a lagging index', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'host-runs') {
        hostRunQueries += 1
        return page('witness-1', 'run-1')
      }
      throw new Error(`unexpected query ${query.method}`)
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(window.snapshot().entries).toEqual([current('witness-1')])

    h.remove()
    expect(window.snapshot().entries).toEqual([])

    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot()).toEqual({ entries: [], total: 1, complete: false })
    window.dispose()
  })

  // Offset pages over an active-then-recency order: a re-index of the chat
  // between two page reads can move one run across the page boundary.
  it.each([
    ['the current later copy', 'witness-1', 'witness-2', 'witness-2', 'witness-2'],
    ['the current earlier copy', 'witness-2', 'witness-1', 'witness-2', 'witness-2'],
    ['the later copy when neither is current', 'witness-1', 'witness-2', 'witness-3', 'witness-2']
  ])(
    'keeps one row per run when a refresh spans a re-index, preferring %s',
    async (_label, firstPage, secondPage, mirrorWitness, keptWitness) => {
      vi.useFakeTimers()
      const h = mirrorHarness()
      h.query.mockImplementation(async (query: { method: string; offset?: number }) => {
        if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
        return query.offset === 0
          ? { entries: page(firstPage, 'run-1').entries, total: 2, next: 1 }
          : { entries: page(secondPage, 'run-1').entries, total: 2, next: null }
      })
      h.setWitness(mirrorWitness)
      const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
      await vi.advanceTimersByTimeAsync(100)

      const { entries, complete } = window.snapshot()
      expect(entries).toEqual([current(keptWitness)])
      expect(complete).toBe(false)
      window.dispose()
    }
  )

  // The mirror fans out nothing when the index catches up with a witness it
  // already observed, so only the window itself can ask again.
  it('asks again with bounded backoff while kept rows are stale', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page(hostRunQueries === 1 || hostRunQueries >= 5 ? 'witness-2' : 'witness-1', 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(window.snapshot().complete).toBe(true)

    h.setWitness('witness-3')
    h.setWitness('witness-2')
    await vi.advanceTimersByTimeAsync(100)
    // The index answers with the previous source for three reads.
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot().complete).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(3)
    await vi.advanceTimersByTimeAsync(199)
    expect(hostRunQueries).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(hostRunQueries).toBe(4)
    await vi.advanceTimersByTimeAsync(400)
    expect(hostRunQueries).toBe(5)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-2')],
      total: 1,
      complete: true
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hostRunQueries).toBe(5)
    window.dispose()
  })

  it('stops asking after a bounded number of stale reads until the mirror changes', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page('witness-1', 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // One debounced read, then eight retries: 100 ms doubling to a 5 s cap.
    expect(hostRunQueries).toBe(9)
    expect(window.snapshot().complete).toBe(false)

    // A mirror event restores the budget: the next stale read retries again.
    h.setWitness('witness-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(10)
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(11)
    window.dispose()
  })

  it('keeps the stale budget spent when the mirror event is about another chat', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page('witness-1', 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hostRunQueries).toBe(9)

    h.touch('chat-2')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // One debounced read for the event, and no fresh budget for chat-1.
    expect(hostRunQueries).toBe(10)
    window.dispose()
  })

  // Every persist of a windowed chat finds that chat's own rows stale.
  it('keeps a chat the index never catches up with to its own budget while another chat persists', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    h.setWitness('other-1', 'chat-2')
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      const run = (runId: string) => ({ runId, provider: 'muse', status: 'running' })
      return {
        entries: [
          // chat-1's index never leaves its first source; chat-2's keeps up.
          { chatId: 'chat-1', sourceWitness: 'witness-1', run: run('run-1') },
          {
            chatId: 'chat-2',
            sourceWitness: h.mirror.sourceWitnessFor('chat-2')!,
            run: run('run-2')
          }
        ],
        total: 2,
        next: null
      }
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hostRunQueries).toBe(9)

    for (let persist = 2; persist <= 11; persist += 1) {
      h.setWitness(`other-${persist}`, 'chat-2')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // One debounced read per chat-2 persist, and no retry for chat-1.
    expect(hostRunQueries).toBe(19)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hostRunQueries).toBe(19)
    expect(window.snapshot().complete).toBe(false)
    window.dispose()
  })

  it('gives a chat a fresh budget each time it goes stale again', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page(hostRunQueries < 3 ? 'witness-1' : 'witness-2', 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // Two stale reads, then current.
    expect(hostRunQueries).toBe(3)

    h.setWitnessSilently('witness-3')
    h.touch('chat-2')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // The event's read, then all eight retries again.
    expect(hostRunQueries).toBe(12)
    window.dispose()
  })

  it('bounds the re-reads of a torn window, and restores them after a read that is not torn', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let torn = true
    let refreshes = 0
    h.query.mockImplementation(async (query: { method: string; offset?: number }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      if (query.offset === 0) refreshes += 1
      if (!torn) return page('witness-2', 'run-1')
      // The chat re-indexes between the two page reads, every time.
      return query.offset === 0
        ? { entries: page('witness-1', 'run-1').entries, total: 2, next: 1 }
        : { entries: page('witness-2', 'run-1').entries, total: 2, next: null }
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // One debounced read, then eight retries.
    expect(refreshes).toBe(9)

    torn = false
    h.setWitness('witness-2')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refreshes).toBe(10)
    expect(window.snapshot().complete).toBe(true)

    // That read restored the budget, so the next torn read retries.
    torn = true
    h.setWitness('witness-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(refreshes).toBe(11)
    torn = false
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(refreshes).toBe(12)
    expect(window.snapshot().complete).toBe(true)
    window.dispose()
  })

  it('never lets a stale chat’s backoff delay the refresh another chat’s event asks for', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page('witness-1', 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    // Reads at 100, 200, 400, 800 and 1,600 ms; the next retry is due at 3,200.
    await vi.advanceTimersByTimeAsync(1_700)
    expect(hostRunQueries).toBe(5)

    h.touch('chat-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(6)
    window.dispose()
  })

  it('keeps an event’s refresh when a retry armed after it would come later', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    const held: Array<ReturnType<typeof deferred<RunWindowPage>>> = []
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      if (hostRunQueries !== 5) return page('witness-1', 'run-1')
      const read = deferred<RunWindowPage>()
      held.push(read)
      return read.promise
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    // Reads at 100, 200, 400 and 800 ms; the fifth, at 1,600, is held.
    await vi.advanceTimersByTimeAsync(1_600)
    expect(hostRunQueries).toBe(5)

    // An event arrives mid-read, then the read ends stale and arms a 1.6 s retry.
    h.touch('chat-2')
    held[0]!.resolve(page('witness-1', 'run-1'))
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(6)
    window.dispose()
  })

  it('does not retry for rows of a chat the mirror has yet to learn', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return {
        entries: [
          ...page('witness-1', 'run-1').entries,
          { chatId: 'chat-unlisted', sourceWitness: 'witness-x', run: { runId: 'run-x' } }
        ],
        total: 2,
        next: null
      }
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // The mirror announces a chat it learns, so no retry is owed here.
    expect(hostRunQueries).toBe(1)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-1')],
      total: 2,
      complete: false
    })
    window.dispose()
  })

  it('settles on a record repeating a run id once a second read repeats it', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return {
        entries: [...page('witness-1', 'run-1').entries, ...page('witness-1', 'run-1').entries],
        total: 2,
        next: null
      }
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-1')],
      total: 2,
      complete: true
    })
    window.dispose()
  })

  // Another chat moving up the order between two page reads repeats the rows
  // at the boundary under their own witness, and skips that chat's rows.
  it('does not settle on a run repeated across a page boundary until a read agrees', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string; offset?: number }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      if (query.offset === 0) hostRunQueries += 1
      if (hostRunQueries > 1) {
        return {
          entries: [...page('witness-1', 'run-1').entries, ...page('witness-1', 'run-2').entries],
          total: 2,
          next: null
        }
      }
      return query.offset === 0
        ? { entries: page('witness-1', 'run-1').entries, total: 2, next: 1 }
        : { entries: page('witness-1', 'run-1').entries, total: 2, next: null }
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(1)
    expect(window.snapshot().complete).toBe(false)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot()).toEqual({
      entries: [
        current('witness-1'),
        expect.objectContaining({ run: expect.objectContaining({ runId: 'run-2' }) })
      ],
      total: 2,
      complete: true
    })
    window.dispose()
  })

  it('re-arms the stale retry when a queued-start barrier cannot refresh', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let indexWitness = 'witness-1'
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'open') {
        return { leaseId: 'lease-1', entry: { snapshot: true, projection: {} } }
      }
      if (query.method === 'release') return true
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page(indexWitness, 'run-1')
    })
    h.setWitness('witness-2')
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(1)

    // The barrier cancels the pending retry and returns before refreshing.
    await expect(window.refreshFor('chat-1', 'run-1')).resolves.toBe(false)
    indexWitness = 'witness-2'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-2')],
      total: 1,
      complete: true
    })
    window.dispose()
  })

  it('restores the refresh a barrier cancelled when it cannot refresh an unsettled window', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method === 'open') return null
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return page('witness-1', 'run-1')
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())

    // The window's first refresh is still pending when the barrier cancels it.
    await expect(window.refreshFor('chat-1', 'run-1')).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(1)
    expect(window.snapshot()).toEqual({
      entries: [current('witness-1')],
      total: 1,
      complete: true
    })
    window.dispose()
  })
})

describe('ThreadCatalogueHostRunWindow.loaded', () => {
  it('is false until a read completes, and neither a mirror event nor a moved witness unloads it', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    const read = deferred<RunWindowPage>()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return hostRunQueries === 1 ? read.promise : page('witness-2', 'run-1')
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    // Before the first read: an empty window must never stand for the profile.
    expect(window.loaded).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(window.loaded).toBe(false)
    read.resolve(page('witness-1', 'run-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(window.loaded).toBe(true)

    // A persist: the event arms a refresh and the chat's rows go stale. The
    // served rows are still its last indexed rows, so the window stays loaded.
    h.setWitness('witness-2')
    expect(window.snapshot().complete).toBe(false)
    expect(window.loaded).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(2)
    expect(window.loaded).toBe(true)
    window.dispose()
  })

  it('is false while the mirror is partial or the last read skipped a chat it has not listed', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    let unlisted = true
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      return {
        entries: [
          ...page('witness-1', 'run-1').entries,
          ...(unlisted
            ? [{ chatId: 'chat-unlisted', sourceWitness: 'witness-x', run: { runId: 'run-x' } }]
            : [])
        ],
        total: unlisted ? 2 : 1,
        next: null
      }
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(window.loaded).toBe(false)

    unlisted = false
    h.touch('chat-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(window.loaded).toBe(true)
    ;(h.mirror as unknown as { complete: boolean }).complete = false
    expect(window.loaded).toBe(false)
    window.dispose()
  })
})

describe('ThreadCatalogueHostRunWindow.snapshot completeness', () => {
  it('stays complete across a mirror event and the refresh it arms while the served rows are current', async () => {
    vi.useFakeTimers()
    const h = mirrorHarness()
    const read = deferred<RunWindowPage>()
    let hostRunQueries = 0
    h.query.mockImplementation(async (query: { method: string }) => {
      if (query.method !== 'host-runs') throw new Error(`unexpected query ${query.method}`)
      hostRunQueries += 1
      return hostRunQueries === 1 ? page('witness-1', 'run-1') : read.promise
    })
    const window = new ThreadCatalogueHostRunWindow(h.mirror, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    expect(window.snapshot().complete).toBe(true)

    // Another chat's persist: an event, a debounce, then a refresh in flight.
    // Nothing served changes, so the flag must not flip and flip back.
    h.touch('chat-2')
    expect(window.snapshot().complete).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(hostRunQueries).toBe(2)
    expect(window.snapshot().complete).toBe(true)
    read.resolve(page('witness-1', 'run-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(window.snapshot()).toEqual({
      entries: [expect.objectContaining({ chatId: 'chat-1', sourceWitness: 'witness-1' })],
      total: 1,
      complete: true
    })
    window.dispose()
  })
})
