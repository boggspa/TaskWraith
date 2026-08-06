import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  HighlightedCodeBlock,
  chatHighlightStyleRules,
  extensionsForLanguage
} from './HighlightedCodeBlock'

function classForColor(rules: string, color: string): string | null {
  const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = rules.match(
    new RegExp(`\\.([\\w\\u0370-\\u03ff]+)\\s*\\{[^}]*color:\\s*${escaped}`)
  )
  return match?.[1] ?? null
}

describe('HighlightedCodeBlock', () => {
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
})
