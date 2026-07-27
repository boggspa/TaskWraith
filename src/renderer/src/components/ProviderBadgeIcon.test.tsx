import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderBadgeIcon } from './Sidebar'

describe('ProviderBadgeIcon', () => {
  it('renders official Cursor and Kimi artwork instead of mnemonic glyphs', () => {
    const cursor = renderToStaticMarkup(<ProviderBadgeIcon provider="cursor" />)
    const kimi = renderToStaticMarkup(<ProviderBadgeIcon provider="kimi" />)

    expect(cursor).toContain('provider-cursor')
    expect(kimi).toContain('provider-kimi')
    expect(cursor).toContain('provider-logo-cursor-on-light.png')
    expect(kimi).toContain('provider-logo-kimi.png')
    expect(cursor).not.toContain('provider-glyph-cursor')
    expect(kimi).not.toContain('provider-glyph-kimi')
    expect(cursor).not.toEqual(kimi)
  })

  it('renders the official Ollama logo in sidebar provider badges', () => {
    const ollama = renderToStaticMarkup(<ProviderBadgeIcon provider="ollama" />)

    expect(ollama).toContain('provider-ollama')
    expect(ollama).toContain('provider-logo-ollama')
    expect(ollama).not.toContain('provider-glyph-ollama')
  })

  it('renders the Ensemble glyph in sidebar provider badges', () => {
    const ensemble = renderToStaticMarkup(<ProviderBadgeIcon provider="ensemble" />)

    expect(ensemble).toContain('provider-ensemble')
    expect(ensemble).toContain('provider-glyph-ensemble')
    expect(ensemble).toContain('provider-glyph-ensemble-spectrum-')
    expect(ensemble).toContain('data-brand="antigravity"')
    expect(ensemble).not.toContain('M6.6 19.8c.25-3.45')
  })
})
