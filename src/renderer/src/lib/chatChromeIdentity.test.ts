import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { chatChromeIdentityEqual, shouldRetainReactChatOnFlush } from './chatChromeIdentity'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '1'
  }
}

function run(runId: string, status: ChatRun['status'] = 'running'): ChatRun {
  return {
    runId,
    status,
    startedAt: '1'
  } as ChatRun
}

function baseChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-a',
    title: 'Hello',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [message('m1', 'hi')],
    runs: [run('r1')],
    ...overrides
  }
}

describe('chatChromeIdentityEqual', () => {
  it('treats identical references as equal', () => {
    const chat = baseChat()
    expect(chatChromeIdentityEqual(chat, chat)).toBe(true)
  })

  it('ignores messages, runs, and updatedAt churn', () => {
    const previous = baseChat()
    const next = {
      ...previous,
      messages: [message('m1', 'hi'), message('m2', 'stream')],
      runs: [run('r1', 'running'), run('r2', 'queued')],
      updatedAt: previous.updatedAt + 10
    }
    expect(chatChromeIdentityEqual(previous, next)).toBe(true)
  })

  it('detects chrome field changes that must commit to React', () => {
    const previous = baseChat()
    const titled = { ...previous, title: 'Renamed' }
    expect(chatChromeIdentityEqual(previous, titled)).toBe(false)
    expect(shouldRetainReactChatOnFlush(previous, titled)).toBe(false)

    const withEnsemble = {
      ...previous,
      ensemble: {
        enabled: true,
        maxParticipants: 4,
        participants: []
      } as ChatRecord['ensemble']
    }
    expect(chatChromeIdentityEqual(previous, withEnsemble)).toBe(false)
  })

  it('detects a newly introduced chrome key', () => {
    const previous = baseChat()
    const next = { ...previous, pinned: true }
    expect(chatChromeIdentityEqual(previous, next)).toBe(false)
  })
})

describe('shouldRetainReactChatOnFlush', () => {
  it('does not retain when previous is missing or ids differ', () => {
    const next = baseChat()
    expect(shouldRetainReactChatOnFlush(null, next)).toBe(false)
    expect(shouldRetainReactChatOnFlush(baseChat({ appChatId: 'other' }), next)).toBe(false)
    expect(shouldRetainReactChatOnFlush(next, next)).toBe(false)
  })

  it('retains across a streaming edit to the trailing message', () => {
    // The case the optimisation exists for: one message, growing token by
    // token. Count is unchanged, so chrome keeps its identity and the panel
    // takes the delta from ChatTranscriptStore.
    const previous = baseChat({ messages: [message('m1', 'hi')] })
    const streamed = {
      ...previous,
      messages: [message('m1', 'hi there')],
      updatedAt: previous.updatedAt + 10
    }
    expect(shouldRetainReactChatOnFlush(previous, streamed)).toBe(true)
  })

  it('commits a new message rather than retaining a stale list', () => {
    // 2026-08-21: measured on a live 19-minute Kimi run. `currentChat.messages`
    // stayed at 2 for eleven minutes while the same renderer grew the persisted
    // chat from 105 KB to 1.5 MB — the transcript showed one row and the user
    // had to switch chats to make the rest appear. Retention across a message
    // COUNT change is what let the stale list survive: chrome identity ignores
    // `messages`, and both counts were non-zero so the welcome gate never
    // tripped. Streaming into the trailing message still retains (see above);
    // only a new row forces the commit, which is rare next to per-token flushes.
    const previous = baseChat({
      messages: [message('m1', 'hi'), message('m2', 'working')]
    })
    const appended = {
      ...previous,
      messages: [
        message('m1', 'hi'),
        message('m2', 'working'),
        message('m3', 'tool row'),
        message('m4', 'another row')
      ],
      updatedAt: previous.updatedAt + 1
    }
    expect(shouldRetainReactChatOnFlush(previous, appended)).toBe(false)
    expect(shouldRetainReactChatOnFlush(appended, previous)).toBe(false)
  })

  it('does not retain across empty↔non-empty message boundaries (welcome gate)', () => {
    const empty = baseChat({ messages: [], runs: [] })
    const first = baseChat({
      messages: [message('m1', 'hi')],
      runs: [run('r1')],
      updatedAt: empty.updatedAt + 1
    })
    expect(shouldRetainReactChatOnFlush(empty, first)).toBe(false)
    expect(shouldRetainReactChatOnFlush(first, empty)).toBe(false)
  })
})

describe('persistenceRevision churn', () => {
  it('retains chrome identity when only the persistence bookkeeping advanced with the stream', () => {
    const previous = baseChat({ persistenceRevision: 41 })
    const next = {
      ...previous,
      persistenceRevision: 42,
      // Same message COUNT — the trailing message just grew. Appending here
      // would test the new-row commit rule instead of the bookkeeping rule
      // this guard is for.
      messages: [message('m1', 'hi there')],
      updatedAt: previous.updatedAt + 10
    }
    // Every main-side save increments persistenceRevision; a patch delivery
    // carries it on every flush. Chrome must not re-render for bookkeeping.
    expect(chatChromeIdentityEqual(previous, next)).toBe(true)
    expect(shouldRetainReactChatOnFlush(previous, next)).toBe(true)
  })
})
