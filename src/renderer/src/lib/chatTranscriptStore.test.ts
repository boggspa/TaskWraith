import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import type { TranscriptPage } from '../../../shared/transcriptPage'
import {
  ChatTranscriptStore,
  DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  EMPTY_CHAT_TRANSCRIPT_PAYLOAD,
  selectTranscriptPageEndingAt
} from './chatTranscriptStore'
import { isChatSummaryRecord } from './chatRecordMerge'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '1'
  }
}

function chat(id: string): ChatRecord {
  return {
    appChatId: id,
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [message('m1', 'hello')],
    runs: []
  }
}

describe('ChatTranscriptStore', () => {
  it('ingests full chat transcript arrays and re-applies them by id', () => {
    const store = new ChatTranscriptStore()
    const full = chat('chat-a')
    store.ingest(full)
    expect(store.stats()).toEqual({ chatCount: 1, messageCount: 1, runCount: 0 })

    const chromeOnly = { ...full, messages: [], runs: [], title: 'renamed' }
    const reapplied = store.applyToChat(chromeOnly)
    expect(reapplied.messages).toBe(store.get('chat-a')!.messages)
    expect(reapplied.runs).toBe(store.get('chat-a')!.runs)
    expect(reapplied.title).toBe('renamed')
  })

  it('detachChrome parks arrays in the store and clears them on the record', () => {
    const store = new ChatTranscriptStore()
    const full = chat('chat-b')
    const chrome = store.detachChrome(full)
    expect(chrome.messages).toEqual([])
    expect(chrome.runs).toEqual([])
    expect(store.get('chat-b')?.messages).toHaveLength(1)
  })

  it('demote drops stored transcript and returns a summaryOnly projection', () => {
    const store = new ChatTranscriptStore()
    const full = chat('chat-c')
    store.ingest(full)
    const demoted = store.demote(full)
    expect(isChatSummaryRecord(demoted)).toBe(true)
    expect(store.has('chat-c')).toBe(false)
    expect(demoted.messageCount).toBe(1)
  })

  it('ignores summary stubs on ingest', () => {
    const store = new ChatTranscriptStore()
    const summary = {
      ...chat('chat-d'),
      summaryOnly: true as const,
      messageCount: 0,
      runCount: 0,
      messages: [],
      runs: []
    }
    expect(store.ingest(summary)).toBeNull()
    expect(store.stats().chatCount).toBe(0)
  })

  it('bumps per-chat generation on set/ingest/drop/clear', () => {
    const store = new ChatTranscriptStore()
    expect(store.generation('chat-e')).toBe(0)

    const full = chat('chat-e')
    store.ingest(full)
    expect(store.generation('chat-e')).toBe(1)

    const nextMessages = [message('m2', 'world')]
    store.set('chat-e', { messages: nextMessages, runs: [], updatedAt: 3 })
    expect(store.generation('chat-e')).toBe(2)

    // Referentially identical payload does not bump.
    store.set('chat-e', { messages: nextMessages, runs: [], updatedAt: 3 })
    expect(store.generation('chat-e')).toBe(2)

    expect(store.drop('chat-e')).toBe(true)
    expect(store.generation('chat-e')).toBe(3)

    store.ingest(full)
    expect(store.generation('chat-e')).toBe(4)
    store.clear()
    expect(store.generation('chat-e')).toBe(5)
    expect(store.has('chat-e')).toBe(false)
  })

  it('getSnapshot returns a stable reference when unchanged', () => {
    const store = new ChatTranscriptStore()
    const missingA = store.getSnapshot('missing')
    const missingB = store.getSnapshot('missing')
    expect(missingA).toBe(EMPTY_CHAT_TRANSCRIPT_PAYLOAD)
    expect(missingB).toBe(missingA)
    expect(store.getSnapshot(null)).toBe(EMPTY_CHAT_TRANSCRIPT_PAYLOAD)
    expect(store.getSnapshot(undefined)).toBe(EMPTY_CHAT_TRANSCRIPT_PAYLOAD)

    const full = chat('chat-f')
    store.ingest(full)
    const snap1 = store.getSnapshot('chat-f')
    const snap2 = store.getSnapshot('chat-f')
    expect(snap1).toBe(snap2)
    expect(snap1.messages).toBe(full.messages)

    store.set('chat-f', {
      messages: [message('m2', 'next')],
      runs: [],
      updatedAt: 9
    })
    const snap3 = store.getSnapshot('chat-f')
    expect(snap3).not.toBe(snap1)
    expect(store.getSnapshot('chat-f')).toBe(snap3)
  })

  it('does not notify for metadata-only ingest with the same transcript arrays', () => {
    const store = new ChatTranscriptStore()
    const listener = vi.fn()
    store.subscribe('chat-metadata', listener)

    const first = chat('chat-metadata')
    const firstPayload = store.ingest(first)
    expect(listener).toHaveBeenCalledTimes(1)

    const metadataOnly = { ...first, title: 'Renamed', updatedAt: 99 }
    const secondPayload = store.ingest(metadataOnly)
    expect(secondPayload).toBe(firstPayload)
    expect(store.getSnapshot('chat-metadata')).toBe(firstPayload)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('subscribe notifies only the matching chat; subscribeAll sees every mutation', () => {
    const store = new ChatTranscriptStore()
    const onA = vi.fn()
    const onB = vi.fn()
    const onAll = vi.fn()

    const unsubA = store.subscribe('chat-a', onA)
    const unsubB = store.subscribe('chat-b', onB)
    const unsubAll = store.subscribeAll(onAll)

    store.ingest(chat('chat-a'))
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).toHaveBeenCalledTimes(0)
    expect(onAll).toHaveBeenCalledTimes(1)

    store.ingest(chat('chat-b'))
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onAll).toHaveBeenCalledTimes(2)

    store.drop('chat-a')
    expect(onA).toHaveBeenCalledTimes(2)
    expect(onAll).toHaveBeenCalledTimes(3)

    unsubA()
    unsubB()
    store.set('chat-b', { messages: [], runs: [], updatedAt: 1 })
    expect(onA).toHaveBeenCalledTimes(2)
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onAll).toHaveBeenCalledTimes(4)

    unsubAll()
    store.clear()
    expect(onAll).toHaveBeenCalledTimes(4)
  })

  it('subscribe with nullish chatId is a no-op', () => {
    const store = new ChatTranscriptStore()
    const listener = vi.fn()
    const unsub = store.subscribe(null, listener)
    store.ingest(chat('chat-z'))
    expect(listener).not.toHaveBeenCalled()
    unsub()
  })

  it('publishes the latest bounded page while retaining the full authoritative chat', () => {
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 3, maxBytesPerPage: 1_000_000 })
    const full = {
      ...chat('paged'),
      messages: Array.from({ length: 10 }, (_, index) => message(`m${index}`, `message ${index}`))
    }
    const payload = store.ingest(full)!

    expect(payload.messages.map((entry) => entry.id)).toEqual(['m7', 'm8', 'm9'])
    expect(payload).toMatchObject({
      totalMessageCount: 10,
      windowStart: 7,
      windowEnd: 10,
      hasOlder: true,
      hasNewer: false
    })
    expect(store.stats().messageCount).toBe(3)

    const chromeOnly = { ...full, messages: [], runs: [] }
    expect(store.applyToChat(chromeOnly).messages).toBe(full.messages)
    expect(store.applyToChat(chromeOnly).messages).toHaveLength(10)
  })

  it('replaces pages in both directions instead of accumulating history', () => {
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 3, maxBytesPerPage: 1_000_000 })
    const full = {
      ...chat('paging'),
      messages: Array.from({ length: 10 }, (_, index) => message(`m${index}`, `message ${index}`))
    }
    store.ingest(full)

    expect(store.showOlderPage('paging')?.messages.map((entry) => entry.id)).toEqual([
      'm4',
      'm5',
      'm6'
    ])
    expect(store.stats().messageCount).toBe(3)
    expect(store.showOlderPage('paging')?.messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      'm3'
    ])
    expect(store.showNewerPage('paging')?.messages.map((entry) => entry.id)).toEqual([
      'm4',
      'm5',
      'm6'
    ])
    expect(store.showLatestPage('paging')?.messages.map((entry) => entry.id)).toEqual([
      'm7',
      'm8',
      'm9'
    ])
  })

  it('keeps an explicitly historical page stable while live updates append', () => {
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 3, maxBytesPerPage: 1_000_000 })
    const first = {
      ...chat('live-history'),
      messages: Array.from({ length: 8 }, (_, index) => message(`m${index}`, `message ${index}`))
    }
    store.ingest(first)
    store.showOlderPage('live-history')
    expect(store.get('live-history')?.messages.map((entry) => entry.id)).toEqual(['m2', 'm3', 'm4'])

    store.ingest({
      ...first,
      updatedAt: 3,
      messages: [...first.messages, message('m8', 'new tail')]
    })
    expect(store.get('live-history')?.messages.map((entry) => entry.id)).toEqual(['m2', 'm3', 'm4'])
    expect(store.get('live-history')).toMatchObject({
      totalMessageCount: 9,
      windowStart: 2,
      windowEnd: 5,
      hasNewer: true
    })
  })

  it('reveals an omitted message in one bounded page', () => {
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 4, maxBytesPerPage: 1_000_000 })
    const full = {
      ...chat('reveal'),
      messages: Array.from({ length: 12 }, (_, index) => message(`m${index}`, `message ${index}`))
    }
    store.ingest(full)

    const revealed = store.revealMessage('reveal', 'm2')!
    expect(revealed.messages.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2'])
    expect(revealed.hasNewer).toBe(true)
    expect(store.stats().messageCount).toBeLessThanOrEqual(4)
  })

  it('enforces the byte bound while always admitting one oversized message', () => {
    const messages = [
      message('small', 'a'),
      message('large', 'x'.repeat(2_000)),
      message('tail', 'b')
    ]
    const tail = selectTranscriptPageEndingAt(messages, messages.length, {
      maxMessagesPerPage: 20,
      maxBytesPerPage: 500
    })
    expect(tail).toMatchObject({ start: 2, end: 3 })

    const oversized = selectTranscriptPageEndingAt(messages, 2, {
      maxMessagesPerPage: 20,
      maxBytesPerPage: 500
    })
    expect(oversized).toMatchObject({ start: 1, end: 2 })
    expect(oversized.estimatedBytes).toBeGreaterThan(500)
  })

  it('keeps a five-figure tool-heavy transcript out of the presentation model', () => {
    const full = {
      ...chat('tool-heavy'),
      messages: Array.from(
        { length: 11_574 },
        (_, index): ChatMessage => ({
          id: `tool-${index}`,
          role: 'tool',
          content: '',
          timestamp: '1',
          toolActivities: [
            {
              id: `activity-${index}`,
              toolName: 'exec_command',
              displayName: 'Shell command',
              category: 'shell',
              status: 'success',
              parameters: { command: `inspect-${index}`, paths: ['a', 'b', 'c'] },
              resultSummary: 'x'.repeat(2_048)
            }
          ]
        })
      )
    }
    const store = new ChatTranscriptStore()
    const payload = store.ingest(full)!

    expect(payload.totalMessageCount).toBe(11_574)
    expect(payload.messages.length).toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES)
    expect(payload.windowEstimatedBytes).toBeLessThanOrEqual(DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES)
    expect(store.stats().messageCount).toBe(payload.messages.length)
    expect(store.applyToChat({ ...full, messages: [], runs: [] }).messages).toBe(full.messages)
  })
})

