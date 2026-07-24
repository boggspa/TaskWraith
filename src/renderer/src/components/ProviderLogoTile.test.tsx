import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderLogoTile } from './ProviderLogoTile'

describe('ProviderLogoTile', () => {
  it('renders official PNG marks for all eight first-class providers', () => {
    for (const provider of [
      'gemini',
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama',
      'antigravity'
    ] as const) {
      const html = renderToStaticMarkup(<ProviderLogoTile provider={provider} />)
      expect(html).toContain(`provider-logo-tile provider-${provider}`)
      expect(html).toContain(`data-provider-logo="${provider}"`)
      expect(html).toContain('<img class="provider-brand-logo-image')
      expect(html).not.toContain(`provider-glyph-${provider}`)
      expect(html).not.toContain('sidebar-provider-icon')
    }
  })

  it('falls back to the generic prompt glyph for unknown future providers', () => {
    const html = renderToStaticMarkup(<ProviderLogoTile provider={'future' as never} />)
    expect(html).toContain('provider-logo-tile provider-future')
    expect(html).toContain('provider-glyph-future')
    expect(html).not.toContain('data-provider-logo=')
    expect(html).not.toContain('<img')
  })
})
