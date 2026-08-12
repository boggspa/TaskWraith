import { describe, expect, it } from 'vitest'
import {
  STUDIO_ERROR_NUMBERS,
  StudioNdjsonDecoder,
  classifyStudioMessage,
  encodeStudioMessage,
  studioError,
  studioResult
} from './StudioProtocol'

describe('StudioProtocol codec', () => {
  it('encodes one LF-terminated line with no embedded raw newline', () => {
    const encoded = encodeStudioMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'studio/hello',
      params: { protocolVersion: 1, client: 'line one\nline two' }
    })
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.indexOf('\n')).toBe(encoded.length - 1)
    expect(JSON.parse(encoded)).toMatchObject({ id: 1, method: 'studio/hello' })
  })

  it('decodes multiple messages from a single chunk', () => {
    const decoder = new StudioNdjsonDecoder()
    const first = encodeStudioMessage(studioResult(1, { revision: 0 }))
    const second = encodeStudioMessage(studioResult(2, { revision: 1 }))
    const events = decoder.push(first + second)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.kind === 'message')).toBe(true)
  })

  it('reassembles a message split inside a multi-byte UTF-8 sequence', () => {
    const decoder = new StudioNdjsonDecoder()
    const encoded = Buffer.from(
      encodeStudioMessage(studioResult(7, { note: 'clip 🎬 marker' })),
      'utf8'
    )
    const splitAt = encoded.indexOf(Buffer.from('🎬', 'utf8')[0]) + 1
    const events = [
      ...decoder.push(encoded.subarray(0, splitAt)),
      ...decoder.push(encoded.subarray(splitAt))
    ]
    expect(events).toHaveLength(1)
    const only = events[0]
    expect(only.kind).toBe('message')
    if (only.kind === 'message') {
      expect((only.value as { result: { note: string } }).result.note).toBe('clip 🎬 marker')
    }
  })

  it('tolerates CRLF line endings and skips blank lines', () => {
    const decoder = new StudioNdjsonDecoder()
    const events = decoder.push('{"jsonrpc":"2.0","id":3,"result":{}}\r\n\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('message')
  })

  it('reports an unparsable line and keeps decoding afterwards', () => {
    const decoder = new StudioNdjsonDecoder()
    const events = decoder.push('this is not json\n{"jsonrpc":"2.0","id":4,"result":{}}\n')
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe('decode_error')
    expect(events[1].kind).toBe('message')
  })

  it('drops an oversized line and resynchronises at the next line feed', () => {
    const decoder = new StudioNdjsonDecoder(64)
    const oversized = 'x'.repeat(200)
    const first = decoder.push(oversized)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'decode_error', code: 'line_too_long' })
    const events = decoder.push('\n{"jsonrpc":"2.0","id":5,"result":{}}\n')
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('message')
    expect(decoder.pendingBytes).toBe(0)
  })

  it('rejects an oversized line that arrives complete in one chunk', () => {
    const decoder = new StudioNdjsonDecoder(40)
    const events = decoder.push(
      `{"pad":"${'y'.repeat(64)}"}\n{"jsonrpc":"2.0","id":6,"result":{}}\n`
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'decode_error', code: 'line_too_long' })
    expect(events[1].kind).toBe('message')
  })
})

describe('StudioProtocol envelopes', () => {
  it('classifies requests, notifications, responses and garbage', () => {
    expect(classifyStudioMessage({ jsonrpc: '2.0', id: 1, method: 'studio/hello' }).kind).toBe(
      'request'
    )
    expect(classifyStudioMessage({ jsonrpc: '2.0', method: 'studio/editCommitted' }).kind).toBe(
      'notification'
    )
    expect(classifyStudioMessage(studioResult(1, {})).kind).toBe('response')
    expect(classifyStudioMessage({ jsonrpc: '1.0', id: 1, method: 'x' }).kind).toBe('invalid')
    expect(classifyStudioMessage('nope').kind).toBe('invalid')
    expect(classifyStudioMessage({ jsonrpc: '2.0', id: 1.5, method: 'x' }).kind).toBe('invalid')
  })

  it('carries stable numeric and studio error codes', () => {
    const error = studioError(9, 'stale_base', 'base revision 3 is stale', { currentRevision: 5 })
    expect(error.error.code).toBe(STUDIO_ERROR_NUMBERS.stale_base)
    expect(error.error.data.studioCode).toBe('stale_base')
    expect(error.error.data.currentRevision).toBe(5)
  })
})
