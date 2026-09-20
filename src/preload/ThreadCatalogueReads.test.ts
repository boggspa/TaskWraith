import { describe, expect, it, vi } from 'vitest'
import { createThreadCatalogueReads } from './ThreadCatalogueReads'

const RECORD = { appChatId: 'chat-1', title: 'From disk' }

/**
 * `open` resolves `{ available, data }`; every other call goes through the
 * generic `query` wrapper, which throws when `available` is false.
 */
function makeInvoke(handlers: Record<string, (...args: any[]) => any>) {
  return vi.fn(async (channel: string, ...args: any[]) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`unexpected channel ${channel}`)
    return handler(...args)
  })
}

describe('getChat falls back to the canonical disk read', () => {
  it('falls back when the whole catalogue is unavailable', async () => {
    const invoke = makeInvoke({
      'thread-catalogue:read': () => ({ available: false, data: null }),
      'get-chat': () => RECORD
    })
    await expect(createThreadCatalogueReads(invoke).getChat('chat-1')).resolves.toEqual(RECORD)
    expect(invoke).toHaveBeenCalledWith('get-chat', 'chat-1')
  })

  it('falls back when the catalogue reports a per-chat miss', async () => {
    // THE BUG: this resolved `null`, so an indexed-but-missing chat opened
    // blank even though chats/<id>.json was intact on disk.
    const invoke = makeInvoke({
      'thread-catalogue:read': () => ({ available: true, data: null }),
      'get-chat': () => RECORD
    })
    await expect(createThreadCatalogueReads(invoke).getChat('chat-1')).resolves.toEqual(RECORD)
    expect(invoke).toHaveBeenCalledWith('get-chat', 'chat-1')
  })
})

describe('lease cleanup never blocks or replaces a completed read', () => {
  it.each(['record', 'message', 'page'] as const)(
    'returns a completed %s while cleanup is still pending',
    async (kind) => {
      vi.useFakeTimers()
      let rejectRelease!: (error: Error) => void
      const release = new Promise<never>((_resolve, reject) => {
        rejectRelease = reject
      })
      const message = {
        id: 'message-1',
        role: 'assistant',
        content: 'Ready to display',
        timestamp: '2026-09-20T12:00:00.000Z'
      }
      const invoke = makeInvoke({
        'thread-catalogue:read': (q: { method: string; kind?: string }) => {
          if (q.method === 'open') {
            return {
              available: true,
              data: {
                leaseId: 'lease-1',
                entry: { projection: { summary: { messageCount: 1, updatedAt: 2 } } }
              }
            }
          }
          if (q.method === 'ordinal') return { available: true, data: 0 }
          if (q.method === 'page-runs') return { available: true, data: [] }
          if (q.method === 'objects') {
            return {
              available: true,
              data: [
                {
                  kind: 'inline',
                  value: q.kind === 'record' ? RECORD : message,
                  ordinal: 0,
                  byteLength: 100
                }
              ]
            }
          }
          if (q.method === 'release') return release
          throw new Error(`unexpected method ${q.method}`)
        }
      })
      const reads = createThreadCatalogueReads(invoke)
      const completed = vi.fn()
      try {
        const read =
          kind === 'record'
            ? reads.getChat('chat-1')
            : kind === 'message'
              ? reads.getTranscriptMessage('chat-1', 'message-1')
              : reads.getChatTranscriptPage({ chatId: 'chat-1', maxMessages: 1 })
        void read.then(completed)
        await vi.advanceTimersByTimeAsync(0)
        expect(invoke).toHaveBeenCalledWith('thread-catalogue:read', {
          method: 'release',
          leaseId: 'lease-1'
        })
        expect(completed).toHaveBeenCalledWith(
          kind === 'record'
            ? RECORD
            : kind === 'message'
              ? message
              : expect.objectContaining({ messages: [message] })
        )
      } finally {
        // A late cleanup failure is handled even after its consumer has the data.
        rejectRelease(new Error('late cleanup failure'))
        await vi.advanceTimersByTimeAsync(0)
        vi.useRealTimers()
      }
    }
  )

  it('returns the record even when releasing its lease rejects', async () => {
    const invoke = makeInvoke({
      'thread-catalogue:read': (q: { method: string }) => {
        if (q.method === 'open') {
          return { available: true, data: { leaseId: 'lease-1', entry: {} } }
        }
        if (q.method === 'objects') {
          return { available: true, data: [{ kind: 'inline', value: RECORD, ordinal: 0 }] }
        }
        if (q.method === 'release') throw new Error('lease registry is gone')
        throw new Error(`unexpected method ${q.method}`)
      }
    })
    // Before the guard the rejection from the bare `await` inside `finally`
    // replaced the resolved record, so a successful read surfaced as a failure.
    await expect(createThreadCatalogueReads(invoke).getChat('chat-1')).resolves.toEqual(RECORD)
  })
})

