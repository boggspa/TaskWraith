import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderGlyph } from './ProviderGlyph'

describe('ProviderGlyph', () => {
  it('renders original mnemonic glyphs for all first-class providers', () => {
    for (const provider of [
      'gemini',
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama',
      'ensemble'
    ] as const) {
      const html = renderToStaticMarkup(<ProviderGlyph provider={provider} />)
      expect(html).toContain(`provider-glyph-${provider}`)
      expect(html).toContain(`--provider-accent:var(--provider-${provider}-color, currentColor)`)
      expect(html).toContain('provider-glyph-contrast-outline')
      expect(html).toContain('provider-glyph-foreground')
      expect(html).not.toContain('<img')
    }
  })

  it('paints a contrast copy behind the provider-accented foreground', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="codex" />)

    expect(html.indexOf('provider-glyph-contrast-outline')).toBeLessThan(
      html.indexOf('provider-glyph-foreground')
    )
    expect(html.match(/fill-rule="evenodd"/g)).toHaveLength(2)
  })

  it('renders Codex as the approved filled command cloud', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="codex" />)

    expect(html).toContain('fill-rule="evenodd"')
    expect(html.match(/M5\.2 18\.9C2\.9 18\.9/g)).toHaveLength(2)
    expect(html).not.toContain('M4.6 6.2h14.8v11.6H4.6Z')
  })

  it('falls back to a generic prompt glyph for future providers', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="future" />)

    expect(html).toContain('provider-glyph-future')
    expect(html).toContain('M4.6 6.2h14.8v11.6H4.6Z')
  })

  it('normalizes unknown provider ids before using them in classes and CSS vars', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="Future Provider!" />)

    expect(html).toContain('provider-glyph-future-provider')
    expect(html).toContain('--provider-accent:var(--provider-future-provider-color, currentColor)')
  })

  it('can keep the glyph shape while overriding the accent provider hue', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="ollama" accentProvider="alibaba" />)

    expect(html).toContain('provider-glyph-ollama')
    expect(html).toContain('--provider-accent:var(--provider-alibaba-color, currentColor)')
  })
})
