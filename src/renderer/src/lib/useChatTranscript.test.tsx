/**
 * Hook binding tests — no jsdom in this repo, so we exercise the bind /
 * subscribe / snapshot helpers the hook wires into useSyncExternalStore
 * rather than mounting React.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { ChatTranscriptStore, EMPTY_CHAT_TRANSCRIPT_PAYLOAD } from './chatTranscriptStore'
import {
  bindChatTranscriptStore,
  getChatTranscriptSnapshot,
  getChatTranscriptStore,
  resetChatTranscriptStoreBindingForTests,
  subscribeChatTranscript,
  useChatTranscript
} from './useChatTranscript'

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

afterEach(() => {
  resetChatTranscriptStoreBindingForTests()
})

describe('useChatTranscript binding', () => {
  it('exports useChatTranscript for React consumers', () => {
    expect(typeof useChatTranscript).toBe('function')
  })

  it('bindChatTranscriptStore makes App store the hook snapshot source', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    expect(getChatTranscriptStore()).toBe(store)

    store.ingest(chat('bound-a'))
    const snap = getChatTranscriptSnapshot('bound-a')
    expect(snap.messages).toHaveLength(1)
    expect(getChatTranscriptSnapshot('bound-a')).toBe(snap)
    expect(getChatTranscriptSnapshot(null)).toBe(EMPTY_CHAT_TRANSCRIPT_PAYLOAD)
  })

  it('subscribeChatTranscript notifies on the bound store', () => {
    const store = new ChatTranscriptStore()
    bindChatTranscriptStore(store)
    const listener = vi.fn()
    const unsub = subscribeChatTranscript('bound-b', listener)

    store.ingest(chat('bound-b'))
    expect(listener).toHaveBeenCalledTimes(1)

    store.set('bound-b', {
      messages: [message('m2', 'next')],
      runs: [],
      updatedAt: 3
    })
    expect(listener).toHaveBeenCalledTimes(2)

    unsub()
    store.drop('bound-b')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reset clears the binding so the next get allocates a fresh store', () => {
    const first = getChatTranscriptStore()
    first.ingest(chat('ephemeral'))
    resetChatTranscriptStoreBindingForTests()
    const second = getChatTranscriptStore()
    expect(second).not.toBe(first)
    expect(second.has('ephemeral')).toBe(false)
  })
})
