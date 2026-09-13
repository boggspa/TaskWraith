import { describe, expect, it } from 'vitest'

import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import { ThreadCatalogueMirror, type ThreadCatalogueReadPort } from './ThreadCatalogueMirror'

function projection(title: string, revision: number): ThreadCatalogueProjection {
  return {
    revision,
    summary: {
      chatId: 'chat-one',
      title,
      provider: 'codex',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: revision + 1,
      archived: false,
      messageCount: 0,
      runCount: 0
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

function changes(sequence: number, entries: Array<{ sequence: number; removed: boolean }> = []) {
  return {
    reset: false,
    changes: entries.map((entry) => ({ ...entry, chatId: 'chat-one' })),
    position: { incarnation: 'worker-one', sequence }
  }
}

describe('ThreadCatalogueMirror local observations', () => {
  it('invalidates an in-flight list before it can overwrite a committed local write', async () => {
    let releaseList!: (value: unknown) => void
    let listStarted!: () => void
    const started = new Promise<void>((resolve) => {
      listStarted = resolve
    })
    const list = new Promise((resolve) => {
      releaseList = resolve
    })
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(0) as never
        if (query.method === 'open') return opened('local', 1) as never
        if (query.method === 'release') return true as never
        listStarted()
        return list as never
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    const refreshing = mirror.refresh()
    await started
    const epoch = mirror.observationEpoch
    mirror.observe(projection('local', 1), 'witness-local')
    expect(mirror.observationEpoch).toBeGreaterThan(epoch)
    releaseList({
      entries: [{ projection: projection('stale', 0), sourceWitness: 'witness-stale' }],
      next: null,
      coverage: 'complete',
      repairPending: []
    })
    await refreshing
    expect(mirror.get('chat-one')?.summary.title).toBe('local')
  })

  it('accepts a current same-revision Desktop overlay indexed before the first cursor read', async () => {
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(5) as never
        if (query.method === 'list')
          return {
            entries: [
              {
                projection: projection('later-desktop-overlay', 1),
                sourceWitness: 'witness-after-desktop'
              }
            ],
            next: null,
            coverage: 'complete',
            repairPending: []
          } as never
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    mirror.observe(projection('host-local', 1), 'witness-host')
    await mirror.refresh()
    expect(mirror.get('chat-one')?.summary.title).toBe('later-desktop-overlay')
    expect(mirror.sourceWitnessFor('chat-one')).toBe('witness-after-desktop')
  })

  it('retains a local row across partial absence and removes it on explicit deletion', async () => {
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(8) as never
        if (query.method === 'list')
          return { entries: [], next: null, coverage: 'partial', repairPending: [] } as never
        if (query.method === 'open') return opened('local', 2) as never
        if (query.method === 'release') return true as never
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    mirror.observe(projection('local', 2), 'witness-local')
    await mirror.refresh()
    expect(mirror.get('chat-one')?.summary.title).toBe('local')

    mirror.forget('chat-one')
    expect(mirror.get('chat-one')).toBeUndefined()
    expect(mirror.sourceWitnessFor('chat-one')).toBeUndefined()
  })
})

function opened(title: string, revision: number, snapshot = false) {
  return {
    leaseId: `lease-${title}`,
    entry: { projection: projection(title, revision), sourceWitness: `witness-${title}`, snapshot }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function incrementalPort() {
  let sequence = 0
  const events: Array<{ sequence: number; removed: boolean }> = []
  let answer: ReturnType<typeof opened> | null | Promise<ReturnType<typeof opened> | null> = null
  const requests: Array<{ method: string; mode?: string; chatId?: string; leaseId?: string }> = []
  const port: ThreadCatalogueReadPort = {
    query: async (query) => {
      requests.push(query)
      if (query.method === 'changes')
        return changes(
          sequence,
          query.position ? events.filter((event) => event.sequence > query.position!.sequence) : []
        ) as never
      if (query.method === 'list')
        return { entries: [], next: null, coverage: 'partial', repairPending: [] } as never
      if (query.method === 'open') return (await answer) as never
      if (query.method === 'release') return true as never
      throw new Error(`Unexpected ${query.method}`)
    }
  }
  return {
    port,
    requests,
    remove() {
      events.push({ sequence: ++sequence, removed: true })
    },
    answer(value: typeof answer) {
      answer = value
    }
  }
}

describe('ThreadCatalogueMirror current-state removal confirmation', () => {
  it('removes a truly deleted local row on an incremental cursor despite unrelated partial coverage', async () => {
    const backend = incrementalPort()
    const mirror = new ThreadCatalogueMirror(backend.port)
    await mirror.refresh()
    mirror.observe(projection('local', 2), 'local-witness')
    backend.remove()
    backend.answer(null)
    await mirror.refresh()
    expect(mirror.get('chat-one')).toBeUndefined()
    expect(mirror.sourceWitnessFor('chat-one')).toBeUndefined()
    expect(backend.requests.filter((query) => query.method === 'open')).toEqual([
      { method: 'open', chatId: 'chat-one', mode: 'metadata' }
    ])
    await mirror.refresh()
    expect(backend.requests.filter((query) => query.method === 'open')).toHaveLength(1)
  })

  it('confirms a local row missing before the first cursor without retaining a deleted task forever', async () => {
    const backend = incrementalPort()
    backend.remove()
    const mirror = new ThreadCatalogueMirror(backend.port)
    mirror.observe(projection('local', 2), 'local-witness')
    await mirror.refresh()
    expect(mirror.get('chat-one')).toBeUndefined()
    expect(backend.requests.filter((query) => query.method === 'open')).toHaveLength(1)
  })

  it('accepts current same-revision overlay metadata instead of applying an old removed event', async () => {
    const backend = incrementalPort()
    const mirror = new ThreadCatalogueMirror(backend.port)
    await mirror.refresh()
    mirror.observe(projection('local', 2), 'local-witness')
    backend.remove()
    backend.answer(opened('desktop-overlay', 2))
    await mirror.refresh()
    expect(mirror.get('chat-one')?.summary.title).toBe('desktop-overlay')
    expect(mirror.sourceWitnessFor('chat-one')).toBe('witness-desktop-overlay')
    expect(backend.requests.filter((query) => query.method === 'release')).toEqual([
      { method: 'release', leaseId: 'lease-desktop-overlay' }
    ])
    await mirror.refresh()
    expect(backend.requests.filter((query) => query.method === 'open')).toHaveLength(1)
    backend.remove()
    backend.answer(null)
    await mirror.refresh()
    expect(mirror.get('chat-one')).toBeUndefined()
  })

  it('rejects and releases an unpublished snapshot, then retries the same change cursor', async () => {
    const backend = incrementalPort()
    const mirror = new ThreadCatalogueMirror(backend.port)
    await mirror.refresh()
    mirror.observe(projection('local', 2), 'local-witness')
    backend.remove()
    backend.answer(opened('unpublished', 2, true))
    await expect(mirror.refresh()).rejects.toThrow('History changed during indexing')
    expect(mirror.get('chat-one')?.summary.title).toBe('local')
    expect(backend.requests.filter((query) => query.method === 'release')).toHaveLength(1)
    backend.answer(null)
    await mirror.refresh()
    expect(mirror.get('chat-one')).toBeUndefined()
    expect(backend.requests.filter((query) => query.method === 'open')).toHaveLength(2)
  })

  it('releases a stale confirmation lease without overwriting a newer local observation', async () => {
    const backend = incrementalPort()
    const mirror = new ThreadCatalogueMirror(backend.port)
    await mirror.refresh()
    mirror.observe(projection('local', 2), 'local-witness')
    backend.remove()
    const reply = deferred<ReturnType<typeof opened> | null>()
    backend.answer(reply.promise)
    const refreshing = mirror.refresh()
    while (!backend.requests.some((query) => query.method === 'open')) await Promise.resolve()
    mirror.observe(projection('newer-local', 3), 'newer-witness')
    reply.resolve(opened('older-confirmation', 2))
    await refreshing
    expect(mirror.get('chat-one')?.summary.title).toBe('newer-local')
    expect(backend.requests.filter((query) => query.method === 'release')).toEqual([
      { method: 'release', leaseId: 'lease-older-confirmation' }
    ])
  })
})

function identified(chatId: string, title: string, revision = 1): ThreadCatalogueProjection {
  const result = projection(title, revision)
  return { ...result, summary: { ...result.summary, chatId } }
}

function neverPort(): ThreadCatalogueReadPort {
  return {
    query: async () => {
      throw new Error('port unused')
    }
  }
}

describe('ThreadCatalogueMirror re-apply equality gate', () => {
  it('notifies listeners once when the same row is re-applied with the same witness', () => {
    const mirror = new ThreadCatalogueMirror(neverPort())
    const notifications: Array<string | null> = []
    mirror.subscribe((row, chatId) =>
      notifications.push(row ? `${chatId}:${row.summary.title}` : `${chatId}:removed`)
    )

    mirror.observe(projection('same', 1), 'witness-a')
    // The poll re-applies indexed rows every pass; a same-content apply is not
    // news. Before the gate, each duplicate fanned listeners out again and one
    // save produced a saveless invalidation storm.
    mirror.observe(projection('same', 1), 'witness-a')
    mirror.observe(
      { ...projection('same', 1), summary: { ...projection('same', 1).summary } },
      'witness-a'
    )

    expect(notifications).toEqual(['chat-one:same'])
  })

  it('still notifies when content changes and on removal, but not for a witness-only re-apply', () => {
    const mirror = new ThreadCatalogueMirror(neverPort())
    const notifications: Array<string | null> = []
    mirror.subscribe((row, chatId) =>
      notifications.push(row ? `${chatId}:${row.summary.title}` : `${chatId}:removed`)
    )

    mirror.observe(projection('one', 1), 'witness-a')
    mirror.observe(projection('two', 2), 'witness-a')
    // A witness-only change (e.g. the deferred Host checkpoint rewriting the
    // file after the edit) carries no new information to listeners — the
    // payload is (row, chatId) with no witness — so it must not fan out.
    mirror.observe(projection('two', 2), 'witness-b')
    mirror.forget('chat-one')

    expect(notifications).toEqual(['chat-one:one', 'chat-one:two', 'chat-one:removed'])
    // The witness bookkeeping still advanced for consumers that read it.
    expect(mirror.sourceWitnessFor('chat-one')).toBeUndefined() // removed
  })

  it('advances the stored witness on a witness-only re-apply without notifying', () => {
    const mirror = new ThreadCatalogueMirror(neverPort())
    const notifications: string[] = []
    mirror.subscribe((_row, chatId) => notifications.push(chatId))
    mirror.observe(projection('same', 1), 'witness-a')
    mirror.observe(projection('same', 1), 'witness-b')
    expect(notifications).toEqual(['chat-one'])
    expect(mirror.sourceWitnessFor('chat-one')).toBe('witness-b')
  })
})
describe('ThreadCatalogueMirror local streaming isolation', () => {
  it.each([1, 2])(
    'keeps deep cold rows progressing when another chat writes during page %i',
    async (writeOnPage) => {
      let firstPages = 0,
        secondPages = 0,
        opens = 0,
        releases = 0,
        revision = 0
      let active = identified('active', 'initial', revision)
      const write = () => {
        active = identified('active', `stream-${++revision}`, revision)
        mirror.observe(active, `local-${revision}`)
      }
      const port: ThreadCatalogueReadPort = {
        query: async (query) => {
          if (query.method === 'changes') return changes(0) as never
          if (query.method === 'list') {
            if (!query.before) {
              firstPages++
              if (writeOnPage === 1) write()
              return {
                entries: [{ projection: identified('cold-one', 'Cold one') }],
                next: { updatedAt: 1, chatId: 'cold-one' },
                coverage: 'complete',
                repairPending: []
              } as never
            }
            secondPages++
            if (writeOnPage === 2) write()
            return {
              entries: [{ projection: identified('cold-two', 'Cold two') }],
              next: null,
              coverage: 'complete',
              repairPending: []
            } as never
          }
          if (query.method === 'open') {
            opens++
            const captured = active
            // Sustained writing also changes this chat during its one-off read.
            // That stale read must not restart the poll or retry in the same poll.
            write()
            return {
              leaseId: `lease-${opens}`,
              entry: { projection: captured, sourceWitness: 'captured', snapshot: false }
            } as never
          }
          if (query.method === 'release') {
            releases++
            return true as never
          }
          throw new Error(`Unexpected query ${query.method}`)
        }
      }
      const mirror = new ThreadCatalogueMirror(port)
      for (let index = 0; index < 3; index++) await mirror.refresh()
      expect(mirror.get('cold-one')?.summary.title).toBe('Cold one')
      expect(mirror.get('cold-two')?.summary.title).toBe('Cold two')
      expect(mirror.get('active')?.summary.title).toBe(active.summary.title)
      expect(firstPages).toBe(1)
      expect(secondPages).toBe(1)
      expect(opens).toBe(3)
      expect(releases).toBe(opens)
    }
  )

  it('keeps a local write stamp after a newer refresh confirms it so an older refresh cannot overwrite it', async () => {
    const oldPage = deferred<unknown>()
    const pageStarted = deferred<void>()
    let sequence = 0
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes')
          return changes(
            sequence,
            query.position && query.position.sequence < sequence
              ? [{ sequence, removed: false }]
              : []
          ) as never
        if (query.method === 'list' && query.limit === 100) {
          pageStarted.resolve()
          return (await oldPage.promise) as never
        }
        if (query.method === 'list')
          return {
            entries: [{ projection: projection('local', 2) }],
            next: null,
            coverage: 'complete',
            repairPending: []
          } as never
        if (query.method === 'summary')
          return { projection: projection('local', 2), sourceWitness: 'local-witness' } as never
        if (query.method === 'open') return opened('local', 2) as never
        if (query.method === 'release') return true as never
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    const older = mirror.refresh()
    await pageStarted.promise
    mirror.observe(projection('local', 2), 'local-witness')
    sequence = 1
    await mirror.refresh()
    expect(mirror.get('chat-one')?.summary.title).toBe('local')
    oldPage.resolve({
      entries: [{ projection: projection('stale', 1), sourceWitness: 'stale-witness' }],
      next: null,
      coverage: 'complete',
      repairPending: []
    })
    await older
    expect(mirror.get('chat-one')?.summary.title).toBe('local')
    expect(mirror.sourceWitnessFor('chat-one')).toBe('local-witness')
  })

  it('re-lists after a first page fails instead of adopting a cursor it never listed against', async () => {
    let attempts = 0
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(4) as never
        if (query.method === 'list') {
          attempts++
          if (attempts <= 2) throw new Error('History read failed')
          return {
            entries: [{ projection: identified('cold-one', 'Cold one') }],
            next: null,
            coverage: 'complete',
            repairPending: []
          } as never
        }
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    await expect(mirror.refresh()).rejects.toThrow('History read failed')
    // The failed pass must not leave the mirror believing it is caught up: a
    // second pass that skips the listing would hide the whole corpus forever.
    await expect(mirror.refresh()).rejects.toThrow('History read failed')
    expect(attempts).toBe(2)
    expect(mirror.projections()).toEqual([])
    expect(mirror.complete).toBe(false)

    await mirror.refresh()
    expect(attempts).toBe(3)
    expect(mirror.get('cold-one')?.summary.title).toBe('Cold one')
    expect(mirror.complete).toBe(true)
  })

  it('resumes a failed listing at the page that failed and keeps the pages already applied', async () => {
    const firstPage = { updatedAt: 1, chatId: 'cold-one' }
    let secondAttempts = 0
    const requested: Array<{ updatedAt: number; chatId: string } | null> = []
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(7) as never
        if (query.method === 'list') {
          requested.push(query.before ?? null)
          if (!query.before)
            return {
              entries: [{ projection: identified('cold-one', 'Cold one') }],
              next: firstPage,
              coverage: 'complete',
              repairPending: []
            } as never
          if (++secondAttempts === 1) throw new Error('History page failed')
          return {
            entries: [{ projection: identified('cold-two', 'Cold two') }],
            next: null,
            coverage: 'complete',
            repairPending: []
          } as never
        }
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    await expect(mirror.refresh()).rejects.toThrow('History page failed')
    expect(mirror.get('cold-one')?.summary.title).toBe('Cold one')
    expect(mirror.get('cold-two')).toBeUndefined()

    await mirror.refresh()
    expect(mirror.get('cold-one')?.summary.title).toBe('Cold one')
    expect(mirror.get('cold-two')?.summary.title).toBe('Cold two')
    // The resumed pass asks for the failed page only; page one is never replayed.
    expect(requested).toEqual([null, firstPage, firstPage])
  })

  it('does not remove a row listed before a resumed listing completes', async () => {
    let secondAttempts = 0
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(9) as never
        if (query.method === 'list') {
          if (!query.before)
            return {
              entries: [{ projection: identified('cold-one', 'Cold one') }],
              next: { updatedAt: 1, chatId: 'cold-one' },
              coverage: 'complete',
              repairPending: []
            } as never
          if (++secondAttempts === 1) throw new Error('History page failed')
          return {
            entries: [{ projection: identified('cold-two', 'Cold two') }],
            next: null,
            coverage: 'complete',
            repairPending: []
          } as never
        }
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    await expect(mirror.refresh()).rejects.toThrow('History page failed')
    // cold-one arrived on the resumed listing's own first page, so the
    // completeness sweep must not read its absence from page two as deletion.
    await mirror.refresh()
    expect(mirror.get('cold-one')?.summary.title).toBe('Cold one')
    expect(mirror.get('cold-two')?.summary.title).toBe('Cold two')
  })

  it('invalidates all old pages on erasure even though ordinary local writes no longer invalidate the poll', async () => {
    const second = deferred<unknown>()
    const secondStarted = deferred<void>()
    const port: ThreadCatalogueReadPort = {
      query: async (query) => {
        if (query.method === 'changes') return changes(0) as never
        if (query.method === 'list' && !query.before)
          return {
            entries: [{ projection: identified('cold-one', 'Cold one') }],
            next: { updatedAt: 1, chatId: 'cold-one' },
            coverage: 'complete',
            repairPending: []
          } as never
        if (query.method === 'list') {
          secondStarted.resolve()
          return (await second.promise) as never
        }
        throw new Error(`Unexpected query ${query.method}`)
      }
    }
    const mirror = new ThreadCatalogueMirror(port)
    const reading = mirror.refresh()
    await secondStarted.promise
    const epoch = mirror.observationEpoch
    mirror.forgetAll()
    expect(mirror.observationEpoch).toBeGreaterThan(epoch)
    second.resolve({
      entries: [{ projection: identified('cold-two', 'Cold two') }],
      next: null,
      coverage: 'complete',
      repairPending: []
    })
    await reading
    expect(mirror.projections()).toEqual([])
    expect(mirror.complete).toBe(false)
  })
})