// Helper for creating TranscriptPage objects
function transcriptPage(
  chatId: string,
  ids: string[],
  overrides: Partial<TranscriptPage> = {}
): TranscriptPage {
  const messages = ids.map((id) => message(id, `message ${id}`))
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
    updatedAt: 5,
    ...overrides
  }
}

describe('Stage 1b paged entries (ingestPage)', () => {
  it('installs a main-produced page as the entire presentation state', () => {
    const store = new ChatTranscriptStore()
    const payload = store.ingestPage(
      transcriptPage('paged', ['m17', 'm18', 'm19'], {
        windowStart: 17,
        windowEnd: 20,
        hasOlder: true
      })
    )
    expect(store.isPaged('paged')).toBe(true)
    expect(payload).toMatchObject({
      totalMessageCount: 20,
      windowStart: 17,
      windowEnd: 20,
      hasOlder: true,
      hasNewer: false,
      updatedAt: 5
    })
    expect(payload.messages.map((entry) => entry.id)).toEqual(['m17', 'm18', 'm19'])
    expect(store.getSnapshot('paged').messages).toHaveLength(3)
  })

  it('makes local rewindow methods no-ops (the pager fetches over IPC)', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m17'], { windowStart: 17, windowEnd: 18, hasOlder: true })
    )
    const before = store.get('paged')
    expect(store.showOlderPage('paged')).toBe(before)
    expect(store.showNewerPage('paged')).toBe(before)
    expect(store.showLatestPage('paged')).toBe(before)
    expect(store.revealMessage('paged', 'm3')).toBe(before)
    expect(store.get('paged')?.messages.map((entry) => entry.id)).toEqual(['m17'])
  })

  it('a full ingest replaces the paged entry wholesale (escalation)', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m19'], { windowStart: 19, windowEnd: 20, hasOlder: true })
    )
    const full = {
      ...chat('paged'),
      messages: Array.from({ length: 4 }, (_, index) => message(`f${index}`, `full ${index}`))
    }
    const payload = store.ingest(full)!
    expect(store.isPaged('paged')).toBe(false)
    expect(payload.totalMessageCount).toBe(4)
    expect(payload.messages.map((entry) => entry.id)).toEqual(['f0', 'f1', 'f2', 'f3'])
  })

  it('a later page replaces the window instead of accumulating', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m18', 'm19'], { windowStart: 18, windowEnd: 20, hasOlder: true })
    )
    store.ingestPage(
      transcriptPage('paged', ['m15', 'm16', 'm17'], {
        windowStart: 15,
        windowEnd: 18,
        hasOlder: true,
        hasNewer: true
      })
    )
    expect(store.get('paged')?.messages.map((entry) => entry.id)).toEqual(['m15', 'm16', 'm17'])
    expect(store.stats().messageCount).toBe(3)
    expect(store.isPaged('paged')).toBe(true)
  })

  it('replaceWindow replaces the entire window', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m18', 'm19'], { windowStart: 18, windowEnd: 20, hasOlder: true })
    )
    const replaced = store.replaceChatTranscriptWindow(
      transcriptPage('paged', ['m0', 'm1'], {
        windowStart: 0,
        windowEnd: 2,
        hasOlder: false,
        hasNewer: true
      })
    )
    expect(replaced.messages.map((entry) => entry.id)).toEqual(['m0', 'm1'])
    expect(replaced.hasOlder).toBe(false)
    expect(replaced.hasNewer).toBe(true)
  })
})

