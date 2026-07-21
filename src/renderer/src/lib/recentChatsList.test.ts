import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { chatRecentsSortKeyMs, selectRecentChats } from './recentChatsList'

const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
  appChatId: 'chat-1',
  title: 'Chat',
  workspaceId: 'workspace-1',
  workspacePath: '/repo',
  createdAt: 1000,
  updatedAt: 1000,
  archived: false,
  messages: [],
  runs: [],
  ...overrides
})

const userMessage = (timestamp: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `u-${timestamp}`,
  role: 'user',
  content: 'hello',
  timestamp,
  ...overrides
})

const assistantMessage = (timestamp: string): ChatMessage => ({
  id: `a-${timestamp}`,
  role: 'assistant',
  content: 'stream…',
  timestamp
})

describe('selectRecentChats', () => {
  it('orders by last user message recency, not updatedAt write thrash', () => {
    const result = selectRecentChats(
      [
        chat({
          appChatId: 'a',
          createdAt: 100,
          updatedAt: 9000,
          messages: [userMessage('1970-01-01T00:00:00.100Z')]
        }),
        chat({
          appChatId: 'b',
          createdAt: 100,
          updatedAt: 1000,
          messages: [userMessage('1970-01-01T00:00:00.300Z')]
        }),
        chat({
          appChatId: 'c',
          createdAt: 100,
          updatedAt: 8000,
          messages: [userMessage('1970-01-01T00:00:00.200Z')]
        })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['b', 'c', 'a'])
  })

  it('does not reorder when only updatedAt advances during concurrent streams', () => {
    const base = [
      chat({
        appChatId: 'first',
        createdAt: 100,
        updatedAt: 500,
        messages: [
          userMessage('1970-01-01T00:00:00.200Z'),
          assistantMessage('1970-01-01T00:00:00.201Z')
        ]
      }),
      chat({
        appChatId: 'second',
        createdAt: 100,
        updatedAt: 400,
        messages: [
          userMessage('1970-01-01T00:00:00.100Z'),
          assistantMessage('1970-01-01T00:00:00.101Z')
        ]
      })
    ]
    const before = selectRecentChats(base, { limit: 5 }).map((c) => c.appChatId)

    // Simulate both chats thrashing updatedAt as tokens/tools persist.
    const afterStream = selectRecentChats(
      [
        { ...base[0], updatedAt: 9001 },
        { ...base[1], updatedAt: 9500 }
      ],
      { limit: 5 }
    ).map((c) => c.appChatId)

    expect(before).toEqual(['first', 'second'])
    expect(afterStream).toEqual(['first', 'second'])
  })

  it('promotes a chat when the user sends a newer message', () => {
    const result = selectRecentChats(
      [
        chat({
          appChatId: 'older',
          messages: [userMessage('1970-01-01T00:00:00.100Z')],
          updatedAt: 9999
        }),
        chat({
          appChatId: 'newer',
          messages: [userMessage('1970-01-01T00:00:00.500Z')],
          updatedAt: 1
        })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['newer', 'older'])
  })

  it('falls back to createdAt (not live updatedAt) when there are no user messages', () => {
    const result = selectRecentChats(
      [
        chat({ appChatId: 'old', createdAt: 100, updatedAt: 9000, messages: [] }),
        chat({ appChatId: 'new', createdAt: 300, updatedAt: 301, messages: [] }),
        chat({ appChatId: 'mid', createdAt: 200, updatedAt: 8000, messages: [] })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['new', 'mid', 'old'])
  })

  it('ignores retired channelInbound rows for recency', () => {
    const result = selectRecentChats(
      [
        chat({
          appChatId: 'inbound-only',
          createdAt: 100,
          updatedAt: 9000,
          messages: [
            userMessage('1970-01-01T00:00:00.900Z', {
              metadata: { kind: 'channelInbound' }
            })
          ]
        }),
        chat({
          appChatId: 'real-user',
          createdAt: 100,
          updatedAt: 200,
          messages: [userMessage('1970-01-01T00:00:00.200Z')]
        })
      ],
      { limit: 5 }
    )
    // inbound-only falls back to createdAt (100); real-user uses 200.
    expect(result.map((c) => c.appChatId)).toEqual(['real-user', 'inbound-only'])
  })

  it('caps results at limit', () => {
    const result = selectRecentChats(
      [
        chat({ appChatId: 'a', createdAt: 100 }),
        chat({ appChatId: 'b', createdAt: 200 }),
        chat({ appChatId: 'c', createdAt: 300 }),
        chat({ appChatId: 'd', createdAt: 400 }),
        chat({ appChatId: 'e', createdAt: 500 }),
        chat({ appChatId: 'f', createdAt: 600 })
      ],
      { limit: 3 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['f', 'e', 'd'])
  })

  it('excludes archived chats by default', () => {
    const result = selectRecentChats(
      [
        chat({ appChatId: 'a', createdAt: 100 }),
        chat({ appChatId: 'b', createdAt: 200, archived: true }),
        chat({ appChatId: 'c', createdAt: 300 })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['c', 'a'])
  })

  it('excludes pinned chats by default', () => {
    const result = selectRecentChats(
      [
        chat({ appChatId: 'a', createdAt: 100 }),
        chat({ appChatId: 'b', createdAt: 200, pinned: true }),
        chat({ appChatId: 'c', createdAt: 300 })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['c', 'a'])
  })

  it('returns empty array for empty input', () => {
    expect(selectRecentChats([], { limit: 5 })).toEqual([])
  })

  it('breaks ties by appChatId for determinism', () => {
    const result = selectRecentChats(
      [
        chat({ appChatId: 'zebra', createdAt: 500 }),
        chat({ appChatId: 'alpha', createdAt: 500 }),
        chat({ appChatId: 'mango', createdAt: 500 })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['alpha', 'mango', 'zebra'])
  })

  it('1.0.7 — includes ensemble chats when the caller passes them in', () => {
    // selectRecentChats is kind-agnostic; the sidebar now feeds it a source
    // list that includes ensembles (when ensemble mode is on) so an active
    // ensemble thread can surface in Recents by recency.
    const result = selectRecentChats(
      [
        chat({
          appChatId: 'solo',
          messages: [userMessage('1970-01-01T00:00:00.100Z')]
        }),
        chat({
          appChatId: 'ens',
          chatKind: 'ensemble',
          messages: [userMessage('1970-01-01T00:00:00.300Z')]
        })
      ],
      { limit: 5 }
    )
    expect(result.map((c) => c.appChatId)).toEqual(['ens', 'solo'])
  })
})

describe('chatRecentsSortKeyMs', () => {
  it('uses the latest genuine user message timestamp', () => {
    const key = chatRecentsSortKeyMs(
      chat({
        createdAt: 1,
        updatedAt: 99999,
        messages: [
          userMessage('1970-01-01T00:00:00.100Z'),
          assistantMessage('1970-01-01T00:00:00.150Z'),
          userMessage('1970-01-01T00:00:00.400Z')
        ]
      })
    )
    expect(key).toBe(Date.parse('1970-01-01T00:00:00.400Z'))
  })
})
