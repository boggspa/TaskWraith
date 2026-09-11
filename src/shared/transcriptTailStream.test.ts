import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../main/store/types'
import {
  MAX_TRANSCRIPT_TAIL_BYTES,
  MAX_TRANSCRIPT_TAIL_ROWS,
  TRANSCRIPT_TAIL_CHANNEL,
  TRANSCRIPT_TAIL_PROTOCOL_VERSION,
  buildTranscriptTailAppend,
  buildTranscriptTailReceipt,
  buildTranscriptTailResync,
  normalizeTranscriptTailReceipt,
  transcriptTailBytesExceed,
  normalizeTranscriptTailChatId,
  normalizeTranscriptTailFrame,
  transcriptTailRowsAreAddressable
} from './transcriptTailStream'

function message(id: string, content = `content-${id}`): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-09-11T17:50:00.000Z' } as ChatMessage
}

function rows(count: number, prefix = 'm'): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`))
}

function appendInput(overrides: Partial<Parameters<typeof buildTranscriptTailAppend>[0]> = {}) {
  return {
    chatId: 'chat-1',
    sequence: 1,
    baseMessageCount: 1492,
    messages: [message('m-1493')],
    appendedAtMs: 1_789_148_441_842,
    ...overrides
  }
}

describe('transcript tail channel identity', () => {
  it('is its own channel, never the acked chat-updated envelope', () => {
    expect(TRANSCRIPT_TAIL_CHANNEL).toBe('transcript-tail-appended')
    expect(TRANSCRIPT_TAIL_PROTOCOL_VERSION).toBe(1)
  })
})

describe('normalizeTranscriptTailChatId', () => {
  it('accepts an ordinary chat id', () => {
    expect(normalizeTranscriptTailChatId('64d38630-c813-4153-8a1f-3ca344b8018e')).toBe(
      '64d38630-c813-4153-8a1f-3ca344b8018e'
    )
  })

  it('rejects control bytes, blanks and non-strings', () => {
    expect(normalizeTranscriptTailChatId('chat\u0000id')).toBeNull()
    expect(normalizeTranscriptTailChatId('chat\nid')).toBeNull()
    expect(normalizeTranscriptTailChatId('')).toBeNull()
    expect(normalizeTranscriptTailChatId('   ')).toBeNull()
    expect(normalizeTranscriptTailChatId(42)).toBeNull()
  })
})

describe('transcriptTailRowsAreAddressable', () => {
  it('requires every row to carry a unique non-empty id', () => {
    expect(transcriptTailRowsAreAddressable([message('a'), message('b')])).toBe(true)
    expect(transcriptTailRowsAreAddressable([message('a'), message('a')])).toBe(false)
    expect(transcriptTailRowsAreAddressable([{ ...message('a'), id: '' } as ChatMessage])).toBe(
      false
    )
  })
})

describe('buildTranscriptTailAppend', () => {
  it('carries only the appended rows, with the pre-append count as the anchor', () => {
    const frame = buildTranscriptTailAppend(appendInput())
    expect(frame).not.toBeNull()
    expect(frame?.kind).toBe('tail-append')
    expect(frame?.chatId).toBe('chat-1')
    expect(frame?.sequence).toBe(1)
    expect(frame?.baseMessageCount).toBe(1492)
    expect(frame?.messages.map((row) => row.id)).toEqual(['m-1493'])
    expect(frame?.appendedAtMs).toBe(1_789_148_441_842)
  })

  it('copies the row array so a later producer mutation cannot rewrite a sent frame', () => {
    const messages = [message('m-1')]
    const frame = buildTranscriptTailAppend(appendInput({ messages }))
    messages.push(message('m-2'))
    expect(frame?.messages).toHaveLength(1)
  })

  it('declines an empty append rather than emitting a frame that says nothing', () => {
    expect(buildTranscriptTailAppend(appendInput({ messages: [] }))).toBeNull()
  })

  it('declines rows beyond the per-frame row cap so the pull lane keeps bulk', () => {
    expect(
      buildTranscriptTailAppend(appendInput({ messages: rows(MAX_TRANSCRIPT_TAIL_ROWS) }))
    ).not.toBeNull()
    expect(
      buildTranscriptTailAppend(appendInput({ messages: rows(MAX_TRANSCRIPT_TAIL_ROWS + 1) }))
    ).toBeNull()
  })

  it('declines an oversized single row so one image never rides the latency lane', () => {
    const fat = message('fat', 'x'.repeat(MAX_TRANSCRIPT_TAIL_BYTES))
    expect(buildTranscriptTailAppend(appendInput({ messages: [fat] }))).toBeNull()
  })

  it('honours a caller cap that is tighter than the ceiling, never looser', () => {
    expect(buildTranscriptTailAppend(appendInput({ messages: rows(3), maxRows: 2 }))).toBeNull()
    expect(
      buildTranscriptTailAppend(
        appendInput({ messages: rows(3), maxRows: MAX_TRANSCRIPT_TAIL_ROWS + 100 })
      )
    ).not.toBeNull()
  })

  it('declines unaddressable rows, because the consumer dedupes by id', () => {
    expect(
      buildTranscriptTailAppend(appendInput({ messages: [message('dup'), message('dup')] }))
    ).toBeNull()
  })

  it('declines a non-monotonic or malformed sequence', () => {
    expect(buildTranscriptTailAppend(appendInput({ sequence: 0 }))).toBeNull()
    expect(buildTranscriptTailAppend(appendInput({ sequence: -1 }))).toBeNull()
    expect(buildTranscriptTailAppend(appendInput({ sequence: 1.5 }))).toBeNull()
  })

  it('declines a malformed chat id or base count', () => {
    expect(buildTranscriptTailAppend(appendInput({ chatId: '' }))).toBeNull()
    expect(buildTranscriptTailAppend(appendInput({ baseMessageCount: -1 }))).toBeNull()
  })
})

describe('buildTranscriptTailResync', () => {
  it('carries a sequence so a skipped frame is not mistaken for a stalled producer', () => {
    const frame = buildTranscriptTailResync({
      chatId: 'chat-1',
      sequence: 9,
      messageCount: 1493,
      appendedAtMs: 5
    })
    expect(frame?.kind).toBe('tail-resync')
    expect(frame?.sequence).toBe(9)
    expect(frame?.messageCount).toBe(1493)
  })

  it('declines a malformed resync', () => {
    expect(
      buildTranscriptTailResync({ chatId: '', sequence: 1, messageCount: 0, appendedAtMs: 0 })
    ).toBeNull()
    expect(
      buildTranscriptTailResync({ chatId: 'c', sequence: 0, messageCount: 0, appendedAtMs: 0 })
    ).toBeNull()
  })
})

describe('normalizeTranscriptTailFrame', () => {
  it('round-trips a built append', () => {
    const frame = buildTranscriptTailAppend(appendInput())
    expect(normalizeTranscriptTailFrame(frame)).toEqual(frame)
  })

  it('round-trips a built resync', () => {
    const frame = buildTranscriptTailResync({
      chatId: 'chat-1',
      sequence: 2,
      messageCount: 10,
      appendedAtMs: 1
    })
    expect(normalizeTranscriptTailFrame(frame)).toEqual(frame)
  })

  it('rejects a foreign protocol version', () => {
    const frame = { ...buildTranscriptTailAppend(appendInput()), protocolVersion: 2 }
    expect(normalizeTranscriptTailFrame(frame)).toBeNull()
  })

  it('rejects an unknown kind', () => {
    const frame = { ...buildTranscriptTailAppend(appendInput()), kind: 'tail-delete' }
    expect(normalizeTranscriptTailFrame(frame)).toBeNull()
  })

  it('rejects an append whose rows exceed the wire cap', () => {
    const frame = {
      ...buildTranscriptTailAppend(appendInput()),
      messages: rows(MAX_TRANSCRIPT_TAIL_ROWS + 1)
    }
    expect(normalizeTranscriptTailFrame(frame)).toBeNull()
  })

  it('rejects an append with duplicate row ids', () => {
    const frame = {
      ...buildTranscriptTailAppend(appendInput()),
      messages: [message('dup'), message('dup')]
    }
    expect(normalizeTranscriptTailFrame(frame)).toBeNull()
  })

  it('rejects an append with no rows', () => {
    const frame = { ...buildTranscriptTailAppend(appendInput()), messages: [] }
    expect(normalizeTranscriptTailFrame(frame)).toBeNull()
  })

  it('rejects a missing base count, sequence or timestamp', () => {
    const base = buildTranscriptTailAppend(appendInput())
    expect(normalizeTranscriptTailFrame({ ...base, baseMessageCount: undefined })).toBeNull()
    expect(normalizeTranscriptTailFrame({ ...base, sequence: undefined })).toBeNull()
    expect(normalizeTranscriptTailFrame({ ...base, appendedAtMs: undefined })).toBeNull()
  })

  it('rejects non-objects and arrays', () => {
    expect(normalizeTranscriptTailFrame(null)).toBeNull()
    expect(normalizeTranscriptTailFrame('frame')).toBeNull()
    expect(normalizeTranscriptTailFrame([])).toBeNull()
  })
})

describe('transcript tail receipts', () => {
  it('builds a receipt for a well-formed chat id and sequence', () => {
    expect(buildTranscriptTailReceipt('chat-1', 4)).toEqual({
      protocolVersion: 1,
      chatId: 'chat-1',
      sequence: 4
    })
  })

  it('refuses a malformed receipt rather than sending a blank one', () => {
    expect(buildTranscriptTailReceipt('', 1)).toBeNull()
    expect(buildTranscriptTailReceipt('chat\nid', 1)).toBeNull()
    expect(buildTranscriptTailReceipt('chat-1', 0)).toBeNull()
    expect(buildTranscriptTailReceipt('chat-1', -2)).toBeNull()
    expect(buildTranscriptTailReceipt('chat-1', 1.5)).toBeNull()
  })

  it('round-trips a built receipt through the main-side validator', () => {
    const receipt = buildTranscriptTailReceipt('chat-1', 9)
    expect(normalizeTranscriptTailReceipt(receipt)).toEqual(receipt)
  })

  it('rejects an untrusted receipt the renderer could forge', () => {
    // This is the payload of an `ipcMain.on` listener: shape-validated here or
    // nowhere, because ipcMain.on gets none of the invoke-path validation.
    expect(normalizeTranscriptTailReceipt(null)).toBeNull()
    expect(normalizeTranscriptTailReceipt('receipt')).toBeNull()
    expect(normalizeTranscriptTailReceipt([])).toBeNull()
    expect(normalizeTranscriptTailReceipt({ chatId: 'chat-1', sequence: 1 })).toBeNull()
    expect(
      normalizeTranscriptTailReceipt({ protocolVersion: 2, chatId: 'chat-1', sequence: 1 })
    ).toBeNull()
    expect(
      normalizeTranscriptTailReceipt({ protocolVersion: 1, chatId: 'chat\u0000', sequence: 1 })
    ).toBeNull()
    expect(
      normalizeTranscriptTailReceipt({ protocolVersion: 1, chatId: ' chat-1 ', sequence: 1 })
    ).toBeNull()
    expect(
      normalizeTranscriptTailReceipt({ protocolVersion: 1, chatId: 'chat-1', sequence: 0 })
    ).toBeNull()
    expect(
      normalizeTranscriptTailReceipt({ protocolVersion: 1, chatId: 'chat-1', sequence: 2 ** 70 })
    ).toBeNull()
  })
})

describe('transcriptTailBytesExceed', () => {
  it('exits as soon as the budget is passed, without measuring the rest', () => {
    let measured = 0
    const rows = Array.from({ length: 50 }, (_, index) => {
      const row = message(`m-${index}`, 'x'.repeat(1_000))
      return new Proxy(row, {
        get(target, key, receiver) {
          if (key === 'content') measured += 1
          return Reflect.get(target, key, receiver)
        }
      }) as ChatMessage
    })
    expect(transcriptTailBytesExceed(rows, 4_000)).toBe(true)
    // The point of the function: a 400k-node payload must not be walked in full
    // just to conclude "too big".
    expect(measured).toBeLessThan(10)
  })

  it('returns false when every row fits', () => {
    expect(transcriptTailBytesExceed([message('a'), message('b')], 1_000_000)).toBe(false)
  })

  it('is false for no rows at all', () => {
    expect(transcriptTailBytesExceed([], 1)).toBe(false)
  })

  it('rejects an oversized frame at the WIRE boundary, not just at the producer', () => {
    const fat = message('fat', 'x'.repeat(MAX_TRANSCRIPT_TAIL_BYTES))
    const forged = {
      protocolVersion: 1,
      kind: 'tail-append',
      chatId: 'chat-1',
      sequence: 1,
      baseMessageCount: 0,
      messages: [fat],
      appendedAtMs: 1
    }
    expect(normalizeTranscriptTailFrame(forged)).toBeNull()
  })
})
