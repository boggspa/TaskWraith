import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatListItem, ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import type { TranscriptPage, TranscriptPageRequest } from '../../../shared/transcriptPage'
import { ChatTranscriptStore } from './chatTranscriptStore'
import {
  hydratePagedChatShell,
  requestLatestTranscriptPage,
  requestNewerTranscriptPage,
  requestOlderTranscriptPage,
  requestRevealTranscriptMessage,
  resetChatTranscriptPagerForTests,
  type TranscriptPageFetcher
} from './chatTranscriptPager'

beforeEach(() => {
  resetChatTranscriptPagerForTests()
})

function message(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `content-${id}`,
    timestamp: '2026-09-01T00:00:00.000Z'
  } as ChatMessage
}

function page(
  chatId: string,
  ids: string[],
  overrides: Partial<TranscriptPage> = {}
): TranscriptPage {
  const messages = ids.map(message)
  return {
    chatId,
    messages,
    runs: [],
    totalMessageCount: 20,
    windowStart: 0,
    windowEnd: ids.length,
    estimatedBytes: 100,
    hasOlder: false,
    hasNewer: false,
    oldestMessageId: messages[0]?.id ?? null,
    newestMessageId: messages[messages.length - 1]?.id ?? null,
    updatedAt: 1,
    ...overrides
  }
}

function summaryRow(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: chatId,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 20,
    runCount: 0
  } as ChatListItem
}

function pagedStore(chatId: string, ids: string[], overrides: Partial<TranscriptPage> = {}) {
  const store = new ChatTranscriptStore()
  store.ingestPage(page(chatId, ids, overrides))
  return store
}

