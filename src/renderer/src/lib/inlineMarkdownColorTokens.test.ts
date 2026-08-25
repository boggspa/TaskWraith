import { describe, expect, it } from 'vitest'
import {
  normalizeInlineMarkdownColor,
  tokeniseInlineMarkdownColors
} from './inlineMarkdownColorTokens'

function compact(value: string): Array<[string, string, string?]> {
  return tokeniseInlineMarkdownColors(value).map((segment) =>
    segment.kind === 'color'
      ? [segment.kind, segment.value, segment.color]
      : [segment.kind, segment.value]
  )
}

describe('inline Markdown color tokens', () => {
  it('recognises bounded six/eight-digit prose colors without changing source text', () => {
    expect(compact('Keep #abc and #0f08 literal; preview #B73BD5 and #11223344.')).toEqual([
      ['text', 'Keep #abc and #0f08 literal; preview '],
      ['color', '#B73BD5', '#B73BD5'],
      ['text', ' and '],
      ['color', '#11223344', '#11223344'],
      ['text', '.']
    ])
  })

  it('rejects partial, overlong, embedded, and doubled-hash candidates', () => {
    const value = 'Keep #12 #12345 #1234567 #123456789 word#abcdef #abcdefword ##abcdef literal.'
    expect(compact(value)).toEqual([['text', value]])
  })

  it('normalises only complete CSS hex tokens', () => {
    expect(normalizeInlineMarkdownColor('#fff')).toBe('#FFFFFF')
    expect(normalizeInlineMarkdownColor('#abcd')).toBe('#AABBCCDD')
    expect(normalizeInlineMarkdownColor('#00aaFF')).toBe('#00AAFF')
    expect(normalizeInlineMarkdownColor('#12345')).toBeUndefined()
    expect(normalizeInlineMarkdownColor('123456')).toBeUndefined()
  })
})
