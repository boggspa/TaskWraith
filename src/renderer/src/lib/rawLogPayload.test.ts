import { describe, expect, it } from 'vitest'
import { RAW_LOG_FIELD_CHAR_CAP, rawLogPayloadForStringify } from './rawLogPayload'

describe('rawLogPayloadForStringify', () => {
  it('returns the SAME reference for small payloads (no allocation)', () => {
    const payload = { type: 'tool_result', output: 'small', nested: { text: 'ok' } }
    expect(rawLogPayloadForStringify(payload)).toBe(payload)
  })

  it('truncates oversized top-level string fields with head + tail + marker', () => {
    const output = `HEAD${'x'.repeat(RAW_LOG_FIELD_CHAR_CAP * 2)}TAIL`
    const payload = { type: 'tool_result', output }
    const out = rawLogPayloadForStringify(payload) as { output: string; type: string }
    expect(out).not.toBe(payload)
    expect(out.type).toBe('tool_result')
    expect(out.output.length).toBeLessThan(RAW_LOG_FIELD_CHAR_CAP + 200)
    expect(out.output.startsWith('HEAD')).toBe(true)
    expect(out.output.endsWith('TAIL')).toBe(true)
    expect(out.output).toContain('chars elided')
  })

  it('truncates oversized strings at any realistic nesting depth', () => {
    const big = 'y'.repeat(RAW_LOG_FIELD_CHAR_CAP + 1)
    const payload = {
      result: { output: big },
      // Codex/ACP shape: item.content[0].text — depth 3.
      item: { content: [{ text: big }] },
      deep: { a: { b: { c: { d: big } } } }
    }
    const out = rawLogPayloadForStringify(payload) as typeof payload
    expect(out.result.output).toContain('chars elided')
    expect(out.item.content[0].text).toContain('chars elided')
    expect(out.deep.a.b.c.d).toContain('chars elided')
  })

  it('prefers a newline seam so a secret cannot be split across the elision', () => {
    // A line-oriented log with a token near the head boundary: the cut lands
    // on a newline, keeping every line (and any token inside it) intact on
    // one side of the seam.
    const lines = Array.from({ length: 2_000 }, (_, i) => `line-${i} Bearer secret-token-${i}`)
    const value = lines.join('\n')
    const out = rawLogPayloadForStringify(value) as string
    const [head, rest] = out.split('\n… [raw log: ')
    expect(rest).toBeDefined()
    // Head ends on a COMPLETE line — no dangling fragment of a longer line.
    const lastHeadLine = head.slice(head.lastIndexOf('\n') + 1)
    expect(lines).toContain(lastHeadLine)
    // Tail also starts on a complete line.
    const tail = out.slice(out.indexOf('] …\n') + 4)
    const firstTailLine = tail.slice(0, tail.indexOf('\n'))
    expect(lines).toContain(firstTailLine)
  })

  it('handles bare strings (malformed_json lane) and non-objects', () => {
    const line = 'z'.repeat(RAW_LOG_FIELD_CHAR_CAP + 10)
    expect(rawLogPayloadForStringify(line) as string).toContain('chars elided')
    expect(rawLogPayloadForStringify(42)).toBe(42)
    expect(rawLogPayloadForStringify(null)).toBe(null)
  })

  it('preserves exit/quota markers in small payloads for downstream matching', () => {
    const payload = { type: 'process_exit', message: 'Process exited with code 1' }
    expect(rawLogPayloadForStringify(payload)).toBe(payload)
  })
})