describe('ChatTranscriptStore - Accumulated Infinite Scroll', () => {
  it('prependPage merges older messages when contiguous', () => {
    const store = new ChatTranscriptStore()
    // First install a page
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11', 'm12'], {
        windowStart: 10,
        windowEnd: 13,
        hasOlder: true,
        hasNewer: true
      })
    )

    // Prepend an older contiguous page
    const entry = store.byId.get('paged')!
    const prepended = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m7', 'm8', 'm9'], {
        windowStart: 7,
        windowEnd: 10,
        hasOlder: true,
        hasNewer: false // contiguous: m9.id === m10.id
      })
    )

    expect(prepended).not.toBeNull()
    expect(prepended!.messages.map((entry) => entry.id)).toEqual([
      'm7',
      'm8',
      'm9',
      'm10',
      'm11',
      'm12'
    ])
    expect(prepended!.hasOlder).toBe(true)
  })

  it('appendPage merges newer messages when contiguous', () => {
    const store = new ChatTranscriptStore()
    // First install a page
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11', 'm12'], {
        windowStart: 10,
        windowEnd: 13,
        hasOlder: true,
        hasNewer: true
      })
    )

    // Append a newer contiguous page
    const appended = store.appendChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m13', 'm14', 'm15'], {
        windowStart: 13,
        windowEnd: 16,
        hasOlder: false, // contiguous: m13.id === m12.id
        hasNewer: true
      })
    )

    expect(appended).not.toBeNull()
    expect(appended!.messages.map((entry) => entry.id)).toEqual([
      'm10',
      'm11',
      'm12',
      'm13',
      'm14',
      'm15'
    ])
    expect(appended!.hasNewer).toBe(true)
  })

  it('ingestPage still REPLACES when handed a contiguous older page', () => {
    const store = new ChatTranscriptStore()
    // First install a page
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], {
        windowStart: 10,
        windowEnd: 12,
        hasOlder: true,
        hasNewer: false
      })
    )

    // Ingest a contiguous older page - should prepend
    const result = store.ingestPage(
      transcriptPage('paged', ['m8', 'm9'], {
        windowStart: 8,
        windowEnd: 10,
        hasOlder: true,
        hasNewer: false
      })
    )

    // Adjacency alone must NOT be read as "extend the window": a re-open or a
    // jump can land on a page that happens to touch the current one, and
    // silently accumulating there would grow the render model behind the
    // caller's back. Only an explicit prepend/append accumulates.
    expect(result.messages.map((entry) => entry.id)).toEqual(['m8', 'm9'])
  })

  it('ingestPage still REPLACES when handed a contiguous newer page', () => {
    const store = new ChatTranscriptStore()
    // First install a page
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], {
        windowStart: 10,
        windowEnd: 12,
        hasOlder: false,
        hasNewer: true
      })
    )

    // Ingest a contiguous newer page - should append
    const result = store.ingestPage(
      transcriptPage('paged', ['m12', 'm13'], {
        windowStart: 12,
        windowEnd: 14,
        hasOlder: false,
        hasNewer: true
      })
    )

    expect(result.messages.map((entry) => entry.id)).toEqual(['m12', 'm13'])
  })

  it('ingestPage replaces the window for a non-contiguous page', () => {
    const store = new ChatTranscriptStore()
    // First install a page
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], {
        windowStart: 10,
        windowEnd: 12,
        hasOlder: true,
        hasNewer: true
      })
    )

    // Ingest a non-contiguous page - should replace
    const result = store.ingestPage(
      transcriptPage('paged', ['m20', 'm21'], {
        windowStart: 20,
        windowEnd: 22,
        hasOlder: true,
        hasNewer: false
      })
    )

    expect(result.messages.map((entry) => entry.id)).toEqual(['m20', 'm21'])
  })

  it('prependPage deduplicates messages by id', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasOlder: true })
    )

    // Prepend a page that overlaps with existing messages
    const prepended = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m8', 'm9', 'm10'], {
        windowStart: 8,
        windowEnd: 11,
        hasOlder: true,
        hasNewer: false
      })
    )

    expect(prepended).not.toBeNull()
    // m10 should not be duplicated
    expect(prepended!.messages.map((entry) => entry.id)).toEqual(['m8', 'm9', 'm10', 'm11'])
  })

  it('accumulated window never reaches saveChat - remains paged', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasOlder: true })
    )

    // Prepend older messages
    store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m8', 'm9'], { windowStart: 8, windowEnd: 10, hasOlder: true })
    )

    // Append newer messages
    store.appendChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m12', 'm13'], { windowStart: 12, windowEnd: 14, hasNewer: true })
    )

    // The chat should still be paged (not full)
    expect(store.isPaged('paged')).toBe(true)

    // The payload should have accumulated messages
    const payload = store.get('paged')
    expect(payload).not.toBeNull()
    expect(payload!.messages.map((entry) => entry.id)).toEqual([
      'm8',
      'm9',
      'm10',
      'm11',
      'm12',
      'm13'
    ])
  })

  it('applyToChat refuses to write an accumulated window onto a chat record', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasOlder: true })
    )
    store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m8', 'm9'], { windowStart: 8, windowEnd: 10, hasOlder: true })
    )
    const canonical = {
      ...chat('paged'),
      messages: Array.from({ length: 40 }, (_, index) => message(`c${index}`, `canon ${index}`))
    }
    const applied = store.applyToChat(canonical)
    // The SAME record comes back: a paged entry holds no authoritative arrays,
    // so the 4-message accumulated window is never merged onto the record and
    // therefore can never travel on to saveChat.
    expect(applied).toBe(canonical)
    expect(applied.messages).toHaveLength(40)
  })

  it('prepend evicts the newer far edge at the window cap and re-opens hasNewer', () => {
    // maxMessagesPerPage 1 => an accumulated window of 4 (the page budget).
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 1 })
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11', 'm12', 'm13'], {
        windowStart: 10,
        windowEnd: 14,
        hasOlder: true,
        hasNewer: true
      })
    )
    const prepended = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m8', 'm9'], { windowStart: 8, windowEnd: 10, hasOlder: true })
    )!
    expect(prepended.messages.map((entry) => entry.id)).toEqual(['m8', 'm9', 'm10', 'm11'])
    expect(prepended.windowStart).toBe(8)
    expect(prepended.windowEnd).toBe(12)
    // The evicted tail must be reported as loadable again, or scrolling back
    // down would dead-end against a window that silently dropped it.
    expect(prepended.hasNewer).toBe(true)
    expect(prepended.hasOlder).toBe(true)
  })

  it('joins an OVERLAPPING older page and still evicts to the cap truthfully', () => {
    // The pager anchors its request on the boundary message, so the page it
    // gets back routinely re-delivers that message. Half-open windows make the
    // edges overlap by one ([8,11) against [10,14)) rather than meet, and
    // treating that as "not adjacent" silently replaced the window and threw
    // away the rows the reader was looking at.
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 1 })
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11', 'm12', 'm13'], {
        windowStart: 10,
        windowEnd: 14,
        hasOlder: true,
        hasNewer: true
      })
    )
    const prepended = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m8', 'm9', 'm10'], {
        windowStart: 8,
        windowEnd: 11,
        hasOlder: true
      })
    )!
    expect(prepended.messages.map((entry) => entry.id)).toEqual(['m8', 'm9', 'm10', 'm11'])
    expect(prepended.windowStart).toBe(8)
    expect(prepended.windowEnd).toBe(12)
    expect(prepended.hasOlder).toBe(true)
    expect(prepended.hasNewer).toBe(true)
  })

  it('append evicts the older far edge at the window cap and re-opens hasOlder', () => {
    const store = new ChatTranscriptStore({ maxMessagesPerPage: 1 })
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11', 'm12', 'm13'], {
        windowStart: 10,
        windowEnd: 14,
        hasOlder: true,
        hasNewer: true
      })
    )
    const appended = store.appendChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m14', 'm15'], { windowStart: 14, windowEnd: 16, hasNewer: true })
    )!
    expect(appended.messages.map((entry) => entry.id)).toEqual(['m12', 'm13', 'm14', 'm15'])
    expect(appended.windowStart).toBe(12)
    expect(appended.windowEnd).toBe(16)
    expect(appended.hasOlder).toBe(true)
  })

  it('recomputes hasOlder from absolute bounds, so reaching index 0 closes it', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m2', 'm3'], { windowStart: 2, windowEnd: 4, hasOlder: true })
    )
    // The page still advertises hasOlder: true; the window itself proves
    // otherwise once it starts at index 0.
    const prepended = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m0', 'm1'], { windowStart: 0, windowEnd: 2, hasOlder: true })
    )!
    expect(prepended.windowStart).toBe(0)
    expect(prepended.hasOlder).toBe(false)
    expect(prepended.hasNewer).toBe(true)
  })

  it('a non-adjacent prepend replaces rather than splicing disjoint history', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasOlder: true })
    )
    const result = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m0', 'm1'], { windowStart: 0, windowEnd: 2, hasNewer: true })
    )!
    // Joining a window that ends at 2 to one that starts at 10 would render
    // history in an order that never existed.
    expect(result.messages.map((entry) => entry.id)).toEqual(['m0', 'm1'])
    expect(result.windowStart).toBe(0)
    expect(result.windowEnd).toBe(2)
  })

  it('append keeps the copy already on screen when a page overlaps', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasNewer: true })
    )
    const appended = store.appendChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m11', 'm12'], { windowStart: 12, windowEnd: 14, hasNewer: true })
    )!
    expect(appended.messages.map((entry) => entry.id)).toEqual(['m10', 'm11', 'm12'])
  })

  it('a page that adds nothing leaves the window reference untouched', () => {
    const store = new ChatTranscriptStore()
    const before = store.ingestPage(
      transcriptPage('paged', ['m10', 'm11'], { windowStart: 10, windowEnd: 12, hasOlder: true })
    )
    const after = store.prependChatTranscriptPage(
      'paged',
      transcriptPage('paged', ['m10'], { windowStart: 9, windowEnd: 10, hasOlder: true })
    )
    // Same reference => no generation bump and no subscriber re-render.
    expect(after).toBe(before)
  })

  it('refuses to accumulate onto a fully hydrated chat', () => {
    const store = new ChatTranscriptStore()
    store.ingest({
      ...chat('full'),
      messages: [message('a', 'a'), message('b', 'b')]
    })
    expect(store.isPaged('full')).toBe(false)
    // A hydrated chat rewindows from its own authoritative arrays; taking
    // transcript content from an IPC page here would fork the two sources.
    expect(
      store.prependChatTranscriptPage('full', transcriptPage('full', ['x'], { windowEnd: 1 }))
    ).toBeNull()
    expect(
      store.appendChatTranscriptPage('full', transcriptPage('full', ['x'], { windowEnd: 1 }))
    ).toBeNull()
    expect(store.get('full')?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})
