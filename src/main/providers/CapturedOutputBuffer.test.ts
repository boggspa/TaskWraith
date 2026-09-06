import { describe, expect, it } from 'vitest'

import { CAPTURED_OUTPUT_LIMIT, CapturedOutputBuffer } from './CapturedOutputBuffer'

/** What the old `s += chunk; if (s.length > cap) s = s.slice(-cap)` produced. */
function naive(chunks: readonly string[], cap: number): string {
  let s = ''
  for (const chunk of chunks) {
    s += chunk
    if (s.length > cap) s = s.slice(-cap)
  }
  return s
}

describe('CapturedOutputBuffer', () => {
  it('returns everything while under the limit', () => {
    const buf = new CapturedOutputBuffer(100)
    buf.push('abc')
    buf.push('def')
    expect(buf.value()).toBe('abcdef')
  })

  it('keeps the LAST limit characters, discarding the head', () => {
    const buf = new CapturedOutputBuffer(5)
    buf.push('abcdefghij')
    expect(buf.value()).toBe('fghij')
  })

  it('is character-for-character identical to the implementation it replaces', () => {
    const cap = 64
    for (const seed of [1, 7, 13, 99]) {
      const chunks: string[] = []
      let n = seed
      for (let i = 0; i < 200; i += 1) {
        n = (n * 1103515245 + 12345) % 2147483648
        const len = (n % 17) + 1
        chunks.push(String.fromCharCode(97 + (n % 26)).repeat(len))
      }
      const buf = new CapturedOutputBuffer(cap)
      for (const chunk of chunks) buf.push(chunk)
      expect(buf.value()).toBe(naive(chunks, cap))
    }
  })

  it('is stable across repeated reads', () => {
    const buf = new CapturedOutputBuffer(4)
    buf.push('abcdefg')
    expect(buf.value()).toBe('defg')
    expect(buf.value()).toBe('defg')
  })

  it('handles a single chunk far larger than the limit', () => {
    const buf = new CapturedOutputBuffer(10)
    buf.push('x'.repeat(1000) + 'TAIL')
    expect(buf.value()).toBe('xxxxxxTAIL')
  })

  it('tolerates empty pushes', () => {
    const buf = new CapturedOutputBuffer(10)
    buf.push('')
    buf.push('ab')
    buf.push('')
    expect(buf.value()).toBe('ab')
  })

  // THE POINT OF THIS CLASS. The old code allocated a fresh `cap`-sized string
  // on EVERY chunk once past the cap: at 1KB chunks and an 80KB cap that is ~80x
  // write amplification, and it is the allocation churn the main process died in.
  it('flattens amortised — not once per chunk', () => {
    const cap = 1_000
    const buf = new CapturedOutputBuffer(cap)
    const chunks = 5_000
    for (let i = 0; i < chunks; i += 1) buf.push('y'.repeat(100))
    // 500,000 chars ingested at a 1,000 cap. An implementation that trims per
    // chunk would compact 5,000 times; amortised compaction is bounded by
    // total/cap, with generous headroom here.
    expect(buf.compactions).toBeLessThanOrEqual(500 / 1 + 10)
    expect(buf.compactions).toBeLessThan(chunks / 10)
    expect(buf.value()).toBe('y'.repeat(cap))
  })

  it('ships the limit the capture path had before', () => {
    expect(CAPTURED_OUTPUT_LIMIT).toBe(80_000)
  })
})
