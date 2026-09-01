import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../main/store/types'
import {
  DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  buildTranscriptPage,
  estimateJsonishBytes,
  selectTranscriptPageEndingAt,
  selectTranscriptPageStartingAt
} from './transcriptPage'

function message(id: string, content = `content-${id}`): ChatMessage {
  return { id, role: 'user', content, timestamp: '2026-09-01T00:00:00.000Z' } as ChatMessage
}

function messages(count: number, prefix = 'm'): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`))
}

describe('estimateJsonishBytes', () => {
  it('walks the full structure (2 bytes per string char, 8 per primitive)', () => {
    expect(estimateJsonishBytes(null)).toBe(0)
    expect(estimateJsonishBytes('abc')).toBe(6)
    expect(estimateJsonishBytes(42)).toBe(8)
    expect(estimateJsonishBytes(true)).toBe(8)
    expect(estimateJsonishBytes(['ab', 1])).toBe(16 + 4 + 8)
    expect(estimateJsonishBytes({ k: 'v' })).toBe(16 + 2 + 2)
  })

  it('is not the cheap transport estimator: nested content is counted', () => {
    const rich = message('rich')
    ;(rich as unknown as Record<string, unknown>).toolEvents = [{ payload: 'x'.repeat(1000) }]
    const plain = message('plain')
    expect(estimateJsonishBytes(rich)).toBeGreaterThan(estimateJsonishBytes(plain) + 2000)
  })
})

describe('selectTranscriptPageEndingAt', () => {
  it('returns the whole array when it fits the page budget', () => {
    const range = selectTranscriptPageEndingAt(messages(10), 10)
    expect(range).toMatchObject({ start: 0, end: 10 })
    expect(range.estimatedBytes).toBeGreaterThan(0)
  })

  it('bounds the window by message count', () => {
    const range = selectTranscriptPageEndingAt(messages(10), 10, { maxMessagesPerPage: 4 })
    expect(range).toMatchObject({ start: 6, end: 10 })
  })

  it('bounds the window by bytes but always includes one message', () => {
    const big = [message('huge', 'x'.repeat(10_000)), ...messages(3)]
    const range = selectTranscriptPageEndingAt(big, big.length, { maxBytesPerPage: 100 })
    expect(range).toMatchObject({ start: 3, end: 4 })
  })

  it('clamps out-of-range ends', () => {
    expect(selectTranscriptPageEndingAt(messages(5), 99).end).toBe(5)
    expect(selectTranscriptPageEndingAt(messages(5), -3)).toMatchObject({ start: 0, end: 0 })
  })
})

describe('selectTranscriptPageStartingAt', () => {
  it('windows forward by count', () => {
    const range = selectTranscriptPageStartingAt(messages(10), 2, { maxMessagesPerPage: 3 })
    expect(range).toMatchObject({ start: 2, end: 5 })
  })

  it('matches the default renderer window limits', () => {
    expect(DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES).toBe(1_500)
    expect(DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES).toBe(24 * 1024 * 1024)
  })
})

describe('buildTranscriptPage', () => {
  const chat = {
    appChatId: 'chat-1',
    messages: messages(20),
    updatedAt: 123
  }

  it('returns the tail page by default with stable cursors', () => {
    const page = buildTranscriptPage(chat, { chatId: 'chat-1', maxMessages: 5 })!
    expect(page.messages.map((m) => m.id)).toEqual(['m-15', 'm-16', 'm-17', 'm-18', 'm-19'])
    expect(page).toMatchObject({
      chatId: 'chat-1',
      totalMessageCount: 20,
      windowStart: 15,
      windowEnd: 20,
      hasOlder: true,
      hasNewer: false,
      oldestMessageId: 'm-15',
      newestMessageId: 'm-19',
      updatedAt: 123
    })
  })

  it('returns the whole transcript when it fits, without slicing', () => {
    const page = buildTranscriptPage(chat, { chatId: 'chat-1' })!
    expect(page.messages).toBe(chat.messages)
    expect(page.hasOlder).toBe(false)
    expect(page.hasNewer).toBe(false)
  })

  it('pages older than a cursor (exclusive)', () => {
    const page = buildTranscriptPage(chat, {
      chatId: 'chat-1',
      beforeMessageId: 'm-15',
      maxMessages: 3
    })!
    expect(page.messages.map((m) => m.id)).toEqual(['m-12', 'm-13', 'm-14'])
    expect(page.hasOlder).toBe(true)
    expect(page.hasNewer).toBe(true)
  })

  it('pages newer than a cursor (exclusive)', () => {
    const page = buildTranscriptPage(chat, {
      chatId: 'chat-1',
      afterMessageId: 'm-4',
      maxMessages: 2
    })!
    expect(page.messages.map((m) => m.id)).toEqual(['m-5', 'm-6'])
    expect(page.hasOlder).toBe(true)
    expect(page.hasNewer).toBe(true)
  })

  it('pages around a message id, biased older first within the count budget', () => {
    const page = buildTranscriptPage(chat, {
      chatId: 'chat-1',
      aroundMessageId: 'm-10',
      maxMessages: 6
    })!
    expect(page.messages.map((m) => m.id)).toEqual(['m-5', 'm-6', 'm-7', 'm-8', 'm-9', 'm-10'])
    expect(page.hasOlder).toBe(true)
    expect(page.hasNewer).toBe(true)
    expect(page.newestMessageId).toBe('m-10')
  })

  it('spends leftover byte budget on newer context around the anchor', () => {
    // ~148 estimated bytes per fixture message: the older side fits only 2,
    // leaving count budget (and one always-included row) for the newer side.
    const page = buildTranscriptPage(chat, {
      chatId: 'chat-1',
      aroundMessageId: 'm-10',
      maxMessages: 6,
      maxBytes: 400
    })!
    expect(page.messages[0].id).toBe('m-9')
    expect(page.messages.map((m) => m.id)).toContain('m-10')
    expect(page.windowEnd).toBeGreaterThan(11)
  })

  it('returns null for an unknown anchor id', () => {
    expect(buildTranscriptPage(chat, { chatId: 'chat-1', aroundMessageId: 'nope' })).toBeNull()
    expect(buildTranscriptPage(chat, { chatId: 'chat-1', beforeMessageId: 'nope' })).toBeNull()
    expect(buildTranscriptPage(chat, { chatId: 'chat-1', afterMessageId: 'nope' })).toBeNull()
  })

  it('handles an empty transcript', () => {
    const page = buildTranscriptPage(
      { appChatId: 'chat-2', messages: [], updatedAt: 0 },
      { chatId: 'chat-2' }
    )!
    expect(page.messages).toEqual([])
    expect(page.totalMessageCount).toBe(0)
    expect(page.oldestMessageId).toBeNull()
    expect(page.newestMessageId).toBeNull()
    expect(page.hasOlder).toBe(false)
    expect(page.hasNewer).toBe(false)
  })
})
