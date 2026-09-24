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
  let witness = 'witness-1'
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
      return chatId === 'chat-1' ? witness : undefined
    }
  } as unknown as ThreadCatalogueMirror
  return {
    mirror,
    query,
    setWitness(next: string) {
      witness = next
      listener?.({} as object, 'chat-1')
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

  it('returns false on query failure, releases the lease, and never exposes an old-witness row', async () => {
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
    expect(window.snapshot().entries).toEqual([])
    window.dispose()
  })
})
