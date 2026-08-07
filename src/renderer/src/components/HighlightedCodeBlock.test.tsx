import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HighlightedCodeBlock,
  chatHighlightStyleRules,
  extensionsForLanguage,
  getHighlightParseCountForTest,
  highlightToNodesCacheSizeForTest,
  resetHighlightToNodesCacheForTest
} from './HighlightedCodeBlock'

function classForColor(rules: string, color: string): string | null {
  const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = rules.match(
    new RegExp(`\\.([\\w\\u0370-\\u03ff]+)\\s*\\{[^}]*color:\\s*${escaped}`)
  )
  return match?.[1] ?? null
}

describe('HighlightedCodeBlock', () => {
  beforeEach(() => {
    resetHighlightToNodesCacheForTest()
  })

  it('renders a static Lezer body with no CodeMirror editor chrome', () => {
    const html = renderToStaticMarkup(
      <HighlightedCodeBlock content={'const value = "ok"'} language="javascript" />
    )

    expect(html).toContain('message-code-static')
    expect(html).toContain('message-code-content')
    expect(html).not.toContain('cm-editor')
    expect(html).not.toContain('cm-scroller')
    expect(html).not.toContain('cm-content')
    expect(html).not.toContain('cm-line')
  })

  it('applies chatHighlightStyle token colors for a small JS snippet', () => {
    const rules = chatHighlightStyleRules()
    expect(rules).toContain('#ff9f7a')
    expect(rules).toContain('#8ee6a8')

    const keywordClass = classForColor(rules, '#ff9f7a')
    const stringClass = classForColor(rules, '#8ee6a8')
    expect(keywordClass).toBeTruthy()
    expect(stringClass).toBeTruthy()

    const html = renderToStaticMarkup(
      <HighlightedCodeBlock content={'const value = "ok"'} language="js" />
    )

    expect(html).toContain(`class="${keywordClass}"`)
    expect(html).toMatch(new RegExp(`<span class="${keywordClass}">const</span>`))
    expect(html).toContain(`class="${stringClass}"`)
    expect(html).toMatch(new RegExp(`<span class="${stringClass}">&quot;ok&quot;</span>`))
  })

  it('falls back to plain text when the language pack is unknown', () => {
    const html = renderToStaticMarkup(
      <HighlightedCodeBlock content={'plain source'} language="not-a-real-lang" />
    )
    expect(html).toContain('plain source')
    expect(html).not.toContain('<span')
  })

  it('keeps the prior language-pack map via extensionsForLanguage', () => {
    expect(extensionsForLanguage('typescript').length).toBe(1)
    expect(extensionsForLanguage('python').length).toBe(1)
    expect(extensionsForLanguage('bash').length).toBe(1)
    expect(extensionsForLanguage('').length).toBe(0)
    expect(extensionsForLanguage('unknown-lang').length).toBe(0)
  })

  it('parses once across remounts with the same content and language', () => {
    const content = 'const value = "ok"'
    const first = renderToStaticMarkup(
      <HighlightedCodeBlock content={content} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(1)

    const second = renderToStaticMarkup(
      <HighlightedCodeBlock content={content} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(1)
    expect(second).toBe(first)
    expect(highlightToNodesCacheSizeForTest()).toBe(1)
  })

  it('hits the cache across js/javascript language aliases', () => {
    const content = 'const alias = 1'
    renderToStaticMarkup(<HighlightedCodeBlock content={content} language="js" />)
    expect(getHighlightParseCountForTest()).toBe(1)

    renderToStaticMarkup(<HighlightedCodeBlock content={content} language="javascript" />)
    expect(getHighlightParseCountForTest()).toBe(1)
    expect(highlightToNodesCacheSizeForTest()).toBe(1)
  })

  it('misses the cache when content changes', () => {
    renderToStaticMarkup(<HighlightedCodeBlock content={'const a = 1'} language="js" />)
    renderToStaticMarkup(<HighlightedCodeBlock content={'const a = 2'} language="js" />)
    expect(getHighlightParseCountForTest()).toBe(2)
    expect(highlightToNodesCacheSizeForTest()).toBe(2)
  })

  it('does not grow the cache for unknown languages', () => {
    renderToStaticMarkup(
      <HighlightedCodeBlock content={'plain source'} language="not-a-real-lang" />
    )
    renderToStaticMarkup(
      <HighlightedCodeBlock content={'more plain'} language="also-unknown" />
    )
    expect(getHighlightParseCountForTest()).toBe(0)
    expect(highlightToNodesCacheSizeForTest()).toBe(0)
  })

  it('highlights huge content without storing it in the cache', () => {
    const huge = `${'const x = 1;\n'.repeat(20_000)}// end`
    expect(huge.length).toBeGreaterThan(200_000)

    const html = renderToStaticMarkup(
      <HighlightedCodeBlock content={huge} language="javascript" />
    )
    expect(html).toContain('message-code-static')
    expect(getHighlightParseCountForTest()).toBe(1)
    expect(highlightToNodesCacheSizeForTest()).toBe(0)

    renderToStaticMarkup(<HighlightedCodeBlock content={huge} language="javascript" />)
    expect(getHighlightParseCountForTest()).toBe(2)
    expect(highlightToNodesCacheSizeForTest()).toBe(0)
  })

  it('evicts the oldest entry once the cache exceeds 64 keys', () => {
    for (let i = 0; i < 65; i += 1) {
      renderToStaticMarkup(
        <HighlightedCodeBlock content={`const n = ${i}`} language="javascript" />
      )
    }
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
    expect(getHighlightParseCountForTest()).toBe(65)

    // Oldest key (n = 0) was evicted — remount re-parses.
    renderToStaticMarkup(
      <HighlightedCodeBlock content={'const n = 0'} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(66)
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
  })
})
