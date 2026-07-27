import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderGlyph } from './ProviderGlyph'

describe('ProviderGlyph', () => {
  it('uses only neutral fallback artwork for external or unknown provider ids', () => {
    for (const provider of ['gemini', 'codex', 'claude', 'pi', 'mistral', 'future'] as const) {
      const html = renderToStaticMarkup(<ProviderGlyph provider={provider} />)
      expect(html).toContain(`provider-glyph-${provider}`)
      expect(html).toContain(`--provider-accent:var(--provider-${provider}-color, currentColor)`)
      expect(html).toContain('provider-glyph-contrast-outline')
      expect(html).toContain('provider-glyph-foreground')
      expect(html).toContain('M4.6 6.2h14.8v11.6H4.6Z')
      expect(html).not.toContain('<img')
    }
  })

  it('paints a contrast copy behind the neutral fallback foreground', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="future" />)

    expect(html.indexOf('provider-glyph-contrast-outline')).toBeLessThan(
      html.indexOf('provider-glyph-foreground')
    )
    expect(html.match(/M4\.6 6\.2h14\.8v11\.6H4\.6Z/g)).toHaveLength(2)
  })

  it('renders Ensemble as the full-colour Confluence Loom with collision-safe paint ids', () => {
    const html = renderToStaticMarkup(
      <>
        <ProviderGlyph provider="ensemble" />
        <ProviderGlyph provider="ensemble" />
      </>
    )
    const spectrumIds = Array.from(
      html.matchAll(/id="(provider-glyph-ensemble-spectrum-[^"]+)"/g),
      (match) => match[1]
    )

    expect(new Set(spectrumIds).size).toBe(2)
    expect(html).toContain('data-brand="antigravity"')
    expect(html).toContain('data-brand="gemini"')
    expect(html).toContain('provider-glyph-ensemble-hub-')
    expect(html).toContain('provider-glyph-ensemble-sparkle-')
    expect(html).toContain('stroke="#000000"')
    expect(html).toContain('fill="#F8FAFF"')
    expect(html).not.toContain('M6.6 19.8c.25-3.45')
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

  it('can keep the neutral fallback shape while overriding its accent hue', () => {
    const html = renderToStaticMarkup(<ProviderGlyph provider="future" accentProvider="alibaba" />)

    expect(html).toContain('provider-glyph-future')
    expect(html).toContain('--provider-accent:var(--provider-alibaba-color, currentColor)')
  })
})
