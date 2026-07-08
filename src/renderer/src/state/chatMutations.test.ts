/* @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { removeChat, removeChats } from './chatMutations'
import type { ChatRecord } from '../../../main/store/types'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Hydrated chat',
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Hello',
        timestamp: 'now',
      },
    ],
    runs: [{ runId: 'run-1', startedAt: 'now' }],
    ...overrides,
  }
}

describe('chatMutations.removeChats', () => {
  it('removes all requested ids in one operation', () => {
    const baseline = [
      chat({ appChatId: 'chat-1', updatedAt: 300 }),
      chat({ appChatId: 'chat-2', updatedAt: 200 }),
      chat({ appChatId: 'chat-3', updatedAt: 100 }),
    ]

    const next = removeChats(baseline, ['chat-1', 'chat-3'])

    expect(next.map((entry) => entry.appChatId)).toEqual(['chat-2'])
  })

  it('returns unchanged when ids is empty', () => {
    const baseline = [chat(), chat({ appChatId: 'chat-2' })]

    const next = removeChats(baseline, [])

    expect(next).toBe(baseline)
  })

  it('returns unchanged when no ids are present', () => {
    const baseline = [chat(), chat({ appChatId: 'chat-2' })]

    const next = removeChats(baseline, ['missing-1', 'missing-2'])

    expect(next).toBe(baseline)
  })

  it('matches removeChat semantics per id', () => {
    const baseline = [chat(), chat({ appChatId: 'chat-2' }), chat({ appChatId: 'chat-3' })]

    expect(removeChats(baseline, ['chat-2'])).toEqual(removeChat(baseline, 'chat-2'))
    expect(removeChats(baseline, ['missing'])).toEqual(removeChat(baseline, 'missing'))
  })
})
