import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { ChatTranscriptStore, EMPTY_CHAT_TRANSCRIPT_PAYLOAD } from './chatTranscriptStore'
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
})
