import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
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
