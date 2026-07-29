import { describe, expect, it } from 'vitest'
import { planEmoticonAutoReplace } from './emoticonAutoReplace'

/** Plan against a draft whose just-typed space is the last char. */
const planAtEnd = (value: string) => planEmoticonAutoReplace(value, value.length)

describe('planEmoticonAutoReplace', () => {
  it('converts the classic set at a whitespace boundary', () => {
    expect(planAtEnd('hi :-) ')?.value).toBe('hi 🙂 ')
    expect(planAtEnd('hi :) ')?.value).toBe('hi 🙂 ')
    expect(planAtEnd('yay :D ')?.value).toBe('yay 😄 ')
    expect(planAtEnd('aw :( ')?.value).toBe('aw 🙁 ')
    expect(planAtEnd('wink ;-) ')?.value).toBe('wink 😉 ')
    expect(planAtEnd('bleh :P ')?.value).toBe('bleh 😛 ')
    expect(planAtEnd('bleh :p ')?.value).toBe('bleh 😛 ')
    expect(planAtEnd('wow :O ')?.value).toBe('wow 😮 ')
    expect(planAtEnd("sad :'( ")?.value).toBe('sad 😢 ')
    expect(planAtEnd('hm :/ ')?.value).toBe('hm 😕 ')
    expect(planAtEnd('meh :| ')?.value).toBe('meh 😐 ')
    expect(planAtEnd('love <3 ')?.value).toBe('love ❤️ ')
  })

  it('prefers the longest emoticon — </3 beats <3, :-) beats :)', () => {
    expect(planAtEnd('rip </3 ')?.value).toBe('rip 💔 ')
    const nose = planAtEnd('hey :-) ')
    expect(nose?.emoticon).toBe(':-)')
    expect(nose?.replacedStart).toBe(4)
  })

  it('places the caret right after the emoji and the preserved space', () => {
    const result = planAtEnd('hi :-) ')
    // 'hi ' (3) + '🙂' (2 UTF-16 units) + ' ' (1)
    expect(result?.caret).toBe(6)
    expect(result?.value.length).toBe(6)
  })

  it('converts mid-draft without touching text after the caret', () => {
    // Caret sits after the space following the emoticon (index 6).
    const result = planEmoticonAutoReplace('a :-) b', 6)
    expect(result?.value).toBe('a 🙂 b')
    expect(result?.caret).toBe(5)
  })

  it('requires a left boundary — never converts glued to a word or number', () => {
    expect(planAtEnd('1<3 ')).toBeNull()
    expect(planAtEnd('PS:) ')).toBeNull()
    expect(planAtEnd('a:-) ')).toBeNull()
    expect(planAtEnd('https:/ ')).toBeNull()
    // Emoji (non-space char) immediately before also blocks.
    expect(planAtEnd('🙂:-) ')).toBeNull()
  })

  it('accepts start-of-draft, newline, and tab boundaries', () => {
    expect(planAtEnd(':-) ')?.value).toBe('🙂 ')
    expect(planAtEnd('line one\n:D ')?.value).toBe('line one\n😄 ')
    expect(planAtEnd('\t;) ')?.value).toBe('\t😉 ')
  })

  it('only converts the emoticon adjacent to the just-typed space', () => {
    // The earlier ':)' already has text after it; only the last one converts.
    expect(planAtEnd('x :) :) ')?.value).toBe('x :) 🙂 ')
  })

  it('never converts inside inline code (odd backtick parity)', () => {
    expect(planAtEnd('` :-) ')).toBeNull()
    // Parity closes → converts again after the span.
    expect(planAtEnd('`code` :-) ')?.value).toBe('`code` 🙂 ')
  })

  it('never converts inside or on a fenced code block', () => {
    expect(planAtEnd('```\n:-) ')).toBeNull()
    expect(planAtEnd('``` :-) ')).toBeNull()
    expect(planAtEnd('```\ncode\n```\n:-) ')?.value).toBe('```\ncode\n```\n🙂 ')
  })

  it('returns null when the caret is not directly after a space', () => {
    expect(planEmoticonAutoReplace('hi :-)', 6)).toBeNull()
    expect(planEmoticonAutoReplace('hi :-) x', 8)).toBeNull()
  })

  it('handles out-of-range and degenerate carets without throwing', () => {
    expect(planEmoticonAutoReplace('', 0)).toBeNull()
    expect(planEmoticonAutoReplace(' ', 1)).toBeNull()
    expect(planEmoticonAutoReplace('ab', 99)).toBeNull()
    expect(planEmoticonAutoReplace(':) ', -1)).toBeNull()
  })

  it('does not convert plain words or near-miss sequences', () => {
    expect(planAtEnd('hello ')).toBeNull()
    expect(planAtEnd('<30 ')).toBeNull()
    expect(planAtEnd(':-)) ')).toBeNull()
    expect(planAtEnd('(: ')).toBeNull()
  })
})
