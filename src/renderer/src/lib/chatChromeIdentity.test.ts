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
    expect(shouldRetainReactChatOnFlush(previous, next)).toBe(true)
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

  it('does not retain when previous is missing or ids differ', () => {
    const next = baseChat()
    expect(shouldRetainReactChatOnFlush(null, next)).toBe(false)
    expect(shouldRetainReactChatOnFlush(baseChat({ appChatId: 'other' }), next)).toBe(false)
    expect(shouldRetainReactChatOnFlush(next, next)).toBe(false)
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
