import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { setSideChatAuthorityReturn, sideChatAuthorityReturnEnabled } from './sideChatReturn'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'side-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Async design room',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    parentChatId: 'parent-1',
    parentChatRelation: 'sideChat',
    sideChatContext: { createdAt: 1 },
    messages: [],
    runs: [],
    ...overrides
  }
}

describe('side-chat authority return preference', () => {
  it('is default-off and explicit per side chat', () => {
    expect(sideChatAuthorityReturnEnabled(chat())).toBe(false)
    expect(sideChatAuthorityReturnEnabled(chat({ sideChatContext: { createdAt: 1 } }))).toBe(false)
  })

  it('records the opt-in gesture boundary without changing isolation identity', () => {
    const updated = setSideChatAuthorityReturn(chat(), true, 42)

    expect(sideChatAuthorityReturnEnabled(updated)).toBe(true)
    expect(updated).toMatchObject({
      appChatId: 'side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      updatedAt: 42,
      sideChatContext: {
        createdAt: 1,
        returnResultToParent: true,
        returnResultEnabledAt: 42
      }
    })
    expect(updated.delegationContext).toBeUndefined()
  })

  it('disables future returns while retaining prior attribution', () => {
    const source = chat({
      sideChatContext: {
        createdAt: 1,
        returnResultToParent: true,
        returnResultEnabledAt: 20,
        resultReturnedAt: 30,
        lastReturnedMessageId: 'answer-1'
      }
    })
    const updated = setSideChatAuthorityReturn(source, false, 42)

    expect(sideChatAuthorityReturnEnabled(updated)).toBe(false)
    expect(updated.sideChatContext).toMatchObject({
      returnResultToParent: false,
      resultReturnedAt: 30,
      lastReturnedMessageId: 'answer-1'
    })
    expect(updated.sideChatContext?.returnResultEnabledAt).toBeUndefined()
  })

  it('does not mutate unrelated linked-chat records', () => {
    const subThread = chat({ parentChatRelation: 'subThread', sideChatContext: undefined })
    expect(setSideChatAuthorityReturn(subThread, true, 42)).toBe(subThread)
  })
})
