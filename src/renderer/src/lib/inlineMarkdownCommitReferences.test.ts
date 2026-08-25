import { describe, expect, it } from 'vitest'
import {
  isInlineMarkdownCommitHash,
  rehypeInlineMarkdownCommitReferences,
  tokeniseInlineMarkdownCommitReferences
} from './inlineMarkdownCommitReferences'
import type { Root } from 'hast'

describe('inline Markdown commit-reference candidates', () => {
  it('finds bounded abbreviated and full hashes without changing source text', () => {
    const full = '0123456789abcdef0123456789abcdef01234567'
    expect(tokeniseInlineMarkdownCommitReferences(`Landed a1b2c3d and ${full}.`)).toEqual([
      { kind: 'text', value: 'Landed ' },
      { kind: 'candidate', value: 'a1b2c3d' },
      { kind: 'text', value: ' and ' },
      { kind: 'candidate', value: full },
      { kind: 'text', value: '.' }
    ])
  })

  it('rejects short and overlong hexadecimal runs', () => {
    const overlong = 'a'.repeat(41)
    expect(tokeniseInlineMarkdownCommitReferences(`abc123 ${overlong}`)).toEqual([
      { kind: 'text', value: `abc123 ${overlong}` }
    ])
    expect(isInlineMarkdownCommitHash('abc123')).toBe(false)
    expect(isInlineMarkdownCommitHash(overlong)).toBe(false)
  })

  it('does not turn short all-hex English words into catalogue lookups', () => {
    expect(tokeniseInlineMarkdownCommitReferences('The surface was defaced.')).toEqual([
      { kind: 'text', value: 'The surface was defaced.' }
    ])
    expect(isInlineMarkdownCommitHash('defaced')).toBe(true)
  })

  it('recognises exact inline-code candidates with the same length bounds', () => {
    expect(isInlineMarkdownCommitHash('6a561c53e')).toBe(true)
  })

  it('treats an annotated eight-digit color as atomic rather than a commit', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'span',
          properties: { dataColorToken: '#11223344' },
          children: [{ type: 'text', value: '#11223344' }]
        }
      ]
    }

    rehypeInlineMarkdownCommitReferences()(tree)

    expect(tree.children[0]).toEqual({
      type: 'element',
      tagName: 'span',
      properties: { dataColorToken: '#11223344' },
      children: [{ type: 'text', value: '#11223344' }]
    })
  })
})
