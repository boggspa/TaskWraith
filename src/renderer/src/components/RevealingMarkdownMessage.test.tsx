import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RevealingMarkdownMessage, safeTailSlice } from './RevealingMarkdownMessage'

describe('safeTailSlice', () => {
  it('reveals code blocks instantly (never a partial fence)', () => {
    const code = '```ts\nconst x = 1'
    expect(safeTailSlice(code, 'code', 2)).toBe(code)
  })

  it('reveals paragraphs / headings at the grapheme cursor', () => {
    expect(safeTailSlice('hello world', 'paragraph', 5)).toBe('hello')
    expect(safeTailSlice('# Title here', 'heading', 7)).toBe('# Title')
  })

  it('keeps multi-byte graphemes whole in a paragraph slice', () => {
    const p = 'hi 👨‍👩‍👧‍👦 there'
    // 4 graphemes = "hi " + the family emoji, never a split surrogate.
    expect(safeTailSlice(p, 'paragraph', 4)).toBe('hi 👨‍👩‍👧‍👦')
  })

  it('reveals lists/tables at completed-line granularity (no half-row flip)', () => {
    const list = '- one\n- two\n- thr'
    // Cursor mid-third-item → cut to the last newline (two completed items).
    expect(safeTailSlice(list, 'list', 14)).toBe('- one\n- two\n')
    // No completed line yet → show nothing rather than a half-item.
    expect(safeTailSlice('- on', 'list', 3)).toBe('')

    const table = '| a | b |\n| - | - |\n| 1 |'
    expect(safeTailSlice(table, 'table', 24)).toBe('| a | b |\n| - | - |\n')
  })
})

describe('RevealingMarkdownMessage (smoke)', () => {
  it('renders the full content when not live (non-animated path)', () => {
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'A paragraph.\n\nSecond para.'} isLive={false} />
    )
    expect(html).toContain('A paragraph.')
    expect(html).toContain('Second para.')
  })

  it('renders the stable prefix immediately even while live', () => {
    // The settled first block is solid regardless of the tail reveal cursor.
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'Settled block.\n\ntail growing'} isLive reduceMotion />
    )
    expect(html).toContain('Settled block.')
  })
})