describe('getChatTranscriptPage falls back to the canonical page read', () => {
  it('falls back when the catalogue reports a per-chat miss', async () => {
    const page = { messages: [], hasOlder: false }
    const invoke = makeInvoke({
      'thread-catalogue:read': () => ({ available: true, data: null }),
      'get-chat-transcript-page': () => page
    })
    const request = { chatId: 'chat-1' }
    await expect(
      createThreadCatalogueReads(invoke).getChatTranscriptPage(request as never)
    ).resolves.toEqual(page)
    expect(invoke).toHaveBeenCalledWith('get-chat-transcript-page', request)
  })
})

describe('one thread’s run history never blanks every other thread’s', () => {
  const projection = (id: string) => ({
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
      messageCount: 1,
      runCount: 1
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

  /** `bad` is the chat whose run-summary read fails; `good` always succeeds. */
  const invokeWith = (badPage: unknown, release?: Promise<unknown>) => {
    const served = new Set<string>()
    return makeInvoke({
      'thread-catalogue:read': (q: any) => {
        if (q.method === 'list')
          return {
            available: true,
            data: {
              entries: [{ projection: projection('good') }, { projection: projection('bad') }],
              next: null
            }
          }
        if (q.method === 'open') return { available: true, data: { leaseId: `lease-${q.chatId}` } }
        if (q.method === 'release') return release ?? { available: true, data: null }
        if (q.method === 'objects') {
          if (q.leaseId === 'lease-bad') return { available: true, data: badPage }
          if (served.has(q.leaseId)) return { available: true, data: [] }
          served.add(q.leaseId)
          return {
            available: true,
            data: [{ kind: 'inline', ordinal: 0, value: { runId: 'r1' } }]
          }
        }
        throw new Error(`unexpected method ${q.method}`)
      },
      'get-chat-list': () => [{ appChatId: 'FALLBACK' }]
    })
  }

  it('continues reading the next thread while prior cleanup is pending', async () => {
    vi.useFakeTimers()
    let finishRelease!: (value: unknown) => void
    const release = new Promise((resolve) => {
      finishRelease = resolve
    })
    const completed = vi.fn()
    const invoke = invokeWith([], release)
    try {
      void createThreadCatalogueReads(invoke).getChatRunSummaries().then(completed)
      await vi.advanceTimersByTimeAsync(0)
      expect(completed).toHaveBeenCalledWith([
        expect.objectContaining({ appChatId: 'good', runsSummary: [{ runId: 'r1' }] }),
        expect.objectContaining({ appChatId: 'bad', runsSummary: [] })
      ])
      const releases = invoke.mock.calls.filter(([, query]) => query.method === 'release')
      expect(releases).toHaveLength(2)
    } finally {
      finishRelease({ available: true, data: null })
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  // Both of these threw out of getChatRunSummaries with only a `finally` to
  // catch them, so a single unreadable thread rejected the entire runs list and
  // the surface went blank -- the same shape as the lease-release bug above.
  it('survives a thread whose run-summary page is incomplete', async () => {
    const chats = await createThreadCatalogueReads(invokeWith(null)).getChatRunSummaries()
    expect(chats.map((c) => c.appChatId)).toEqual(['good', 'bad'])
    expect(chats[0].runsSummary).toHaveLength(1)
    expect(chats[1].runsSummary).toBeUndefined()
  })

  it('survives a thread whose run summary exceeds its metadata budget', async () => {
    const oversized = [{ kind: 'reference', ordinal: 0, reference: { byteLength: 99 } }]
    const chats = await createThreadCatalogueReads(invokeWith(oversized)).getChatRunSummaries()
    expect(chats.map((c) => c.appChatId)).toEqual(['good', 'bad'])
    expect(chats[0].runsSummary).toHaveLength(1)
    expect(chats[1].runsSummary).toBeUndefined()
  })

  it('does not fall back to the whole-profile disk parse for a single bad thread', async () => {
    const invoke = invokeWith(null)
    await createThreadCatalogueReads(invoke).getChatRunSummaries()
    expect(invoke).not.toHaveBeenCalledWith('get-chat-list', undefined)
  })
})
