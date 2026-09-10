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

describe('a failing lease release never demotes a completed read', () => {
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