describe('requestOlderTranscriptPage', () => {
  it('fetches the page before the current oldest cursor and joins it onto the window', async () => {
    const store = pagedStore('c1', ['m-10', 'm-11'], {
      windowStart: 10,
      windowEnd: 12,
      hasOlder: true,
      oldestMessageId: 'm-10',
      newestMessageId: 'm-11'
    })
    const requests: TranscriptPageRequest[] = []
    const fetchPage: TranscriptPageFetcher = async (request) => {
      requests.push(request)
      return page('c1', ['m-7', 'm-8', 'm-9'], {
        windowStart: 7,
        windowEnd: 10,
        hasOlder: true,
        hasNewer: true,
        oldestMessageId: 'm-7',
        newestMessageId: 'm-9'
      })
    }
    requestOlderTranscriptPage('c1', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([{ chatId: 'c1', beforeMessageId: 'm-10' }])
    // Accumulated infinite scroll: the older page JOINS the loaded window
    // rather than replacing it, so the rows the reader is looking at stay
    // mounted while history arrives above them.
    expect(store.get('c1')?.messages.map((m) => m.id)).toEqual([
      'm-7',
      'm-8',
      'm-9',
      'm-10',
      'm-11'
    ])
    expect(store.get('c1')?.windowStart).toBe(7)
    expect(store.get('c1')?.windowEnd).toBe(12)
    expect(store.get('c1')?.hasNewer).toBe(true)
  })

  it('is a no-op when there is no older page', async () => {
    const store = pagedStore('c1', ['m-1'])
    const fetchPage = async () => {
      throw new Error('must not be called')
    }
    requestOlderTranscriptPage('c1', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.get('c1')?.messages.map((m) => m.id)).toEqual(['m-1'])
  })

  it('deduplicates concurrent requests for the same direction', async () => {
    const store = pagedStore('c1', ['m-10'], {
      windowStart: 10,
      windowEnd: 11,
      hasOlder: true,
      oldestMessageId: 'm-10'
    })
    let calls = 0
    const fetchPage: TranscriptPageFetcher = async () => {
      calls += 1
      return page('c1', ['m-9'], { windowStart: 9, windowEnd: 10, hasNewer: true })
    }
    requestOlderTranscriptPage('c1', store, fetchPage)
    requestOlderTranscriptPage('c1', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)
  })

  it('drops the response when the chat was fully hydrated mid-flight', async () => {
    const store = pagedStore('c1', ['m-10'], {
      windowStart: 10,
      windowEnd: 11,
      hasOlder: true,
      oldestMessageId: 'm-10'
    })
    let resolveFetch: ((page: TranscriptPage | null) => void) | null = null
    const fetchPage: TranscriptPageFetcher = () =>
      new Promise((resolve) => {
        resolveFetch = resolve
      })
    requestOlderTranscriptPage('c1', store, fetchPage)
    // Escalation: a full record ingest replaces the paged entry.
    const full = {
      ...summaryRow('c1'),
      summaryOnly: undefined,
      messages: [message('m-0')],
      runs: [] as ChatRun[]
    } as unknown as ChatRecord
    delete (full as { summaryOnly?: boolean }).summaryOnly
    store.ingest(full)
    expect(store.isPaged('c1')).toBe(false)
    resolveFetch!(page('c1', ['m-9']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Full entry is untouched by the stale page.
    expect(store.get('c1')?.messages.map((m) => m.id)).toEqual(['m-0'])
    expect(store.isPaged('c1')).toBe(false)
  })
})

describe('requestNewerTranscriptPage / requestLatestTranscriptPage / reveal', () => {
  it('requests the page after the newest cursor', async () => {
    const store = pagedStore('c1', ['m-5'], {
      windowStart: 5,
      windowEnd: 6,
      hasNewer: true,
      oldestMessageId: 'm-5',
      newestMessageId: 'm-5'
    })
    const requests: TranscriptPageRequest[] = []
    const fetchPage: TranscriptPageFetcher = async (request) => {
      requests.push(request)
      return page('c1', ['m-6'])
    }
    requestNewerTranscriptPage('c1', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([{ chatId: 'c1', afterMessageId: 'm-5' }])
  })

  it('requests the bare tail for jump-to-latest', async () => {
    const store = pagedStore('c1', ['m-5'], { windowStart: 5, windowEnd: 6, hasNewer: true })
    const requests: TranscriptPageRequest[] = []
    const fetchPage: TranscriptPageFetcher = async (request) => {
      requests.push(request)
      return page('c1', ['m-19'], { windowStart: 19, windowEnd: 20 })
    }
    requestLatestTranscriptPage('c1', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([{ chatId: 'c1' }])
  })

  it('requests a page around a reveal target', async () => {
    const store = pagedStore('c1', ['m-5'])
    const requests: TranscriptPageRequest[] = []
    const fetchPage: TranscriptPageFetcher = async (request) => {
      requests.push(request)
      return page('c1', ['m-2'], { windowStart: 2, windowEnd: 3, hasOlder: true, hasNewer: true })
    }
    requestRevealTranscriptMessage('c1', 'm-2', store, fetchPage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toEqual([{ chatId: 'c1', aroundMessageId: 'm-2' }])
    expect(store.get('c1')?.messages.map((m) => m.id)).toEqual(['m-2'])
  })
})

describe('hydratePagedChatShell', () => {
  it('returns the main-produced shell when present', async () => {
    const shell = { ...summaryRow('c1'), transcriptPaged: true } as ChatListItem & {
      transcriptPaged: true
    }
    const fetchPage: TranscriptPageFetcher = async () => page('c1', ['m-19'], { shell })
    const result = await hydratePagedChatShell('c1', summaryRow('c1'), fetchPage)
    expect(result?.shell).toBe(shell)
    expect(result?.page.messages.map((m) => m.id)).toEqual(['m-19'])
  })

  it('falls back to stamping the summary row when main predates shell support', async () => {
    const fetchPage: TranscriptPageFetcher = async () => page('c1', ['m-19'])
    const result = await hydratePagedChatShell('c1', summaryRow('c1'), fetchPage)
    expect(result?.shell.transcriptPaged).toBe(true)
    expect(result?.shell.summaryOnly).toBe(true)
    expect(result?.shell.messageCount).toBe(20)
  })

  it('returns null without a page or without any shell source', async () => {
    const noPage: TranscriptPageFetcher = async () => null
    expect(await hydratePagedChatShell('c1', summaryRow('c1'), noPage)).toBeNull()
    const noShell: TranscriptPageFetcher = async () => page('c1', ['m-19'])
    const full = summaryRow('c1') as ChatRecord
    delete (full as { summaryOnly?: boolean }).summaryOnly
    expect(await hydratePagedChatShell('c1', full, noShell)).toBeNull()
  })
})
