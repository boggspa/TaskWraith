import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HighlightMatch } from './HighlightMatch'

describe('HighlightMatch', () => {
  it('returns the text unchanged when the query is empty', () => {
    const html = renderToStaticMarkup(<HighlightMatch text="hello world" query="" />)

    expect(html).toBe('hello world')
    expect(html).not.toContain('<mark')
  })

  it('wraps every case-insensitive match in a highlighted mark', () => {
    const html = renderToStaticMarkup(<HighlightMatch text="Hello hello HELLO" query="hello" />)

    const marks = html.match(/<mark class="sidebar-search-highlight">/g) ?? []
    expect(marks).toHaveLength(3)
    // Original casing is preserved inside each mark.
    expect(html).toContain('>Hello</mark>')
    expect(html).toContain('>hello</mark>')
    expect(html).toContain('>HELLO</mark>')
  })

  it('returns the original text when nothing matches', () => {
    const html = renderToStaticMarkup(<HighlightMatch text="hello world" query="xyz" />)

    expect(html).toBe('hello world')
    expect(html).not.toContain('<mark')
  })

  it('preserves unmatched text around a match', () => {
    const html = renderToStaticMarkup(<HighlightMatch text="say hello there" query="hello" />)

    expect(html).toContain('say ')
    expect(html).toContain('<mark class="sidebar-search-highlight">hello</mark>')
    expect(html).toContain(' there')
  })
})
