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
    // Zero-pad so later indices are not strict prefixes of earlier ones
    // (recipe C would otherwise collapse `const n = 1` under `const n = 10`).
    const snippet = (i: number) => `const n = ${String(i).padStart(3, '0')}`
    for (let i = 0; i < 65; i += 1) {
      renderToStaticMarkup(
        <HighlightedCodeBlock content={snippet(i)} language="javascript" />
      )
    }
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
    expect(getHighlightParseCountForTest()).toBe(65)

    // Oldest key (n = 0) was evicted — remount re-parses.
    renderToStaticMarkup(
      <HighlightedCodeBlock content={snippet(0)} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(66)
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
  })

  it('drops strict-prefix keys while a fence streams so settled remounts stay cached', () => {
    const settled = Array.from({ length: 5 }, (_, i) => `const settled_${i} = ${i}`)
    for (const content of settled) {
      renderToStaticMarkup(<HighlightedCodeBlock content={content} language="javascript" />)
    }
    expect(highlightToNodesCacheSizeForTest()).toBe(5)
    const afterSeedParses = getHighlightParseCountForTest()
    expect(afterSeedParses).toBe(5)

    // Append-only growth: each step is a strict prefix of the next.
    let growing = 'function streamFence() {\n'
    for (let i = 1; i <= 70; i += 1) {
      growing += '  x++;\n'
      renderToStaticMarkup(<HighlightedCodeBlock content={growing} language="javascript" />)
    }

    // 5 settled + 1 final stream entry; prefixes must not accumulate.
    expect(highlightToNodesCacheSizeForTest()).toBe(6)
    expect(getHighlightParseCountForTest()).toBe(afterSeedParses + 70)

    const afterStreamParses = getHighlightParseCountForTest()
    for (const content of settled) {
      renderToStaticMarkup(<HighlightedCodeBlock content={content} language="javascript" />)
    }
    expect(getHighlightParseCountForTest()).toBe(afterStreamParses)
  })

  it('promotes a touched entry so LRU eviction spares it', () => {
    const snippet = (i: number) => `const n = ${String(i).padStart(3, '0')}`
    for (let i = 0; i < 64; i += 1) {
      renderToStaticMarkup(
        <HighlightedCodeBlock content={snippet(i)} language="javascript" />
      )
    }
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
    expect(getHighlightParseCountForTest()).toBe(64)

    // Touch n=0 → most-recent; n=1 becomes the oldest.
    renderToStaticMarkup(
      <HighlightedCodeBlock content={snippet(0)} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(64)

    renderToStaticMarkup(
      <HighlightedCodeBlock content={snippet(64)} language="javascript" />
    )
    expect(highlightToNodesCacheSizeForTest()).toBe(64)
    expect(getHighlightParseCountForTest()).toBe(65)

    const afterInsert = getHighlightParseCountForTest()
    renderToStaticMarkup(
      <HighlightedCodeBlock content={snippet(0)} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(afterInsert)

    renderToStaticMarkup(
      <HighlightedCodeBlock content={snippet(1)} language="javascript" />
    )
    expect(getHighlightParseCountForTest()).toBe(afterInsert + 1)
  })

  it('hits the cache on remount of the exact final streamed content', () => {
    let final = 'function finalFence() {\n'
    for (let i = 1; i <= 40; i += 1) {
      final += '  y++;\n'
      renderToStaticMarkup(<HighlightedCodeBlock content={final} language="javascript" />)
    }
    expect(highlightToNodesCacheSizeForTest()).toBe(1)
    const afterStream = getHighlightParseCountForTest()
    expect(afterStream).toBe(40)

    renderToStaticMarkup(<HighlightedCodeBlock content={final} language="javascript" />)
    expect(getHighlightParseCountForTest()).toBe(afterStream)
    expect(highlightToNodesCacheSizeForTest()).toBe(1)
  })
})
