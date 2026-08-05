import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { ChatTranscriptStore } from './chatTranscriptStore'
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
})
