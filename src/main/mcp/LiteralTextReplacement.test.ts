import { describe, expect, it } from 'vitest'

import { replaceLiteralText } from './LiteralTextReplacement'

describe('replaceLiteralText', () => {
  it.each(['$&', '$$', "$'", '$`', '$1', '$<name>'])(
    'treats %s as literal replacement text',
    (replacement) => {
      expect(replaceLiteralText('before OLD after OLD', 'OLD', replacement, false)).toBe(
        `before ${replacement} after OLD`
      )
    }
  )

  it('replaces only the first match by default', () => {
    expect(replaceLiteralText('one one one', 'one', 'two', false)).toBe('two one one')
  })

  it('replaces every match without interpreting replacement tokens', () => {
    expect(replaceLiteralText('one one one', 'one', '$&-$$', true)).toBe(
      '$&-$$ $&-$$ $&-$$'
    )
  })

  it('preserves the MCP validation errors', () => {
    expect(() => replaceLiteralText('content', '', 'replacement', false)).toThrow(
      'old_string is required.'
    )
    expect(() => replaceLiteralText('content', 'missing', 'replacement', false)).toThrow(
      'old_string was not found in the target file.'
    )
  })
})
