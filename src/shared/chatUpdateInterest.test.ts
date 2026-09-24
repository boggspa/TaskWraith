import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord } from '../main/store/types'
import {
  CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
  MAX_CHAT_UPDATE_INTEREST_CHAT_ID_LENGTH,
  buildChatUpdateInvalidation,
  createChatUpdateInterestSnapshot,
  normalizeChatUpdateInterestSnapshot,
  normalizeChatUpdateInvalidation
} from './chatUpdateInterest'

function summary(chatId = 'chat-1', revision = 7): ChatListItem {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: chatId,
    archived: false,
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 20,
    runCount: 2
  } as ChatListItem
}

describe('chat update interest snapshots', () => {
  it('normalizes valid entries, rejects malformed ids and lets full interest dominate duplicates', () => {
    expect(
      normalizeChatUpdateInterestSnapshot({
        protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
        entries: [
          { chatId: ' chat-a ', mode: 'paged' },
          { chatId: '', mode: 'full' },
          { chatId: 'chat-a', mode: 'full' },
          { chatId: 'chat-b', mode: 'other' },
          { chatId: 'chat-c\n', mode: 'paged' },
          null
        ]
      })
    ).toEqual({
      protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
      entries: [{ chatId: 'chat-a', mode: 'full' }]
    })
  })

  it('bounds retained ids, parser work and caller-supplied limits', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      chatId: `chat-${index}`,
      mode: 'paged' as const
    }))
    expect(
      normalizeChatUpdateInterestSnapshot(
        { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries },
        3
      )?.entries
    ).toEqual([
      { chatId: 'chat-0', mode: 'paged' },
      { chatId: 'chat-1', mode: 'paged' },
      { chatId: 'chat-2', mode: 'paged' }
    ])

    const overlongId = 'x'.repeat(MAX_CHAT_UPDATE_INTEREST_CHAT_ID_LENGTH + 1)
    expect(
      createChatUpdateInterestSnapshot([
        { chatId: overlongId, mode: 'full' },
        { chatId: 'ok', mode: 'paged' }
      ]).entries
    ).toEqual([{ chatId: 'ok', mode: 'paged' }])
  })

  it('distinguishes a valid empty handshake from malformed wire values', () => {
    expect(
      normalizeChatUpdateInterestSnapshot({
        protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
        entries: []
      })
    ).toEqual({ protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries: [] })
    expect(normalizeChatUpdateInterestSnapshot({ entries: [] })).toBeNull()
    expect(normalizeChatUpdateInterestSnapshot([])).toBeNull()
  })
})

describe('chat update invalidations', () => {
  it('carries only a lean ChatListItem and derives a monotonic-compatible revision', () => {
    const item = summary('chat-a', 42)
    const invalidation = buildChatUpdateInvalidation(item)
    expect(invalidation).toEqual({
      protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
      kind: 'invalidation',
      chatId: 'chat-a',
      revision: 42,
      summary: item
    })
    expect(normalizeChatUpdateInvalidation(invalidation)).toBe(invalidation)
  })

  it('fails closed if a full record is accidentally offered to the compact channel', () => {
    const full = {
      ...summary(),
      summaryOnly: undefined,
      messages: [
        { id: 'message-1', role: 'assistant', content: 'large transcript', timestamp: 'now' }
      ]
    } as unknown as ChatRecord
    expect(buildChatUpdateInvalidation(full as unknown as ChatListItem)).toBeNull()
  })

  it('rejects mismatched, malformed and non-lean renderer payloads', () => {
    const valid = buildChatUpdateInvalidation(summary())!
    expect(normalizeChatUpdateInvalidation({ ...valid, chatId: 'other' })).toBeNull()
    expect(normalizeChatUpdateInvalidation({ ...valid, revision: -1 })).toBeNull()
    expect(
      normalizeChatUpdateInvalidation({
        ...valid,
        summary: { ...valid.summary, messages: [{}] }
      })
    ).toBeNull()
  })
})
